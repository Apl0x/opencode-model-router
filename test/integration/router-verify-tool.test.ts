/**
 * test/integration/router-verify-tool.test.ts
 *
 * Phase 2.4.3 (plan Phase 2.4, section 1.5-18; pending.ts R2, R4, R6, R8, R11): router_verify.
 *
 * - "verifyHandles (2.4.3a)" drives the wiring directly.
 * - "the router_verify tool (2.4.3b)" drives the plugin's registered tool.
 *
 * The project is a real vitest-shaped directory on disk, so the real planner, scope opener, batch
 * coordinator, readResult and judge run (as in batch-wiring.test.ts). Only the process seams are
 * fake: runArgv writes the vitest JSON report the spec asks for, acquireSlot counts holds, the tree
 * snapshot is fixed, and materialize returns an exact reference over a copy of the project.
 * Pending entries are registered directly with the shape 2.4.2's finishDeferred registers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache } from "../../src/router/config";
import {
  createVerificationWiring,
  digestFiles,
  DRIFT_NOTICE,
  DRIFT_UNCHECKED_NOTICE,
  isRetryableVerdict,
  parseRouterVerifyArgs,
  ROUTER_VERIFY_ARGS_TEXT,
  ROUTER_VERIFY_NO_PENDING_TEXT,
  ROUTER_VERIFY_NO_RETRY_TEXT,
  type HandleReport,
  type VerificationWiring,
} from "../../src/verify/wiring";
import {
  EXPIRED_HANDLE_TEXT,
  MAX_HANDLES_PER_CALL,
  UNKNOWN_HANDLE_TEXT,
  type PendingRegistration,
  type PendingRegistry,
} from "../../src/verify/pending";
import type { RouterConfig } from "../../src/router/config";
import type { DoD } from "../../src/verify/dod";
import type { TreeSnapshot } from "../../src/verify/dispatch";
import type { DispatchReference } from "../../src/verify/reference";
import type { ReferenceState, Verdict } from "../../src/verify/types";

type ExecOut = { code: number; stdout: string; stderr: string; timedOut: boolean };

const state = vi.hoisted(() => ({
  root: "",
  /** Test file letter -> failing test names now. */
  failing: {} as Record<string, string[]>,
  /** The same at the exact reference (a failure listed here is pre-existing). */
  failingAtRef: {} as Record<string, string[]>,
  /** Every scoped test run (non-git argv spawn): its inputs and the live slot holds. */
  runs: [] as { inputs: string[]; holds: number }[],
  git: 0,
  shells: 0,
  acquires: 0,
  releases: 0,
  holds: 0,
  maxHolds: 0,
  snapshots: 0,
  deadlines: 0,
  /** acquireSlot answers busy while set. */
  slotBusy: false,
  /** When set, materialize returns an exact reference over this copy of the project. */
  refRoot: "",
  /** Called after each planScopedRun with the planned changed paths: a barrier or a hold. */
  planGate: undefined as undefined | ((changed: readonly string[]) => Promise<void> | undefined),
}));

vi.mock("../../src/verify/exec", () => ({
  runShell: async (): Promise<ExecOut> => {
    state.shells++;
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  },
  runArgv: async (file: string, args: readonly string[]): Promise<ExecOut> => {
    if (file === "git") {
      state.git++;
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    return await fakeVitest(args);
  },
}));

vi.mock("../../src/verify/tree", () => ({
  snapshotTree: async (): Promise<TreeSnapshot> => {
    state.snapshots++;
    return { cwd: state.root, root: state.root, head: "a".repeat(40), fingerprint: "now", dirty: true, files: [] };
  },
}));

vi.mock("../../src/verify/deterministic", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/deterministic")>();
  return {
    ...actual,
    createDeadline: (...args: Parameters<typeof actual.createDeadline>) => {
      state.deadlines++;
      return actual.createDeadline(...args);
    },
  };
});

vi.mock("../../src/verify/runner", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/runner")>();
  return {
    ...actual,
    planScopedRun: async (...args: Parameters<typeof actual.planScopedRun>) => {
      const plan = await actual.planScopedRun(...args);
      const changed = args[0].changedFiles;
      await state.planGate?.(changed === "unavailable" ? [] : changed.map(c => c.path));
      return plan;
    },
  };
});

