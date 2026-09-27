/**
 * 2.2.3.b: the S5 batch coordinator behind the real verification wiring.
 *
 * Five testsPass gates run concurrently through createVerificationWiring -> buildGateDeps ->
 * accept, over a real vitest-shaped project on disk (the real planner, scope opener, readResult
 * and judge). Only the process seams are fake: runArgv writes the vitest JSON report the spec asks
 * for, and acquireSlot counts holds. Each scenario runs twice, batched (batchWindowMs > 0) and
 * alone (batchWindowMs: 0), and the verdicts must be equal (B-G1), with the spawn counts of B13.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createVerificationWiring, type PreparedVerification, type VerificationWiring } from "../../src/verify/wiring";
import { createDeadline } from "../../src/verify/deterministic";
import { accept, type GateResult } from "../../src/verify/gate";
import { BATCH_REASONS } from "../../src/verify/batch";
import type { RouterConfig } from "../../src/router/config";
import type { DoD } from "../../src/verify/dod";
import type { TreeSnapshot } from "../../src/verify/dispatch";
import type { DispatchReference } from "../../src/verify/reference";
import type { ReferenceState } from "../../src/verify/types";

type ExecOpts = { cwd?: string; timeoutMs?: number; signal?: AbortSignal; lowPriority?: boolean; env?: Record<string, string | undefined> };
type ExecOut = { code: number; stdout: string; stderr: string; timedOut: boolean };

const state = vi.hoisted(() => ({
  root: "",
  /** Test file letter -> failing test names ("c" -> ["t2"] makes test/c.test.ts > t2 fail). */
  failing: {} as Record<string, string[]>,
  /** Every scoped test run (non-git argv spawn): its inputs, and how many slot holds were live. */
  runs: [] as { inputs: string[]; holds: number }[],
  git: 0,
  shells: [] as string[],
  acquires: 0,
  releases: 0,
  holds: 0,
  maxHolds: 0,
  /** The currentTree each materialize call received (QA-2.2-8). */
  materialized: [] as unknown[],
}));

vi.mock("../../src/verify/exec", () => ({
  runShell: async (command: string): Promise<ExecOut> => {
    state.shells.push(command);
    return { code: 0, stdout: " Tests  2 passed (2)\n", stderr: "", timedOut: false };
  },
  runArgv: async (file: string, args: readonly string[], _opts?: ExecOpts): Promise<ExecOut> => {
    if (file === "git") {
      state.git++;
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    return fakeVitest(args);
  },
}));

vi.mock("../../src/verify/slot", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/verify/slot")>()),
  acquireSlot: async (opts: { signal?: AbortSignal }) => {
    if (opts.signal?.aborted) return { busy: true as const };
    state.acquires++;
    state.holds++;
    state.maxHolds = Math.max(state.maxHolds, state.holds);
    let released = false;
    return {
      lost: false,
      release: async () => {
        if (released) return;
        released = true;
        state.holds--;
        state.releases++;
      },
    };
  },
}));

vi.mock("../../src/verify/reference", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/verify/reference")>()),
  gcStaleReferences: async () => ({ removed: [], kept: [], failed: [] }),
  materialize: async (_ref: unknown, currentTree: unknown) => {
    state.materialized.push(currentTree);
    return { ok: false as const, reason: "worktree-add-failed" as const, detail: "test seam: no worktree" };
  },
}));

/** A vitest `related` run over the fake project: each source relates to its own test file only. */
function fakeVitest(args: readonly string[]): ExecOut {
  const report = args.find(a => a.startsWith("--outputFile="))?.slice("--outputFile=".length);
  const inputs = args.filter(a => isAbsolute(a) && a.startsWith(state.root) && !a.includes("node_modules"));
  state.runs.push({ inputs: [...inputs].sort(), holds: state.holds });
  const letters = [...new Set(inputs.map(a => /[\\/]([a-z])(?:\.test)?\.ts$/.exec(a)?.[1]).filter((x): x is string => x !== undefined))].sort();
  const testResults = letters.map(x => {
    const failing = state.failing[x] ?? [];
    return {
      name: join(state.root, "test", `${x}.test.ts`),
      status: failing.length > 0 ? "failed" : "passed",
      assertionResults: ["t1", "t2"].map(title => ({ title, ancestorTitles: [], status: failing.includes(title) ? "failed" : "passed" })),
    };
  });
  const total = testResults.reduce((n, s) => n + s.assertionResults.length, 0);
  if (report !== undefined) writeFileSync(report, JSON.stringify({ numTotalTests: total, numRuntimeErrorTestSuites: 0, testResults }));
  return { code: testResults.some(s => s.status === "failed") ? 1 : 0, stdout: "", stderr: "", timedOut: false };
}

