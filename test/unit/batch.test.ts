import { posix } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BATCH_REASONS,
  BATCH_STALE_GRACE_MS,
  argvTemplate,
  attributeUnion,
  batchKey,
  createBatchCoordinator,
  createBatchDeadline,
  deriveSharedRecheck,
  envSignature,
  fileKeyOf,
  isGuardSensitive,
  referenceKey,
  taintUnreproduced,
  unionChangedFiles,
} from "../../src/verify/batch";
import type { BatchPlanInput, BatchPlanner, BatchRuntime } from "../../src/verify/batch";
import type { DispatchReference } from "../../src/verify/reference";
import type { RunResult, RunnerKind, ScopedSpec, ScopingPlan } from "../../src/verify/runner";
import type {
  Deadline,
  OpenVerificationScope,
  RecheckOutcome,
  ScopedOutcome,
  TestsPassHook,
  TestsPassRequest,
  TestsPassRun,
} from "../../src/verify/types";

const REPORT = "/tmp/omr-verify-00000000-0000-0000-0000-000000000000.json";

function spec(over: Partial<ScopedSpec> = {}): ScopedSpec {
  const inputs = over.inputs ?? ["/r/app/src/a.ts"];
  const reportPath = over.reportPath ?? REPORT;
  return {
    runner: "vitest",
    mode: "related",
    file: "/usr/bin/node",
    args: ["/r/node_modules/vitest/vitest.mjs", "related", "--run", "--reporter=json", `--outputFile=${reportPath}`, "--maxWorkers=2", ...inputs],
    cwd: "/r/app",
    env: {},
    reportPath,
    gitRoot: "/r",
    entry: "/r/node_modules/vitest/vitest.mjs",
    inputs,
    inputsAreTests: false,
    workers: 2,
    notes: [],
    ...over,
  };
}

function run(over: Partial<RunResult> = {}): RunResult {
  return { failingIds: [], failingFiles: [], collectionError: false, total: 5, complete: true, source: "report", ...over };
}

// ---------------------------------------------------------------------------------------------
// B3: keys
// ---------------------------------------------------------------------------------------------

describe("envSignature", () => {
  it("is independent of key order and sensitive to values", () => {
    expect(envSignature({ B: "1", A: "2" })).toBe(envSignature({ A: "2", B: "1" }));
    expect(envSignature({ A: "1" })).not.toBe(envSignature({ A: "2" }));
    expect(envSignature({})).toBe("[]");
  });
});

describe("argvTemplate", () => {
  it("drops inputs and masks the report path, also inside an option", () => {
    const s = spec({ inputs: ["/r/app/src/a.ts", "/r/app/src/b.ts"] });
    expect(argvTemplate(s)).toEqual(["/r/node_modules/vitest/vitest.mjs", "related", "--run", "--reporter=json", "--outputFile=<report>", "--maxWorkers=2"]);
  });

  it("keeps an option token equal to nothing in inputs", () => {
    const s = spec({ args: ["-t", "name", REPORT, "/r/app/src/a.ts"] });
    expect(argvTemplate(s)).toEqual(["-t", "name", "<report>"]);
  });
});

describe("batchKey", () => {
  it("equal for specs that differ only in inputs and report path", () => {
    const a = spec({ inputs: ["/r/app/src/a.ts"] });
    const b = spec({ inputs: ["/r/app/src/b.ts", "/r/app/src/c.ts"], reportPath: "/tmp/omr-verify-11111111-1111-1111-1111-111111111111.json" });
    expect(batchKey(a, "linux")).toBe(batchKey(b, "linux"));
  });

  const base = spec();
  const table: [string, ScopedSpec][] = [
    ["kept argument", spec({ args: [...base.args, "-t", "x"] })],
    ["worker cap", spec({ args: base.args.map((x) => (x === "--maxWorkers=2" ? "--maxWorkers=1" : x)) })],
    ["env", spec({ env: { NODE_ENV: "test" } })],
    ["cwd", spec({ cwd: "/r/other" })],
    ["file", spec({ file: "/opt/node" })],
    ["entry", spec({ entry: "/r/node_modules/vitest/other.mjs" })],
    ["gitRoot", spec({ gitRoot: "/s" })],
    ["runner", spec({ runner: "jest" })],
  ];
  for (const [what, other] of table) {
    it(`differs by ${what}`, () => expect(batchKey(other, "linux")).not.toBe(batchKey(base, "linux")));
  }

  it("folds path case on win32 only", () => {
    const upper = spec({ cwd: "C:\\R\\App", gitRoot: "C:\\R", entry: "C:\\R\\node_modules\\vitest\\vitest.mjs", file: "C:\\Node\\node.exe", args: [] });
    const lower = spec({ cwd: "c:\\r\\app", gitRoot: "c:\\r", entry: "c:\\r\\node_modules\\vitest\\vitest.mjs", file: "c:\\node\\node.exe", args: [] });
    expect(batchKey(upper, "win32")).toBe(batchKey(lower, "win32"));
    expect(batchKey(upper, "linux")).not.toBe(batchKey(lower, "linux"));
  });
});

describe("referenceKey", () => {
  const ref = (over: Partial<DispatchReference> = {}): DispatchReference => ({
    root: "/r",
    head: "h1",
    commit: "c1",
    untracked: new Map([
      ["a.txt", "1"],
      ["b.txt", "2"],
    ]),
    tracked: new Map([["src/x.ts", "9"]]),
    captureReasons: [
      { cause: "dependency-drift", path: "" },
      { cause: "untracked-symlink", path: "l" },
    ],
    capturedAt: 1,
    ...over,
  });

  it("ignores capturedAt and entry order", () => {
    const reordered = ref({
      capturedAt: 999,
      untracked: new Map([
        ["b.txt", "2"],
        ["a.txt", "1"],
      ]),
      captureReasons: [
        { cause: "untracked-symlink", path: "l" },
        { cause: "dependency-drift", path: "" },
      ],
    });
    expect(referenceKey(reordered)).toBe(referenceKey(ref()));
  });

  const table: [string, DispatchReference][] = [
    ["commit", ref({ commit: "c2" })],
    ["root", ref({ root: "/s" })],
    ["untracked hash", ref({ untracked: new Map([["a.txt", "1"], ["b.txt", "3"]]) })],
    ["tracked", ref({ tracked: new Map() })],
    ["captureReasons", ref({ captureReasons: [] })],
  ];
  for (const [what, other] of table) {
    it(`differs by ${what}`, () => expect(referenceKey(other)).not.toBe(referenceKey(ref())));
  }
});

// ---------------------------------------------------------------------------------------------
// B6: union change set
// ---------------------------------------------------------------------------------------------

