import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { observeTests, compareTests, type TestBaseline } from "../../src/verify/baseline";
import { createChangedFileStore, buildAcceptedSuffix, type TreeSnapshot, type BaselineCaptureDeps } from "../../src/verify/dispatch";
import { accept, type Artefact } from "../../src/verify/gate";
import { buildGradingPrompt } from "../../src/verify/checker";
import { validateConfig } from "../../src/router/config";
import { nextAction, newLadderState } from "../../src/escalate/ladder";
import type { ExecResult, RecheckOutcome, ScopedOutcome } from "../../src/verify/types";
import { judgeScoped, formatIds } from "../../src/verify/baseline";
import type { RunResult } from "../../src/verify/runner";

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

describe("judgeScoped verdict algebra (deterministic.ts T5-T7)", () => {
  const ID = "a.test.ts > t1";
  const OBS = `; observed failures: ${ID}`;
  const rr = (failingIds: string[], o: Partial<RunResult> = {}): RunResult => ({
    failingIds, failingFiles: failingIds.map(id => `/repo/${id.split(" > ")[0]}`), collectionError: false,
    total: 3, complete: true, source: "text", ...o,
  });
  const ran = (result: RunResult, exitCode = 1): ScopedOutcome => ({ kind: "ran", result, exitCode, notes: [] });
  const exact = (refIds: string[], o: Partial<Extract<RecheckOutcome, { kind: "exact" }>> = {}): RecheckOutcome => ({
    kind: "exact", result: rr(refIds, { total: 5 }), ranFiles: ["a.test.ts"], absentFiles: [], notes: [], ...o,
  });
  const cols: Record<string, RecheckOutcome | undefined> = {
    "--": undefined,
    "X+": exact([ID]),
    "X-": exact([]),
    "X?": exact(["a.test.ts > other"]),
    A: { kind: "approximate", inexactReasons: [{ cause: "untracked-modified", path: "src/x.ts" }, { cause: "untracked-deleted", path: "" }] },
    U: { kind: "unusable", cause: "no-reference", reason: "the dispatch was not tracked" },
    D: { kind: "disabled" },
    T: { kind: "timed-out", boundMs: 4000 },
    S: { kind: "skipped-deadline", remainingMs: 8000 },
  };
  const rows: Record<string, ScopedOutcome> = {
    R2: ran(rr([ID])),
    R2i: ran(rr([ID], { complete: false, note: "report truncated" })),
    R3: ran(rr([ID], { complete: false, collectionError: true })),
  };
  const col = (inventoryNote: string): Record<string, [boolean, boolean, string]> => ({
    "X-": [false, false, `testsPass: introduced failures: ${ID}${OBS}`],
    "X?": [false, true, `testsPass: cannot prove failures predate dispatch: ${ID}${OBS}`],
    A: [false, true, `testsPass: cannot attribute failures: the dispatch reference is approximate (untracked-modified src/x.ts, untracked-deleted)${OBS}`],
    U: [false, true, `testsPass: no reference: pre-existing failures cannot be told apart (the dispatch was not tracked)${OBS}`],
    D: [false, true, `testsPass: cannot attribute failures: failureRecheck is off, pre-existing failures cannot be told apart${OBS}`],
    T: [false, true, `testsPass: cannot attribute failures: the reference rerun timed out after 4000ms${OBS}`],
    S: [false, true, `testsPass: gate budget exhausted before recheck${OBS}`],
    "X+": [false, true, `testsPass: the scoped failure inventory is incomplete (${inventoryNote}); known failures predate dispatch, others may not${OBS}`],
  });
  const u9: [boolean, boolean, string] = [false, true, `testsPass: cannot attribute failures: no failing test file identified, recheck not attempted${OBS}`];
  const table: Record<string, Record<string, [boolean, boolean, string]>> = {
    R2: { ...col(""), "--": u9, "X+": [true, false, ""] },
    R2i: { ...col("report truncated"), "--": u9 },
    R3: { ...col("collection error"), "--": [false, true, `testsPass: collection error without failing test files: no details${OBS}`] },
  };
  const cells = Object.entries(table).flatMap(([row, byCol]) => Object.entries(byCol).map(([c, want]) => [row, c, ...want] as const));

  it.each(cells)("%s x %s -> ok=%s unverifiable=%s", (row, c, ok, unv, reason) => {
    const j = judgeScoped(rows[row], cols[c]);
    expect(j.ok).toBe(ok);
    expect(j.unverifiable).toBe(unv);
    if (ok) {
      expect(j.reason).toBeUndefined();
      expect(j.note).toBe(`testsPass: no worse than before; pre-existing failures: ${ID}; suite is NOT green (affected tests checked against the exact dispatch reference)`);
      expect(j.failures).toEqual({ introduced: [], preexisting: [ID], unknown: [] });
    } else {
      expect(j.reason).toBe(reason);
    }
    if (c.startsWith("X")) expect(j.failures).toBeDefined();
    else expect(j.failures).toBeUndefined();
  });

  it("u4 names the cause of a non-reference unusable recheck", () => {
    expect(judgeScoped(rows.R2, { kind: "unusable", cause: "materialize-failed", reason: "worktree add failed" }).reason)
      .toBe(`testsPass: cannot attribute failures: reference unusable (materialize-failed): worktree add failed${OBS}`);
  });

  it("R0 no-affected passes with the NoAffected note verbatim, ignoring any recheck", () => {
    for (const recheck of Object.values(cols)) {
      expect(judgeScoped({ kind: "no-affected", note: "no changed files, no affected tests" }, recheck))
        .toEqual({ ok: true, unverifiable: false, note: "no changed files, no affected tests" });
    }
  });

  it("R1 green passes with e1, plus n1 when no test ran, ignoring any recheck", () => {
    for (const recheck of Object.values(cols)) {
      expect(judgeScoped(ran(rr([]), 0), recheck))
        .toEqual({ ok: true, unverifiable: false, evidence: "testsPass: affected tests passed (full, 3 tests)" });
    }
    expect(judgeScoped(ran(rr([], { total: 0 }), 0), undefined)).toEqual({
      ok: true, unverifiable: false, evidence: "testsPass: affected tests passed (full, 0 tests)", note: "testsPass: no affected tests ran",
    });
  });

  it("R4 incomplete without failing ids is u12 whatever the recheck", () => {
    for (const recheck of Object.values(cols)) {
      expect(judgeScoped(ran(rr([], { complete: false, note: "no report written" }), 2), recheck))
        .toEqual({ ok: false, unverifiable: true, reason: "testsPass: the scoped result is incomplete: no report written (exit 2)" });
    }
  });

  it.each([
    ["R5 timed out", { kind: "timed-out", boundMs: 5000 }, "testsPass timed out after 5000ms"],
    ["R5 aborted", { kind: "aborted", reason: "gate budget exhausted during the scoped run" }, "testsPass: gate budget exhausted during the scoped run"],
    ["R6 slot busy", { kind: "slot-busy", waitedMs: 60000, deadlineCut: false }, "verification slot busy (waited 60000ms)"],
    ["R6 deadline cut", { kind: "slot-busy", waitedMs: 5000, deadlineCut: true }, "gate budget exhausted waiting for the verification slot"],
    ["R7 S6", { kind: "unverifiable", code: "node-not-found", reason: "no node on PATH" }, "testsPass: scoping impossible (node-not-found): no node on PATH"],
    ["R8 error", { kind: "error", reason: "spawn EPERM" }, "testsPass check errored: spawn EPERM"],
  ] as [string, ScopedOutcome, string][])("%s is unverifiable whatever the recheck", (_name, scoped, reason) => {
    for (const recheck of Object.values(cols)) {
      expect(judgeScoped(scoped, recheck)).toEqual({ ok: false, unverifiable: true, reason });
    }
  });

  describe("T5 classification edge cases", () => {
    it("an id whose file is absent at the reference is introduced", () => {
      const j = judgeScoped(ran(rr(["new.test.ts > t"])), exact([], { result: undefined, ranFiles: [], absentFiles: ["new.test.ts"] }));
      expect(j).toMatchObject({ ok: false, unverifiable: false, failures: { introduced: ["new.test.ts > t"], preexisting: [], unknown: [] } });
    });

    it("a file that was not rerun leaves its ids unknown", () => {
      const j = judgeScoped(ran(rr(["b.test.ts > t"])), exact([ID]));
      expect(j).toMatchObject({ ok: false, unverifiable: true, failures: { unknown: ["b.test.ts > t"] } });
    });

    it("report source classifies id-level: another failing id in the same file does not hide a new one", () => {
      const j = judgeScoped(ran(rr([ID], { source: "report" })), exact(["a.test.ts > other"]));
      expect(j).toMatchObject({ ok: false, unverifiable: false, reason: `testsPass: introduced failures: ${ID}${OBS}` });
    });

    it("text source classifies file-level only when the file passed at the reference", () => {
      expect(judgeScoped(ran(rr([ID])), exact(["a.test.ts > other"])).failures).toEqual({ introduced: [], preexisting: [], unknown: [ID] });
      expect(judgeScoped(ran(rr([ID])), exact([])).failures).toEqual({ introduced: [ID], preexisting: [], unknown: [] });
    });

    it("pytest ids key on the part before ::", () => {
      const id = "tests/test_x.py::TestA::test_b";
      const j = judgeScoped(ran(rr([id], { source: "report" })), exact([id], { ranFiles: ["tests/test_x.py"] }));
      expect(j).toMatchObject({ ok: true, failures: { preexisting: [id] } });
    });

    it("a bare-file id is never pre-existing: introduced when its file ran or is absent", () => {
      const bare = "a.test.ts";
      const scoped = ran(rr([bare], { collectionError: true, complete: false }));
      expect(judgeScoped(scoped, exact([bare])).failures).toEqual({ introduced: [bare], preexisting: [], unknown: [] });
      expect(judgeScoped(scoped, exact([], { result: undefined, ranFiles: [], absentFiles: [bare] })).ok).toBe(false);
    });

    it("r1 names only the introduced ids and notes the pre-existing ones", () => {
      const j = judgeScoped(ran(rr([ID, "a.test.ts > t2"], { source: "report" })), exact([ID]));
      expect(j).toMatchObject({
        ok: false, unverifiable: false,
        reason: `testsPass: introduced failures: a.test.ts > t2; observed failures: ${ID}, a.test.ts > t2`,
        note: `testsPass: also failing at the dispatch reference: ${ID}`,
      });
    });
  });

  it("<ids> lists at most 10 ids, then the remainder count", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `t${String(i).padStart(2, "0")}`);
    expect(formatIds(ids)).toBe(`${ids.slice(0, 10).join(", ")} (+2 more)`);
    expect(formatIds(ids.slice(0, 10))).toBe(ids.slice(0, 10).join(", "));
  });
});
