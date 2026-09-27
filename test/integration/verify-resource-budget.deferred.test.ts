/**
 * Phase 3.1.2.f-h e2e: deferred verification costs nothing, the orchestrator keeps control, and the
 * background opt-in reports late. Drives the REAL plugin (real runners, real slot, real reference
 * worktrees; no mocks) against a temp git copy of the `vitest-app` fixture. Gated by RUN_VERIFY_E2E=1.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { e2eEnabled, prepareFixtureRepo, type FixtureRepo } from "./e2e/fixture-repo";
import { acceptance, createE2EPlugin, type E2EPlugin, type E2ETaskResult } from "./e2e/harness";
import { seen, startSampler, type ProcSample, type Sampler, type Snapshot } from "./e2e/sampler";

const suite = e2eEnabled() ? describe.sequential : describe.skip;

const TEST_TIMEOUT_MS = 180_000;
/** Default VERIFY_WAIT (captureWaitMs). */
const VERIFY_WAIT_DEFAULT_MS = 5_000;
/** DEFERRED_FINISH_MS (src/verify/wiring.ts) plus scheduling slack; see QA-2.4-11. */
const DEFERRED_AFTER_BOUND_MS = 2_500;
const FOOTER_RE = /\[router\] unverified \u00b7 (vrf_[0-9a-f]{24}) \u00b7 risk \S+/;
const PENDING_HEADER = "[router] Unverified delegations in this session (newest first):";
const LATE_NOTICE_MARK = "Background verification";
const DRIFT_NOTICE = "tree drifted since delegation";

const ENV_TMP_KEYS = ["TEMP", "TMP", "TMPDIR"] as const;
/** The real profile, captured before any plugin instance points HOME/USERPROFILE at a temp home. */
const REAL_PROFILE = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

/**
 * startSampler inherits process.env at spawn time. With USERPROFILE pointing at the plugin's temp
 * home, powershell.exe's Get-CimInstance loop emits no snapshot at all (measured: 0 snapshots in
 * 6 s), so the sampler is spawned with the real profile restored for that synchronous call only.
 */