vi.mock("../../src/verify/slot", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/verify/slot")>()),
  acquireSlot: async (opts: { signal?: AbortSignal }) => {
    if (opts.signal?.aborted === true || state.slotBusy) return { busy: true as const };
    state.acquires++;
    state.holds++;
    state.maxHolds = Math.max(state.maxHolds, state.holds);
    let released = false;
    return {
      lost: false,
      release: async () => {
        if (released) return;
        released = true;
        state.releases++;
        state.holds--;
      },
    };
  },
}));

// The plugin's own wiring instance, so the tool tests can register pending entries in it.
const plugin = vi.hoisted(() => ({ wiring: undefined as import("../../src/verify/wiring").VerificationWiring | undefined }));
vi.mock("../../src/verify/wiring", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/wiring")>();
  return {
    ...actual,
    createVerificationWiring: (...args: Parameters<typeof actual.createVerificationWiring>) => {
      const wiring = actual.createVerificationWiring(...args);
      plugin.wiring = wiring;
      return wiring;
    },
  };
});

vi.mock("../../src/verify/reference", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/verify/reference")>()),
  gcStaleReferences: async () => ({ removed: [], kept: [], failed: [] }),
  materialize: async () => {
    const dir = state.refRoot;
    if (dir === "") return { ok: false as const, reason: "worktree-add-failed" as const, detail: "test seam: no worktree" };
    return {
      ok: true as const,
      reference: {
        dir,
        exact: true,
        inexactReasons: [],
        unreproduced: [],
        links: [],
        toRefPath: (livePath: string) => {
          const rel = relative(state.root, livePath);
          return rel.startsWith("..") || isAbsolute(rel) ? undefined : join(dir, rel);
        },
        dispose: async () => {},
      },
    };
  },
}));

/** A vitest run over the fake project (or its reference copy): each source relates to its own test file. */
async function fakeVitest(args: readonly string[]): Promise<ExecOut> {
  const atRef = state.refRoot !== "" && args.some(a => a.startsWith(state.refRoot));
  const root = atRef ? state.refRoot : state.root;
  const failingNow = atRef ? state.failingAtRef : state.failing;
  const report = args.find(a => a.startsWith("--outputFile="))?.slice("--outputFile=".length);
  const inputs = args.filter(a => isAbsolute(a) && a.startsWith(root) && !a.includes("node_modules"));
  state.runs.push({ inputs: [...inputs].sort(), holds: state.holds });
  const letters = [...new Set(inputs.map(a => /[\\/]([a-z])(?:\.test)?\.ts$/.exec(a)?.[1]).filter((x): x is string => x !== undefined))].sort();
  const testResults = letters.map(x => {
    const failing = failingNow[x] ?? [];
    return {
      name: join(root, "test", `${x}.test.ts`),
      status: failing.length > 0 ? "failed" : "passed",
      assertionResults: ["t1", "t2"].map(title => ({ title, ancestorTitles: [], status: failing.includes(title) ? "failed" : "passed" })),
    };
  });
  const total = testResults.reduce((n, s) => n + s.assertionResults.length, 0);
  if (report !== undefined) writeFileSync(report, JSON.stringify({ numTotalTests: total, numRuntimeErrorTestSuites: 0, testResults }));
  return { code: testResults.some(s => s.status === "failed") ? 1 : 0, stdout: "", stderr: "", timedOut: false };
}

const FILES = ["a", "b", "c", "d", "e"];
const DOD: DoD = { kind: "deterministic", source: "explicit", criteria: [], deliverable: null, checks: [{ kind: "testsPass", command: "npm test" }] };
const NONE: ReferenceState = { kind: "none", reason: "no reference captured" };

function config(verify: NonNullable<NonNullable<RouterConfig["enforcement"]>["verify"]> = {}): RouterConfig {
  return { activePreset: "a", presets: { a: { medium: { model: "p/m" } } }, defaultTier: "medium", rules: [], enforcement: { verify } };
}

function captured(): ReferenceState {
  return {
    kind: "captured",
    reference: { root: state.root, head: "a".repeat(40), commit: "b".repeat(40), untracked: new Map(), tracked: new Map(), captureReasons: [], capturedAt: 0 } satisfies DispatchReference,
  };
}

