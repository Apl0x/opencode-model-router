/**
 * Phase 3.1.2.b-c e2e: verification is bounded machine-wide. Drives the REAL plugin (real runners,
 * real slot, real reference worktrees; no mocks) against temp git copies of the `vitest-app`
 * fixture while a process sampler watches this process's descendants. Gated by RUN_VERIFY_E2E=1.
 *
 * - b: 5 concurrent VERIFY:required dispatches (2 introduce failures -> rechecks), then 5 deferred
 *   dispatches verified by one router_verify({pending:true}). Peak concurrent runner workers stay
 *   within maxWorkers x maxConcurrentVerifications, the runner tree runs below normal priority,
 *   nothing runs inside a before hook, and no run covers the full file set.
 * - c: two child processes (two "opencode sessions"), each with its own plugin and repo but the
 *   same TEMP (so the same machine-wide slot dir), are jointly held to the same bound; each child
 *   gets exactly one rejection (its broken leaf) and two verified passes, and no deferred footer.
 * - d: a gate with a small gateBudgetMs and a 120 s test returns on time, not as a pass, and no
 *   attributable process is alive 3 s after it returned.
 * - e (last): no reference worktree or omr-ref dir is left, and each fixture install is intact.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { builtinModules, createRequire } from "node:module";
import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { e2eEnabled, prepareFixtureRepo, type FixtureRepo } from "./e2e/fixture-repo";
import { acceptance, createE2EPlugin, type E2EPlugin, type E2ETaskResult } from "./e2e/harness";
import { ancestorsOf, descendantsOf, peak, priorityViolations, seen, startSampler, type ProcSample, type Snapshot } from "./e2e/sampler";
import type { ChildConfig, ChildSummary } from "./e2e/child-instance";

const suite = e2eEnabled() ? describe.sequential : describe.skip;

const TEST_TIMEOUT_MS = 480_000;
const ENV_TMP_KEYS = ["TEMP", "TMP", "TMPDIR"] as const;
/** Default budget (src/router/config.ts): maxWorkers 2, maxConcurrentVerifications max(1, floor(cores/8)). */
const MAX_WORKERS = 2;
const CORES = os.availableParallelism();
const MAX_CONCURRENT = Math.max(1, Math.floor(CORES / 8));
const WORKER_BOUND = MAX_WORKERS * MAX_CONCURRENT;
/** The fixture has 41 static test files plus dynamic.test.js. */
const FULL_FILE_SET = 42;
const SUMMARY_PREFIX = "OMR_CHILD_SUMMARY ";
const CHILD_ENTRY = fileURLToPath(new URL("./e2e/child-instance.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function norm(s: string): string {
  return s.replace(/\\/g, "/").toLowerCase();
}

/** Case-insensitive on win32 (paths there are), case-sensitive elsewhere. */
function foldCase(s: string): string {
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/**
 * Every spelling of `dir` a command line may carry: raw and realpath (an 8.3 short os.tmpdir()
 * vs its long form), each with `\` and with `/` separators, case-folded on win32.
 */
function pathSpellings(dir: string): string[] {
  const forms = [dir];
  try {
    forms.push(realpathSync.native(dir));
  } catch (e) {
    // A dir that does not exist (yet) has only its raw spelling.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const out = new Set<string>();
  for (const f of forms) {
    out.add(foldCase(f.replace(/\//g, "\\")));
    out.add(foldCase(f.replace(/\\/g, "/")));
  }
  return [...out];
}

/** Whether `args` mentions any of `spellings`, compared as-is and with separators unified to `/`. */
function mentionsAny(args: string, spellings: readonly string[]): boolean {
  const raw = foldCase(args);
  const slashed = raw.replace(/\\/g, "/");
  return spellings.some(s => raw.includes(s) || slashed.includes(s.replace(/\\/g, "/")));
}

/** Verdict markers appended by the gate (src/verify/dispatch.ts buildAcceptedSuffix / buildForcingNote). */
const ACCEPTED_MARK = "[router \u2713 accepted";
const REJECTED_MARK = "NOT ACCEPTED";
const CAVEAT_MARK = "Verification caveats \u2014 NOT verified";
/** A deferred verification footer names a vrf_ handle; VERIFY:required dispatches must not carry one. */
const DEFERRED_FOOTER = /\bvrf_/;
/** 3.1.2.d: small enough for the 120 s slow test to hit it, larger than capture + planning (measured). */
const GATE_BUDGET_MS = 6000;
/**
 * 3.1.2.b/c: neutral dispatches start this long after the broken ones: past the broken edit
 * (produce delay 1000 ms) and the broken gate's batch window (batchWindowMs 2000 ms).
 */
const NEUTRAL_START_DELAY_MS = 3500;
const SLOW_TEST = `\nit("slow", async () => { await new Promise(r => setTimeout(r, 120000)); }, 200000);\n`;
/**
 * How far a snapshot's `t` may sit from the moment its process list was read: win32 stamps it
 * before the CIM query (~100 ms), POSIX when the parent reads the `@@T` frame, possibly after `ps`.
 */
const SNAPSHOT_SKEW_MS = 250;

/** Logs the measured numbers; with OMR_E2E_REPORT=<file> also appends them there (vitest may hide a passing test's console). */
function emit(text: string): void {
  console.log(text);
  const file = process.env.OMR_E2E_REPORT;
  if (file !== undefined && file !== "") appendFileSync(file, `${text}\n`, "utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function mod(i: number): string {
  return `src/m${String(i).padStart(2, "0")}.js`;
}

function intervalStats(snapshots: Snapshot[]): string {
  const gaps = snapshots
    .slice(1)
    .map((s, i) => s.t - snapshots[i].t)
    .sort((a, b) => a - b);
  if (gaps.length === 0) return "n/a";
  return `median=${gaps[Math.floor(gaps.length / 2)]}ms max=${gaps[gaps.length - 1]}ms`;
}

/** A vitest pool worker process (vitest 4: node .../vitest/dist/workers/forks.js). */
function isWorkerArgs(args: string): boolean {
  return /vitest\/dist\/workers\//.test(norm(args));
}

/** The vitest CLI process (node .../vitest/vitest.mjs <args>), not a worker. */
function isMainArgs(args: string): boolean {
  const a = norm(args);
  return !isWorkerArgs(args) && /vitest\/vitest\.mjs\b|node_modules\/\.bin\/vitest\b|vitest\/dist\/cli/.test(a);
}

/** Test-file tokens in a runner command line. */
function testFileArgs(args: string): string[] {
  return args.split(/\s+/).filter(t => /\.test\.[cm]?[jt]sx?"?$/.test(t));
}

suite("verify resource budget: machine-wide bound (3.1.2.b-e)", () => {
  let root = "";
  let tmpDir = "";
  const repos: FixtureRepo[] = [];
  const plugins: E2EPlugin[] = [];
  const savedTmp = new Map<string, string | undefined>();
  let bundlePath = "";
  let bundleDir = "";

  /** Spellings of every repo dir and of `<tmp>/omr-ref-`, rebuilt when a repo is added. */
  let scopeCache: { n: number; spellings: string[] } = { n: -1, spellings: [] };
  const scopeSpellings = (): string[] => {
    if (scopeCache.n !== repos.length) {
      const refPrefixes = pathSpellings(tmpDir).flatMap(t => [`${t}\\omr-ref-`, `${t}/omr-ref-`]);
      scopeCache = { n: repos.length, spellings: [...refPrefixes, ...repos.flatMap(r => pathSpellings(r.dir))] };
    }
    return scopeCache.spellings;
  };
  /** Runner processes scoped to one of our repos or a reference worktree of one. */
  const inScope = (p: ProcSample): boolean => mentionsAny(p.args, scopeSpellings());
  const isWorker = (p: ProcSample): boolean => inScope(p) && isWorkerArgs(p.args);
  const isMain = (p: ProcSample): boolean => inScope(p) && isMainArgs(p.args);
  const isRunnerTree = (p: ProcSample): boolean => isWorker(p) || isMain(p);

  beforeAll(async () => {
    // The raw os.tmpdir(), possibly an 8.3 short path (fixed in 29760a6); the scope predicates
    // match both the raw and the realpath spelling of every dir.
    root = await mkdtemp(join(os.tmpdir(), "omr-e2e-bound-"));
    tmpDir = join(root, "tmp");
    await mkdir(join(root, "repos"), { recursive: true });
    await mkdir(tmpDir, { recursive: true });
    await mkdir(join(root, "home"), { recursive: true });
    for (const k of ENV_TMP_KEYS) {
      savedTmp.set(k, process.env[k]);
      process.env[k] = tmpDir;
    }
    for (let i = 0; i < 3; i++) repos.push(await prepareFixtureRepo("vitest-app", { root: join(root, "repos") }));

    // Bundle the child entry (and the plugin it imports) to one .mjs. The output sits two levels
    // below this repo's root, like src/router/config.ts: the plugin finds tiers.json at
    // `<module dir>/../..`, and the externalised package imports resolve from the root node_modules.
    bundleDir = join(REPO_ROOT, "test", `.omr-e2e-child-${process.pid}`);
    const req = createRequire(createRequire(import.meta.url).resolve("vitest/package.json"));
    const vite = req("vite") as { build(config: Record<string, unknown>): Promise<unknown> };
    await vite.build({
      configFile: false,
      root: REPO_ROOT,
      logLevel: "silent",
      build: {
        ssr: CHILD_ENTRY,
        write: true,
        outDir: bundleDir,
        emptyOutDir: true,
        minify: false,
        rollupOptions: {
          external: [...builtinModules, ...builtinModules.map(m => `node:${m}`)],
          output: { format: "es", entryFileNames: "child-instance.mjs" },
        },
      },
    });
    bundlePath = join(bundleDir, "child-instance.mjs");
  }, 900_000);

  afterAll(async () => {
    for (const p of plugins.reverse()) {
      await p.dispose().catch((e: unknown) => process.stderr.write(`[bound-e2e] dispose failed: ${String(e)}\n`));
    }
    for (const [k, v] of savedTmp) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // FixtureRepo.dispose unlinks a node_modules junction before removing the tree.
    for (const r of repos) await r.dispose();
    if (bundleDir !== "") await rm(bundleDir, { recursive: true, force: true });
    if (root !== "") await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }, 180_000);

  it("3.1.2.b: 5 required + 5 deferred dispatches stay within the worker bound, below normal priority", async () => {
    const repo = repos[0];
    const base = repo.head();
    const plugin = await createE2EPlugin({ directory: repo.dir, home: join(root, "home", "b"), verify: {} });
    plugins.push(plugin);

    const edit = async (rel: string, from: string | undefined, to: string | undefined, tag: string): Promise<void> => {
      const text = await readFile(join(repo.dir, rel), "utf8");
      if (from === undefined || to === undefined) return repo.write(rel, `${text}\n// neutral edit ${tag}\n`);
      if (!text.includes(from)) throw new Error(`${rel} does not contain ${from}`);
      return repo.write(rel, text.replace(from, to));
    };
    // The producers share one working tree and verification judges the current tree. In vitest-app
    // module k imports module floor(k/2), so a neutral edit to m01..m05 has the tests of modules
    // another producer broke among its related tests, and all five were rejected. m11..m20 have no
    // importers (leaves): each leaf's related tests are its own. That alone is not enough: a
    // dispatch's change set is the tree against its dispatch-time capture, so a neutral dispatch
    // captured before a sibling's broken edit counts that edit as its own (measured: m11 rejected
    // over m12/m14 failures). The neutral dispatches therefore start NEUTRAL_START_DELAY_MS later,
    // after the broken edits are in the tree and outside their batch window (2000 ms).
    const REQUIRED = [11, 12, 13, 14, 15];
    const FAILING = new Set([12, 14]);

    // No profile restore here: the sampler must work with USERPROFILE at the plugin's fake home.
    const sampler = startSampler({ intervalMs: 100 });
    let snapshots: Snapshot[] = [];
    let required: E2ETaskResult[] = [];
    let deferred: E2ETaskResult[] = [];
    let report = "";
    try {
      required = await Promise.all(
        REQUIRED.map(async i => {
          if (!FAILING.has(i)) await sleep(NEUTRAL_START_DELAY_MS);
          return plugin.task({
            sessionID: `orch-b${i}`,
            callID: `b-req-${i}`,
            prompt: `VERIFY:required\nAdjust ${mod(i)}.\n${acceptance(repo.testCommand)}`,
            description: `adjust ${mod(i)}`,
            produce: async () => {
              await sleep(1000);
              if (FAILING.has(i)) await edit(mod(i), `return x + ${i};`, `return x + ${i * 100};`, `b${i}`);
              else await edit(mod(i), undefined, undefined, `b${i}`);
            },
          });
        }),
      );
      repo.git("reset", "-q", "--hard", base);
      repo.git("clean", "-q", "-fd", "-e", "node_modules");
      deferred = await Promise.all(
        [6, 8, 10, 12, 14].map((m, i) =>
          plugin.task({
            sessionID: "orch-bd",
            callID: `b-def-${i + 1}`,
            prompt: `Tidy ${mod(m)}.\n${acceptance(repo.testCommand)}`,
            description: `tidy ${mod(m)}`,
            produce: async () => {
              await sleep(1000);
              await edit(mod(m), undefined, undefined, `bd${i + 1}`);
            },
          }),
        ),
      );
      report = await plugin.routerVerify({ pending: true }, { sessionID: "orch-bd" });
      await sleep(500);
    } finally {
      snapshots = await sampler.stop();
    }

    const excl = [sampler.pid];
    const all = seen(snapshots, process.pid, excl, () => true);
    const runnerish = all.filter(p => /vitest|npm|node_modules/i.test(p.args));
    const workers = seen(snapshots, process.pid, excl, isWorker);
    const mains = seen(snapshots, process.pid, excl, isMain);
    const peakWorkers = peak(snapshots, process.pid, excl, isWorker);
    const peakMains = peak(snapshots, process.pid, excl, isMain);
    const violations = priorityViolations(snapshots, process.pid, excl, isRunnerTree, 250);
    const gitCmdNormal = all.filter(p => /\b(git|cmd)(\.exe)?\b/i.test(p.args) && p.lowPriority === false);
    const beforeWindows = [...required, ...deferred].map(r => [r.produceStartedAt - r.beforeMs, r.produceStartedAt] as const);
    const inBefore = snapshots.filter(s => beforeWindows.some(([a, b]) => s.t >= a && s.t <= b));
    // The staggered neutral before hooks overlap the broken dispatches' gates; those gate runs
    // (scoped run and recheck) name a broken module and are not before-hook work.
    const failingNames = new RegExp(`(src/m(${[...FAILING].join("|")})\\.js|test/m(${[...FAILING].join("|")})-\\d+\\.test\\.js)`);
    const runnersInBefore = inBefore.flatMap(s => {
      const gateMains = new Set(s.procs.filter(p => isMain(p) && failingNames.test(norm(p.args))).map(p => p.pid));
      return seen([s], process.pid, excl, p => isRunnerTree(p) && !gateMains.has(p.pid) && !gateMains.has(p.ppid));
    });
    const outputs = [...required, ...deferred].map(r => r.output);
    const failingOutputs = required.filter(r => r.output.includes("NOT ACCEPTED")).length;

    emit(
      [
        `[3.1.2.b] cores=${CORES} maxWorkers=${MAX_WORKERS} x maxConcurrentVerifications=${MAX_CONCURRENT} -> bound ${WORKER_BOUND}`,
        `[3.1.2.b] sampler snapshots=${snapshots.length} interval ${intervalStats(snapshots)}`,
        `[3.1.2.b] peak workers=${peakWorkers} distinct workers=${workers.length} peak mains=${peakMains} distinct runner-main invocations=${mains.length}`,
        `[3.1.2.b] priority violations=${violations.length} ${violations.map(p => `${p.pid}:${String(p.priority)}:${p.args}`).join(" | ")}`,
        `[3.1.2.b] git/cmd descendants seen at normal priority=${gitCmdNormal.length} ${gitCmdNormal.map(p => `${p.pid}:${p.args.slice(0, 120)}`).join(" | ")}`,
        `[3.1.2.b] snapshots inside before-hook windows=${inBefore.length} runners in them=${runnersInBefore.length}`,
        `[3.1.2.b] NOT ACCEPTED among required=${failingOutputs}`,
        `[3.1.2.b] distinct runner-related descendant args:`,
        ...[...new Set(runnerish.map(p => `  prio=${String(p.priority)} ${p.args}`))],
        `[3.1.2.b] runner-main args:`,
        ...mains.map(p => `  ${p.args}`),
        `[3.1.2.b] outputs:`,
        ...outputs.map((o, i) => `  --- #${i + 1}\n${o}`),
        `[3.1.2.b] pending report:\n${report}`,
      ].join("\n"),
    );

    // Non-vacuity.
    expect(snapshots.filter(s => s.procs.some(p => p.pid === process.pid)).length).toBeGreaterThanOrEqual(5);
    expect(peakWorkers).toBeGreaterThanOrEqual(1);
    expect(workers.length).toBeGreaterThanOrEqual(1);
    expect(mains.length).toBeGreaterThanOrEqual(1);
    // The bound.
    expect(peakWorkers).toBeLessThanOrEqual(WORKER_BOUND);
    // Below normal priority for the whole runner tree (after the documented spawn race).
    expect(violations.map(p => `${p.pid} prio=${String(p.priority)} ${p.args}`)).toEqual([]);
    // Nothing runs inside a before hook.
    expect(runnersInBefore.map(p => p.args)).toEqual([]);
    // Scoped runs only: `related` or explicit test files, never the full file set.
    for (const m of mains) {
      const files = testFileArgs(m.args);
      expect(/\brelated\b/.test(m.args) || files.length > 0, m.args).toBe(true);
      expect(files.length, m.args).toBeLessThan(FULL_FILE_SET);
    }
    // Runs are batched/bounded: at most one per dispatch plus a recheck per failure (x2 slack).
    expect(mains.length).toBeLessThanOrEqual(5 + 5 + 2 * FAILING.size);
    // Exactly the two broken leaves are rejected; the three neutral leaves pass.
    REQUIRED.forEach((m, i) => {
      const out = required[i].output;
      expect(out.includes(REJECTED_MARK), `${mod(m)}:\n${out}`).toBe(FAILING.has(m));
      expect(DEFERRED_FOOTER.test(out), out).toBe(false);
    });
    expect(failingOutputs).toBe(FAILING.size);
    expect(report).not.toBe("");
  }, TEST_TIMEOUT_MS);

  it("3.1.2.c: two plugin instances in two processes share the machine-wide bound", async () => {
    // Leaf modules and staggered starts only (see 3.1.2.b): each child yields exactly one rejection
    // and two passes.
    const children = [
      { tag: "c1", repo: repos[1], mods: [16, 17, 18], broken: 16 },
      { tag: "c2", repo: repos[2], mods: [19, 20, 13], broken: 19 },
    ];
    const startAt = Date.now() + 1500;
    const configPaths: string[] = [];
    for (const c of children) {
      const cfg: ChildConfig = {
        tag: c.tag,
        repoDir: c.repo.dir,
        home: join(root, "home", c.tag),
        testCommand: c.repo.testCommand,
        startAt,
        produceDelayMs: 1000,
        edits: c.mods.map(m =>
          m === c.broken
            ? { rel: mod(m), from: `return x + ${m};`, to: `return x + ${m * 100};` }
            : { rel: mod(m), startDelayMs: NEUTRAL_START_DELAY_MS },
        ),
      };
      const p = join(root, `${c.tag}.json`);
      await writeFile(p, JSON.stringify(cfg), "utf8");
      configPaths.push(p);
    }

    const sampler = startSampler({ intervalMs: 100 });
    let snapshots: Snapshot[] = [];
    let runs: { code: number | null; stdout: string; stderr: string }[] = [];
    try {
      runs = await Promise.all(
        configPaths.map(
          cfgPath =>
            new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
              // TEMP/TMP/TMPDIR are inherited (set in beforeAll): the same slot dir for both children.
              const child = spawn(process.execPath, [bundlePath, cfgPath], { cwd: REPO_ROOT, env: process.env, windowsHide: true });
              let stdout = "";
              let stderr = "";
              child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
              child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
              child.on("error", reject);
              child.on("exit", code => resolve({ code, stdout, stderr }));
            }),
        ),
      );
      await sleep(300);
    } finally {
      snapshots = await sampler.stop();
    }

    const summaries = runs.map(r => {
      const line = r.stdout.split("\n").find(l => l.startsWith(SUMMARY_PREFIX));
      return line === undefined ? undefined : (JSON.parse(line.slice(SUMMARY_PREFIX.length)) as ChildSummary);
    });
    const excl = [sampler.pid];
    const peakWorkers = peak(snapshots, process.pid, excl, isWorker);
    const workers = seen(snapshots, process.pid, excl, isWorker);
    const mains = seen(snapshots, process.pid, excl, isMain);
    const perChildPeak = summaries.map(s =>
      s === undefined ? -1 : peak(snapshots, s.pid, excl, isWorker),
    );
    emit(
      [
        `[3.1.2.c] bound ${WORKER_BOUND}; sampler snapshots=${snapshots.length} interval ${intervalStats(snapshots)}`,
        `[3.1.2.c] peak workers (both children)=${peakWorkers} per child=${perChildPeak.join(",")} distinct workers=${workers.length} runner-main invocations=${mains.length}`,
        ...runs.map((r, i) => `[3.1.2.c] child ${i + 1} exit=${String(r.code)} stderr:\n${r.stderr.slice(-2000)}`),
        ...summaries.flatMap(s => (s === undefined ? [] : s.dispatches.map(d => `  --- ${d.callID} after=${d.afterMs.toFixed(0)}ms\n${d.output}`))),
      ].join("\n"),
    );

    /**
     * Runner mains of this child, in its repo, whose args name module m's source or one of its test
     * files, seen in the snapshots taken within [from, to] (widened by SNAPSHOT_SKEW_MS).
     */
    const mainsFor = (childPid: number, repoDir: string, m: number, from = -Infinity, to = Infinity): ProcSample[] => {
      const nn = String(m).padStart(2, "0");
      const names = new RegExp(`(src/m${nn}\\.js|test/m${nn}-\\d+\\.test\\.js)`);
      const repoSpellings = pathSpellings(repoDir);
      const within = snapshots.filter(s => s.t >= from - SNAPSHOT_SKEW_MS && s.t <= to + SNAPSHOT_SKEW_MS);
      return seen(within, childPid, excl, p => isMain(p) && mentionsAny(p.args, repoSpellings) && names.test(norm(p.args)));
    };
    const perDispatch = children.flatMap((c, ci) =>
      c.mods.map((m, di) => {
        const s = summaries[ci];
        const d = s?.dispatches[di];
        const mains = s === undefined ? [] : mainsFor(s.pid, c.repo.dir, m);
        // This dispatch's own gate: its after hook, from its start to its return.
        const gateMains = s === undefined || d === undefined ? [] : mainsFor(s.pid, c.repo.dir, m, d.returnedAt - d.afterMs, d.returnedAt);
        return { tag: c.tag, m, broken: m === c.broken, d, mains, gateMains };
      }),
    );
    emit(
      perDispatch
        .map(x => `[3.1.2.c] ${x.tag} ${mod(x.m)}${x.broken ? " (broken)" : ""}: after=${x.d?.afterMs.toFixed(0) ?? "?"}ms runner mains naming it=${x.mains.length} ${x.mains.map(p => p.pid).join(",")}; during its gate=${x.gateMains.length} ${x.gateMains.map(p => p.pid).join(",")}`)
        .join("\n"),
    );

    for (const r of runs) expect(r.code, r.stderr).toBe(0);
    for (const s of summaries) {
      expect(s).toBeDefined();
      expect(s?.dispatches.length).toBe(3);
    }
    for (const x of perDispatch) {
      const out = x.d?.output ?? "";
      const label = `${x.tag} ${mod(x.m)}:\n${out}`;
      // VERIFY:required: never a deferred-verification footer.
      expect(DEFERRED_FOOTER.test(out), label).toBe(false);
      if (x.broken) {
        // Exactly one rejection per child, naming the broken module's test.
        expect(out.includes(REJECTED_MARK), label).toBe(true);
        expect(new RegExp(`m${String(x.m).padStart(2, "0")}`).test(out), label).toBe(true);
      } else {
        // A clean required-mode pass leaves the output untouched: no rejection, no caveat.
        expect(out.includes(REJECTED_MARK), label).toBe(false);
        expect(out.includes(CAVEAT_MARK), label).toBe(false);
        // Non-vacuity: verification really ran for this dispatch. The direct evidence is a runner
        // main of this child, in its repo, naming this module and alive during this dispatch's own
        // gate. (CI round 1: a duration floor is no proof; a batched 2-file run on Linux finished
        // its gate in 587-686 ms.)
        expect(x.gateMains.map(p => p.pid), label).not.toEqual([]);
      }
    }
    expect(peakWorkers).toBeGreaterThanOrEqual(1);
    expect(workers.length).toBeGreaterThanOrEqual(1);
    expect(peakWorkers).toBeLessThanOrEqual(WORKER_BOUND);
  }, TEST_TIMEOUT_MS);

  it("3.1.2.d: a gate that hits its budget returns on time and leaves no orphan", async () => {
    const repo = await prepareFixtureRepo("vitest-app", { root: join(root, "repos") });
    repos.push(repo);
    const plugin = await createE2EPlugin({ directory: repo.dir, home: join(root, "home", "d"), verify: { gateBudgetMs: GATE_BUDGET_MS } });
    plugins.push(plugin);
    const spellings = [...pathSpellings(repo.dir), ...pathSpellings(tmpDir).flatMap(t => [`${t}\\omr-ref-`, `${t}/omr-ref-`])];
    const attributable = (p: ProcSample): boolean => mentionsAny(p.args, spellings) || /vitest/i.test(p.args);

    const sampler = startSampler({ intervalMs: 100 });
    let snapshots: Snapshot[] = [];
    let result: E2ETaskResult | undefined;
    let dispatchedAt = 0;
    try {
      dispatchedAt = Date.now();
      result = await plugin.task({
        sessionID: "orch-d",
        callID: "d-slow",
        prompt: `VERIFY:required\nAdjust ${mod(7)} and cover it.\n${acceptance(repo.testCommand)}`,
        description: `adjust ${mod(7)}`,
        produce: async () => {
          await sleep(1000);
          const src = await readFile(join(repo.dir, mod(7)), "utf8");
          await repo.write(mod(7), `${src}\n// neutral edit d\n`);
          const rel = "test/m07-1.test.js";
          const t = await readFile(join(repo.dir, rel), "utf8");
          await repo.write(rel, `${t}${SLOW_TEST}`);
        },
      });
      // Keep sampling well past return + 3 s so at least one snapshot starts after it.
      await sleep(Math.max(0, result.returnedAt + 5000 - Date.now()));
    } finally {
      snapshots = await sampler.stop();
    }
    if (result === undefined) throw new Error("the dispatch did not return");
    const res: E2ETaskResult = result;

    const excl = [sampler.pid];
    const gateStartedAt = res.returnedAt - res.afterMs;
    const deadlineAt = gateStartedAt + GATE_BUDGET_MS;
    const deadlineToReturn = res.returnedAt - deadlineAt;
    const runDuring = seen(
      snapshots.filter(s => s.t <= res.returnedAt),
      process.pid,
      excl,
      p => isRunnerTree(p),
    );
    const trackedDuring = seen(
      snapshots.filter(s => s.t <= res.returnedAt),
      process.pid,
      excl,
      attributable,
    );
    const late = snapshots.filter(s => s.t >= res.returnedAt + 3000);
    // This process's own ancestors (the vitest main, and in CI npx and cmd) outlive the gate by
    // design; they are never a gate orphan (CI round 1).
    const ancestors = new Set(snapshots.flatMap(s => ancestorsOf(s, process.pid)).map(p => p.pid));
    /** Created by this dispatch or later (creation times are known on win32 only). */
    const sinceDispatch = (p: ProcSample): boolean => p.createdMs === undefined || p.createdMs >= dispatchedAt;
    // Descendants still attached to this process, and (Windows does not reparent) any process on
    // the machine created since the dispatch that is one of the tracked pids (same creation time)
    // or names our paths.
    const tracked = new Map(trackedDuring.filter(sinceDispatch).map(p => [p.pid, p.createdMs]));
    const lateDesc = late.flatMap(s => descendantsOf(s, process.pid, excl).filter(attributable).map(p => ({ t: s.t, p })));
    const lateMachine = late.flatMap(s =>
      s.procs
        .filter(p => p.pid !== sampler.pid && p.pid !== process.pid && !ancestors.has(p.pid) && sinceDispatch(p))
        .filter(p => (tracked.has(p.pid) && tracked.get(p.pid) === p.createdMs) || mentionsAny(p.args, spellings))
        .map(p => ({ t: s.t, p })),
    );
    const describeProc = (x: { t: number; p: ProcSample }): string =>
      `+${x.t - res.returnedAt}ms pid=${x.p.pid} ppid=${x.p.ppid} created=${x.p.createdMs === undefined ? "?" : `${x.p.createdMs - dispatchedAt}ms after dispatch`} ${x.p.args.slice(0, 300)}`;
    // Direct check, after the sampler stopped: signal 0 on every pid seen.
    const directAlive: number[] = [];
    for (const pid of tracked.keys()) {
      try {
        process.kill(pid, 0);
        directAlive.push(pid);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EPERM") directAlive.push(pid);
        else if (code !== "ESRCH") throw e;
      }
    }
    const directAliveAt = Date.now() - res.returnedAt;

    emit(
      [
        `[3.1.2.d] gateBudgetMs=${GATE_BUDGET_MS} beforeMs=${res.beforeMs.toFixed(0)} afterMs(gate)=${res.afterMs.toFixed(0)}`,
        `[3.1.2.d] dispatch->return=${res.returnedAt - dispatchedAt}ms deadline->gate return=${deadlineToReturn.toFixed(0)}ms`,
        `[3.1.2.d] sampler snapshots=${snapshots.length} interval ${intervalStats(snapshots)}; snapshots >= return+3s=${late.length} (first at +${late.length > 0 ? late[0].t - res.returnedAt : -1}ms, last at +${late.length > 0 ? late[late.length - 1].t - res.returnedAt : -1}ms)`,
        `[3.1.2.d] runner processes seen during the run=${runDuring.length} attributable descendants seen=${trackedDuring.length} (created since the dispatch=${tracked.size}); own ancestors=[${[...ancestors].join(",")}]`,
        ...trackedDuring.map(p => `  seen ${p.pid} ppid=${p.ppid} created=${p.createdMs === undefined ? "?" : `${p.createdMs - dispatchedAt}ms after dispatch`} ${p.args.slice(0, 200)}`),
        `[3.1.2.d] alive >= 3 s after return: descendants=${lateDesc.length} machine-wide=${lateMachine.length} direct kill(0) at +${directAliveAt}ms=${directAlive.length} [${directAlive.join(",")}]`,
        ...[...lateDesc, ...lateMachine].map(x => `  alive at ${describeProc(x)}`),
        `[3.1.2.d] output:\n${res.output}`,
      ].join("\n"),
    );

    // Non-vacuity: the runner did start, and the sampler covered the +3 s mark.
    expect(runDuring.length).toBeGreaterThanOrEqual(1);
    expect(late.length).toBeGreaterThanOrEqual(1);
    // Returns on time.
    expect(res.afterMs).toBeLessThanOrEqual(GATE_BUDGET_MS + 3000);
    // Not a pass: rejected, or accepted only with an unverified caveat naming the timeout.
    const out = res.output;
    const notPass = out.includes(REJECTED_MARK) || (out.includes(ACCEPTED_MARK) && out.includes(CAVEAT_MARK));
    expect(notPass, out).toBe(true);
    expect(/timed out|budget|deadline/i.test(out), out).toBe(true);
    expect(DEFERRED_FOOTER.test(out), out).toBe(false);
    // No orphans 3 s after return.
    expect(lateDesc.map(describeProc)).toEqual([]);
    expect(lateMachine.map(describeProc)).toEqual([]);
    expect(directAlive).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // Keep last: checks what every test above left behind.
  it("3.1.2.e: reference worktrees are disposed and the fixture installs are intact", async () => {
    const refEntries = (r: FixtureRepo): string[] =>
      r
        .git("worktree", "list", "--porcelain")
        .split("\n")
        .filter(l => l.startsWith("worktree ") && /omr-ref-/.test(l));
    const refDirs = async (): Promise<string[]> => (await readdir(tmpDir)).filter(n => n.startsWith("omr-ref-"));
    const t0 = Date.now();
    let worktrees = repos.flatMap(refEntries);
    let dirs = await refDirs();
    while ((worktrees.length > 0 || dirs.length > 0) && Date.now() - t0 < 15_000) {
      await sleep(500);
      worktrees = repos.flatMap(refEntries);
      dirs = await refDirs();
    }
    const settledMs = Date.now() - t0;
    const installs = await Promise.all(
      repos.map(async r => {
        const nm = await lstat(join(r.dir, "node_modules"));
        return { dir: r.dir, sentinel: existsSync(r.sentinelPath), realDir: nm.isDirectory() && !nm.isSymbolicLink() };
      }),
    );
    emit(
      [
        `[3.1.2.e] repos=${repos.length} settled after ${settledMs}ms; omr-ref worktrees=${worktrees.length} omr-ref dirs in tmp=${dirs.length}`,
        ...worktrees.map(w => `  worktree ${w}`),
        ...dirs.map(d => `  dir ${d}`),
        ...installs.map(i => `  ${i.dir} sentinel=${i.sentinel} node_modules real dir=${i.realDir}`),
      ].join("\n"),
    );
    expect(repos.length).toBeGreaterThanOrEqual(4);
    expect(worktrees).toEqual([]);
    expect(dirs).toEqual([]);
    for (const i of installs) {
      expect(i.sentinel, i.dir).toBe(true);
      expect(i.realDir, i.dir).toBe(true);
    }
  }, 60_000);
});
