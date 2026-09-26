import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { observeTests, compareTests, type TestBaseline } from "../../src/verify/baseline";
import { createChangedFileStore, buildAcceptedSuffix, type TreeSnapshot, type BaselineCaptureDeps } from "../../src/verify/dispatch";
import { accept, type Artefact } from "../../src/verify/gate";
import { buildGradingPrompt } from "../../src/verify/checker";
import { validateConfig } from "../../src/router/config";
import { nextAction, newLadderState } from "../../src/escalate/ladder";
import type { ExecResult } from "../../src/verify/types";

const cwd = resolve("baseline-workspace");
const green: ExecResult = { code: 0, stdout: "", stderr: "" };
const failed = (...ids: string[]): ExecResult => ({ code: 1, stdout: ids.map(id => `FAILED ${id} - assertion`).join("\n") + `\n=== ${ids.length} failed ===`, stderr: "" });
const baseline = (result: ExecResult, dirty = false): TestBaseline => ({ observation: observeTests(result), dirty });
const tree = (over: Partial<TreeSnapshot> = {}): TreeSnapshot => ({ cwd, head: "head1", fingerprint: "diff1", dirty: false, files: [], ...over });
const artefact: Artefact = { changedFiles: [], declaredOutputs: [], finalReturnText: "done", producerTier: "medium", producerSessionID: "child" };
async function grade(after: ExecResult, before?: TestBaseline) {
  return accept({ dod: { kind: "deterministic", checks: [{ kind: "testsPass" }], criteria: [], deliverable: null, source: "explicit" } }, artefact, {
    deterministic: { cwd, exec: async () => after, fs: { fileExists: async () => false, readFile: async () => "" }, testBaseline: async () => before },
    checker: { dispatchGrader: async () => ({ sessionID: "grader", text: "" }) },
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

describe("baseline-aware testsPass", () => {
  it("rejects and escalates a producer failure against a green baseline", async () => {
    const r = await grade(failed("new-test"), baseline(green));
    expect(r.accepted).toBe(false);
    expect(r.verdict.outcome).toBe("fail");
    expect(r.verdict.reasons[0]).toContain("new-test");
    const policy = { ladder: ["medium", "heavy"], maxAttemptsPerTier: 0, maxTotalAttempts: 4 };
    expect(nextAction(newLadderState("medium", policy), r.verdict, policy).action).toBe("escalate");
  });
  it("accepts unchanged pre-existing failures with an explicit no-worse note", async () => {
    const r = await grade(failed("old-test"), baseline(failed("old-test"), true));
    expect(r.accepted).toBe(true);
    expect(r.verdict.outcome).toBe("pass");
    const output = buildAcceptedSuffix(r.verdict.method, r.verdict.caveats, r.verdict.notes);
    expect(output).toContain("no worse than before");
    expect(output).toContain("NOT green");
    expect(output).toContain("dirty");
  });
  it("rejects only the additional failure, never blaming the old one", async () => {
    const r = await grade(failed("old-test", "new-test"), baseline(failed("old-test")));
    expect(r.accepted).toBe(false);
    expect(r.verdict.reasons.join()).toContain("new-test");
    expect(r.verdict.reasons.join()).not.toContain("old-test");
  });
  it("detects a replacement failure even when counts are equal", async () => {
    expect((await grade(failed("new"), baseline(failed("old")))).accepted).toBe(false);
  });
  it("accepts missing baseline as unverifiable with observed failures and a caveat", async () => {
    const r = await grade(failed("observed-test"));
    expect(r.accepted).toBe(true);
    expect(r.verdict.pass).toBe(false);
    expect(r.verdict.outcome).toBe("unverifiable");
    expect(r.verdict.caveats?.join()).toContain("observed-test");
  });
  it("does not fabricate a baseline even for an observed green run", async () => {
    expect((await grade(green)).verdict.outcome).toBe("unverifiable");
    expect((await grade(green, baseline(failed("old")))).verdict.outcome).toBe("pass");
  });
  it("unknown output uses the exit-code floor; equal broken exits cannot excuse identities", async () => {
    const opaque = { code: 2, stdout: "custom runner broke", stderr: "" };
    expect((await grade(opaque, baseline(green))).accepted).toBe(false);
    expect((await grade(opaque, baseline(opaque))).verdict.outcome).toBe("unverifiable");
    expect(observeTests(opaque)).toMatchObject({ code: 2, failures: [], complete: false });
  });
  it("count-only output detects increases but cannot prove equal failures predate dispatch", () => {
    const before = baseline({ code: 1, stdout: "2 failing", stderr: "" });
    expect(compareTests(observeTests({ code: 1, stdout: "3 failing", stderr: "" }), before).ok).toBe(false);
    expect(compareTests(observeTests({ code: 1, stdout: "3 failing", stderr: "" }), before).unverifiable).toBeUndefined();
    expect(compareTests(before.observation, before).unverifiable).toBe(true);
  });
  it("parses multiple runner formats opportunistically without counting failing suites as tests", () => {
    expect(observeTests({ code: 1, stdout: " FAIL test/a.ts > suite > test\n Tests  1 failed | 2 passed", stderr: "" })).toMatchObject({ failures: ["test/a.ts > suite > test"], count: 1, complete: true });
    expect(observeTests({ code: 1, stdout: "--- FAIL: TestThing (0.01s)\nFAIL package 0.1s", stderr: "" }).failures).toEqual(["TestThing"]);
    expect(observeTests({ code: 1, stdout: JSON.stringify({ numFailedTests: 1, testResults: [{ name: "suite", assertionResults: [{ status: "failed", fullName: "test" }] }] }), stderr: "" })).toMatchObject({ failures: ["suite > test"], complete: true });
    expect(observeTests({ code: 1, stdout: "Test Files 8 failed\nTests 1 failed", stderr: "" }).count).toBe(1);
  });
});

describe("conservative capture and shared cache in changed-file store", () => {
  function harness() {
    let snapshot = tree();
    let now = 0;
    const store = createChangedFileStore({ now: () => now });
    const run = vi.fn(async () => green);
    const deps: BaselineCaptureDeps = { snapshot: async () => snapshot, run, timeoutMs: 50 };
    const start = (id: string) => store.beginDispatch(id, cwd, ["custom tests"], deps);
    const get = (id: string, head = snapshot.head) => store.baseline(id, "custom tests", head);
    return { store, deps, run, start, get, setTree: (s: TreeSnapshot) => { snapshot = s; }, tick: (n: number) => { now = n; } };
  }
  it("starts without blocking and caches across dispatches after the first session is cleared", async () => {
    const h = harness();
    expect(h.start("first")).toBeUndefined();
    expect(await h.get("first")).toEqual(baseline(green));
    h.store.clear("first");
    h.start("second");
    expect(await h.get("second")).toEqual(baseline(green));
    expect(h.run).toHaveBeenCalledTimes(1);
  });
  it.each(["head", "fingerprint"] as const)("does not reuse cache when %s changes", async key => {
    const h = harness();
    h.start("first"); await h.get("first");
    h.setTree(tree({ [key]: "changed" }));
    h.start("second"); await h.get("second");
    expect(h.run).toHaveBeenCalledTimes(2);
    if (key === "head") expect(await h.get("first", "changed")).toBeUndefined();
  });
  it("keys by command and directory too", async () => {
    const h = harness();
    h.start("first"); await h.get("first");
    h.store.beginDispatch("other-command", cwd, ["another command"], h.deps);
    await h.store.baseline("other-command", "another command", "head1");
    h.setTree(tree({ cwd: resolve("another-workspace") }));
    h.store.beginDispatch("other-dir", resolve("another-workspace"), ["custom tests"], h.deps);
    await h.get("other-dir");
    expect(h.run).toHaveBeenCalledTimes(3);
  });
  it("runs at most one capture per directory and command, whatever the fingerprint", async () => {
    const h = harness(); const held = deferred<ExecResult>(); const started = deferred<void>();
    h.run.mockImplementationOnce(async () => { started.resolve(); return held.promise; });
    h.start("first"); await started.promise;
    h.setTree(tree({ fingerprint: "changed" }));
    h.start("second");
    expect(await h.get("second")).toBeUndefined();
    expect(h.run).toHaveBeenCalledTimes(1);
    held.resolve(green);
    h.setTree(tree());
    expect(await h.get("first")).toEqual(baseline(green));
    h.setTree(tree({ fingerprint: "changed" }));
    h.start("third"); await h.get("third");
    expect(h.run).toHaveBeenCalledTimes(2);
  });
  it.each(["fingerprint", "edit", "patch", "bash"])("discards a baseline contaminated by %s mid-capture", async cause => {
    const h = harness();
    const held = deferred<ExecResult>();
    const started = deferred<void>();
    h.deps.run = async () => { started.resolve(); return held.promise; };
    h.start("child");
    await started.promise;
    if (cause === "fingerprint") h.setTree(tree({ fingerprint: "changed" }));
    else h.store.observeEdit(cause === "patch" ? "apply_patch" : cause, cwd);
    held.resolve(green);
    expect(await h.get("child")).toBeUndefined();
    const r = await grade(failed("observed"), await h.get("child"));
    expect(r.verdict.outcome).toBe("unverifiable");
    expect(r.accepted).toBe(true);
  });
  it("an edit during initial fingerprinting also discards the snapshot", async () => {
    const h = harness(); const held = deferred<TreeSnapshot>();
    h.deps.snapshot = () => held.promise;
    h.start("child"); h.store.observeEdit("edit", cwd); held.resolve(tree());
    expect(await h.get("child")).toBeUndefined();
    expect(h.store.delta("child", "child", tree()).changeBaseline).toBe("unavailable");
    expect(h.run).not.toHaveBeenCalled();
  });
  it("editing a different known directory does not contaminate capture", async () => {
    const h = harness(); const held = deferred<ExecResult>(); const started = deferred<void>();
    h.deps.run = async () => { started.resolve(); return held.promise; };
    h.start("child"); await started.promise;
    h.store.observeEdit("edit", resolve("unrelated-workspace")); held.resolve(green);
    expect(await h.get("child")).toEqual(baseline(green));
  });
  it("baseline timeout is bounded, aborts capture, and yields accepted unverifiable", async () => {
    vi.useFakeTimers(); const h = harness(); let signal: AbortSignal | undefined;
    h.deps.run = async (_c, _d, s) => { signal = s; return new Promise<ExecResult>(() => {}); };
    h.start("child"); const pending = h.get("child");
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBeUndefined(); expect(signal?.aborted).toBe(true);
    expect((await grade(failed("observed"), await pending)).verdict.outcome).toBe("unverifiable");
  });
  it("TTL sweeps both dispatch references and cross-dispatch cache", async () => {
    const h = harness(); h.start("first"); await h.get("first");
    h.tick(100); h.store.sweep(100, 100);
    expect(await h.get("first")).toBeUndefined();
    h.start("second"); await h.get("second");
    expect(h.run).toHaveBeenCalledTimes(2);
  });
  it("grader receives child edits union new changed paths, not unrelated pre-existing dirt", async () => {
    const h = harness(); const old = resolve(cwd, "old.ts"); const edited = resolve(cwd, "edited.ts"); const added = resolve(cwd, "new.ts");
    const before = tree({ dirty: true, files: [{ path: old, status: " M" }, { path: edited, status: " M" }] });
    h.setTree(before); h.start("dispatch"); await h.get("dispatch");
    h.store.record("child", "edit", { filePath: edited });
    const delta = h.store.delta("dispatch", "child", { ...before, files: [...before.files, { path: added, status: "??" }] });
    expect(delta.changedFiles.map(f => f.path).sort()).toEqual([edited, added].sort());
    const prompt = buildGradingPrompt({ criteria: ["investigate"], artefact: { ...artefact, ...delta }, producerTier: "medium", producerSessionID: "child" }).prompt;
    expect(prompt).toContain("Producer delta only"); expect(prompt).toContain("predate the dispatch");
    expect(prompt).not.toContain(old);
    expect(prompt).toContain(edited); expect(prompt).toContain(added);
  });
  it("missing snapshot never substitutes a raw dirty tree and explicitly disclaims attribution", () => {
    const h = harness(); const old = resolve(cwd, "old.ts");
    const delta = h.store.delta("missing", "child", tree({ files: [{ path: old, status: " M" }] }));
    expect(delta.changedFiles).toEqual([]);
    const prompt = buildGradingPrompt({ criteria: [], artefact: { ...artefact, ...delta }, producerTier: "medium", producerSessionID: "child" }).prompt;
    expect(prompt).toContain("snapshot unavailable"); expect(prompt).not.toContain(old);
  });
  it("patch edit logs cover additions, updates, removals and rename destinations", () => {
    const h = harness();
    h.store.record("child", "apply_patch", { patchText: "*** Begin Patch\n*** Update File: old.ts\n*** Move to: renamed.ts\n*** Add File: new.ts\n*** Delete File: gone.ts\n*** End Patch" });
    expect(h.store.get("child").map(f => f.path)).toEqual(["old.ts", "renamed.ts", "new.ts", "gone.ts"]);
  });
});

it("validateConfig validates both baseline settings without requiring either", () => {
  const cfg = { activePreset: "a", presets: { a: { fast: { model: "p/m" } } }, rules: [], defaultTier: "fast" };
  expect(validateConfig(cfg).enforcement).toBeUndefined();
  for (const testBaseline of [true, false]) expect(validateConfig({ ...cfg, enforcement: { verify: { testBaseline, baselineTimeoutMs: 1 } } }).enforcement?.verify?.testBaseline).toBe(testBaseline);
  expect(() => validateConfig({ ...cfg, enforcement: { verify: { testBaseline: "yes" } } })).toThrow("testBaseline must be a boolean");
  for (const baselineTimeoutMs of [0, -1, 1.5, "100", Infinity]) expect(() => validateConfig({ ...cfg, enforcement: { verify: { baselineTimeoutMs } } })).toThrow("baselineTimeoutMs must be an integer");
});