/** Makes state.refRoot a copy of the project: materialize then returns an exact reference. */
function exactReference(): void {
  const refRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-rv-ref-")));
  cpSync(state.root, refRoot, { recursive: true });
  state.refRoot = refRoot;
}

const src = (x: string): string => join(state.root, "src", `${x}.ts`);

/** What 2.4.2's finishDeferred registers for a deferred producer that changed src/<x>.ts. */
async function register(pending: PendingRegistry, x: string, over: Partial<PendingRegistration> = {}): Promise<string> {
  const digests = await digestFiles([src(x)]);
  const r = pending.register({
    orchestratorSessionID: "orch",
    dispatchID: `task:orch:${x}`,
    producerSessionID: `child-${x}`,
    producerTier: "fast",
    description: `work ${x}`,
    cwd: state.root,
    root: state.root,
    dispatchedAt: Date.now(),
    dod: DOD,
    reference: Promise.resolve(captured()),
    changedFiles: [{ path: src(x), status: " M" }],
    risk: { level: "low", reasons: [] },
    digests: Promise.resolve(digests),
    ...over,
  });
  if (!r.ok) throw new Error(r.detail);
  return r.handle;
}

function makeWiring(
  verify: NonNullable<NonNullable<RouterConfig["enforcement"]>["verify"]> = {},
  pendingSeams: Parameters<typeof createVerificationWiring>[0]["pending"] = undefined,
) {
  const cfg = config(verify);
  const client = { session: { create: vi.fn(async () => ({ data: { id: "never" } })), abort: vi.fn(async () => ({})), delete: vi.fn(async () => ({})) } };
  const wiring = createVerificationWiring({
    client,
    directory: state.root,
    getConfig: () => cfg,
    logger: { warn: () => {} },
    batch: { maxBatchSize: 5 },
    ...(pendingSeams !== undefined ? { pending: pendingSeams } : {}),
  });
  return { wiring, client, cfg };
}

function resetCounters(): void {
  Object.assign(state, { runs: [], git: 0, shells: 0, acquires: 0, releases: 0, holds: 0, maxHolds: 0, snapshots: 0, deadlines: 0, planGate: undefined });
}

/** Holds each planScopedRun until `n` are waiting, then releases them together (W7: all in flight). */
function barrier(n: number): void {
  const waiting: (() => void)[] = [];
  state.planGate = () =>
    new Promise<void>(resolve => {
      waiting.push(resolve);
      if (waiting.length < n) return;
      state.planGate = undefined;
      for (const go of waiting) go();
    });
}

/** Holds the planning of src/<x>.ts until the returned function is called. */
function holdPlanning(x: string): () => void {
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  state.planGate = changed => (changed.includes(src(x)) ? held : undefined);
  return release;
}

function verdictOf(item: HandleReport | undefined) {
  if (item?.kind !== "verdict") throw new Error(`expected a verdict, got ${item?.kind}`);
  return item;
}

const inputsOf = (x: string): number => state.runs.filter(r => r.inputs.includes(src(x))).length;

beforeEach(() => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-rv-")));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  mkdirSync(join(root, "node_modules", "vitest"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "router-verify", scripts: { test: "vitest run" }, devDependencies: { vitest: "3.0.0" } }));
  writeFileSync(join(root, "node_modules", "vitest", "package.json"), JSON.stringify({ name: "vitest", version: "3.0.0", bin: { vitest: "vitest.mjs" } }));
  writeFileSync(join(root, "node_modules", "vitest", "vitest.mjs"), "");
  for (const x of FILES) {
    writeFileSync(join(root, "src", `${x}.ts`), `export const ${x} = 1;\n`);
    writeFileSync(join(root, "test", `${x}.test.ts`), `import { ${x} } from "../src/${x}";\n`);
  }
  state.root = root;
  state.failing = {};
  state.failingAtRef = {};
  state.slotBusy = false;
  state.refRoot = "";
  resetCounters();
});