const LETTERS = ["a", "b", "c", "d", "e"];
const DOD: DoD = { kind: "deterministic", source: "explicit", criteria: [], deliverable: null, checks: [{ kind: "testsPass", command: "npm test" }] };
const NONE: ReferenceState = { kind: "none", reason: "no reference captured" };
/** Long enough that only the size cap (5) closes the window: all five gates meet in one batch. */
const WINDOW_MS = 60_000;

function config(verify: NonNullable<NonNullable<RouterConfig["enforcement"]>["verify"]>): RouterConfig {
  return { activePreset: "a", presets: { a: { medium: { model: "p/m" } } }, defaultTier: "medium", rules: [], enforcement: { verify } };
}

function wiringWith(verify: NonNullable<NonNullable<RouterConfig["enforcement"]>["verify"]>, batch: Parameters<typeof createVerificationWiring>[0]["batch"] = {}): VerificationWiring {
  const cfg = config(verify);
  return createVerificationWiring({ client: {}, directory: state.root, getConfig: () => cfg, logger: { warn: () => {} }, batch: { maxBatchSize: 5, ...batch } });
}

function tree(x: string): TreeSnapshot {
  return { cwd: state.root, root: state.root, head: "a".repeat(40), fingerprint: `tree-${x}`, dirty: true, files: [] };
}

interface GateOptions {
  readonly reference?: ReferenceState;
  readonly snapshot?: TreeSnapshot;
  /** Called when this gate's verdict is in (QA-2.2-5: whether the batch still holds the slot). */
  readonly onSettled?: () => void;
}

/** One gate, as index.ts runs it: a gate deadline, buildGateDeps with the prepared inputs, accept. */
async function gate(wiring: VerificationWiring, x: string, o: GateOptions = {}): Promise<GateResult> {
  const prepared: PreparedVerification = {
    changedFiles: [{ path: join(state.root, "src", `${x}.ts`), status: " M" }],
    changeBaseline: "available",
    reference: o.reference ?? NONE,
    snapshot: o.snapshot,
  };
  const deadline = createDeadline(120_000);
  try {
    const deps = wiring.buildGateDeps(undefined, undefined, prepared, deadline);
    const r = await accept({ dod: DOD }, { ...prepared, finalReturnText: "done", declaredOutputs: [], producerSessionID: `p-${x}`, producerTier: "medium" }, deps);
    o.onSettled?.();
    return r;
  } finally {
    deadline.dispose();
  }
}

/** What B12 compares: acceptance, outcome, the failure classification and the reasons. */
function verdictOf(r: GateResult) {
  return { accepted: r.accepted, outcome: r.verdict.outcome, failures: r.verdict.failures, reasons: r.verdict.reasons };
}

function resetCounters(): void {
  Object.assign(state, { runs: [], git: 0, shells: [], acquires: 0, releases: 0, holds: 0, maxHolds: 0, materialized: [] });
}

/** Five gates at once (batched), then the same five with batchWindowMs: 0 (alone). */
async function batchedAndAlone(options: (x: string) => GateOptions = () => ({}), verify: Parameters<typeof wiringWith>[0] = {}) {
  resetCounters();
  const batchedWiring = wiringWith({ ...verify, batchWindowMs: WINDOW_MS });
  const batched = await Promise.all(LETTERS.map(x => gate(batchedWiring, x, options(x))));
  await batchedWiring.disposeVerification();
  const b = { runs: state.runs, acquires: state.acquires, releases: state.releases, maxHolds: state.maxHolds, materialized: state.materialized, shells: state.shells };

  resetCounters();
  const aloneWiring = wiringWith({ ...verify, batchWindowMs: 0 });
  const alone = await Promise.all(LETTERS.map(x => gate(aloneWiring, x, options(x))));
  await aloneWiring.disposeVerification();
  const a = { runs: state.runs, acquires: state.acquires, releases: state.releases, maxHolds: state.maxHolds, materialized: state.materialized, shells: state.shells };
  return { batched, alone, b, a };
}