function startRealSampler(intervalMs: number): Sampler {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const put = (k: "HOME" | "USERPROFILE", v: string | undefined): void => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  put("HOME", REAL_PROFILE.HOME);
  put("USERPROFILE", REAL_PROFILE.USERPROFILE);
  try {
    return startSampler({ intervalMs });
  } finally {
    put("HOME", saved.HOME);
    put("USERPROFILE", saved.USERPROFILE);
  }
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function stats(values: number[]): string {
  return `p50=${percentile(values, 50).toFixed(0)}ms p95=${percentile(values, 95).toFixed(0)}ms max=${Math.max(...values).toFixed(0)}ms`;
}

function norm(s: string): string {
  return s.replace(/\\/g, "/").toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function mod(i: number): string {
  return `src/m${String(i).padStart(2, "0")}.js`;
}

suite("verify resource budget: deferred (3.1.2.f-h)", () => {
  let root = "";
  let slotDir = "";
  let homeA = "";
  let homeB = "";
  let repo: FixtureRepo | undefined;
  let base = "";
  const plugins: E2EPlugin[] = [];
  const savedTmp = new Map<string, string | undefined>();
  /** Handles of the 3.1.2.f dispatches, in dispatch order. */
  let fHandles: string[] = [];

  const r = (): FixtureRepo => {
    if (repo === undefined) throw new Error("fixture repo not prepared");
    return repo;
  };

  /** The mandated runner predicate: args mention the fixture repo dir AND a test runner. */
  const isRunner = (p: ProcSample): boolean => norm(p.args).includes(norm(r().dir)) && /vitest|jest|pytest/i.test(p.args);
  /** A broader cross-check: any descendant that looks like a runner or npm, wherever it runs. */
  const looksLikeRunner = (p: ProcSample): boolean => /vitest|jest|pytest|npm-cli|npm\.cmd|\bnpm\b/i.test(p.args);

  async function reset(): Promise<void> {
    r().git("reset", "-q", "--hard", base);
    r().git("clean", "-q", "-fd", "-e", "node_modules", "-e", ".venv");
  }

  async function neutralEdit(rel: string, tag: string): Promise<void> {
    const text = await readFile(join(r().dir, rel), "utf8");
    await r().write(rel, `${text}\n// neutral edit ${tag}\n`);
  }

  async function breakModule(rel: string, from: string, to: string): Promise<void> {
    const text = await readFile(join(r().dir, rel), "utf8");
    if (!text.includes(from)) throw new Error(`${rel} does not contain ${from}`);
    await r().write(rel, text.replace(from, to));
  }

  function handleOf(res: E2ETaskResult): string | undefined {
    return FOOTER_RE.exec(res.output)?.[1];
  }

  async function slotLocks(): Promise<string[]> {
    if (!existsSync(slotDir)) return [];
    return (await readdir(slotDir)).filter(f => /^slot-\d+\.lock$/.test(f));
  }

  beforeAll(async () => {
    // The raw os.tmpdir() on purpose: on Windows it is often an 8.3 short path
    // (C:\Users\ABCDEF~1\...), and the plugin directory, TEMP and the reference worktrees must all
    // work under that spelling (E2E-2).
    root = await mkdtemp(join(os.tmpdir(), "omr-e2e-def-"));
    await mkdir(join(root, "repos"), { recursive: true });
    await mkdir(join(root, "tmp"), { recursive: true });
    await mkdir(join(root, "home"), { recursive: true });
    for (const k of ENV_TMP_KEYS) {
      savedTmp.set(k, process.env[k]);
      process.env[k] = join(root, "tmp");
    }
    slotDir = join(root, "tmp", "opencode-model-router", "verify-slots");
    homeA = join(root, "home", "a");
    homeB = join(root, "home", "b");
    repo = await prepareFixtureRepo("vitest-app", { root: join(root, "repos") });
    base = repo.head();
    plugins.push(await createE2EPlugin({ directory: repo.dir, home: homeA, verify: {} }));
  }, 600_000);

  afterAll(async () => {
    for (const p of plugins.reverse()) {
      await p.dispose().catch((e: unknown) => process.stderr.write(`[deferred-e2e] dispose failed: ${String(e)}\n`));
    }
    for (const [k, v] of savedTmp) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // FixtureRepo.dispose unlinks a node_modules junction before removing the tree.
    if (repo !== undefined) await repo.dispose();
    if (root !== "") await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }, 120_000);

  it("3.1.2.f: 20 parallel deferred delegations spawn no runner and take no slot", async () => {
    await reset();
    const plugin = plugins[0];
    const sampler = startRealSampler(100);
    let snapshots: Snapshot[] = [];
    let results: E2ETaskResult[] = [];
    try {
      results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          plugin.task({
            sessionID: "orch-f",
            callID: `f-${i + 1}`,
            prompt: `Tidy module ${mod(i + 1)} without changing behaviour.\n${acceptance(r().testCommand)}`,
            description: `tidy ${mod(i + 1)}`,
            produce: () => neutralEdit(mod(i + 1), `f${i + 1}`),
          }),
        ),
      );
      await sleep(1000);
    } finally {
      snapshots = await sampler.stop();
    }

    const handles = results.map(handleOf);
    for (const [i, res] of results.entries()) expect(handles[i], res.output).toBeDefined();
    fHandles = handles as string[];
    expect(new Set(fHandles).size).toBe(20);

    const selfSnaps = snapshots.filter(s => s.procs.some(p => p.pid === process.pid));
    const runners = seen(snapshots, process.pid, [sampler.pid], isRunner);
    const broad = seen(snapshots, process.pid, [sampler.pid], looksLikeRunner);
    const gaps = snapshots.slice(1).map((s, i) => s.t - snapshots[i].t);
    const locks = await slotLocks();
    const before = results.map(x => x.beforeMs);
    const after = results.map(x => x.afterMs);
    console.log(
      `[3.1.2.f] dispatches=20 capture wait (beforeMs) ${stats(before)} | after-hook (afterMs) ${stats(after)}\n` +
        `[3.1.2.f] sampler snapshots=${snapshots.length} withSelf=${selfSnaps.length} interval ${gaps.length > 0 ? stats(gaps) : "n/a"}\n` +
        `[3.1.2.f] runner processes seen (repo predicate)=${runners.length} broad=${broad.length} ${broad.map(p => `${p.pid}:${p.args}`).join(" | ")}\n` +
        `[3.1.2.f] slot dir exists=${existsSync(slotDir)} lock files=${locks.length}`,
    );

    // Non-vacuous: the sampler saw this process in enough snapshots.
    expect(selfSnaps.length).toBeGreaterThanOrEqual(5);
    expect(runners.map(p => p.args)).toEqual([]);
    expect(broad.map(p => p.args)).toEqual([]);
    expect(locks).toEqual([]);
    for (const x of before) expect(x).toBeLessThanOrEqual(VERIFY_WAIT_DEFAULT_MS);
    // QA-2.4-11: the plan said "within 50 ms"; the implementation bounds the deferred finish at
    // DEFERRED_FINISH_MS = 2 s (src/verify/wiring.ts), a documented deviation.
    for (const x of after) expect(x).toBeLessThanOrEqual(DEFERRED_AFTER_BOUND_MS);
  }, TEST_TIMEOUT_MS);

  it("3.1.2.h (background: false): 3 s later still no runner, and the 20 handles stay listed as unverified", async () => {
    // With the default `background: false`, the 3.1.2.f run above already proved nothing runs while
    // the dispatches happen; this keeps watching afterwards.
    expect(fHandles.length).toBe(20);
    const sampler = startRealSampler(100);
    let snapshots: Snapshot[] = [];
    try {
      await sleep(3000);
    } finally {
      snapshots = await sampler.stop();
    }
    const selfSnaps = snapshots.filter(s => s.procs.some(p => p.pid === process.pid));
    const runners = seen(snapshots, process.pid, [sampler.pid], isRunner);
    const broad = seen(snapshots, process.pid, [sampler.pid], looksLikeRunner);
    console.log(`[3.1.2.h/bg-off] snapshots=${snapshots.length} withSelf=${selfSnaps.length} runners=${runners.length} broad=${broad.length}`);
    expect(selfSnaps.length).toBeGreaterThanOrEqual(5);
    expect(runners.map(p => p.args)).toEqual([]);
    expect(broad.map(p => p.args)).toEqual([]);
    expect(await slotLocks()).toEqual([]);

    const system = (await plugins[0].systemPrompt("orch-f")).join("\n");
    expect(system).toContain(PENDING_HEADER);
    const listed = fHandles.filter(h => system.includes(h));
    // The list shows the 5 newest and summarises the rest.
    expect(listed.length).toBe(5);
    expect(system).toContain("- ... and 15 more");
    expect(system).not.toContain(LATE_NOTICE_MARK);
  }, TEST_TIMEOUT_MS);

  it("3.1.2.g: VERIFY_WAIT:0s returns from the before hook quickly", async () => {
    const plugin = plugins[0];
    await reset();
    const plain = await plugin.task({
      sessionID: "orch-g-wait",
      callID: "g-wait-default",
      prompt: `Tidy module ${mod(3)}.\n${acceptance(r().testCommand)}`,
      description: "tidy m03 (default wait)",
      // A real producer takes time; editing instantly can race the background capture (see report).
      produce: async () => {
        await sleep(1500);
        await neutralEdit(mod(3), "g-default");
      },
    });
    await reset();
    const zero = await plugin.task({
      sessionID: "orch-g-wait0",
      callID: "g-wait-zero",
      prompt: `VERIFY_WAIT:0s\nTidy module ${mod(4)}.\n${acceptance(r().testCommand)}`,
      description: "tidy m04 (wait 0)",
      produce: async () => {
        await sleep(1500);
        await neutralEdit(mod(4), "g-zero");
      },
    });
    console.log(
      `[3.1.2.g] beforeMs default=${plain.beforeMs.toFixed(0)}ms VERIFY_WAIT:0s=${zero.beforeMs.toFixed(0)}ms; ` +
        `afterMs default=${plain.afterMs.toFixed(0)}ms 0s=${zero.afterMs.toFixed(0)}ms`,
    );
    expect(handleOf(plain), plain.output).toBeDefined();
    expect(handleOf(zero), zero.output).toBeDefined();
    expect(zero.beforeMs).toBeLessThanOrEqual(300);
    expect(zero.beforeMs).toBeLessThanOrEqual(plain.beforeMs);
  }, TEST_TIMEOUT_MS);

  it("3.1.2.g: VERIFY:required blocks until a verdict (introduced failure -> NOT ACCEPTED, no handle)", async () => {
    const plugin = plugins[0];
    await reset();
    const res = await plugin.task({
      sessionID: "orch-g-req",
      callID: "g-required",
      prompt: `VERIFY:required\nAdjust ${mod(20)}.\n${acceptance(r().testCommand)}`,
      description: "adjust m20 (required)",
      produce: () => breakModule(mod(20), "return x + 20;", "return x + 2000;"),
    });
    console.log(`[3.1.2.g/required] beforeMs=${res.beforeMs.toFixed(0)}ms afterMs=${res.afterMs.toFixed(0)}ms\n${res.output}`);
    expect(res.output).toContain("NOT ACCEPTED");
    expect(res.output).not.toContain("vrf_");
  }, TEST_TIMEOUT_MS);

  it("3.1.2.g: an edit after the producer returned is reported as drift, not a pass", async () => {
    const plugin = plugins[0];
    await reset();
    const res = await plugin.task({
      sessionID: "orch-g-drift",
      callID: "g-drift",
      prompt: `Tidy module ${mod(5)}.\n${acceptance(r().testCommand)}`,
      description: "tidy m05 (drift)",
      produce: () => neutralEdit(mod(5), "g-drift-1"),
    });
    const h = handleOf(res);
    expect(h, res.output).toBeDefined();
    await neutralEdit(mod(5), "g-drift-2");
    const report = await plugin.routerVerify({ handles: [h as string] }, { sessionID: "orch-g-drift" });
    console.log(`[3.1.2.g/drift] report:\n${report}`);
    expect(report).toContain(DRIFT_NOTICE);
    const line = report.split("\n").find(l => l.includes(h as string)) ?? "";
    // Not a pass: drift downgrades the verdict (to unverifiable, or fail if tests broke). Under the
    // default strictUnverifiable=false an unverifiable verdict still carries the "accepted" suffix
    // with a NOT-verified caveat (QA-2.2-17), so the outcome word is what is asserted.
    expect(line).not.toMatch(/\u00b7 pass\b/);
    expect(line).toMatch(/\u00b7 (unverifiable|fail)\b/);
  }, TEST_TIMEOUT_MS);

  it("3.1.2.h: background: true reports an introduced failure once, as a late notice", async () => {
    await reset();
    const plugin = await createE2EPlugin({ directory: r().dir, home: homeB, verify: { background: true } });
    plugins.push(plugin);
    const sampler = startRealSampler(200);
    let snapshots: Snapshot[] = [];
    let notice = "";
    let h = "";
    const t0 = Date.now();
    try {
      const res = await plugin.task({
        sessionID: "orch-h-bg",
        callID: "h-bg",
        prompt: `Adjust ${mod(19)}.\n${acceptance(r().testCommand)}`,
        description: "adjust m19 (background)",
        produce: () => breakModule(mod(19), "return x + 19;", "return x + 1900;"),
      });
      h = handleOf(res) ?? "";
      expect(h, res.output).not.toBe("");
      console.log(`[3.1.2.h/bg-on] beforeMs=${res.beforeMs.toFixed(0)}ms afterMs=${res.afterMs.toFixed(0)}ms handle=${h}`);
      while (Date.now() - t0 < 90_000) {
        const system = (await plugin.systemPrompt("orch-h-bg")).join("\n");
        if (system.includes(LATE_NOTICE_MARK)) {
          notice = system;
          break;
        }
        await sleep(500);
      }
    } finally {
      snapshots = await sampler.stop();
    }
    const runners = seen(snapshots, process.pid, [sampler.pid], isRunner);
    const broad = seen(snapshots, process.pid, [sampler.pid], looksLikeRunner);
    console.log(
      `[3.1.2.h/bg-on] late notice after ${Date.now() - t0}ms; runners seen (repo predicate)=${runners.length} broad=${broad.length}\n` +
        `${broad.map(p => `  ${p.pid} prio=${String(p.priority)}: ${p.args}`).join("\n")}\n${notice}`,
    );
    const header = "[router] Background verification found introduced failures:";
    expect(notice).toContain(header);
    // The pending list also names the handle; the late-notice entry is the one after its header.
    const block = notice.slice(notice.indexOf(header));
    const entry = block.split("\n").find(l => l.startsWith(`- ${h}`)) ?? "";
    expect(entry).toContain("failing:");
    expect(entry).toMatch(/m19/);
    const again = (await plugin.systemPrompt("orch-h-bg")).join("\n");
    expect(again).not.toContain(LATE_NOTICE_MARK);
  }, TEST_TIMEOUT_MS);
});