afterEach(() => {
  rmSync(state.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  if (state.refRoot !== "") rmSync(state.refRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("verifyHandles (2.4.3a)", () => {
  describe("pure helpers", () => {
    it("parseRouterVerifyArgs requires exactly one of handles (non-empty) or pending: true", () => {
      expect(parseRouterVerifyArgs({ handles: ["vrf_x"] })).toEqual({ kind: "handles", handles: ["vrf_x"] });
      expect(parseRouterVerifyArgs({ pending: true })).toEqual({ kind: "pending" });
      for (const bad of [{}, { handles: ["vrf_x"], pending: true }, { handles: ["vrf_x"], pending: false }, { pending: false }, { handles: [] }, { handles: "vrf_x" }, null, "x"]) {
        expect(parseRouterVerifyArgs(bad)).toEqual({ error: ROUTER_VERIFY_ARGS_TEXT });
      }
    });

    it("isRetryableVerdict: only a cut or transient unverifiable is retryable; a pass or a fail never", () => {
      const u = (reason: string): Verdict => ({ pass: false, outcome: "unverifiable", method: "deterministic", reasons: [reason], caveats: [reason] });
      expect(isRetryableVerdict(u("verification slot busy (waited 0ms)"), false)).toBe(true);
      expect(isRetryableVerdict(u("testsPass: gate budget exhausted before recheck"), false)).toBe(true);
      expect(isRetryableVerdict(u("testsPass timed out after 120000ms: npm test"), false)).toBe(true);
      expect(isRetryableVerdict(u("testsPass check errored: boom"), false)).toBe(true);
      expect(isRetryableVerdict(u("the capture had not resolved within the gate budget"), false)).toBe(true);
      // Terminal: a property of the delegation, the same on every re-run.
      expect(isRetryableVerdict(u("testsPass: scoping impossible (unsupported-command): x"), false)).toBe(false);
      expect(isRetryableVerdict(u("the dispatch-time capture failed or timed out"), false)).toBe(false);
      expect(isRetryableVerdict(u("testsPass: scoping impossible (unsupported-command): x"), true)).toBe(true);
      expect(isRetryableVerdict({ pass: true, outcome: "pass", method: "deterministic", reasons: [] }, true)).toBe(false);
      expect(isRetryableVerdict({ pass: false, outcome: "fail", method: "deterministic", reasons: ["verification slot busy"] }, true)).toBe(false);
      expect(isRetryableVerdict({ pass: false, method: "none", skipped: true, reasons: ["verification disabled"] }, false)).toBe(true);
    });
  });

  it("pass: judged once, verified; a second call replays the cached verdict and spawns nothing", async () => {
    const { wiring, client } = makeWiring();
    const h = await register(wiring.pending, "a");
    const first = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    const item = verdictOf(first.items[0]);
    expect(item.via).toBe("run");
    expect(item.result.verdict.outcome).toBe("pass");
    expect(item.result.retryable).toBe(false);
    expect(first.text).toContain(`- ${h} \u00b7 work a \u00b7 pass`);
    expect(first.text).toContain("[router \u2713 accepted: deterministic]");
    expect(wiring.pending.get("orch", h)).toMatchObject({ kind: "found", entry: { state: "verified" } });
    expect(inputsOf("a")).toBe(1);
    expect(client.session.create).not.toHaveBeenCalled();

    const counts = { runs: state.runs.length, acquires: state.acquires, git: state.git, snapshots: state.snapshots };
    const again = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    expect(verdictOf(again.items[0]).via).toBe("cached");
    expect(again.text).toContain("(cached verdict; nothing was run)");
    expect({ runs: state.runs.length, acquires: state.acquires, git: state.git, snapshots: state.snapshots }).toEqual(counts);
  });

  it("fail: the forcing note with the next tier, no retry and no session; the rejection feeds lineage", async () => {
    exactReference();
    state.failing = { a: ["t2"] };
    const { wiring, client } = makeWiring();
    const h = await register(wiring.pending, "a");
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    const item = verdictOf(report.items[0]);
    expect(item.result.verdict.outcome).toBe("fail");
    expect(item.result.retryable).toBe(false);
    expect(item.result.nextTier).toBe("medium");
    expect(item.result.introduced?.join(" ")).toContain("t2");
    expect(report.text).toContain(`- ${h} \u00b7 work a \u00b7 fail`);
    expect(report.text).toContain("[router \u26a0 NOT ACCEPTED]");
    expect(report.text).toContain('re-run via `Task(subagent_type="medium")` (escalated from fast)');
    expect(report.text).toContain(ROUTER_VERIFY_NO_RETRY_TEXT);
    // No retry and no escalation: no producer session, one scoped run plus its recheck at most.
    expect(client.session.create).not.toHaveBeenCalled();
    expect(wiring.pending.stats().rejections).toBe(1);
    expect(wiring.pending.get("orch", h)).toMatchObject({ kind: "found", entry: { state: "verified" } });
  });

  it("unverifiable (failures without a reference): terminal, accepted with its caveat by default", async () => {
    state.failing = { a: ["t2"] };
    const { wiring } = makeWiring();
    const h = await register(wiring.pending, "a", { reference: Promise.resolve(NONE) });
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    const item = verdictOf(report.items[0]);
    expect(item.result.verdict.outcome).toBe("unverifiable");
    expect(item.result.retryable).toBe(false);
    expect(report.text).toContain(`- ${h} \u00b7 work a \u00b7 unverifiable`);
    expect(report.text).toContain("[router \u2713 accepted: deterministic]");
    expect(wiring.pending.get("orch", h)).toMatchObject({ kind: "found", entry: { state: "verified" } });
  });

  it("an unattributed change set is unverifiable, never scoped over []", async () => {
    const { wiring } = makeWiring();
    const h = await register(wiring.pending, "a", { changedFiles: "unavailable", digests: undefined });
    const item = verdictOf((await wiring.verifyHandles("orch", { kind: "handles", handles: [h] })).items[0]);
    expect(item.result.verdict.outcome).toBe("unverifiable");
    expect(state.runs).toEqual([]);
  });

  it("drift: a producer file edited after it returned -> the notice, and the pass does not stand", async () => {
    const { wiring } = makeWiring();
    const h = await register(wiring.pending, "a");
    writeFileSync(src("a"), "export const a = 2;\n");
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    const item = verdictOf(report.items[0]);
    expect(item.result.driftedPaths).toEqual([src("a")]);
    expect(item.result.verdict.outcome).toBe("unverifiable");
    expect(item.result.verdict.caveats).toContain(DRIFT_NOTICE);
    expect(report.text).toContain(`[router] ${DRIFT_NOTICE} (changed after the producer returned: ${join("src", "a.ts")})`);
    expect(report.text).not.toContain("\u00b7 work a \u00b7 pass");
  });

  it("drift that cannot be checked (no stored digests) never lets a pass stand either", async () => {
    const { wiring } = makeWiring();
    const h = await register(wiring.pending, "a", { digests: undefined });
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    const item = verdictOf(report.items[0]);
    expect(item.result.verdict.outcome).toBe("unverifiable");
    expect(item.result.verdict.caveats).toContain(DRIFT_UNCHECKED_NOTICE);
    expect(report.text).toContain(`[router] ${DRIFT_UNCHECKED_NOTICE}`);
  });

  it("several handles share one deadline and meet in one window: one union run under one slot hold", async () => {
    const { wiring } = makeWiring();
    const handles = [await register(wiring.pending, "a"), await register(wiring.pending, "b"), await register(wiring.pending, "c")];
    barrier(3);
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles });
    expect(report.items.map(i => verdictOf(i).result.verdict.outcome)).toEqual(["pass", "pass", "pass"]);
    expect(state.deadlines).toBe(1);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]?.inputs).toEqual(["a", "b", "c"].map(src).sort());
    expect(state.acquires).toBe(1);
    expect(state.maxHolds).toBe(1);
  });

  it("two concurrent calls for one handle make one run; the second joins it", async () => {
    const { wiring } = makeWiring();
    const h = await register(wiring.pending, "a");
    const release = holdPlanning("a");
    const first = wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    const second = wiring.verifyHandles("orch", { kind: "handles", handles: [`\`${h.toUpperCase()}\``] });
    expect(wiring.pending.get("orch", h)).toMatchObject({ kind: "found", entry: { state: "verifying" } });
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(verdictOf(a.items[0]).via).toBe("run");
    expect(verdictOf(b.items[0]).via).toBe("joined");
    expect(verdictOf(b.items[0]).result).toBe(verdictOf(a.items[0]).result);
    expect(b.text).toContain("(joined a run already in progress)");
    expect(inputsOf("a")).toBe(1);
  });

  it("a transient result (slot busy) returns the entry to unverified; a later call judges it", async () => {
    const { wiring } = makeWiring();
    const h = await register(wiring.pending, "a");
    state.slotBusy = true;
    const busy = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    const item = verdictOf(busy.items[0]);
    expect(item.result.retryable).toBe(true);
    expect(busy.text).toContain(`- ${h} \u00b7 work a \u00b7 not judged: `);
    expect(busy.text).toContain("verification slot busy");
    expect(busy.text).toContain("still unverified; call `router_verify` again");
    expect(wiring.pending.get("orch", h)).toMatchObject({ kind: "found", entry: { state: "unverified" } });
    state.slotBusy = false;
    const judged = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    expect(verdictOf(judged.items[0]).result.verdict.outcome).toBe("pass");
  });

  it("R11: a later pass on ids an earlier router_verify rejection introduced becomes unverifiable", async () => {
    exactReference();
    state.failing = { a: ["t2"] };
    const { wiring } = makeWiring();
    const rejected = await register(wiring.pending, "a");
    expect(verdictOf((await wiring.verifyHandles("orch", { kind: "handles", handles: [rejected] })).items[0]).result.verdict.outcome).toBe("fail");
    // A re-dispatch whose reference already contains the broken test: pre-existing there.
    state.failingAtRef = { a: ["t2"] };
    const redo = await register(wiring.pending, "a", { dispatchID: "task:orch:redo", producerSessionID: "child-redo" });
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles: [redo] });
    const item = verdictOf(report.items[0]);
    expect(item.result.verdict.outcome).toBe("unverifiable");
    expect(item.result.verdict.caveats?.join(" ")).toContain(`failed after ${rejected} in this session and still fail`);
    expect(item.result.retryable).toBe(false);
  });

  it("scoping (R6): another session, the producer's session and malformed input are all unknown; nothing runs", async () => {
    const { wiring } = makeWiring();
    const h = await register(wiring.pending, "a");
    for (const sid of ["other", "child-a", ""]) {
      const report = await wiring.verifyHandles(sid, { kind: "handles", handles: [h] });
      expect(report.items).toEqual([{ kind: "unknown", input: h }]);
      expect(report.text).toContain(`- ${h} \u00b7 ${UNKNOWN_HANDLE_TEXT}`);
    }
    const malformed = await wiring.verifyHandles("orch", { kind: "handles", handles: ["vrf_nothex", 42] });
    expect(malformed.items.map(i => i.kind)).toEqual(["unknown", "unknown"]);
    expect(state.runs).toEqual([]);
    expect(wiring.pending.get("orch", h)).toMatchObject({ kind: "found", entry: { state: "unverified" } });
    expect(await wiring.verifyHandles("other", { kind: "pending" })).toMatchObject({ items: [], text: ROUTER_VERIFY_NO_PENDING_TEXT });
  });

  it("an expired handle (TTL) gets the expired text in its own session, unknown elsewhere", async () => {
    let clock = 1_000;
    const { wiring } = makeWiring({}, { now: () => clock });
    const h = await register(wiring.pending, "a");
    clock += 3_600_000;
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] });
    expect(report.items).toEqual([{ kind: "expired", handle: h }]);
    expect(report.text).toContain(`- ${h} \u00b7 ${EXPIRED_HANDLE_TEXT}`);
    expect((await wiring.verifyHandles("other", { kind: "handles", handles: [h] })).items[0]?.kind).toBe("unknown");
  });

  it("dedupes normalized handles and runs at most MAX_HANDLES_PER_CALL; the excess is reported", async () => {
    const { wiring } = makeWiring();
    const many = Array.from({ length: MAX_HANDLES_PER_CALL + 8 }, (_, i) => `vrf_${i.toString(16).padStart(24, "0")}`);
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles: [many[0], ` '${many[0].toUpperCase()}' `, ...many] });
    expect(report.items).toHaveLength(MAX_HANDLES_PER_CALL);
    expect(report.excess).toBe(8);
    expect(report.text).toContain(`- 8 more handle(s) not run: at most ${MAX_HANDLES_PER_CALL} per call`);
  });

  it("pending: true verifies every open delegation of the session and joins one already in flight", async () => {
    const { wiring } = makeWiring();
    const ha = await register(wiring.pending, "a");
    const hb = await register(wiring.pending, "b");
    const release = holdPlanning("a");
    const first = wiring.verifyHandles("orch", { kind: "handles", handles: [ha] });
    const all = wiring.verifyHandles("orch", { kind: "pending" });
    release();
    const [, report] = await Promise.all([first, all]);
    // listOpen is newest first.
    expect(report.items.map(i => [verdictOf(i).handle, verdictOf(i).via])).toEqual([[hb, "run"], [ha, "joined"]]);
    expect(inputsOf("a")).toBe(1);
    expect(wiring.pending.listUnverified("orch")).toEqual([]);
  });

  it("a cancelled call (the tool's abort) judges nothing and leaves the entry unverified", async () => {
    const { wiring } = makeWiring();
    const h = await register(wiring.pending, "a");
    const controller = new AbortController();
    controller.abort();
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles: [h] }, { signal: controller.signal });
    expect(verdictOf(report.items[0]).result.retryable).toBe(true);
    expect(state.runs).toEqual([]);
    expect(wiring.pending.get("orch", h)).toMatchObject({ kind: "found", entry: { state: "unverified" } });
  });
});

