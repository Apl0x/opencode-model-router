import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createVerificationWiring } from "../../src/verify/wiring";
import { createChangedFileStore, type TreeSnapshot } from "../../src/verify/dispatch";
import { accept } from "../../src/verify/gate";
import { REFERENCE_NONE } from "../../src/verify/baseline";
import type { RouterConfig } from "../../src/router/config";
import type { DoD } from "../../src/verify/dod";
import type { DispatchReference } from "../../src/verify/reference";
import type { TestsPassRequest } from "../../src/verify/types";

const state = vi.hoisted(() => ({
  snapshot: undefined as TreeSnapshot | undefined,
  commands: [] as string[],
  captures: [] as { cwd: string; timeoutMs: number | undefined }[],
  captureResult: undefined as unknown,
  held: false, finish: undefined as (() => void) | undefined,
  /** When set, the capture settles after this many (fake) ms; captureThrows rejects instead. */
  captureDelayMs: undefined as number | undefined, captureThrows: false,
  gcCalls: [] as string[], gcRejects: false,
}));
vi.mock("../../src/verify/tree", () => ({ snapshotTree: async () => state.snapshot }));
// G6: no process may run at dispatch time; any shell or argv spawn is recorded and fails the assertion.
vi.mock("../../src/verify/exec", () => ({
  runShell: async (command: string) => { state.commands.push(command); return { code: 0, stdout: "", stderr: "", timedOut: false }; },
  runArgv: async (file: string, args: readonly string[]) => { state.commands.push([file, ...args].join(" ")); return { code: 0, stdout: "", stderr: "", timedOut: false }; },
}));
vi.mock("../../src/verify/reference", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/verify/reference")>()),
  captureReference: (at: string, _signal: AbortSignal, deps: { timeoutMs?: number }) => new Promise((resolve, reject) => {
    state.captures.push({ cwd: at, timeoutMs: deps.timeoutMs });
    const finish = () => (state.captureThrows ? reject(new Error("capture exploded")) : resolve(state.captureResult));
    if (state.captureDelayMs !== undefined) setTimeout(finish, state.captureDelayMs);
    else if (state.held) state.finish = finish; else finish();
  }),
  gcStaleReferences: (root: string) => {
    state.gcCalls.push(root);
    return state.gcRejects ? Promise.reject(new Error("gc exploded")) : Promise.resolve({ removed: [], kept: [], failed: [] });
  },
}));
const cwd = resolve("baseline-wiring-project");
const dod: DoD = { kind: "deterministic", source: "explicit", criteria: [], deliverable: null, checks: [{ kind: "testsPass", command: "pnpm test" }] };
const REF: DispatchReference = { root: cwd, head: "HEAD", commit: "HEAD", untracked: new Map(), tracked: new Map(), captureReasons: [], capturedAt: 0 };
beforeEach(() => Object.assign(state, {
  snapshot: { cwd, head: "HEAD", fingerprint: "before", dirty: true, files: [{ path: resolve(cwd, "old.ts"), status: " M" }] },
  commands: [], captures: [], captureResult: REF, held: false, finish: undefined,
  captureDelayMs: undefined, captureThrows: false, gcCalls: [], gcRejects: false,
}));
function harness() {
  const cfg: RouterConfig = { activePreset: "a", presets: { a: { medium: { model: "p/m" } } }, defaultTier: "medium", rules: [], enforcement: { verify: { baselineTimeoutMs: 1234 } } };
  const wiring = createVerificationWiring({ client: {}, directory: cwd, getConfig: () => cfg });
  const store = createChangedFileStore();
  return { cfg, wiring, store };
}
describe("tree snapshot against a real git repository", () => {
  const withRepo = async (body: (repo: string) => Promise<void>) => {
    const repo = mkdtempSync(join(tmpdir(), "omr-tree-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, windowsHide: true });
    try {
      git("init", "-q");
      git("config", "user.email", "t@example.invalid"); git("config", "user.name", "t");
      git("config", "commit.gpgsign", "false");
      mkdirSync(join(repo, "sub"));
      writeFileSync(join(repo, "a.test.ts"), "export const a = 1;\n");
      writeFileSync(join(repo, "sub", "keep.ts"), "export {};\n");
      git("add", "-A"); git("commit", "-q", "-m", "init");
      git("mv", "a.test.ts", "b.test.ts");
      await body(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  };
  const real = () => vi.importActual<typeof import("../../src/verify/tree")>("../../src/verify/tree");

  it("records the rename source as previousPath", async () => {
    const { snapshotTree } = await real();
    await withRepo(async repo => {
      const snapshot = await snapshotTree(repo, new AbortController().signal);
      const top = realpathSync.native(repo);
      const renamed = snapshot?.files.find(f => f.status.includes("R"));
      expect(renamed).toBeDefined();
      expect(realpathSync.native(renamed!.path)).toBe(join(top, "b.test.ts"));
      expect(renamed!.previousPath && resolve(renamed!.previousPath).toLowerCase())
        .toBe(resolve(snapshot!.root!, "a.test.ts").toLowerCase());
    });
  });

  it("records the real top-level path when captured from a subdirectory", async () => {
    const { snapshotTree } = await real();
    await withRepo(async repo => {
      const snapshot = await snapshotTree(join(repo, "sub"), new AbortController().signal);
      expect(snapshot?.root).toBe(realpathSync.native(repo));
      expect(snapshot?.cwd).toBe(realpathSync.native(join(repo, "sub")));
    });
  });
});

describe("dispatch reference wiring", () => {
  it("captures a git-only reference (no test command) and the gate judges against it after the producer changed the tree", async () => {
    const { wiring, store } = harness(); state.held = true;
    const begun = wiring.beginVerification(store, "dispatch", undefined, dod);
    expect(begun).toBeInstanceOf(Promise);
    await vi.waitFor(() => expect(state.finish).toBeDefined());
    expect(state.captures).toEqual([{ cwd, timeoutMs: 1234 }]);
    state.finish?.();
    await begun;
    state.snapshot = { ...state.snapshot!, fingerprint: "after", files: [...state.snapshot!.files, { path: resolve(cwd, "new.ts"), status: "??" }] };
    const prepared = await wiring.prepareVerification(store, "dispatch", "child");
    expect(prepared.changedFiles.map(f => f.path)).toEqual([resolve(cwd, "new.ts")]);
    expect(prepared.reference).toEqual({ kind: "captured", reference: REF });
    expect(prepared.snapshot?.fingerprint).toBe("after");
    const deps = wiring.buildGateDeps(undefined, undefined, prepared);
    const seen: TestsPassRequest[] = [];
    deps.deterministic.testsPass = async req => {
      seen.push(req);
      return {
        scoped: { kind: "ran", exitCode: 1, notes: [], result: { failingIds: ["new.test.ts > new-test"], failingFiles: [resolve(cwd, "new.test.ts")], collectionError: false, total: 1, complete: true, source: "report" } },
        recheck: { kind: "exact", result: undefined, ranFiles: [], absentFiles: ["new.test.ts"], notes: [] },
      };
    };
    const result = await accept({ dod }, { ...prepared, finalReturnText: "done", declaredOutputs: [], producerSessionID: "child", producerTier: "medium" }, deps);
    expect(result.accepted).toBe(false); expect(result.verdict.reasons[0]).toContain("new-test");
    expect(result.verdict.failures?.introduced).toEqual(["new.test.ts > new-test"]);
    expect(seen[0]).toMatchObject({ command: "pnpm test", cwd, reference: { kind: "captured" }, changedFiles: [{ path: resolve(cwd, "new.ts"), status: "??" }] });
    // G6: the dispatch and the gate (whose hook is faked) spawned nothing.
    expect(state.commands).toEqual([]);
  });
  it("failureRecheck off (deprecated testBaseline false) captures nothing but still snapshots changed files", async () => {
    const { cfg, wiring, store } = harness();
    cfg.enforcement!.verify!.testBaseline = false;
    await wiring.beginVerification(store, "disabled", undefined, dod);
    cfg.enforcement!.verify = { failureRecheck: false };
    await wiring.beginVerification(store, "off", undefined, dod);
    expect(state.captures).toEqual([]);
    const prepared = await wiring.prepareVerification(store, "disabled", "child");
    expect(prepared.changeBaseline).toBe("available");
    expect(prepared.reference).toEqual({ kind: "disabled" });
    expect((await wiring.prepareVerification(store, "off", "child")).reference).toEqual({ kind: "disabled" });
  });
  it("read-only dispatches and forbidden commands capture nothing and run nothing", async () => {
    const { wiring, store } = harness();
    await wiring.beginVerification(store, "readonly", undefined, { ...dod, kind: "checker", checks: [], criteria: ["investigate"] });
    await wiring.beginVerification(store, "blocked", undefined, { ...dod, checks: [{ kind: "testsPass", command: "npm test && evil" }] });
    for (const id of ["readonly", "blocked"]) {
      expect((await wiring.prepareVerification(store, id, "child")).reference).toEqual({ kind: "none", reason: REFERENCE_NONE.notRequested });
    }
    expect(state.captures).toEqual([]);
    expect(state.commands).toEqual([]);
  });
  it("a retry keeps the first reference, and an untracked dispatch has none", async () => {
    const { wiring, store } = harness();
    await wiring.beginVerification(store, "dispatch", undefined, dod);
    state.captureResult = { ...REF, commit: "after-the-failed-attempt" };
    await wiring.beginVerification(store, "dispatch", undefined, dod);
    expect(state.captures).toHaveLength(1);
    expect((await wiring.prepareVerification(store, "dispatch", "retry")).reference).toEqual({ kind: "captured", reference: REF });
    expect((await wiring.prepareVerification(store, "never-begun", "child")).reference).toEqual({ kind: "none", reason: REFERENCE_NONE.untracked });
  });
  describe("bounded wait (2.1.5b, fake timers)", () => {
    const bounded = (verify: Record<string, unknown>) => {
      const warnings: string[] = [];
      const cfg: RouterConfig = { activePreset: "a", presets: { a: { medium: { model: "p/m" } } }, defaultTier: "medium", rules: [], enforcement: { verify: { baselineTimeoutMs: 30_000, ...verify } } };
      const wiring = createVerificationWiring({ client: {}, directory: cwd, getConfig: () => cfg, logger: { warn: m => void warnings.push(m) } });
      return { wiring, store: createChangedFileStore(), warnings };
    };
    const track = (p: Promise<void>) => { const s = { done: false }; void p.then(() => { s.done = true; }); return s; };
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("a capture resolving at 2 s lets the dispatch proceed at 2 s", async () => {
      const { wiring, store } = bounded({ captureWaitMs: 5_000 }); state.captureDelayMs = 2_000;
      const s = track(wiring.beginVerificationBounded(store, "d", undefined, dod));
      await vi.advanceTimersByTimeAsync(1_999); expect(s.done).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect(s.done).toBe(true);
      expect((await wiring.prepareVerification(store, "d", "child")).reference).toEqual({ kind: "captured", reference: REF });
    });
    it("a capture at 20 s with captureWaitMs 5 s proceeds at 5 s and the capture is still usable later", async () => {
      const { wiring, store } = bounded({ captureWaitMs: 5_000 }); state.captureDelayMs = 20_000;
      const s = track(wiring.beginVerificationBounded(store, "d", undefined, dod));
      await vi.advanceTimersByTimeAsync(4_999); expect(s.done).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect(s.done).toBe(true);
      await vi.advanceTimersByTimeAsync(15_000);
      expect((await wiring.prepareVerification(store, "d", "child")).reference).toEqual({ kind: "captured", reference: REF });
    });
    it("a capture that throws never fails the dispatch", async () => {
      const { wiring, store } = bounded({ captureWaitMs: 5_000 }); state.captureDelayMs = 1_000; state.captureThrows = true;
      const p = wiring.beginVerificationBounded(store, "d", undefined, dod);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(p).resolves.toBeUndefined();
      expect((await wiring.prepareVerification(store, "d", "child")).reference.kind).not.toBe("captured");
    });
    it("gcStaleReferences runs once per start and its rejection is logged, not thrown", async () => {
      const { wiring, warnings } = bounded({}); state.gcRejects = true;
      expect(() => wiring.startReferenceGc()).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      expect(state.gcCalls).toEqual([cwd]);
      expect(warnings.some(w => w.includes("reference GC failed"))).toBe(true);
    });
  });

  it("an overlapping edit before the capture resolves discards the reference", async () => {
    const { wiring, store } = harness(); state.held = true;
    const begun = wiring.beginVerification(store, "dispatch", undefined, dod);
    await vi.waitFor(() => expect(state.finish).toBeDefined());
    store.observeEdit("bash", cwd);
    state.finish?.();
    await begun;
    expect((await wiring.prepareVerification(store, "dispatch", "child")).reference)
      .toEqual({ kind: "none", reason: REFERENCE_NONE.contaminated });
  });
});