beforeEach(() => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-batch-wiring-")));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  mkdirSync(join(root, "node_modules", "vitest"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "batch-wiring", scripts: { test: "vitest run" }, devDependencies: { vitest: "3.0.0" } }));
  writeFileSync(join(root, "node_modules", "vitest", "package.json"), JSON.stringify({ name: "vitest", version: "3.0.0", bin: { vitest: "vitest.mjs" } }));
  writeFileSync(join(root, "node_modules", "vitest", "vitest.mjs"), "");
  for (const x of LETTERS) {
    writeFileSync(join(root, "src", `${x}.ts`), `export const ${x} = 1;\n`);
    writeFileSync(join(root, "test", `${x}.test.ts`), `import { ${x} } from "../src/${x}";\n`);
  }
  state.root = root;
  state.failing = {};
  resetCounters();
});

afterEach(() => {
  rmSync(state.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("batch coordinator behind the verification wiring (2.2.3)", () => {
  it("green: 5 concurrent gates spawn 1 union run under 1 slot hold; the verdicts equal batchWindowMs: 0", async () => {
    const { batched, alone, b, a } = await batchedAndAlone();
    // B13 green path, P1 present, no test file among the inputs: exactly one scoped run.
    expect(b.runs).toHaveLength(1);
    expect(b.runs[0]?.inputs).toEqual(LETTERS.map(x => join(state.root, "src", `${x}.ts`)).sort());
    expect(b.acquires).toBe(1);
    expect(b.releases).toBe(1);
    expect(b.maxHolds).toBe(1);
    // Alone: the direct hook, one run and one hold per gate.
    expect(a.runs.map(r => r.inputs)).toEqual(expect.arrayContaining(LETTERS.map(x => [join(state.root, "src", `${x}.ts`)])));
    expect(a.runs).toHaveLength(5);
    expect(a.acquires).toBe(5);
    expect(batched.map(r => r.verdict.outcome)).toEqual(LETTERS.map(() => "pass"));
    expect(batched.map(verdictOf)).toEqual(alone.map(verdictOf));
  });

  it("failing vitest path (mode B): 1 + 5 runs under 1 hold; only the failing test's producer is not a pass, as alone", async () => {
    state.failing = { c: ["t2"] };
    const { batched, alone, b, a } = await batchedAndAlone();
    // Deviation D2: the union, then each member's own spec, all under the batch's single hold.
    expect(b.runs).toHaveLength(1 + 5);
    expect(b.runs.every(r => r.holds === 1)).toBe(true);
    expect(b.acquires).toBe(1);
    expect(b.maxHolds).toBe(1);
    expect(a.runs).toHaveLength(5);
    expect(batched.map(r => r.verdict.outcome)).toEqual(["pass", "pass", "unverifiable", "pass", "pass"]);
    expect(batched[2]?.verdict.reasons.join(" ")).toContain("test/c.test.ts > t2");
    expect(batched.map(verdictOf)).toEqual(alone.map(verdictOf));
  });

  it("QA-2.2-5: a member settles while its batch still holds the slot for the others' own runs", async () => {
    state.failing = { c: ["t2"] };
    const holdsAtSettle: number[] = [];
    const wiring = wiringWith({ batchWindowMs: WINDOW_MS });
    await Promise.all(LETTERS.map(x => gate(wiring, x, { onSettled: () => holdsAtSettle.push(state.holds) })));
    await wiring.disposeVerification();
    // Settled early: the batch's hold was still live for at least one gate's verdict ...
    expect(holdsAtSettle.some(h => h === 1)).toBe(true);
    // ... and it is released exactly once, after the last run (B10: an accepted cost, never a deadlock).
    expect(state.releases).toBe(1);
    expect(state.holds).toBe(0);
  });

  it("QA-2.2-8: each batched recheck receives its own gate's tree snapshot, as the direct hook does", async () => {
    state.failing = { c: ["t2"], d: ["t1"] };
    // Two distinct references: one recheck per member (B8.4), each with its own gate's tree.
    const ref = (commit: string): ReferenceState => ({
      kind: "captured",
      reference: { root: state.root, head: "a".repeat(40), commit, untracked: new Map(), tracked: new Map(), captureReasons: [], capturedAt: 0 } satisfies DispatchReference,
    });
    const refs: Record<string, ReferenceState> = { c: ref("c".repeat(40)), d: ref("d".repeat(40)) };
    const trees = Object.fromEntries(LETTERS.map(x => [x, tree(x)]));
    const { batched, alone, b, a } = await batchedAndAlone(x => ({ reference: refs[x] ?? NONE, snapshot: trees[x] }));
    expect(b.materialized).toHaveLength(2);
    expect(new Set(b.materialized)).toEqual(new Set([trees.c, trees.d]));
    expect(new Set(a.materialized)).toEqual(new Set([trees.c, trees.d]));
    expect(b.acquires).toBe(1);
    expect(batched.map(r => r.verdict.outcome)).toEqual(["pass", "pass", "unverifiable", "unverifiable", "pass"]);
    expect(batched.map(verdictOf)).toEqual(alone.map(verdictOf));
  });

  it("a shared reference: the failing members' recheck is one shared recheck, with the first member's tree", async () => {
    state.failing = { c: ["t2"], d: ["t1"] };
    const shared: ReferenceState = {
      kind: "captured",
      reference: { root: state.root, head: "a".repeat(40), commit: "b".repeat(40), untracked: new Map(), tracked: new Map(), captureReasons: [], capturedAt: 0 },
    };
    const trees = Object.fromEntries(LETTERS.map(x => [x, tree(x)]));
    const { batched, alone, b, a } = await batchedAndAlone(x => ({ reference: shared, snapshot: trees[x] }));
    // B13: 1 + n runs, and <= 1 recheck for the distinct reference; alone, one recheck per failing gate.
    expect(b.runs).toHaveLength(1 + 5);
    expect(b.materialized).toHaveLength(1);
    expect([trees.c, trees.d]).toContain(b.materialized[0]);
    expect(a.materialized).toHaveLength(2);
    expect(batched.map(verdictOf)).toEqual(alone.map(verdictOf));
  });

  it("testScope full bypasses the window: the direct hook runs the command as written, once per gate", async () => {
    const { batched, alone, b, a } = await batchedAndAlone(() => ({}), { testScope: "full" });
    expect(b.runs).toHaveLength(0);
    expect(b.shells).toEqual(LETTERS.map(() => "npm test"));
    expect(b.acquires).toBe(5);
    expect(a.shells).toHaveLength(5);
    expect(batched.map(verdictOf)).toEqual(alone.map(verdictOf));
  });

  it("dispose settles a gate waiting in its window, and later gates, with nothing spawned; sweep evicts nothing live", async () => {
    // A recording timer seam: the window's one timer is armed when the first member joins (W1).
    const windows: unknown[] = [];
    const wiring = wiringWith({ batchWindowMs: WINDOW_MS }, {
      timers: {
        setTimeout: (callback: () => void, ms: number) => {
          const handle = setTimeout(callback, ms);
          windows.push(handle);
          return handle;
        },
        clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
    });
    const waiting = gate(wiring, "a");
    await vi.waitFor(() => expect(windows).toHaveLength(1));
    // The window is open (it needs 5 members or 60 s) and has a live member: nothing to evict.
    expect(wiring.sweepVerification()).toBe(0);
    await wiring.disposeVerification();
    const first = await waiting;
    const later = await gate(wiring, "b");
    for (const r of [first, later]) {
      expect(r.verdict.outcome).toBe("unverifiable");
      expect(r.verdict.reasons.join(" ")).toContain(BATCH_REASONS.disposed);
    }
    expect(state.runs).toHaveLength(0);
    expect(state.acquires).toBe(0);
    // Idempotent.
    await expect(wiring.disposeVerification()).resolves.toBeUndefined();
  });
});