// ---------------------------------------------------------------------------------------------
// The plugin's router_verify tool (2.4.3b)
// ---------------------------------------------------------------------------------------------

interface ToolHooks {
  tool: Record<string, { execute(args: unknown, ctx?: { sessionID?: string; abort?: AbortSignal }): Promise<string> } | undefined>;
  "tool.execute.before": (input: unknown, output: unknown) => Promise<void>;
  "tool.execute.after": (input: unknown, output: { output: string; metadata: unknown }) => Promise<void>;
}

describe("the router_verify tool (2.4.3b)", () => {
  let home = "";
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "omr-rv-home-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.MODEL_ROUTER_ENFORCE = "1";
    delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
    invalidateConfigCache();
    plugin.wiring = undefined;
  });

  afterEach(() => {
    for (const key of ["HOME", "USERPROFILE"] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete process.env.MODEL_ROUTER_ENFORCE;
    delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
    invalidateConfigCache();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function writeOverrides(verify: Record<string, unknown>): void {
    const p = join(home, ".config/opencode/opencode-model-router.overrides.jsonc");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ enforcement: { verify } }), "utf-8");
    invalidateConfigCache();
  }

  async function makePlugin(): Promise<{ hooks: ToolHooks; created: string[] }> {
    const created: string[] = [];
    const ctx = {
      directory: state.root,
      worktree: state.root,
      project: {},
      serverUrl: new URL("http://localhost"),
      $: () => undefined,
      client: {
        session: {
          get: async () => ({ data: {} }),
          create: async () => {
            const id = `sess_${created.length + 1}`;
            created.push(id);
            return { data: { id } };
          },
          prompt: async () => ({ data: { parts: [{ type: "text", text: "DONE" }] } }),
          abort: async () => ({}),
          delete: async () => ({}),
        },
      },
    };
    const hooks = (await ModelRouterPlugin(ctx as unknown as Parameters<typeof ModelRouterPlugin>[0])) as unknown as ToolHooks;
    return { hooks, created };
  }

  const registry = (): PendingRegistry => {
    if (plugin.wiring === undefined) throw new Error("the plugin built no wiring");
    return plugin.wiring.pending;
  };

  const routerVerify = (hooks: ToolHooks) => {
    const t = hooks.tool.router_verify;
    if (t === undefined) throw new Error("router_verify is not registered");
    return t;
  };

  it("is registered whenever verification is enabled, independent of the delegate tool", async () => {
    expect((await makePlugin()).hooks.tool.router_verify).toBeDefined();
    expect((await makePlugin()).hooks.tool.delegate).toBeUndefined();
    process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";
    const both = (await makePlugin()).hooks.tool;
    expect(Object.keys(both).sort()).toEqual(["delegate", "router_verify"]);
    writeOverrides({ require: "never" });
    expect((await makePlugin()).hooks.tool.router_verify).toBeUndefined();
  });

  it("without the tool (verification off at start) a later testsPass task is gated, never deferred", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "0";
    const { hooks } = await makePlugin();
    expect(hooks.tool.router_verify).toBeUndefined();
    // Enforcement switched on at runtime: the native path verifies again, synchronously.
    process.env.MODEL_ROUTER_ENFORCE = "1";
    const prompt = `Implement it.\n[acceptance]\ncheck: testsPass command="npm test"\n[/acceptance]`;
    const input = { tool: "task", sessionID: "orch", callID: "c1", args: { subagent_type: "fast", prompt, description: "the work" } };
    const before = { args: { ...input.args } };
    await hooks["tool.execute.before"](input, before);
    const output = { output: "<task_result>\nDONE\n</task_result>", metadata: { sessionId: "child1" } };
    await hooks["tool.execute.after"]({ ...input, args: before.args }, output);
    expect(output.output).not.toMatch(/\[router\] unverified/);
    expect(registry().listUnverified("orch")).toEqual([]);
  });

  it("requires exactly one of handles or pending: true, as text; it never throws", async () => {
    const { hooks } = await makePlugin();
    const t = routerVerify(hooks);
    for (const bad of [{}, { handles: ["vrf_x"], pending: true }, { pending: false }, { handles: [] }]) {
      await expect(t.execute(bad, { sessionID: "orch" })).resolves.toBe(ROUTER_VERIFY_ARGS_TEXT);
    }
    await expect(t.execute({ pending: true }, { sessionID: "orch" })).resolves.toBe(ROUTER_VERIFY_NO_PENDING_TEXT);
    vi.spyOn(registry(), "markVerifying").mockImplementation(() => {
      throw new Error("registry exploded");
    });
    const h = await register(registry(), "a");
    const out = await t.execute({ handles: [h] }, { sessionID: "orch" });
    expect(out).toContain("[router] router_verify failed; nothing was verified: registry exploded");
  });

  it("is scoped by the calling session: another session and the producer's own get unknown handle", async () => {
    const { hooks, created } = await makePlugin();
    const t = routerVerify(hooks);
    const h = await register(registry(), "a");
    for (const sessionID of ["other", "child-a", undefined]) {
      const out = await t.execute({ handles: [h] }, sessionID === undefined ? {} : { sessionID });
      expect(out).toContain(`- ${h} \u00b7 ${UNKNOWN_HANDLE_TEXT}`);
    }
    expect(state.runs).toEqual([]);
    const out = await t.execute({ handles: [h] }, { sessionID: "orch" });
    expect(out).toContain(`- ${h} \u00b7 work a \u00b7 pass`);
    // No session was created: nothing retried, escalated or graded.
    expect(created).toEqual([]);
  });

  it("end to end: a deferred native task's footer handle verifies through the tool", async () => {
    const { hooks } = await makePlugin();
    const prompt = `Implement it.\n[acceptance]\ncheck: testsPass command="npm test"\n[/acceptance]`;
    const input = { tool: "task", sessionID: "orch", callID: "c1", args: { subagent_type: "fast", prompt, description: "the work" } };
    const before = { args: { ...input.args } };
    await hooks["tool.execute.before"](input, before);
    const output = { output: "<task_result>\nDONE\n</task_result>", metadata: { sessionId: "child1" } };
    await hooks["tool.execute.after"]({ ...input, args: before.args }, output);
    const handle = /\[router\] unverified \u00b7 (vrf_[0-9a-f]{24}) \u00b7/.exec(output.output)?.[1];
    expect(handle).toBeDefined();
    const out = await routerVerify(hooks).execute({ pending: true }, { sessionID: "orch" });
    expect(out).toContain(`- ${handle} \u00b7 the work \u00b7 `);
    expect(registry().listUnverified("orch")).toEqual([]);
    // A cancelled call (the host's abort) answers at once and judges nothing.
    const h = await register(registry(), "b");
    const controller = new AbortController();
    controller.abort();
    const cancelled = await routerVerify(hooks).execute({ handles: [h] }, { sessionID: "orch", abort: controller.signal });
    expect(cancelled).toContain(`- ${h} \u00b7 work b \u00b7 not judged`);
  });
});