describe("unionChangedFiles", () => {
  it("posix: resolves against each member's cwd and dedups by (path, previousPath) in first-seen order", () => {
    const out = unionChangedFiles(
      [
        { cwd: "/r/a", changedFiles: [{ path: "x.ts", status: "M" }, { path: "/r/shared.ts" }] },
        {
          cwd: "/r/b",
          changedFiles: [{ path: "../shared.ts", status: "A" }, { path: "y.ts", previousPath: "old.ts" }, { path: "y.ts" }, { path: "./y.ts", previousPath: "old.ts" }],
        },
      ],
      "linux",
    );
    expect(out).toEqual([
      { path: "/r/a/x.ts", status: "M" },
      { path: "/r/shared.ts" },
      { path: "/r/b/y.ts", previousPath: "/r/b/old.ts" },
      { path: "/r/b/y.ts" },
    ]);
  });

  it("win32: case-insensitive keys, native separators, first spelling kept", () => {
    const members = [
      { cwd: "C:\\R", changedFiles: [{ path: "src/A.ts", status: "M" }] },
      { cwd: "c:\\r\\src", changedFiles: [{ path: "a.ts", status: "D" }] },
    ];
    expect(unionChangedFiles(members, "win32")).toEqual([{ path: "C:\\R\\src\\A.ts", status: "M" }]);
  });

  it("posix keeps case-distinct paths apart", () => {
    const members = [
      { cwd: "/r", changedFiles: [{ path: "A.ts" }] },
      { cwd: "/r", changedFiles: [{ path: "a.ts" }] },
    ];
    expect(unionChangedFiles(members, "linux")).toHaveLength(2);
  });

  it("an empty set of members gives an empty union", () => {
    expect(unionChangedFiles([], "linux")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// B7: attribution
// ---------------------------------------------------------------------------------------------

describe("isGuardSensitive", () => {
  const table: [string, ScopedSpec, boolean][] = [
    ["source inputs only", spec(), false],
    ["a .test file", spec({ inputs: ["/r/app/src/a.ts", "/r/app/test/a.test.ts"] }), true],
    ["a .spec.tsx file", spec({ inputs: ["/r/app/src/a.spec.tsx"] }), true],
    ["a file under __tests__", spec({ inputs: ["/r/app/__tests__/a.ts"] }), true],
    ["a win32 __tests__ path", spec({ inputs: ["C:\\r\\app\\__tests__\\a.ts"] }), true],
    ["lexicalPaths", spec({ lexicalPaths: true }), true],
    ["inputsAreTests", spec({ runner: "pytest", inputsAreTests: true, inputs: ["/r/app/tests/test_a.py"] }), true],
    ["no inputs", spec({ inputs: [] }), false],
  ];
  for (const [what, s, want] of table) {
    it(`${what} -> ${want}`, () => {
      expect(isGuardSensitive(s, "linux")).toBe(want);
      expect(isGuardSensitive(s, "win32")).toBe(want);
    });
  }
});

describe("fileKeyOf", () => {
  const table: [string, string, NodeJS.Platform, string][] = [
    ["/r/app", "/r/app/test/a.test.ts", "linux", "test/a.test.ts"],
    ["/r/app", "/r/other/x.ts", "linux", "../other/x.ts"],
    ["C:\\R\\App", "c:\\r\\app\\test\\a.test.ts", "win32", "test/a.test.ts"],
    ["C:\\R\\App", "C:\\R\\App\\Test\\A.test.ts", "win32", "Test/A.test.ts"],
  ];
  for (const [cwd, abs, platform, want] of table) {
    it(`${platform} ${abs} -> ${want}`, () => expect(fileKeyOf(cwd, abs, platform)).toBe(want));
  }
});

describe("attributeUnion", () => {
  const src = spec();
  const withTest = spec({ inputs: ["/r/app/src/a.ts", "/r/app/test/a.test.ts"] });
  const lexical = spec({ lexicalPaths: true });
  const py = spec({ runner: "pytest", cwd: "/r/py", inputs: ["/r/py/tests/test_a.py", "/r/py/tests/test_b.py"], inputsAreTests: true });
  const pyCounts = { "tests/test_a.py": 2, "tests/test_b.py": 1, "tests/test_c.py": 4 };
  const green = (total: number | undefined) => ({ kind: "derived", exitCode: 0, result: run({ total }) });

  const table: [string, RunResult, Record<string, number> | undefined, ScopedSpec, unknown][] = [
    // 7.1
    ["7.1 incomplete union", run({ complete: false }), undefined, src, { kind: "own-run", cause: "not-comparable" }],
    ["7.1 collection error", run({ collectionError: true }), undefined, src, { kind: "own-run", cause: "not-comparable" }],
    ["7.1 text source", run({ source: "text" }), undefined, src, { kind: "own-run", cause: "not-comparable" }],
    // 7.2a
    ["7.2a not guard-sensitive", run({ total: 7 }), undefined, src, green(7)],
    // 7.2b JS
    ["7.2b JS test input, no counts", run(), undefined, withTest, { kind: "own-run", cause: "zero-test-ambiguous" }],
    ["7.2b JS test input, counted", run(), { "test/a.test.ts": 3, "test/z.test.ts": 2 }, withTest, green(3)],
    ["7.2b JS test input, 0 counted", run(), { "test/z.test.ts": 2 }, withTest, { kind: "own-run", cause: "zero-test-ambiguous" }],
    ["7.2b lexical, sources only", run(), { "src/a.ts": 1 }, lexical, { kind: "own-run", cause: "zero-test-ambiguous" }],
    // 7.2b pytest
    ["7.2b pytest, no counts", run(), undefined, py, { kind: "own-run", cause: "zero-test-ambiguous" }],
    ["7.2b pytest, counted", run(), pyCounts, py, green(3)],
    [
      "7.2b pytest, 0 counted",
      run(),
      { "tests/test_c.py": 4 },
      py,
      { kind: "derived", exitCode: 5, result: run({ total: 0, complete: false, note: "pytest ran no tests although a test file was passed" }) },
    ],
    // 7.3a
    [
      "7.3a pytest failure in the member's file, counted",
      run({ failingIds: ["tests/test_a.py::t1", "tests/test_c.py::t9"], failingFiles: ["/r/py/tests/test_a.py", "/r/py/tests/test_c.py"] }),
      pyCounts,
      py,
      { kind: "derived", exitCode: 1, result: run({ failingIds: ["tests/test_a.py::t1"], failingFiles: ["/r/py/tests/test_a.py"], total: 3 }) },
    ],
    [
      "7.3a pytest failure in the member's file, no counts",
      run({ failingIds: ["tests/test_a.py::t1"], failingFiles: ["/r/py/tests/test_a.py"] }),
      undefined,
      py,
      { kind: "derived", exitCode: 1, result: run({ failingIds: ["tests/test_a.py::t1"], failingFiles: ["/r/py/tests/test_a.py"], total: 5 }) },
    ],
    [
      "7.3a pytest bare collection-file id attributes too",
      run({ failingIds: ["tests/test_b.py"], failingFiles: ["/r/py/tests/test_b.py"] }),
      pyCounts,
      py,
      { kind: "derived", exitCode: 1, result: run({ failingIds: ["tests/test_b.py"], failingFiles: ["/r/py/tests/test_b.py"], total: 3 }) },
    ],
    ["7.3a pytest failure elsewhere, counted", run({ failingIds: ["tests/test_c.py::t9"], failingFiles: ["/r/py/tests/test_c.py"] }), pyCounts, py, green(3)],
    ["7.3a pytest failure elsewhere, no counts", run({ failingIds: ["tests/test_c.py::t9"] }), undefined, py, { kind: "own-run", cause: "zero-test-ambiguous" }],
    // 7.3b
    ["7.3b vitest failing, source member", run({ failingIds: ["test/a.test.ts > x"] }), { "test/a.test.ts": 1 }, src, { kind: "own-run", cause: "mode-b" }],
    ["7.3b vitest failing, test member", run({ failingIds: ["test/a.test.ts > x"] }), { "test/a.test.ts": 1 }, withTest, { kind: "own-run", cause: "mode-b" }],
  ];
  for (const [what, union, counts, member, want] of table) {
    it(what, () => expect(attributeUnion(union, counts, member, "linux")).toEqual(want));
  }

  it("win32: ids and files match the member's inputs case-insensitively", () => {
    const wpy = spec({ runner: "pytest", cwd: "C:\\R\\Py", gitRoot: "C:\\R", inputs: ["C:\\R\\Py\\tests\\test_a.py"], inputsAreTests: true });
    const union = run({ failingIds: ["Tests/test_a.py::t", "tests/test_b.py::u"], failingFiles: ["c:\\r\\py\\tests\\test_a.py", "C:\\R\\Py\\tests\\test_b.py"] });
    expect(attributeUnion(union, { "tests/Test_A.py": 2 }, wpy, "win32")).toEqual({
      kind: "derived",
      exitCode: 1,
      result: run({ failingIds: ["Tests/test_a.py::t"], failingFiles: ["c:\\r\\py\\tests\\test_a.py"], total: 2 }),
    });
    // On posix the same spellings do not match.
    const ppy = spec({ runner: "pytest", cwd: "/R/Py", inputs: ["/R/Py/tests/test_a.py"], inputsAreTests: true });
    expect(attributeUnion(run({ failingIds: ["Tests/test_a.py::t"] }), undefined, ppy, "linux")).toEqual({ kind: "own-run", cause: "zero-test-ambiguous" });
  });
});

describe("taintUnreproduced", () => {
  it("nothing unreproduced returns the result unchanged", () => {
    const r = run();
    expect(taintUnreproduced(r, [])).toBe(r);
  });

  it("marks the result incomplete with sorted, deduplicated ids and keeps its failures", () => {
    const r = run({ failingIds: ["a > x"], failingFiles: ["/r/a"] });
    expect(taintUnreproduced(r, ["z > 2", "b > 1", "z > 2"])).toEqual({
      ...r,
      complete: false,
      note: "batched run failure not reproduced by any request's own run: b > 1, z > 2",
    });
  });
});

// ---------------------------------------------------------------------------------------------
// B8: shared recheck
// ---------------------------------------------------------------------------------------------

describe("deriveSharedRecheck", () => {
  const passThrough: RecheckOutcome[] = [
    { kind: "approximate", inexactReasons: [{ cause: "dependency-drift", path: "" }] },
    { kind: "disabled" },
    { kind: "timed-out", boundMs: 100 },
    { kind: "skipped-deadline", remainingMs: 50 },
  ];
  for (const o of passThrough) {
    it(`${o.kind} is the same for every member`, () => expect(deriveSharedRecheck(o, undefined, ["/r/app/x.test.ts"], "/r/app", "linux")).toBe(o));
  }

  for (const cause of ["no-reference", "materialize-failed", "reference-vanished", "unreproduced-inputs", "runner-unsupported", "error"] as const) {
    it(`unusable ${cause} (reference-level) is shared`, () => {
      const o: RecheckOutcome = { kind: "unusable", cause, reason: "r" };
      expect(deriveSharedRecheck(o, undefined, [], "/r", "linux")).toBe(o);
    });
  }
  for (const cause of ["incomplete", "collection-error", "no-tests", "rerun-unplannable"] as const) {
    it(`unusable ${cause} (run-level) splits`, () => {
      expect(deriveSharedRecheck({ kind: "unusable", cause, reason: "r" }, undefined, [], "/r", "linux")).toBe("split");
    });
  }

  const shared: RecheckOutcome = {
    kind: "exact",
    result: run({
      failingIds: ["test/a.test.ts > x", "test/b.test.ts > y"],
      failingFiles: ["/wt/app/test/a.test.ts", "/wt/app/test/b.test.ts"],
      total: 4,
    }),
    ranFiles: ["test/a.test.ts", "test/b.test.ts", "test/e.test.ts"],
    absentFiles: ["test/c.test.ts"],
    notes: ["n"],
  };
  const counts = { "test/a.test.ts": 2, "test/b.test.ts": 2, "test/e.test.ts": 1 };

  it("exact: filtered to the member's ran files, total from the counts", () => {
    expect(deriveSharedRecheck(shared, counts, ["/r/app/test/a.test.ts", "/r/app/test/c.test.ts"], "/r/app", "linux")).toEqual({
      kind: "exact",
      result: run({ failingIds: ["test/a.test.ts > x"], failingFiles: ["/wt/app/test/a.test.ts"], total: 2 }),
      ranFiles: ["test/a.test.ts"],
      absentFiles: ["test/c.test.ts"],
      notes: ["n"],
    });
  });

  it("exact: every file of the member absent -> undefined result", () => {
    expect(deriveSharedRecheck(shared, counts, ["/r/app/test/c.test.ts"], "/r/app", "linux")).toEqual({
      kind: "exact",
      result: undefined,
      ranFiles: [],
      absentFiles: ["test/c.test.ts"],
      notes: ["n"],
    });
  });

  it("exact: a ran file with no failing id at the reference is exact with counts", () => {
    const r = deriveSharedRecheck(shared, counts, ["/r/app/test/e.test.ts"], "/r/app", "linux");
    expect(r).toMatchObject({ kind: "exact", result: { failingIds: [], failingFiles: [], total: 1, complete: true } });
  });

  it("exact: the same without counts splits", () => {
    expect(deriveSharedRecheck(shared, undefined, ["/r/app/test/e.test.ts"], "/r/app", "linux")).toBe("split");
  });

  it("exact: without counts, a failing id keeps the shared total", () => {
    expect(deriveSharedRecheck(shared, undefined, ["/r/app/test/b.test.ts"], "/r/app", "linux")).toMatchObject({
      kind: "exact",
      result: { failingIds: ["test/b.test.ts > y"], failingFiles: ["/wt/app/test/b.test.ts"], total: 4 },
    });
  });

  it("exact: the member's ran files hold 0 tests -> unusable incomplete", () => {
    expect(deriveSharedRecheck(shared, { ...counts, "test/a.test.ts": 0 }, ["/r/app/test/a.test.ts"], "/r/app", "linux")).toEqual({
      kind: "unusable",
      cause: "incomplete",
      reason: "rerun ran no tests although every input is a test file",
    });
  });

  it("exact: a member file neither ran nor absent splits", () => {
    expect(deriveSharedRecheck(shared, counts, ["/r/app/test/d.test.ts"], "/r/app", "linux")).toBe("split");
  });

  it("exact: ran files without a shared result split", () => {
    expect(deriveSharedRecheck({ ...shared, result: undefined }, counts, ["/r/app/test/a.test.ts"], "/r/app", "linux")).toBe("split");
  });

  it("exact: rerun files take the longest matching key", () => {
    const nested: RecheckOutcome = {
      kind: "exact",
      result: run({ failingIds: ["sub/x.test.ts > b", "x.test.ts > a"], failingFiles: ["/wt/sub/x.test.ts", "/wt/x.test.ts"], total: 2 }),
      ranFiles: ["x.test.ts", "sub/x.test.ts"],
      absentFiles: [],
      notes: [],
    };
    expect(deriveSharedRecheck(nested, { "x.test.ts": 1, "sub/x.test.ts": 1 }, ["/r/x.test.ts"], "/r", "linux")).toMatchObject({
      result: { failingIds: ["x.test.ts > a"], failingFiles: ["/wt/x.test.ts"], total: 1 },
      ranFiles: ["x.test.ts"],
    });
  });

  it("win32: member files, keys and rerun paths match case-insensitively", () => {
    const w: RecheckOutcome = {
      kind: "exact",
      result: run({ failingIds: ["test/a.test.ts > x"], failingFiles: ["D:\\wt\\Test\\A.test.ts"], total: 3 }),
      ranFiles: ["test/a.test.ts"],
      absentFiles: [],
      notes: [],
    };
    expect(deriveSharedRecheck(w, { "Test/A.test.ts": 3 }, ["c:\\r\\Test\\A.test.ts"], "C:\\R", "win32")).toMatchObject({
      kind: "exact",
      result: { failingIds: ["test/a.test.ts > x"], failingFiles: ["D:\\wt\\Test\\A.test.ts"], total: 3 },
      ranFiles: ["test/a.test.ts"],
    });
    expect(deriveSharedRecheck(w, undefined, ["/R/Test/A.test.ts"], "/R", "linux")).toBe("split");
  });
});

// ---------------------------------------------------------------------------------------------
// B9: batch deadline
// ---------------------------------------------------------------------------------------------

interface FakeDeadline extends Deadline {
  abort(): void;
  listeners: Set<unknown>;
}

function fake(budgetMs: number, remainingMs: number): FakeDeadline {
  const ctl = new AbortController();
  const listeners = new Set<unknown>();
  const signal = ctl.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  vi.spyOn(signal, "addEventListener").mockImplementation((type, listener, options) => {
    listeners.add(listener);
    add(type, listener, options);
  });
  vi.spyOn(signal, "removeEventListener").mockImplementation((type, listener, options) => {
    listeners.delete(listener);
    remove(type, listener, options);
  });
  return {
    budgetMs,
    remaining: () => (signal.aborted ? 0 : remainingMs),
    bound: (ms) => Math.min(ms, signal.aborted ? 0 : remainingMs),
    signal,
    abort: () => ctl.abort(),
    listeners,
  };
}

describe("createBatchDeadline", () => {
  it("remaining is the largest attached remaining, bound clamps, budget is the largest budget", () => {
    const a = fake(1000, 300);
    const b = fake(5000, 700);
    const d = createBatchDeadline([a, b]);
    expect(d.budgetMs).toBe(5000);
    expect(d.remaining()).toBe(700);
    expect(d.bound(500)).toBe(500);
    expect(d.bound(Number.POSITIVE_INFINITY)).toBe(700);
    expect(d.signal.aborted).toBe(false);
    d.dispose();
  });

  it("a released member no longer counts; releasing everyone aborts and leaves no listener", () => {
    const a = fake(1000, 300);
    const b = fake(5000, 700);
    const d = createBatchDeadline([a, b]);
    d.release(b);
    expect(b.listeners.size).toBe(0);
    expect(d.remaining()).toBe(300);
    d.release(b); // idempotent
    expect(d.signal.aborted).toBe(false);
    d.release(a);
    expect(d.signal.aborted).toBe(true);
    expect(d.remaining()).toBe(0);
    expect(a.listeners.size).toBe(0);
  });

  it("aborts only once every attached member has aborted", () => {
    const a = fake(1000, 300);
    const b = fake(5000, 700);
    const d = createBatchDeadline([a, b]);
    a.abort();
    expect(d.signal.aborted).toBe(false);
    expect(d.remaining()).toBe(700);
    b.abort();
    expect(d.signal.aborted).toBe(true);
    expect(d.remaining()).toBe(0);
    expect(a.listeners.size + b.listeners.size).toBe(0);
  });

  it("releasing the last live member when the rest have aborted aborts", () => {
    const a = fake(1000, 300);
    const b = fake(5000, 700);
    const d = createBatchDeadline([a, b]);
    a.abort();
    d.release(b);
    expect(d.signal.aborted).toBe(true);
    expect(a.listeners.size + b.listeners.size).toBe(0);
  });

  it("dispose aborts, removes every listener and is idempotent", () => {
    const a = fake(1000, 300);
    const b = fake(5000, 700);
    const d = createBatchDeadline([a, b, a]);
    expect(a.listeners.size).toBe(1);
    d.dispose();
    expect(d.signal.aborted).toBe(true);
    expect(a.listeners.size + b.listeners.size).toBe(0);
    d.dispose();
    expect(d.signal.aborted).toBe(true);
    expect(a.signal.aborted).toBe(false);
  });

  it("no members, or members already aborted, abort at once", () => {
    const empty = createBatchDeadline([]);
    expect(empty.signal.aborted).toBe(true);
    expect(empty.remaining()).toBe(0);
    expect(empty.budgetMs).toBe(0);
    const a = fake(1000, 300);
    a.abort();
    const d = createBatchDeadline([a]);
    expect(d.signal.aborted).toBe(true);
    expect(a.listeners.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// createBatchCoordinator: fakes (fake timers; a model repository behind fake planner and scope seams)
// ---------------------------------------------------------------------------------------------

const WINDOW = 100;
const ROOT = "/r";

interface TestDeadline extends Deadline {
  abort(): void;
}

/** A gate deadline on the (fake) clock. It has no timer: the owner aborts it, as withTimeout does. */
function liveDeadline(budgetMs = 60_000): TestDeadline {
  const ctl = new AbortController();
  const start = Date.now();
  const remaining = () => (ctl.signal.aborted ? 0 : Math.max(0, budgetMs - (Date.now() - start)));
  return { budgetMs, remaining, bound: (ms) => Math.min(ms, remaining()), signal: ctl.signal, abort: () => ctl.abort() };
}

const REF: DispatchReference = {
  root: ROOT,
  head: "h1",
  commit: "c1",
  untracked: new Map(),
  tracked: new Map(),
  captureReasons: [],
  capturedAt: 0,
};

interface TestRequest extends TestsPassRequest {
  readonly deadline: TestDeadline;
}

function req(files: readonly string[], over: Partial<TestRequest> = {}): TestRequest {
  return {
    command: "npx vitest run",
    cwd: ROOT,
    testScope: "affected",
    changedFiles: files.map((path) => ({ path, status: "M" })),
    reference: { kind: "captured", reference: REF },
    deadline: liveDeadline(),
    ...over,
  };
}

/** The model repository: which test files relate to which source, and what fails now and at the reference. */
interface Model {
  /** Source key (cwd-relative) -> its related test files. A test file relates to itself. */
  readonly related?: Readonly<Record<string, readonly string[]>>;
  /** Test file -> its number of tests (default 2). */
  readonly tests?: Readonly<Record<string, number>>;
  /** Test file -> the names failing in the live tree. */
  readonly failing?: Readonly<Record<string, readonly string[]>>;
  /** Test file -> the names failing at the reference; a file missing here is absent there. */
  readonly atRef?: Readonly<Record<string, readonly string[]>>;
  /** false: reports carry no per-file counts (P1 absent). */
  readonly counts?: boolean;
}

const MODEL: Model = {
  related: Object.fromEntries([..."abcdefgh"].map((x) => [`src/${x}.ts`, [`test/${x}.test.ts`]])),
};

const isTestKey = (k: string) => /\.test\.ts$|(^|\/)test_[^/]*\.py$/.test(k);
const idOf = (runner: RunnerKind, file: string, name: string) => (runner === "pytest" ? `${file}::${name}` : `${file} > ${name}`);
const keyOfId = (id: string) => id.split(/ > |::/)[0] ?? id;

/** readResult over the model, with its zero-test guard and per-file counts. */
function runModel(model: Model, spec: ScopedSpec): RunResult {
  const files = new Set<string>();
  for (const abs of spec.inputs) {
    const k = posix.relative(spec.cwd, abs);
    if (spec.inputsAreTests || isTestKey(k)) files.add(k);
    for (const t of model.related?.[k] ?? []) files.add(t);
  }
  const keys = [...files].sort();
  const failingIds = keys.flatMap((k) => (model.failing?.[k] ?? []).map((n) => idOf(spec.runner, k, n))).sort();
  const failingFiles = [...new Set(failingIds.map(keyOfId))].map((k) => posix.join(spec.cwd, k)).sort();
  const testsByFile: Record<string, number> = Object.fromEntries(keys.map((k) => [k, model.tests?.[k] ?? 2]));
  const total = keys.reduce((n, k) => n + (testsByFile[k] ?? 0), 0);
  const guard = total === 0 && (spec.inputsAreTests || spec.inputs.some((f) => isTestKey(posix.relative(spec.cwd, f))));
  return {
    failingIds,
    failingFiles,
    collectionError: false,
    total,
    complete: !guard,
    source: "report",
    ...(guard ? { note: `${spec.runner} ran no tests although a test file was passed` } : {}),
    ...(model.counts === false ? {} : { testsByFile }),
  };
}

function ranModel(model: Model, spec: ScopedSpec): ScopedOutcome {
  const result = runModel(model, spec);
  return { kind: "ran", result, exitCode: result.failingIds.length > 0 ? 1 : 0, spec, notes: spec.notes };
}

/** 2.1's Rechecker over the model: pytest is runner-unsupported; vitest reruns the files present at the reference. */
function recheckModel(model: Model, command: string, cwd: string, files: readonly string[]): RecheckOutcome {
  if (command.split(" ").includes("pytest")) return { kind: "unusable", cause: "runner-unsupported", reason: "pytest imports the live tree" };
  const keys = [...new Set(files.map((f) => posix.relative(cwd, f)))].sort();
  const ranFiles = keys.filter((k) => model.atRef?.[k] !== undefined);
  const absentFiles = keys.filter((k) => model.atRef?.[k] === undefined);
  if (ranFiles.length === 0) return { kind: "exact", result: undefined, ranFiles, absentFiles, notes: [] };
  const failingIds = ranFiles.flatMap((k) => (model.atRef?.[k] ?? []).map((n) => idOf("vitest", k, n))).sort();
  const testsByFile: Record<string, number> = Object.fromEntries(ranFiles.map((k) => [k, model.tests?.[k] ?? 2]));
  const result: RunResult = {
    failingIds,
    failingFiles: [...new Set(failingIds.map(keyOfId))].map((k) => `/tmp/omr-ref/${k}`),
    collectionError: false,
    total: ranFiles.reduce((n, k) => n + (testsByFile[k] ?? 0), 0),
    complete: true,
    source: "report",
    ...(model.counts === false ? {} : { testsByFile }),
  };
  return { kind: "exact", result, ranFiles, absentFiles, notes: ["rechecked at the reference"] };
}

/** planScopedRun over the model. The command's words after the subcommand are kept options (B3). */
function planModel(input: BatchPlanInput, report = 0, argvCap = Number.POSITIVE_INFINITY): ScopingPlan {
  if (input.changedFiles === "unavailable") return { unverifiable: true, code: "attribution-unavailable", reason: "no change attribution" };
  const inputs = [...new Set(input.changedFiles.map((c) => posix.resolve(input.cwd, c.path)))].sort();
  if (inputs.length === 0) return { noAffected: true, note: "no affected tests" };
  if (inputs.some((f) => f.includes("untestable"))) return { unverifiable: true, code: "config-changed", reason: "a config file changed" };
  if (inputs.length > argvCap) return { unverifiable: true, code: "argv-too-long", reason: "argv too long" };
  const words = input.command.split(" ");
  const runner: RunnerKind = words.includes("pytest") ? "pytest" : words.includes("jest") ? "jest" : "vitest";
  const reportPath = `/tmp/omr-report-${report}.${runner === "pytest" ? "xml" : "json"}`;
  const entry = `${input.cwd}/node_modules/${runner}/bin.js`;
  const options = words.slice(runner === "vitest" ? 3 : 2);
  return {
    runner,
    mode: "related",
    file: runner === "pytest" ? "/usr/bin/pytest" : "/usr/bin/node",
    args:
      runner === "pytest"
        ? [`--junitxml=${reportPath}`, ...options, ...inputs]
        : [entry, "related", "--run", ...options, `--outputFile=${reportPath}`, ...inputs],
    cwd: input.cwd,
    env: { CI: "1" },
    reportPath,
    gitRoot: input.cwd,
    entry,
    inputs,
    inputsAreTests: runner === "pytest",
    workers: runner === "pytest" ? null : 2,
    notes: [`planned ${inputs.length} input(s)`],
  };
}

interface Calls {
  readonly events: string[];
  readonly plans: BatchPlanInput[];
  readonly planned: ScopingPlan[];
  readonly opens: { readonly cwd: string; readonly command: string }[];
  readonly executes: { readonly scope: number; readonly spec: ScopedSpec; readonly deadline: Deadline; readonly at: number }[];
  readonly rechecks: {
    readonly scope: number;
    readonly command: string;
    readonly reference: DispatchReference;
    readonly files: readonly string[];
    readonly deadline: Deadline;
  }[];
  readonly closes: number[];
  readonly direct: TestsPassRequest[];
}

interface HarnessOptions {
  /** Replaces the model run; `n` is the index of the execute call. */
  readonly execute?: (spec: ScopedSpec, deadline: Deadline, n: number) => ScopedOutcome | Promise<ScopedOutcome>;
  /** Replaces the model recheck; `n` is the index of the recheck call. */
  readonly rechecker?: (
    reference: DispatchReference,
    files: readonly string[],
    deadline: Deadline,
    n: number,
  ) => RecheckOutcome | Promise<RecheckOutcome>;
  readonly plan?: BatchPlanner;
  readonly argvCap?: number;
  readonly runtime?: Partial<BatchRuntime>;
}

/** The runtime seams, each counting its calls. A scope throws when used after its close. */
function harness(model: Model = MODEL, o: HarnessOptions = {}) {
  const calls: Calls = { events: [], plans: [], planned: [], opens: [], executes: [], rechecks: [], closes: [], direct: [] };
  let reports = 0;
  const plan: BatchPlanner = async (input, deadline) => {
    calls.plans.push(input);
    const out = o.plan !== undefined ? await o.plan(input, deadline) : planModel(input, reports++, o.argvCap);
    calls.planned.push(out);
    return out;
  };
  const openScope: OpenVerificationScope = (meta) => {
    const id = calls.opens.length;
    calls.opens.push(meta);
    calls.events.push(`open ${id}`);
    let closed = false;
    const use = (what: string) => {
      if (closed) throw new Error(`${what} after close`);
      calls.events.push(`${what} ${id}`);
    };
    return {
      execute: async (spec, deadline) => {
        use("execute");
        const n = calls.executes.push({ scope: id, spec, deadline, at: Date.now() }) - 1;
        if (deadline.signal.aborted) return { kind: "aborted", reason: "aborted before the spawn" };
        return o.execute !== undefined ? o.execute(spec, deadline, n) : ranModel(model, spec);
      },
      rechecker: (command, cwd) => async (reference, files, deadline) => {
        use("recheck");
        const n = calls.rechecks.push({ scope: id, command, reference, files, deadline }) - 1;
        return o.rechecker !== undefined ? o.rechecker(reference, files, deadline, n) : recheckModel(model, command, cwd, files);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        calls.closes.push(id);
        calls.events.push(`close ${id}`);
      },
    };
  };
  const direct: TestsPassHook = async (request) => {
    calls.direct.push(request);
    return { scoped: { kind: "no-affected", note: "direct" }, recheck: undefined };
  };
  const runtime: BatchRuntime = { direct, plan, openScope, batchWindowMs: WINDOW, recheckMinRemainingMs: 1_000, ...o.runtime };
  return { calls, runtime };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** An executor that runs until its signal aborts, as a killed tree reports. */
function untilAborted(_spec: ScopedSpec, deadline: Deadline): Promise<ScopedOutcome> {
  return new Promise((resolve) => {
    deadline.signal.addEventListener("abort", () => resolve({ kind: "aborted", reason: "tree killed" }), { once: true });
  });
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const at = (k: string, cwd = ROOT) => posix.join(cwd, k);
const aborted = (reason: string): TestsPassRun => ({ scoped: { kind: "aborted", reason }, recheck: undefined });

function specOf(plan: ScopingPlan): ScopedSpec {
  if ("noAffected" in plan || "unverifiable" in plan) throw new Error(`expected a ScopedSpec, got ${JSON.stringify(plan)}`);
  return plan;
}

function ran(run: TestsPassRun): Extract<ScopedOutcome, { kind: "ran" }> {
  if (run.scoped.kind !== "ran") throw new Error(`expected a ran outcome, got ${JSON.stringify(run.scoped)}`);
  return run.scoped;
}

// ---------------------------------------------------------------------------------------------
// createBatchCoordinator: B2 bypasses, B4 windows, B5 union run, B9 deadlines, B11 disposal
// ---------------------------------------------------------------------------------------------

describe("createBatchCoordinator: windows and the union run", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("five requests in one window: exactly one union run under one scope, five outcomes", async () => {
    const { calls, runtime } = harness();
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const names = [..."abcde"];
    const outs = names.map((x) => hook(req([`src/${x}.ts`])));
    await flush();
    expect(c.stats()).toMatchObject({ openWindows: 1, pendingRequests: 5, runningBatches: 0 });
    expect(calls.executes).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(WINDOW);
    const runs = await Promise.all(outs);
    expect(calls.opens).toEqual([{ cwd: ROOT, command: "npx vitest run" }]);
    expect(calls.executes).toHaveLength(1);
    expect(calls.executes[0]?.spec.inputs).toEqual(names.map((x) => at(`src/${x}.ts`)));
    runs.forEach((run, i) => {
      expect(run.recheck).toBeUndefined();
      const s = ran(run);
      expect(s).toMatchObject({ exitCode: 0, result: { failingIds: [], complete: true, total: 10 } });
      expect(s.spec?.inputs).toEqual([at(`src/${names[i]}.ts`)]);
      expect(s.notes).toEqual(["planned 1 input(s)", "batched: 1 run for 5 requests"]);
    });
    expect(c.stats()).toEqual({
      openWindows: 0,
      runningBatches: 0,
      pendingRequests: 0,
      unionRuns: 1,
      ownRuns: 0,
      rechecks: 0,
      splits: 0,
      taints: 0,
    });
    await c.dispose();
    expect(calls.closes).toEqual([0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("different roots, runners or kept options form separate batches, each with its own scope", async () => {
    const { calls, runtime } = harness();
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const outs = [
      hook(req(["src/a.ts"])),
      hook(req(["src/b.ts"])),
      hook(req(["src/a.ts"], { cwd: "/s" })),
      hook(req(["src/a.ts"], { command: "npx jest" })),
      hook(req(["src/c.ts"], { command: "npx vitest run -t smoke" })),
    ];
    await vi.advanceTimersByTimeAsync(WINDOW);
    const runs = await Promise.all(outs);
    expect(runs.map((r) => r.scoped.kind)).toEqual(["ran", "ran", "ran", "ran", "ran"]);
    expect(calls.opens).toHaveLength(4);
    const batches = calls.executes.map((e) => JSON.stringify([e.spec.runner, e.spec.cwd, e.spec.args.includes("smoke"), e.spec.inputs.length]));
    expect(batches.sort()).toEqual(
      [
        ["jest", ROOT, false, 1],
        ["vitest", "/s", false, 1],
        ["vitest", ROOT, false, 2],
        ["vitest", ROOT, true, 1],
      ]
        .map((x) => JSON.stringify(x))
        .sort(),
    );
    expect(new Set(calls.executes.map((e) => e.scope)).size).toBe(4);
    expect(c.stats()).toMatchObject({ unionRuns: 1, ownRuns: 3 });
    await c.dispose();
  });

  it("batchWindowMs <= 0 and testScope full use runtime.direct", async () => {
    const { calls, runtime } = harness(MODEL, { runtime: { batchWindowMs: 0 } });
    const c = createBatchCoordinator({ platform: "linux" });
    const direct = { scoped: { kind: "no-affected", note: "direct" }, recheck: undefined };
    expect(await c.hook(runtime)(req(["src/a.ts"]))).toEqual(direct);
    expect(await c.hook({ ...runtime, batchWindowMs: -1 })(req(["src/b.ts"]))).toEqual(direct);
    expect(await c.hook({ ...runtime, batchWindowMs: Number.NaN })(req(["src/b.ts"]))).toEqual(direct);
    expect(await c.hook({ ...runtime, batchWindowMs: WINDOW })(req(["src/c.ts"], { testScope: "full" }))).toEqual(direct);
    expect(calls.direct).toHaveLength(4);
    expect(calls.plans).toHaveLength(0);
    expect(calls.opens).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("planning outcomes and an exhausted deadline settle at once, without a window or the slot", async () => {
    const late = req(["src/b.ts"]);
    const { calls, runtime } = harness(MODEL, {
      plan: async (input) => {
        if (input.changedFiles !== "unavailable" && input.changedFiles.some((f) => f.path === "src/b.ts")) late.deadline.abort();
        return planModel(input);
      },
    });
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    expect(await hook(req([]))).toEqual({ scoped: { kind: "no-affected", note: "no affected tests" }, recheck: undefined });
    expect(await hook(req(["vitest.untestable.ts"]))).toEqual({
      scoped: { kind: "unverifiable", code: "config-changed", reason: "a config file changed" },
      recheck: undefined,
    });
    expect(await hook(req(["src/a.ts"], { changedFiles: "unavailable" }))).toMatchObject({
      scoped: { kind: "unverifiable", code: "attribution-unavailable" },
    });
    const gone = req(["src/a.ts"]);
    gone.deadline.abort();
    expect(await hook(gone)).toEqual(aborted(BATCH_REASONS.beforeRun));
    expect(await hook(late)).toEqual(aborted(BATCH_REASONS.beforeRun));
    expect(calls.plans).toHaveLength(4);
    expect(calls.opens).toHaveLength(0);
    expect(c.stats()).toMatchObject({ openWindows: 0, pendingRequests: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an arrival during a running batch joins the next window, never the running union", async () => {
    const gate = deferred<void>();
    const { calls, runtime } = harness(MODEL, {
      execute: async (spec, _d, n) => {
        if (n === 0) await gate.promise;
        return ranModel(MODEL, spec);
      },
    });
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const first = [hook(req(["src/a.ts"])), hook(req(["src/b.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(calls.executes).toHaveLength(1);

    const late = hook(req(["src/c.ts"]));
    await flush();
    expect(c.stats()).toMatchObject({ openWindows: 1, runningBatches: 1, pendingRequests: 3 });
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(ran(await late).spec?.inputs).toEqual([at("src/c.ts")]);
    expect(calls.executes.map((e) => [e.scope, e.spec.inputs])).toEqual([
      [0, [at("src/a.ts"), at("src/b.ts")]],
      [1, [at("src/c.ts")]],
    ]);

    gate.resolve();
    expect((await Promise.all(first)).map((r) => ran(r).exitCode)).toEqual([0, 0]);
    await c.dispose();
    expect([...calls.closes].sort()).toEqual([0, 1]);
  });

  it("the maximum size closes a window early, and so does a joiner that could not outlive the wait (W2, W3)", async () => {
    const { calls, runtime } = harness();
    const c = createBatchCoordinator({ platform: "linux", maxBatchSize: 3 });
    const hook = c.hook(runtime);
    const outs = [..."abcd"].map((x) => hook(req([`src/${x}.ts`])));
    await flush();
    expect(calls.executes.map((e) => e.spec.inputs.length)).toEqual([3]);
    expect(c.stats().openWindows).toBe(1);
    await Promise.all(outs.slice(0, 3));
    await vi.advanceTimersByTimeAsync(WINDOW);
    await outs[3];
    expect(calls.executes.map((e) => e.spec.inputs.length)).toEqual([3, 1]);

    // W3: 60 ms left in the window, and a joiner with exactly 60 ms left.
    const w3 = harness();
    const c3 = createBatchCoordinator({ platform: "linux" });
    const hook3 = c3.hook(w3.runtime);
    const long = hook3(req(["src/a.ts"]));
    await vi.advanceTimersByTimeAsync(40);
    const short = hook3(req(["src/b.ts"], { deadline: liveDeadline(60) }));
    await flush();
    expect(w3.calls.executes.map((e) => e.spec.inputs)).toEqual([[at("src/a.ts"), at("src/b.ts")]]);
    expect(vi.getTimerCount()).toBe(0);
    await Promise.all([long, short]);
    await Promise.all([c.dispose(), c3.dispose()]);
  });

  it("a maximum size that is not a safe integer >= 1 means no batching", async () => {
    for (const maxBatchSize of [0, 1.5, Number.NaN]) {
      const { calls, runtime } = harness();
      const c = createBatchCoordinator({ platform: "linux", maxBatchSize });
      const hook = c.hook(runtime);
      await Promise.all([hook(req(["src/a.ts"])), hook(req(["src/b.ts"]))]);
      expect(calls.opens).toHaveLength(2);
      expect(calls.executes.map((e) => e.spec.inputs.length)).toEqual([1, 1]);
      expect(vi.getTimerCount()).toBe(0);
      await c.dispose();
    }
  });

  it("an abort while waiting in the window settles at once; a window left empty clears its timer", async () => {
    const { calls, runtime } = harness();
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const a = req(["src/a.ts"]);
    const pa = hook(a);
    const pb = hook(req(["src/b.ts"]));
    await flush();
    a.deadline.abort();
    expect(await pa).toEqual(aborted(BATCH_REASONS.window));
    expect(c.stats().pendingRequests).toBe(1);
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(ran(await pb).exitCode).toBe(0);
    expect(calls.executes.map((e) => e.spec.inputs)).toEqual([[at("src/b.ts")]]);

    const x = req(["src/c.ts"]);
    const px = hook(x);
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    x.deadline.abort();
    expect(await px).toEqual(aborted(BATCH_REASONS.window));
    expect(vi.getTimerCount()).toBe(0);
    expect(c.stats()).toMatchObject({ openWindows: 0, pendingRequests: 0 });
    await c.dispose();
  });

  it("a requester whose deadline expires mid-batch gets aborted labelled with the phase; the batch continues", async () => {
    const gate = deferred<void>();
    const { calls, runtime } = harness(MODEL, {
      execute: async (spec) => {
        await gate.promise;
        return ranModel(MODEL, spec);
      },
    });
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const a = req(["src/a.ts"], { deadline: liveDeadline(1_000) });
    const b = req(["src/b.ts"], { deadline: liveDeadline(9_000) });
    const pa = hook(a);
    const pb = hook(b);
    await vi.advanceTimersByTimeAsync(WINDOW);
    const union = calls.executes[0];
    expect(union?.deadline.remaining()).toBe(8_900);

    await vi.advanceTimersByTimeAsync(900);
    expect(a.deadline.remaining()).toBe(0);
    a.deadline.abort();
    expect(await pa).toEqual(aborted(BATCH_REASONS.run));
    expect(union?.deadline.signal.aborted).toBe(false);
    expect(union?.deadline.remaining()).toBe(8_000);

    gate.resolve();
    expect(ran(await pb)).toMatchObject({ exitCode: 0, spec: { inputs: [at("src/b.ts")] } });
    expect(calls.executes).toHaveLength(1);
    await c.dispose();
  });

  it("when every member aborts, the union's signal aborts (the tree is killed) and nothing is spawned afterwards", async () => {
    const { calls, runtime } = harness(MODEL, { execute: untilAborted });
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const a = req(["src/a.ts"]);
    const b = req(["src/b.ts"]);
    const outs = [hook(a), hook(b)];
    await vi.advanceTimersByTimeAsync(WINDOW);
    a.deadline.abort();
    expect(calls.executes[0]?.deadline.signal.aborted).toBe(false);
    b.deadline.abort();
    expect(calls.executes[0]?.deadline.signal.aborted).toBe(true);
    expect(await Promise.all(outs)).toEqual([aborted(BATCH_REASONS.run), aborted(BATCH_REASONS.run)]);
    await flush();
    expect(calls.executes).toHaveLength(1);
    expect(calls.closes).toEqual([0]);
    expect(c.stats()).toMatchObject({ runningBatches: 0, pendingRequests: 0, ownRuns: 0 });
  });

  it("dispose settles waiting and running members, kills the runs, leaves no timer and is idempotent", async () => {
    const { calls, runtime } = harness(MODEL, { execute: untilAborted });
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const running = [hook(req(["src/a.ts"])), hook(req(["src/b.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    const waiting = hook(req(["src/c.ts"]));
    const alone = hook(req(["src/d.ts"], { command: "npx jest" }));
    await vi.advanceTimersByTimeAsync(WINDOW / 2);
    const single = hook(req(["src/e.ts"], { command: "npx jest -i" }));
    await flush();
    expect(c.stats()).toMatchObject({ openWindows: 3, runningBatches: 1, pendingRequests: 5 });

    await c.dispose();
    const gone = aborted(BATCH_REASONS.disposed);
    expect(await Promise.all([...running, waiting, alone, single])).toEqual([gone, gone, gone, gone, gone]);
    expect(calls.executes[0]?.deadline.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(calls.closes).toEqual([0]);
    await flush();
    expect(c.stats()).toMatchObject({ openWindows: 0, runningBatches: 0, pendingRequests: 0 });
    expect(await hook(req(["src/f.ts"]))).toEqual(gone);
    await c.dispose();
    expect(calls.executes).toHaveLength(1);
  });

  it("dispose kills a batch of one that runs under the member's own deadline", async () => {
    const { calls, runtime } = harness(MODEL, { execute: untilAborted });
    const c = createBatchCoordinator({ platform: "linux" });
    const out = c.hook(runtime)(req(["src/a.ts"]));
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(calls.executes[0]?.deadline.signal.aborted).toBe(false);
    await c.dispose();
    expect(await out).toEqual(aborted(BATCH_REASONS.disposed));
    expect(calls.executes[0]?.deadline.signal.aborted).toBe(true);
    expect(calls.executes[0]?.deadline.remaining()).toBe(0);
  });

  it("the starvation bound: a steady stream cannot keep a window open past its fixed close", async () => {
    const { calls, runtime } = harness();
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const t0 = Date.now();
    const outs: Promise<TestsPassRun>[] = [];
    for (const x of "abcdef") {
      outs.push(hook(req([`src/${x}.ts`])));
      await vi.advanceTimersByTimeAsync(30);
    }
    await vi.advanceTimersByTimeAsync(WINDOW);
    await Promise.all(outs);
    // a..d arrived at 0, 30, 60, 90: closed at 100. e opened the next window at 120; f joined at 150.
    expect(calls.executes.map((e) => [e.at - t0, e.spec.inputs.length])).toEqual([
      [100, 4],
      [220, 2],
    ]);
    await c.dispose();
  });

  it("a batch holds one scope: opened once, every run and recheck inside it, closed after the last", async () => {
    const model: Model = { ...MODEL, failing: { "test/b.test.ts": ["fails"] }, atRef: { "test/b.test.ts": [] } };
    const { calls, runtime } = harness(model);
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const outs = [..."abc"].map((x) => hook(req([`src/${x}.ts`])));
    await vi.advanceTimersByTimeAsync(WINDOW);
    await Promise.all(outs);
    await flush();
    expect(calls.events).toEqual(["open 0", "execute 0", "execute 0", "execute 0", "execute 0", "recheck 0", "close 0"]);
    await c.dispose();
  });

  it("a batch of one runs the member's own spec under the member's own deadline (the direct path)", async () => {
    const { calls, runtime } = harness();
    const c = createBatchCoordinator({ platform: "linux" });
    const a = req(["src/a.ts"], { deadline: liveDeadline(5_000) });
    const out = c.hook(runtime)(a);
    await vi.advanceTimersByTimeAsync(WINDOW);
    const run = await out;
    expect(calls.plans).toHaveLength(1);
    expect(calls.executes[0]?.spec).toBe(calls.planned[0]);
    expect(calls.executes[0]?.deadline.remaining()).toBe(a.deadline.remaining());
    expect(calls.executes[0]?.deadline.bound(100)).toBe(100);
    expect(run).toEqual({ scoped: ranModel(MODEL, calls.executes[0]?.spec ?? spec()), recheck: undefined });
    expect(c.stats()).toMatchObject({ unionRuns: 0, ownRuns: 1 });
    await c.dispose();
  });

  it("an inconsistent union plan splits the batch into own runs, logged once", async () => {
    const union = (input: BatchPlanInput) => input.changedFiles !== "unavailable" && input.changedFiles.length > 1;
    const cases: [string, HarnessOptions][] = [
      ["a union-only S6", { argvCap: 1 }],
      [
        "a rejected union plan",
        {
          plan: async (input) => {
            if (union(input)) throw new Error("search failed");
            return planModel(input);
          },
        },
      ],
      ["a union with nothing to run", { plan: async (input) => (union(input) ? { noAffected: true, note: "none" } : planModel(input)) }],
      [
        "a union with other options",
        { plan: async (input) => planModel(union(input) ? { ...input, command: "npx vitest run --bail" } : input) },
      ],
      [
        "a union with other inputs",
        {
          plan: async (input) =>
            planModel(union(input) && input.changedFiles !== "unavailable" ? { ...input, changedFiles: input.changedFiles.slice(1) } : input),
        },
      ],
    ];
    for (const [what, o] of cases) {
      const { calls, runtime } = harness(MODEL, o);
      const warn = vi.fn();
      const c = createBatchCoordinator({ platform: "linux", logger: { warn } });
      const hook = c.hook(runtime);
      const outs = [hook(req(["src/a.ts"])), hook(req(["src/b.ts"]))];
      await vi.advanceTimersByTimeAsync(WINDOW);
      const runs = await Promise.all(outs);
      expect(runs.map((r) => ran(r).spec?.inputs), what).toEqual([[at("src/a.ts")], [at("src/b.ts")]]);
      expect(runs.map((r) => ran(r).notes), what).toEqual([["planned 1 input(s)"], ["planned 1 input(s)"]]);
      expect(calls.opens, what).toHaveLength(1);
      expect(c.stats(), what).toMatchObject({ unionRuns: 0, ownRuns: 2, splits: 1 });
      expect(warn, what).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0], what).toContain("split");
      await c.dispose();
    }
  });

  it("a busy slot reaches every member; a timed-out or failed union falls back to own runs", async () => {
    const busy: ScopedOutcome = { kind: "slot-busy", waitedMs: 30_000, deadlineCut: false };
    const b1 = harness(MODEL, { execute: () => busy });
    const c1 = createBatchCoordinator({ platform: "linux" });
    const outs1 = [c1.hook(b1.runtime)(req(["src/a.ts"])), c1.hook(b1.runtime)(req(["src/b.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(await Promise.all(outs1)).toEqual([
      { scoped: busy, recheck: undefined },
      { scoped: busy, recheck: undefined },
    ]);
    expect(b1.calls.executes).toHaveLength(1);

    for (const first of [{ kind: "timed-out", boundMs: 120_000 }, { kind: "error", reason: "spawn failed" }] as const) {
      const h = harness(MODEL, { execute: (spec, _d, n) => (n === 0 ? first : ranModel(MODEL, spec)) });
      const c = createBatchCoordinator({ platform: "linux" });
      const outs = [c.hook(h.runtime)(req(["src/a.ts"])), c.hook(h.runtime)(req(["src/b.ts"]))];
      await vi.advanceTimersByTimeAsync(WINDOW);
      const runs = await Promise.all(outs);
      expect(runs.map((r) => ran(r).spec?.inputs)).toEqual([[at("src/a.ts")], [at("src/b.ts")]]);
      expect(h.calls.executes).toHaveLength(3);
      expect(c.stats()).toMatchObject({ unionRuns: 1, ownRuns: 2 });
      await c.dispose();
    }
    await c1.dispose();
  });

  it("the union plan deduplicates overlapping change sets", async () => {
    const { calls, runtime } = harness();
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const outs = [hook(req(["src/a.ts", "src/shared.ts"])), hook(req([at("src/shared.ts"), "src/b.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    await Promise.all(outs);
    expect(calls.plans[2]?.changedFiles).toEqual([
      { path: at("src/a.ts"), status: "M" },
      { path: at("src/shared.ts"), status: "M" },
      { path: at("src/b.ts"), status: "M" },
    ]);
    expect(calls.executes.map((e) => e.spec.inputs)).toEqual([[at("src/a.ts"), at("src/b.ts"), at("src/shared.ts")]]);
    await c.dispose();
  });

  it("the hook never rejects when a seam throws", async () => {
    const boom = () => {
      throw new Error("boom");
    };
    const warn = vi.fn();
    const c = createBatchCoordinator({ platform: "linux", logger: { warn } });

    const planning = harness(MODEL, { plan: async () => boom() });
    expect(await c.hook(planning.runtime)(req(["src/a.ts"]))).toEqual({
      scoped: { kind: "error", reason: "scoped run planning failed: boom" },
      recheck: undefined,
    });

    const direct = harness(MODEL, { runtime: { batchWindowMs: 0, direct: async () => boom() } });
    expect(await c.hook(direct.runtime)(req(["src/a.ts"]))).toEqual({
      scoped: { kind: "error", reason: "verification coordinator failed: boom" },
      recheck: undefined,
    });

    const opening = harness(MODEL, { runtime: { openScope: boom } });
    const opened = [c.hook(opening.runtime)(req(["src/a.ts"])), c.hook(opening.runtime)(req(["src/b.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    const failed = { scoped: { kind: "error", reason: "verification batch failed: boom" }, recheck: undefined };
    expect(await Promise.all(opened)).toEqual([failed, failed]);

    const executing = harness(MODEL, { execute: boom });
    const executed = [c.hook(executing.runtime)(req(["src/a.ts"])), c.hook(executing.runtime)(req(["src/b.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    const spawnFailed = { scoped: { kind: "error", reason: "scoped run failed: boom" }, recheck: undefined };
    expect(await Promise.all(executed)).toEqual([spawnFailed, spawnFailed]);
    expect(executing.calls.executes).toHaveLength(3);

    const failing: Model = { ...MODEL, failing: { "test/a.test.ts": ["x"] } };
    const rechecking = harness(failing, { rechecker: boom });
    const rechecked = c.hook(rechecking.runtime)(req(["src/a.ts"]));
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect((await rechecked).recheck).toEqual({ kind: "unusable", cause: "error", reason: "recheck failed: boom" });

    const inner = harness();
    const closing = harness(MODEL, { runtime: { openScope: (meta) => ({ ...inner.runtime.openScope(meta), close: async () => boom() }) } });
    const closed = c.hook(closing.runtime)(req(["src/a.ts"]));
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(ran(await closed).exitCode).toBe(0);
    await c.dispose();
    expect(warn).toHaveBeenCalledWith("verify batch: scope close failed", { error: "boom" });
  });

  it("sweep evicts a batch whose seam never returned once the grace period has passed", async () => {
    const { calls, runtime } = harness(MODEL, { execute: () => new Promise<ScopedOutcome>(() => undefined) });
    const warn = vi.fn();
    const c = createBatchCoordinator({ platform: "linux", logger: { warn } });
    const hook = c.hook(runtime);
    const a = req(["src/a.ts"]);
    const b = req(["src/b.ts"]);
    const outs = [hook(a), hook(b)];
    await vi.advanceTimersByTimeAsync(WINDOW);
    a.deadline.abort();
    b.deadline.abort();
    expect(await Promise.all(outs)).toEqual([aborted(BATCH_REASONS.run), aborted(BATCH_REASONS.run)]);
    expect(c.stats().runningBatches).toBe(1);
    expect(c.sweep()).toBe(0);
    await vi.advanceTimersByTimeAsync(BATCH_STALE_GRACE_MS + 1);
    expect(c.sweep()).toBe(1);
    expect(c.stats().runningBatches).toBe(0);
    expect(warn).toHaveBeenCalledWith("verify batch: evicted a batch whose seam never returned", expect.objectContaining({ members: 2 }));
    await c.dispose();
    expect(calls.closes).toEqual([0]);
  });

  it("uses the injected timers and clock", async () => {
    let t = 1_000;
    const handles: (() => void)[] = [];
    const timers = {
      setTimeout: vi.fn((callback: () => void) => handles.push(callback)),
      clearTimeout: vi.fn(),
    };
    const { calls, runtime } = harness();
    const c = createBatchCoordinator({ platform: "linux", timers, now: () => t });
    const out = c.hook(runtime)(req(["src/a.ts"]));
    await flush();
    expect(timers.setTimeout).toHaveBeenCalledWith(expect.any(Function), WINDOW);
    t += WINDOW;
    handles[0]?.();
    expect(ran(await out).exitCode).toBe(0);
    expect(timers.clearTimeout).toHaveBeenCalledWith(1);
    expect(calls.executes).toHaveLength(1);
    await c.dispose();
  });
});

// ---------------------------------------------------------------------------------------------
// createBatchCoordinator: B7 attribution, B7.5 taint, B8 shared recheck
// ---------------------------------------------------------------------------------------------

describe("createBatchCoordinator: attribution and rechecks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Submits one request per change set in one window and returns the settled runs. */
  async function batch(runtime: BatchRuntime, requests: readonly TestRequest[], options: Parameters<typeof createBatchCoordinator>[0] = {}) {
    const c = createBatchCoordinator({ platform: "linux", ...options });
    const hook = c.hook(runtime);
    const outs = requests.map((r) => hook(r));
    await vi.advanceTimersByTimeAsync(WINDOW);
    const runs = await Promise.all(outs);
    await c.dispose();
    return { runs, stats: c.stats() };
  }

  const sharedFile = (file: string): Model => ({
    related: Object.fromEntries([..."abcd"].map((x) => [`src/${x}.ts`, [`test/${x}.test.ts`, file]])),
  });

  it("a union failure in one member's file fails only that member: 1 + n runs (mode B), outcomes as direct", async () => {
    const model: Model = { ...MODEL, failing: { "test/b.test.ts": ["breaks"] }, atRef: { "test/b.test.ts": [] } };
    const { calls, runtime } = harness(model);
    const { runs, stats } = await batch(runtime, [req(["src/a.ts"]), req(["src/b.ts"]), req(["src/c.ts"])]);
    expect(calls.executes).toHaveLength(4);
    expect(calls.executes.slice(1).map((e) => e.spec)).toEqual(calls.planned.slice(0, 3));
    const own = calls.planned.slice(0, 3).map(specOf);
    expect(runs).toEqual([
      { scoped: ranModel(model, own[0] ?? spec()), recheck: undefined },
      { scoped: ranModel(model, own[1] ?? spec()), recheck: recheckModel(model, "npx vitest run", ROOT, [at("test/b.test.ts")]) },
      { scoped: ranModel(model, own[2] ?? spec()), recheck: undefined },
    ]);
    expect(ran(runs[1] ?? aborted("")).result.failingIds).toEqual(["test/b.test.ts > breaks"]);
    expect(calls.rechecks.map((r) => r.files)).toEqual([[at("test/b.test.ts")]]);
    expect(stats).toMatchObject({ unionRuns: 1, ownRuns: 3, rechecks: 1, taints: 0, splits: 0 });
  });

  it("a failing file related to two members: both are rechecked, through one shared recheck", async () => {
    const model: Model = { ...sharedFile("test/shared.test.ts"), failing: { "test/shared.test.ts": ["new"] }, atRef: { "test/shared.test.ts": [] } };
    const { calls, runtime } = harness({
      ...model,
      related: { ...model.related, "src/c.ts": ["test/c.test.ts"] },
    });
    const { runs, stats } = await batch(runtime, [req(["src/a.ts"]), req(["src/b.ts"]), req(["src/c.ts"])]);
    expect(calls.rechecks.map((r) => r.files)).toEqual([[at("test/shared.test.ts")]]);
    const exact = {
      kind: "exact",
      result: { failingIds: [], failingFiles: [], collectionError: false, total: 2, complete: true, source: "report" },
      ranFiles: ["test/shared.test.ts"],
      absentFiles: [],
      notes: ["rechecked at the reference"],
    };
    expect(runs.map((r) => r.recheck)).toEqual([exact, exact, undefined]);
    expect(runs.map((r) => ran(r).result.failingIds)).toEqual([["test/shared.test.ts > new"], ["test/shared.test.ts > new"], []]);
    expect(stats).toMatchObject({ unionRuns: 1, ownRuns: 3, rechecks: 1 });
  });

  it("a pre-existing failure shared by every member at one reference: a single recheck, all derive exact, one scope", async () => {
    const model: Model = { ...sharedFile("test/common.test.ts"), failing: { "test/common.test.ts": ["old"] }, atRef: { "test/common.test.ts": ["old"] } };
    const { calls, runtime } = harness(model);
    const { runs, stats } = await batch(runtime, [..."abcd"].map((x) => req([`src/${x}.ts`])));
    expect(calls.rechecks).toHaveLength(1);
    for (const run of runs) {
      expect(run.recheck).toEqual({
        kind: "exact",
        result: {
          failingIds: ["test/common.test.ts > old"],
          failingFiles: ["/tmp/omr-ref/test/common.test.ts"],
          collectionError: false,
          total: 2,
          complete: true,
          source: "report",
        },
        ranFiles: ["test/common.test.ts"],
        absentFiles: [],
        notes: ["rechecked at the reference"],
      });
    }
    expect(stats).toMatchObject({ unionRuns: 1, ownRuns: 4, rechecks: 1 });
    expect(calls.events).toEqual(["open 0", ...Array.from({ length: 5 }, () => "execute 0"), "recheck 0", "close 0"]);
  });

  it("distinct references get one recheck each", async () => {
    const model: Model = { ...sharedFile("test/common.test.ts"), failing: { "test/common.test.ts": ["old"] }, atRef: { "test/common.test.ts": ["old"] } };
    const { calls, runtime } = harness(model);
    const other: DispatchReference = { ...REF, commit: "c2" };
    const { runs, stats } = await batch(runtime, [
      req(["src/a.ts"]),
      req(["src/b.ts"], { reference: { kind: "captured", reference: other } }),
      req(["src/c.ts"]),
    ]);
    expect(calls.rechecks.map((r) => r.reference.commit).sort()).toEqual(["c1", "c2"]);
    expect(runs.map((r) => r.recheck?.kind)).toEqual(["exact", "exact", "exact"]);
    expect(stats.rechecks).toBe(2);
  });

  it("a run-level unusable shared recheck splits into own rechecks; a reference-level one is shared", async () => {
    const model: Model = {
      ...MODEL,
      failing: { "test/a.test.ts": ["x"], "test/b.test.ts": ["y"] },
      atRef: { "test/a.test.ts": [], "test/b.test.ts": ["y"] },
    };
    const collection: RecheckOutcome = { kind: "unusable", cause: "collection-error", reason: "setup failed at the reference" };
    const split = harness(model, {
      rechecker: (_ref, files, _d, n) => (n === 0 ? collection : recheckModel(model, "npx vitest run", ROOT, files)),
    });
    const warn = vi.fn();
    const one = await batch(split.runtime, [req(["src/a.ts"]), req(["src/b.ts"])], { logger: { warn } });
    expect(split.calls.rechecks.map((r) => r.files)).toEqual([[at("test/a.test.ts"), at("test/b.test.ts")], [at("test/a.test.ts")], [at("test/b.test.ts")]]);
    expect(one.runs.map((r) => r.recheck)).toEqual([
      recheckModel(model, "npx vitest run", ROOT, [at("test/a.test.ts")]),
      recheckModel(model, "npx vitest run", ROOT, [at("test/b.test.ts")]),
    ]);
    expect(one.stats.rechecks).toBe(3);
    expect(warn).toHaveBeenCalledWith("verify batch: a shared recheck split into own rechecks", { members: 2, shared: "unusable" });

    const vanished: RecheckOutcome = { kind: "unusable", cause: "reference-vanished", reason: "stash commit missing" };
    const shared = harness(model, { rechecker: () => vanished });
    const two = await batch(shared.runtime, [req(["src/a.ts"]), req(["src/b.ts"])]);
    expect(two.runs.map((r) => r.recheck)).toEqual([vanished, vanished]);
    expect(shared.calls.rechecks).toHaveLength(1);
  });

  it("a member below the recheck threshold gets skipped-deadline and leaves its group", async () => {
    const model: Model = { ...sharedFile("test/common.test.ts"), failing: { "test/common.test.ts": ["old"] }, atRef: { "test/common.test.ts": ["old"] } };
    const { calls, runtime } = harness(model);
    const { runs } = await batch(runtime, [req(["src/a.ts"], { deadline: liveDeadline(1_050) }), req(["src/b.ts"])]);
    expect(runs[0]?.recheck).toEqual({ kind: "skipped-deadline", remainingMs: 950 });
    expect(runs[1]?.recheck?.kind).toBe("exact");
    expect(calls.rechecks).toHaveLength(1);
    expect(calls.rechecks[0]?.deadline.remaining()).toBe(59_900);
  });

  it("reference disabled or none: decided without a recheck", async () => {
    const model: Model = { ...MODEL, failing: { "test/a.test.ts": ["x"], "test/b.test.ts": ["y"] } };
    const { calls, runtime } = harness(model);
    const { runs } = await batch(runtime, [
      req(["src/a.ts"], { reference: { kind: "disabled" } }),
      req(["src/b.ts"], { reference: { kind: "none", reason: "dispatch not tracked" } }),
    ]);
    expect(runs.map((r) => r.recheck)).toEqual([
      { kind: "disabled" },
      { kind: "unusable", cause: "no-reference", reason: "dispatch not tracked" },
    ]);
    expect(calls.rechecks).toHaveLength(0);
  });

  it("the flaky taint: a union failure that no own run reproduces makes every member incomplete", async () => {
    const flaky: Model = { ...MODEL, failing: { "test/a.test.ts": ["flaky"] } };
    const warn = vi.fn();
    const { calls, runtime } = harness(MODEL, { execute: (spec, _d, n) => ranModel(n === 0 ? flaky : MODEL, spec) });
    const { runs, stats } = await batch(runtime, [req(["src/a.ts"]), req(["src/b.ts"])], { logger: { warn } });
    expect(calls.executes).toHaveLength(3);
    for (const run of runs) {
      expect(run.recheck).toBeUndefined();
      expect(ran(run).result).toMatchObject({
        failingIds: [],
        complete: false,
        note: "batched run failure not reproduced by any request's own run: test/a.test.ts > flaky",
      });
    }
    expect(stats.taints).toBe(1);
    expect(warn).toHaveBeenCalledWith("verify batch: a batched run failure was not reproduced by any request's own run", {
      ids: ["test/a.test.ts > flaky"],
    });
  });

  it("pytest: static attribution from the union's report, without a process", async () => {
    const model: Model = { failing: { "tests/test_b.py": ["test_x"] }, tests: { "tests/test_c.py": 0 } };
    const { calls, runtime } = harness(model);
    const requests = ["a", "b", "c"].map((x) => req([`tests/test_${x}.py`], { command: "pytest" }));
    const { runs, stats } = await batch(runtime, requests);
    expect(calls.executes).toHaveLength(1);
    const own = calls.planned.slice(0, 3).map(specOf);
    runs.forEach((run, i) => {
      const direct = runModel(model, own[i] ?? spec());
      const s = ran(run);
      expect(s.result).toMatchObject({
        failingIds: direct.failingIds,
        failingFiles: direct.failingFiles,
        total: direct.total,
        complete: direct.complete,
      });
      expect(s.result.note).toBe(direct.note);
      expect(s.notes).toEqual(["planned 1 input(s)", "batched: 1 run for 3 requests"]);
    });
    expect(runs.map((r) => ran(r).exitCode)).toEqual([0, 1, 5]);
    expect(runs.map((r) => r.recheck)).toEqual([undefined, { kind: "unusable", cause: "runner-unsupported", reason: "pytest imports the live tree" }, undefined]);
    expect(stats).toMatchObject({ unionRuns: 1, ownRuns: 0, rechecks: 1, taints: 0 });

    // Without per-file counts, the members with no failure of their own confirm by running alone.
    const bare = harness({ ...model, counts: false });
    const without = await batch(bare.runtime, ["a", "b", "c"].map((x) => req([`tests/test_${x}.py`], { command: "pytest" })));
    expect(bare.calls.executes.map((e) => e.spec.inputs)).toEqual([
      [at("tests/test_a.py"), at("tests/test_b.py"), at("tests/test_c.py")],
      [at("tests/test_a.py")],
      [at("tests/test_c.py")],
    ]);
    expect(without.runs.map((r) => [ran(r).result.failingIds, ran(r).result.complete])).toEqual([
      [[], true],
      [["tests/test_b.py::test_x"], true],
      [[], false],
    ]);
  });

  it("a guard-sensitive member of a green union: derived from per-file counts, else a confirmation run", async () => {
    const withCounts = harness();
    const one = await batch(withCounts.runtime, [req(["test/a.test.ts"]), req(["src/b.ts"])]);
    expect(withCounts.calls.executes).toHaveLength(1);
    expect(ran(one.runs[0] ?? aborted("")).result).toMatchObject({ failingIds: [], complete: true, total: 2 });
    expect(ran(one.runs[1] ?? aborted("")).result).toMatchObject({ failingIds: [], complete: true, total: 4 });

    const bare = harness({ ...MODEL, counts: false });
    const two = await batch(bare.runtime, [req(["test/a.test.ts"]), req(["src/b.ts"])]);
    expect(bare.calls.executes.map((e) => e.spec.inputs)).toEqual([[at("src/b.ts"), at("test/a.test.ts")], [at("test/a.test.ts")]]);
    expect(two.runs.map((r) => ran(r).exitCode)).toEqual([0, 0]);
    expect(two.stats).toMatchObject({ unionRuns: 1, ownRuns: 1 });
  });

  it("an abort while queued for an own run settles with the attribution phase, and that run is never spawned", async () => {
    const model: Model = { ...MODEL, failing: { "test/a.test.ts": ["x"] }, atRef: { "test/a.test.ts": ["x"] } };
    const gate = deferred<void>();
    const { calls, runtime } = harness(model, {
      execute: async (spec, _d, n) => {
        if (n === 1) await gate.promise;
        return ranModel(model, spec);
      },
    });
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const a = req(["src/a.ts"]);
    const b = req(["src/b.ts"]);
    const outs = [hook(a), hook(b)];
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(calls.executes).toHaveLength(2);
    b.deadline.abort();
    expect(await outs[1]).toEqual(aborted(BATCH_REASONS.attribution));
    gate.resolve();
    const run = await outs[0];
    expect(ran(run ?? aborted("")).result.failingIds).toEqual(["test/a.test.ts > x"]);
    expect(run?.recheck?.kind).toBe("exact");
    expect(calls.executes).toHaveLength(2);
    await c.dispose();
  });

  it("a member whose deadline ends during its own run settles with that run at once, as alone", async () => {
    const model: Model = { ...MODEL, failing: { "test/a.test.ts": ["x"], "test/b.test.ts": ["y"] }, atRef: { "test/b.test.ts": [] } };
    const gate = deferred<void>();
    const { calls, runtime } = harness(model, {
      execute: async (spec, _d, n) => {
        if (n === 1) await gate.promise;
        return ranModel(model, spec);
      },
    });
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const a = req(["src/a.ts"]);
    const d = req(["src/d.ts"], { reference: { kind: "disabled" } });
    const outs = [hook(a), hook(req(["src/b.ts"])), hook(d)];
    await vi.advanceTimersByTimeAsync(WINDOW);
    a.deadline.abort();
    expect(calls.executes[1]?.deadline.signal.aborted).toBe(true);
    gate.resolve();
    const [ra, rb, rd] = await Promise.all(outs);
    expect(ra?.recheck).toEqual({ kind: "skipped-deadline", remainingMs: 0 });
    expect(ran(ra ?? aborted("")).result.failingIds).toEqual(["test/a.test.ts > x"]);
    expect(rb?.recheck?.kind).toBe("exact");
    expect(rd).toMatchObject({ scoped: { kind: "ran", exitCode: 0 }, recheck: undefined });
    await c.dispose();

    // The same with a disabled reference reports its reference decision.
    const gate2 = deferred<void>();
    const h2 = harness(model, {
      execute: async (spec, _d, n) => {
        if (n === 1) await gate2.promise;
        return ranModel(model, spec);
      },
    });
    const c2 = createBatchCoordinator({ platform: "linux" });
    const x = req(["src/a.ts"], { reference: { kind: "disabled" } });
    const outs2 = [c2.hook(h2.runtime)(x), c2.hook(h2.runtime)(req(["src/c.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    x.deadline.abort();
    gate2.resolve();
    expect((await outs2[0])?.recheck).toEqual({ kind: "disabled" });
    await Promise.all(outs2);
    await c2.dispose();
  });

  it("an abort while waiting for a shared recheck gets timed-out; when all abort, the recheck's signal aborts", async () => {
    const model: Model = { ...sharedFile("test/common.test.ts"), failing: { "test/common.test.ts": ["old"] }, atRef: { "test/common.test.ts": ["old"] } };
    const gate = deferred<void>();
    const { calls, runtime } = harness(model, {
      rechecker: async (_ref, files) => {
        await gate.promise;
        return recheckModel(model, "npx vitest run", ROOT, files);
      },
    });
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const a = req(["src/a.ts"]);
    const outs = [hook(a), hook(req(["src/b.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(calls.rechecks).toHaveLength(1);
    a.deadline.abort();
    const ra = await outs[0];
    expect(ra?.recheck).toEqual({ kind: "timed-out", boundMs: 59_900 });
    expect(ra?.scoped.kind).toBe("ran");
    expect(calls.rechecks[0]?.deadline.signal.aborted).toBe(false);
    gate.resolve();
    expect((await outs[1])?.recheck?.kind).toBe("exact");
    await c.dispose();

    const killed = harness(model, {
      rechecker: (_ref, _files, deadline) =>
        new Promise<RecheckOutcome>((resolve) => {
          deadline.signal.addEventListener("abort", () => resolve({ kind: "timed-out", boundMs: 1 }), { once: true });
        }),
    });
    const c2 = createBatchCoordinator({ platform: "linux" });
    const members = [req(["src/a.ts"]), req(["src/b.ts"])];
    const outs2 = members.map((m) => c2.hook(killed.runtime)(m));
    await vi.advanceTimersByTimeAsync(WINDOW);
    for (const m of members) m.deadline.abort();
    expect((await Promise.all(outs2)).map((r) => r.recheck)).toEqual([
      { kind: "timed-out", boundMs: 59_900 },
      { kind: "timed-out", boundMs: 59_900 },
    ]);
    expect(killed.calls.rechecks[0]?.deadline.signal.aborted).toBe(true);
    await c2.dispose();
    expect(killed.calls.closes).toEqual([0]);
  });

  it("dispose during a shared recheck aborts it and settles every member", async () => {
    const model: Model = { ...sharedFile("test/common.test.ts"), failing: { "test/common.test.ts": ["old"] }, atRef: { "test/common.test.ts": ["old"] } };
    const { calls, runtime } = harness(model, {
      rechecker: (_ref, _files, deadline) =>
        new Promise<RecheckOutcome>((resolve) => {
          deadline.signal.addEventListener("abort", () => resolve({ kind: "timed-out", boundMs: 1 }), { once: true });
        }),
    });
    const c = createBatchCoordinator({ platform: "linux" });
    const outs = [c.hook(runtime)(req(["src/a.ts"])), c.hook(runtime)(req(["src/b.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    await c.dispose();
    expect(await Promise.all(outs)).toEqual([aborted(BATCH_REASONS.disposed), aborted(BATCH_REASONS.disposed)]);
    expect(calls.rechecks[0]?.deadline.signal.aborted).toBe(true);
    expect(calls.closes).toEqual([0]);
  });
});
