import { describe, expect, it, vi } from "vitest";
import {
  argvTemplate,
  attributeUnion,
  batchKey,
  createBatchDeadline,
  deriveSharedRecheck,
  envSignature,
  fileKeyOf,
  isGuardSensitive,
  referenceKey,
  taintUnreproduced,
  unionChangedFiles,
} from "../../src/verify/batch";
import type { DispatchReference } from "../../src/verify/reference";
import type { RunResult, ScopedSpec } from "../../src/verify/runner";
import type { Deadline, RecheckOutcome } from "../../src/verify/types";

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
