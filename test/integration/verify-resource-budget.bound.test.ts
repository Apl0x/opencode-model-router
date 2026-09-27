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
 *   same TEMP (so the same machine-wide slot dir), are jointly held to the same bound.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { builtinModules, createRequire } from "node:module";
import { appendFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { e2eEnabled, prepareFixtureRepo, type FixtureRepo } from "./e2e/fixture-repo";
import { acceptance, createE2EPlugin, type E2EPlugin, type E2ETaskResult } from "./e2e/harness";
import { peak, priorityViolations, seen, startSampler, type ProcSample, type Snapshot } from "./e2e/sampler";
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

suite("verify resource budget: machine-wide bound (3.1.2.b-c)", () => {
  let root = "";
  let tmpDir = "";
  const repos: FixtureRepo[] = [];
  const plugins: E2EPlugin[] = [];
  const savedTmp = new Map<string, string | undefined>();
  let bundlePath = "";
  let bundleDir = "";

  /** Runner processes scoped to one of our repos or a reference worktree of one. */
  const inScope = (p: ProcSample): boolean => {
    const a = norm(p.args);
    return a.includes(norm(join(tmpDir, "omr-ref-"))) || repos.some(r => a.includes(norm(r.dir)));
  };
  const isWorker = (p: ProcSample): boolean => inScope(p) && isWorkerArgs(p.args);
  const isMain = (p: ProcSample): boolean => inScope(p) && isMainArgs(p.args);
  const isRunnerTree = (p: ProcSample): boolean => isWorker(p) || isMain(p);

  beforeAll(async () => {
    // TEMPORARY realpath: os.tmpdir() may be an 8.3 short path (C:\Users\ABCDEF~1\...); the reference
    // worktree then fails its node_modules link check and every recheck reports "runner not
    // installed: vitest" (fix landing separately in src/verify/reference.ts). It also keeps the
    // repo dir comparable with the long paths in the sampled command lines.
    root = await mkdtemp(join(realpathSync.native(os.tmpdir()), "omr-e2e-bound-"));
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
    const FAILING = new Set([2, 4]);

    // No profile restore here: the sampler must work with USERPROFILE at the plugin's fake home.
    const sampler = startSampler({ intervalMs: 100 });
    let snapshots: Snapshot[] = [];
    let required: E2ETaskResult[] = [];
    let deferred: E2ETaskResult[] = [];
    let report = "";
    try {
      required = await Promise.all(
        [1, 2, 3, 4, 5].map(i =>
          plugin.task({
            sessionID: `orch-b${i}`,
            callID: `b-req-${i}`,
            prompt: `VERIFY:required\nAdjust ${mod(i)}.\n${acceptance(repo.testCommand)}`,
            description: `adjust ${mod(i)}`,
            produce: async () => {
              await sleep(1000);
              if (FAILING.has(i)) await edit(mod(i), `return x + ${i};`, `return x + ${i * 100};`, `b${i}`);
              else await edit(mod(i), undefined, undefined, `b${i}`);
            },
          }),
        ),
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
    const runnersInBefore = inBefore.flatMap(s => seen([s], process.pid, excl, isRunnerTree));
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
    expect(failingOutputs).toBeGreaterThanOrEqual(1);
    expect(report).not.toBe("");
  }, TEST_TIMEOUT_MS);

  it("3.1.2.c: two plugin instances in two processes share the machine-wide bound", async () => {
    const children = [
      { tag: "c1", repo: repos[1], mods: [1, 3, 5] },
      { tag: "c2", repo: repos[2], mods: [2, 4, 6] },
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
        edits: c.mods.map(m => ({ rel: mod(m) })),
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

    for (const r of runs) expect(r.code, r.stderr).toBe(0);
    for (const s of summaries) {
      expect(s).toBeDefined();
      expect(s?.dispatches.length).toBe(3);
      for (const d of s?.dispatches ?? []) expect(d.output.trim()).not.toBe("");
    }
    expect(peakWorkers).toBeGreaterThanOrEqual(1);
    expect(workers.length).toBeGreaterThanOrEqual(1);
    expect(peakWorkers).toBeLessThanOrEqual(WORKER_BOUND);
  }, TEST_TIMEOUT_MS);
});
