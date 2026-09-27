import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import type { VerifyBudget } from "../../src/router/config";
import type {
  DetectedRunner,
  PlannerFs,
  PlanScopedRunInput,
  ResolvedEntry,
  RunResult,
  RunnerFs,
  ScopedSpec,
  ScopingPlan,
  TestSearchSeam,
} from "../../src/verify/runner";
import type { DispatchReference, MaterializeResult, ReferenceFs, ReferenceStats } from "../../src/verify/reference";
import type { acquireSlot } from "../../src/verify/slot";
import type {
  ArgvSeam,
  Deadline,
  ExecSeam,
  RecheckOutcome,
  RecheckUnusableCause,
  Rechecker,
  ScopedOutcome,
  TestsPassRequest,
} from "../../src/verify/types";
import type { TreeSnapshot } from "../../src/verify/dispatch";
import {
  type CheckScope,
  type CommandOutcome,
  type RecheckSeams,
  ABORTED_BEFORE_RUN,
  ABORTED_DURING_RUN,
  createDirectTestsPassHook,
  createScopeOpener,
  SLOT_LOST_NOTE,
  createDeadline,
  deriveDeadline,
  fileKeyOfId,
  INERT_UNREPRODUCED,
  isInertUnreproduced,
  RECHECK_MIN_REMAINING_MS,
} from "../../src/verify/deterministic";

describe("createDeadline", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("counts down, bounds steps by the remaining time and aborts at expiry", () => {
    const d = createDeadline(5_000);
    expect(d.budgetMs).toBe(5_000);
    expect(d.remaining()).toBe(5_000);
    expect(d.bound(60_000)).toBe(5_000);
    expect(d.bound(1_000)).toBe(1_000);
    expect(d.bound(Infinity)).toBe(5_000);
    vi.advanceTimersByTime(3_000);
    expect(d.remaining()).toBe(2_000);
    expect(d.bound(60_000)).toBe(2_000);
    expect(d.signal.aborted).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(d.signal.aborted).toBe(true);
    expect(d.remaining()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(d.remaining()).toBe(0);
    expect(d.bound(1_000)).toBe(0);
  });

  it("never returns a negative bound or remaining", () => {
    const d = createDeadline(-5);
    expect(d.budgetMs).toBe(0);
    expect(d.remaining()).toBe(0);
    expect(d.bound(-10)).toBe(0);
    expect(d.bound(Number.NaN)).toBe(0);
    d.dispose();
  });

  it("uses the injected clock", () => {
    let t = 1_000;
    const d = createDeadline(500, { now: () => t });
    t += 200;
    expect(d.remaining()).toBe(300);
    t += 1_000;
    expect(d.remaining()).toBe(0);
    d.dispose();
  });

  it("abort() aborts the signal at once, zeroes remaining and clears the timer", () => {
    const d = createDeadline(60_000);
    d.abort("owner timed out");
    expect(d.signal.aborted).toBe(true);
    expect((d.signal.reason as Error).message).toBe("owner timed out");
    expect(d.remaining()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    d.abort("again");
    expect((d.signal.reason as Error).message).toBe("owner timed out");
  });

  it("dispose() leaves no timer behind and the signal never aborts afterwards", () => {
    const d = createDeadline(5_000);
    expect(vi.getTimerCount()).toBe(1);
    d.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(d.signal.aborted).toBe(false);
    d.dispose();
  });
});

describe("deriveDeadline", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("never exceeds the parent", () => {
    const parent = createDeadline(5_000);
    const rd = deriveDeadline(parent, 60_000);
    expect(rd.remaining()).toBe(5_000);
    expect(rd.bound(60_000)).toBe(5_000);
    vi.advanceTimersByTime(4_000);
    expect(rd.remaining()).toBe(1_000);
    vi.advanceTimersByTime(1_000);
    expect(parent.signal.aborted).toBe(true);
    expect(rd.signal.aborted).toBe(true);
    expect(rd.remaining()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires on its own budget before the parent", () => {
    const parent = createDeadline(60_000);
    const rd = deriveDeadline(parent, 2_000);
    expect(rd.bound(5_000)).toBe(2_000);
    vi.advanceTimersByTime(2_000);
    expect(rd.signal.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
    expect(parent.remaining()).toBe(58_000);
    parent.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts when the parent is aborted, and is born aborted under an aborted parent", () => {
    const parent = createDeadline(60_000);
    const rd = deriveDeadline(parent, 30_000);
    parent.abort("gate budget exhausted");
    expect(rd.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const late = deriveDeadline(parent, 30_000);
    expect(late.signal.aborted).toBe(true);
    expect(late.remaining()).toBe(0);
  });

  it("dispose() clears its timer", () => {
    const parent = createDeadline(60_000);
    const rd = deriveDeadline(parent, 30_000);
    expect(vi.getTimerCount()).toBe(2);
    rd.dispose();
    parent.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("recheck helpers", () => {
  it("RECHECK_MIN_REMAINING_MS is 10 s", () => {
    expect(RECHECK_MIN_REMAINING_MS).toBe(10_000);
  });

  it.each([
    ["src/a.test.ts > suite > case", "src/a.test.ts"],
    ["tests/test_x.py::TestCls::test_y", "tests/test_x.py"],
    ["src/b.test.ts", "src/b.test.ts"],
    ["src\\c.test.ts > x", "src/c.test.ts"],
    ["pkg/a.test.ts > has :: in name", "pkg/a.test.ts"],
    ["a.test.ts > suite > t", "a.test.ts"],
    ["tests/test_x.py::test_cmp[1 > 0]", "tests/test_x.py"],
    ["tests\\test_x.py::TestA::test_cmp[a > b > c]", "tests/test_x.py"],
    ["tests/test_x.py::test_cmp[1 > 0 :: x]", "tests/test_x.py"],
  ])("fileKeyOfId(%j) = %j", (id, key) => {
    expect(fileKeyOfId(id)).toBe(key);
  });

  it("lists the inert entries of T4.f", () => {
    expect(INERT_UNREPRODUCED).toContain("coverage/");
    expect(INERT_UNREPRODUCED).toContain("*.pyc");
  });

  it.each([
    ["coverage/", "linux", true],
    ["packages/web/coverage/", "linux", true],
    ["__pycache__/", "linux", true],
    ["logs/", "linux", true],
    ["debug.log", "linux", true],
    ["a/b/mod.cpython-312.pyc", "linux", true],
    [".DS_Store", "linux", true],
    ["Thumbs.db", "linux", true],
    ["COVERAGE/", "win32", true],
    ["THUMBS.DB", "win32", true],
    ["Debug.LOG", "win32", true],
    ["COVERAGE/", "linux", false],
    ["coverage", "linux", false],
    ["logs.txt", "linux", false],
    [".log", "linux", false],
    ["debug.log/", "linux", false],
    [".env", "linux", false],
    [".env.local", "linux", false],
    ["dist/", "linux", false],
    ["build/", "linux", false],
    [".next/", "linux", false],
    ["coverage/lcov.info", "linux", false],
    ["", "linux", false],
  ] as const)("isInertUnreproduced(%j, %s) = %s", (entry, platform, inert) => {
    expect(isInertUnreproduced(entry, platform)).toBe(inert);
  });
});

describe("createScopeOpener", () => {
  const TMP = process.platform === "win32" ? "C:\\omr-tmp" : "/omr-tmp";
  const REPORT = join(TMP, "omr-verify-00000000-0000-4000-8000-000000000000.json");
  const HOST = { platform: process.platform, tmpdir: TMP };
  const BUDGET: VerifyBudget = {
    testScope: "affected",
    maxWorkers: 2,
    lowPriority: true,
    maxConcurrentVerifications: 1,
    defaultVerify: "required",
    captureWaitMs: 5_000,
    background: false,
    pendingTtlMs: 600_000,
    slotWaitMs: 60_000,
    batchWindowMs: 250,
    failureRecheck: true,
    recheckTimeoutMs: 120_000,
    baselineTimeoutMs: 60_000,
    gateBudgetMs: 300_000,
  };
  const SPEC: ScopedSpec = {
    runner: "vitest",
    mode: "related",
    file: "node",
    args: ["vitest.mjs", "related", "src/a.ts"],
    cwd: join(TMP, "repo"),
    env: { OMR_SCOPED: "1" },
    reportPath: REPORT,
    gitRoot: join(TMP, "repo"),
    entry: "vitest.mjs",
    inputs: ["src/a.ts"],
    inputsAreTests: false,
    workers: 2,
    notes: ["planner note"],
  };

  interface FakeDeadline extends Deadline {
    left: number;
    abort(): void;
  }
  function fakeDeadline(left: number): FakeDeadline {
    const controller = new AbortController();
    const d: FakeDeadline = {
      budgetMs: left,
      left,
      remaining: () => (controller.signal.aborted ? 0 : d.left),
      bound: ms => Math.min(ms, d.remaining()),
      signal: controller.signal,
      abort: () => controller.abort(new Error("gate budget exhausted")),
    };
    return d;
  }

  function setup(opts: { acquire?: typeof acquireSlot; argv?: ArgvSeam; now?: () => number } = {}) {
    const release = vi.fn(async (): Promise<void> => {});
    const handle = { release, lost: false };
    const acquire = vi.fn<typeof acquireSlot>(opts.acquire ?? (async () => handle));
    const argv = vi.fn<ArgvSeam>(opts.argv ?? (async () => ({ code: 0, stdout: " Test Files  1 passed (1)\n Tests  3 passed (3)\n", stderr: "" })));
    const exec = vi.fn<ExecSeam>(async () => ({ code: 0, stdout: "", stderr: "" }));
    const unlink = vi.fn(async (_path: string): Promise<void> => {});
    const fs: RunnerFs = {
      fileExists: async () => false,
      readFile: async (p: string) => { throw new Error(`ENOENT: ${p}`); },
      unlink,
    };
    const warn = vi.fn();
    const open = createScopeOpener({
      argv, exec, fs, acquire, budget: BUDGET, checkTimeoutMs: 120_000, host: HOST, logger: { warn },
      ...(opts.now ? { now: opts.now } : {}),
    });
    const scope = open({ cwd: SPEC.cwd, command: "npx vitest run" });
    return { scope, acquire, argv, exec, unlink, release, handle, warn };
  }

  it("reports a busy slot with the time waited, spawns nothing and does not wait again", async () => {
    let t = 1_000;
    const s = setup({ now: () => t, acquire: async () => { t += 1_500; return { busy: true }; } });
    const d = fakeDeadline(100_000);
    const first = await s.scope.execute(SPEC, d);
    expect(first).toEqual({ kind: "slot-busy", waitedMs: 1_500, deadlineCut: false });
    expect(await s.scope.execute(SPEC, d)).toEqual(first);
    expect(s.acquire).toHaveBeenCalledTimes(1);
    expect(s.argv).not.toHaveBeenCalled();
    expect(s.unlink).not.toHaveBeenCalled();
  });

  it("bounds the slot wait by the deadline and marks a deadline-cut wait", async () => {
    const d = fakeDeadline(5_000);
    const s = setup({ acquire: async opts => { d.left = 0; d.abort(); expect(opts.signal).toBe(d.signal); return { busy: true }; } });
    expect(await s.scope.execute(SPEC, d)).toMatchObject({ kind: "slot-busy", deadlineCut: true });
    expect(s.acquire.mock.calls[0]?.[0]).toMatchObject({
      max: BUDGET.maxConcurrentVerifications,
      waitMs: 5_000,
      meta: { cwd: SPEC.cwd, command: "npx vitest run" },
    });
    expect(s.argv).not.toHaveBeenCalled();
  });

  it("never acquires or spawns once the deadline has aborted", async () => {
    const s = setup();
    const d = fakeDeadline(100_000);
    d.abort();
    expect(await s.scope.execute(SPEC, d)).toEqual({ kind: "slot-busy", waitedMs: 0, deadlineCut: true });
    expect(s.acquire).not.toHaveBeenCalled();
    expect(s.argv).not.toHaveBeenCalled();
  });

  it("spawns nothing after an abort while the slot is held", async () => {
    const s = setup();
    const d = fakeDeadline(100_000);
    expect((await s.scope.execute(SPEC, d)).kind).toBe("ran");
    d.abort();
    expect(await s.scope.execute(SPEC, d)).toEqual({ kind: "aborted", reason: ABORTED_BEFORE_RUN });
    expect(await s.scope.runShell("npm run build", SPEC.cwd, d)).toEqual({ kind: "aborted", reason: ABORTED_BEFORE_RUN });
    expect(s.argv).toHaveBeenCalledTimes(1);
    expect(s.exec).not.toHaveBeenCalled();
  });

  it("reports a timeout with its bound and aborts the signal the argv seam received", async () => {
    let seen: AbortSignal | undefined;
    const s = setup({ argv: async (_f, _a, o) => { seen = o?.signal; return { code: 1, stdout: "", stderr: "", timedOut: true }; } });
    const d = fakeDeadline(30_000);
    const out = await s.scope.execute(SPEC, d);
    expect(out).toMatchObject({ kind: "timed-out", boundMs: 30_000 });
    expect(seen?.aborted).toBe(true);
    expect(d.signal.aborted).toBe(false);
    expect(s.unlink).toHaveBeenCalledWith(REPORT);
  });

  it("reports aborted when the deadline fires during the run, and the seam signal follows it", async () => {
    let seen: AbortSignal | undefined;
    const d = fakeDeadline(30_000);
    const s = setup({ argv: async (_f, _a, o) => { seen = o?.signal; d.abort(); return { code: 1, stdout: "", stderr: "", timedOut: true }; } });
    expect(await s.scope.execute(SPEC, d)).toEqual({ kind: "aborted", reason: ABORTED_DURING_RUN });
    expect(seen?.aborted).toBe(true);
    expect(s.unlink).toHaveBeenCalledWith(REPORT);
  });

  it("still runs readResult (deleting the report) when the argv seam throws", async () => {
    let seen: AbortSignal | undefined;
    const s = setup({ argv: async (_f, _a, o) => { seen = o?.signal; throw new Error("spawn EACCES"); } });
    const out = await s.scope.execute(SPEC, fakeDeadline(30_000));
    expect(out.kind).toBe("error");
    expect(out.kind === "error" ? out.reason : "").toContain("spawn EACCES");
    expect(s.unlink).toHaveBeenCalledWith(REPORT);
    expect(seen?.aborted).toBe(true);
  });

  it("notes a slot reclaimed during the run and warns", async () => {
    const release = vi.fn(async (): Promise<void> => {});
    const s = setup({ acquire: async opts => { opts.onLost?.(); return { release, lost: true }; } });
    const out = await s.scope.execute(SPEC, fakeDeadline(30_000));
    expect(out.kind).toBe("ran");
    expect(out.kind === "ran" ? out.notes : []).toEqual(expect.arrayContaining(["planner note", SLOT_LOST_NOTE]));
    expect(s.warn).toHaveBeenCalledWith(expect.stringContaining(SLOT_LOST_NOTE));
  });

  it("passes cwd, env, lowPriority and the bounded timeout to the argv seam", async () => {
    const s = setup();
    const out = await s.scope.execute(SPEC, fakeDeadline(50_000));
    expect(out).toMatchObject({ kind: "ran", exitCode: 0, spec: SPEC });
    expect(s.argv).toHaveBeenCalledTimes(1);
    const [file, args, o] = s.argv.mock.calls[0] ?? [];
    expect(file).toBe(SPEC.file);
    expect(args).toEqual(SPEC.args);
    expect(o).toMatchObject({ cwd: SPEC.cwd, env: { OMR_SCOPED: "1" }, lowPriority: true, timeoutMs: 50_000 });
    expect(o?.signal).toBeInstanceOf(AbortSignal);
    expect(s.unlink).toHaveBeenCalledWith(REPORT);
  });

  it("acquires exactly one slot per scope across several runs", async () => {
    const s = setup();
    const d = fakeDeadline(100_000);
    await Promise.all([s.scope.execute(SPEC, d), s.scope.execute(SPEC, d)]);
    await s.scope.execute(SPEC, d);
    const shell = await s.scope.runShell("npm run build", SPEC.cwd, d);
    expect(shell.kind).toBe("ran");
    expect(s.exec.mock.calls[0]?.[1]).toMatchObject({ cwd: SPEC.cwd, lowPriority: true, timeoutMs: 100_000 });
    expect(s.acquire).toHaveBeenCalledTimes(1);
    expect(s.argv).toHaveBeenCalledTimes(3);
  });

  it("releases the hold once on close and refuses runs afterwards", async () => {
    const s = setup();
    const d = fakeDeadline(100_000);
    await s.scope.execute(SPEC, d);
    await Promise.all([s.scope.close(), s.scope.close()]);
    await s.scope.close();
    expect(s.release).toHaveBeenCalledTimes(1);
    expect((await s.scope.execute(SPEC, d)).kind).toBe("error");
    expect(s.argv).toHaveBeenCalledTimes(1);
  });

  it("close without a run acquires nothing", async () => {
    const s = setup();
    await s.scope.close();
    expect(s.acquire).not.toHaveBeenCalled();
    expect(s.release).not.toHaveBeenCalled();
  });

  it("never rejects: slot errors become error outcomes", async () => {
    const s = setup({ acquire: async () => { throw new Error("EPERM lock"); } });
    const d = fakeDeadline(100_000);
    await expect(s.scope.execute(SPEC, d)).resolves.toMatchObject({ kind: "error" });
    await expect(s.scope.runLint({ ...SPEC, runner: "eslint" }, d)).resolves.toMatchObject({ kind: "error" });
    await expect(s.scope.close()).resolves.toBeUndefined();
    expect(s.argv).not.toHaveBeenCalled();
  });
});

describe("scope.rechecker (T4)", () => {
  const TMP = process.platform === "win32" ? "C:\\omr-tmp" : "/omr-tmp";
  const ROOT = join(TMP, "repo");
  const REF_DIR = join(TMP, "omr-ref-1-0123456789abcdef");
  const HOST = { platform: process.platform, tmpdir: TMP };
  const BUDGET: VerifyBudget = {
    testScope: "affected",
    maxWorkers: 2,
    lowPriority: true,
    maxConcurrentVerifications: 1,
    defaultVerify: "required",
    captureWaitMs: 5_000,
    background: false,
    pendingTtlMs: 600_000,
    slotWaitMs: 60_000,
    batchWindowMs: 250,
    failureRecheck: true,
    recheckTimeoutMs: 120_000,
    baselineTimeoutMs: 60_000,
    gateBudgetMs: 300_000,
  };
  const REFERENCE: DispatchReference = {
    root: ROOT,
    head: "a".repeat(40),
    commit: "b".repeat(40),
    untracked: new Map(),
    tracked: new Map(),
    captureReasons: [],
    capturedAt: 0,
  };
  const RUNNER: DetectedRunner = {
    kind: "vitest",
    launcher: "npx",
    source: { type: "command" },
    gitRoot: ROOT,
    runnerCwd: ROOT,
    env: {},
    keptArgs: ["run"],
    pathScopes: [],
    xdist: false,
    covInConfig: false,
    notes: [],
  };
  const ENTRY: ResolvedEntry = { file: "node", prefix: ["vitest.mjs"], entry: join(ROOT, "node_modules", "vitest", "vitest.mjs") };
  const FAIL_A = join(ROOT, "test", "a.test.ts");
  const FAIL_B = join(ROOT, "test", "b.test.ts");
  const OUTSIDE = join(TMP, "elsewhere", "c.test.ts");
  const toRefPath = (p: string): string | undefined =>
    p.startsWith(ROOT + (process.platform === "win32" ? "\\" : "/")) || p === ROOT ? REF_DIR + p.slice(ROOT.length) : undefined;
  const GOOD: RunResult = {
    failingIds: ["test/a.test.ts > fails"],
    failingFiles: [join(REF_DIR, "test", "a.test.ts")],
    collectionError: false,
    total: 3,
    complete: true,
    source: "report",
  };

  function deadline(left: number): Deadline & { abort(): void } {
    const controller = new AbortController();
    return {
      budgetMs: left,
      remaining: () => (controller.signal.aborted ? 0 : left),
      bound: ms => Math.min(ms, controller.signal.aborted ? 0 : left),
      signal: controller.signal,
      abort: () => controller.abort(new Error("gate budget exhausted")),
    };
  }

  const notUsed = (name: string) => async (): Promise<never> => { throw new Error(`unexpected ${name}`); };

  interface Opts {
    materialized?: { exact?: boolean; unreproduced?: string[] };
    materializeResult?: MaterializeResult;
    existing?: string[];
    result?: RunResult;
    argv?: ArgvSeam;
    acquire?: typeof acquireSlot;
    vanished?: boolean;
    recheck?: Partial<RecheckSeams>;
  }

  function setup(opts: Opts = {}) {
    const events: string[] = [];
    let held = false;
    const release = vi.fn(async (): Promise<void> => { events.push("release"); held = false; });
    const acquire = vi.fn<typeof acquireSlot>(opts.acquire ?? (async () => { events.push("acquire"); held = true; return { release, lost: false }; }));
    const argv = vi.fn<ArgvSeam>(opts.argv ?? (async () => { events.push("argv"); return { code: 1, stdout: "", stderr: "" }; }));
    const exec = vi.fn<ExecSeam>(async () => ({ code: 0, stdout: "", stderr: "" }));
    const existing = new Set(opts.existing ?? [join(REF_DIR, "test", "a.test.ts"), join(REF_DIR, "test", "b.test.ts")]);
    const fs: RunnerFs = {
      fileExists: async p => existing.has(p),
      readFile: async (p: string) => { throw new Error(`ENOENT: ${p}`); },
      unlink: async () => {},
    };
    const stats: ReferenceStats = { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, size: 0, mode: 0o700, mtimeMs: 0 };
    const refFs: ReferenceFs = {
      lstat: async p => {
        if (opts.vanished === true) throw new Error(`ENOENT: ${p}`);
        return stats;
      },
      realpath: notUsed("realpath"),
      readFile: notUsed("readFile"),
      writeFile: notUsed("writeFile"),
      mkdir: notUsed("mkdir"),
      chmod: notUsed("chmod"),
      readdir: notUsed("readdir"),
      symlink: notUsed("symlink"),
      unlink: notUsed("unlink"),
      utimes: notUsed("utimes"),
      rm: notUsed("rm"),
    };
    const dispose = vi.fn(async (): Promise<void> => { events.push("dispose"); });
    const materializedWhileHeld: boolean[] = [];
    const materialize = vi.fn<RecheckSeams["materialize"]>(async () => {
      events.push("materialize");
      materializedWhileHeld.push(held);
      if (opts.materializeResult) return opts.materializeResult;
      const exact = opts.materialized?.exact ?? true;
      return {
        ok: true,
        reference: {
          dir: REF_DIR,
          exact,
          inexactReasons: exact ? [] : [{ cause: "dependency-drift", path: "package-lock.json" }],
          unreproduced: opts.materialized?.unreproduced ?? [],
          links: [],
          toRefPath,
          dispose,
        },
      };
    });
    const gcStaleReferences = vi.fn<RecheckSeams["gcStaleReferences"]>(async () => {
      events.push("gc");
      return { removed: [], kept: [], failed: [] };
    });
    const detectRunner = vi.fn<RecheckSeams["detectRunner"]>(async () => RUNNER);
    const resolveEntry = vi.fn<RecheckSeams["resolveEntry"]>(async () => ENTRY);
    const planRerun = vi.fn<RecheckSeams["planRerun"]>(async (_runner, files, cwd) => ({
      runner: "vitest",
      mode: "rerun",
      file: "node",
      args: ["vitest.mjs", "run", ...files],
      cwd,
      env: { OMR: "1" },
      reportPath: join(TMP, "report.json"),
      gitRoot: REF_DIR,
      entry: ENTRY.entry,
      inputs: [...files],
      inputsAreTests: true,
      workers: 2,
      notes: [],
    }));
    const readResult = vi.fn<RecheckSeams["readResult"]>(async () => { events.push("readResult"); return opts.result ?? GOOD; });
    const warn = vi.fn();
    const open = createScopeOpener({
      argv, exec, fs, acquire, budget: BUDGET, checkTimeoutMs: 120_000, host: HOST, logger: { warn },
      reference: { fs: refFs },
      recheck: { materialize, gcStaleReferences, detectRunner, resolveEntry, planRerun, readResult, ...opts.recheck },
    });
    const scope = open({ cwd: ROOT, command: "npx vitest run" });
    const recheck = scope.rechecker("npx vitest run", ROOT);
    return {
      scope, recheck, events, acquire, argv, release, dispose, materialize, materializedWhileHeld, gcStaleReferences,
      detectRunner, resolveEntry, planRerun, readResult, warn,
    };
  }

  it("skips below the recheck threshold without detecting, acquiring, materializing or spawning", async () => {
    const s = setup();
    const out = await s.recheck(REFERENCE, [FAIL_A], deadline(RECHECK_MIN_REMAINING_MS - 1));
    expect(out).toEqual({ kind: "skipped-deadline", remainingMs: RECHECK_MIN_REMAINING_MS - 1 });
    expect(s.detectRunner).not.toHaveBeenCalled();
    expect(s.acquire).not.toHaveBeenCalled();
    expect(s.materialize).not.toHaveBeenCalled();
    expect(s.argv).not.toHaveBeenCalled();
  });

  it("forwards the current tree snapshot to materialize, and undefined when none is given", async () => {
    const tree: TreeSnapshot = { cwd: ROOT, head: "a".repeat(40), fingerprint: "fp", dirty: true, files: [] };
    const s = setup();
    await s.scope.rechecker("npx vitest run", ROOT, tree)(REFERENCE, [FAIL_A], deadline(300_000));
    await s.recheck(REFERENCE, [FAIL_A], deadline(300_000));
    expect(s.materialize).toHaveBeenCalledTimes(2);
    expect(s.materialize.mock.calls[0][1]).toBe(tree);
    expect(s.materialize.mock.calls[1][1]).toBeUndefined();
    await s.scope.close();
  });

  it("reports pytest as runner-unsupported without materializing or rerunning", async () => {
    const s = setup({ recheck: { detectRunner: async () => ({ ...RUNNER, kind: "pytest" }) } });
    const out = await s.recheck(REFERENCE, [FAIL_A], deadline(200_000));
    expect(out).toMatchObject({ kind: "unusable", cause: "runner-unsupported" });
    expect(s.gcStaleReferences).not.toHaveBeenCalled();
    expect(s.materialize).not.toHaveBeenCalled();
    expect(s.argv).not.toHaveBeenCalled();
  });

  it("reports an S6 from detectRunner as rerun-unplannable", async () => {
    const s = setup({ recheck: { detectRunner: async () => ({ unverifiable: true, code: "no-git-root", reason: "no git repository" }) } });
    expect(await s.recheck(REFERENCE, [FAIL_A], deadline(200_000))).toMatchObject({ kind: "unusable", cause: "rerun-unplannable" });
    expect(s.materialize).not.toHaveBeenCalled();
  });

  it("GCs, then materializes inside the hold, reruns only files present at the reference and disposes before release", async () => {
    const s = setup({ existing: [join(REF_DIR, "test", "a.test.ts")] });
    const d = deadline(200_000);
    const out = await s.recheck(REFERENCE, [FAIL_A, FAIL_B, OUTSIDE], d);
    expect(out).toEqual({ kind: "exact", result: GOOD, ranFiles: ["test/a.test.ts"], absentFiles: ["test/b.test.ts"], notes: [] });
    expect(s.materializedWhileHeld).toEqual([true]);
    expect(s.gcStaleReferences.mock.calls[0]?.[0]).toBe(ROOT);
    expect(s.gcStaleReferences.mock.calls[0]?.[1].timeoutMs).toBeLessThanOrEqual(5_000);
    expect(s.planRerun).toHaveBeenCalledWith(RUNNER, [join(REF_DIR, "test", "a.test.ts")], REF_DIR, { maxWorkers: 2 }, expect.objectContaining({ entry: ENTRY }));
    expect(s.resolveEntry.mock.calls[0]?.[1]).toBe(ROOT);
    const argvOpts = s.argv.mock.calls[0]?.[2];
    expect(argvOpts).toMatchObject({ cwd: REF_DIR, lowPriority: true, env: { OMR: "1" } });
    expect(argvOpts?.timeoutMs).toBeGreaterThan(0);
    expect(argvOpts?.timeoutMs).toBeLessThanOrEqual(BUDGET.recheckTimeoutMs);
    await s.scope.close();
    expect(s.events).toEqual(["acquire", "gc", "materialize", "argv", "readResult", "dispose", "release"]);
    expect(s.acquire).toHaveBeenCalledTimes(1);
  });

  it("shares the scope's hold with an earlier scoped run", async () => {
    const s = setup();
    const d = deadline(200_000);
    await s.scope.runShell("npm run build", ROOT, d);
    await s.recheck(REFERENCE, [FAIL_A], d);
    expect(s.acquire).toHaveBeenCalledTimes(1);
    await s.scope.close();
  });

  it("returns exact with no result when every failing file is absent at the reference", async () => {
    const s = setup({ existing: [] });
    const out = await s.recheck(REFERENCE, [FAIL_A, FAIL_B], deadline(200_000));
    expect(out).toEqual({ kind: "exact", result: undefined, ranFiles: [], absentFiles: ["test/a.test.ts", "test/b.test.ts"], notes: [] });
    expect(s.argv).not.toHaveBeenCalled();
    expect(s.dispose).toHaveBeenCalledTimes(1);
  });

  it("returns approximate with the inexact reasons, reruns nothing and disposes", async () => {
    const s = setup({ materialized: { exact: false } });
    const out = await s.recheck(REFERENCE, [FAIL_A], deadline(200_000));
    expect(out).toEqual({ kind: "approximate", inexactReasons: [{ cause: "dependency-drift", path: "package-lock.json" }] });
    expect(s.argv).not.toHaveBeenCalled();
    expect(s.dispose).toHaveBeenCalledTimes(1);
  });

  it("refuses a reference missing a non-inert ignored input, and reruns when only inert ones are missing", async () => {
    const bad = setup({ materialized: { unreproduced: ["coverage/", ".env"] } });
    const out = await bad.recheck(REFERENCE, [FAIL_A], deadline(200_000));
    expect(out).toMatchObject({ kind: "unusable", cause: "unreproduced-inputs" });
    expect(out.kind === "unusable" ? out.reason : "").toContain(".env");
    expect(bad.argv).not.toHaveBeenCalled();
    expect(bad.dispose).toHaveBeenCalledTimes(1);

    const inert = setup({ materialized: { unreproduced: ["coverage/", "logs/debug.log"] } });
    expect((await inert.recheck(REFERENCE, [FAIL_A], deadline(200_000))).kind).toBe("exact");
    expect(inert.argv).toHaveBeenCalledTimes(1);
  });

  it.each<[string, MaterializeResult, RecheckUnusableCause]>([
    ["commit-missing", { ok: false, reason: "commit-missing", detail: "no such commit" }, "reference-vanished"],
    ["worktree-add-failed", { ok: false, reason: "worktree-add-failed", detail: "git failed" }, "materialize-failed"],
    ["aborted", { ok: false, reason: "aborted", detail: "signal aborted" }, "materialize-failed"],
  ])("maps a %s materialize failure to %s", async (_name, materializeResult, cause) => {
    const s = setup({ materializeResult });
    expect(await s.recheck(REFERENCE, [FAIL_A], deadline(200_000))).toMatchObject({ kind: "unusable", cause });
    expect(s.argv).not.toHaveBeenCalled();
    expect(s.dispose).not.toHaveBeenCalled();
  });

  it.each<[string, RunResult, RecheckUnusableCause]>([
    ["incomplete", { ...GOOD, complete: false }, "incomplete"],
    ["a collection error", { ...GOOD, collectionError: true }, "collection-error"],
    ["zero tests", { ...GOOD, total: 0 }, "no-tests"],
  ])("refuses a rerun with %s", async (_name, result, cause) => {
    const s = setup({ result });
    expect(await s.recheck(REFERENCE, [FAIL_A], deadline(200_000))).toMatchObject({ kind: "unusable", cause });
    expect(s.dispose).toHaveBeenCalledTimes(1);
  });

  it("reports a reference dir that vanished during the rerun", async () => {
    const s = setup({ vanished: true });
    expect(await s.recheck(REFERENCE, [FAIL_A], deadline(200_000))).toMatchObject({ kind: "unusable", cause: "reference-vanished" });
    expect(s.readResult).toHaveBeenCalledTimes(1);
    expect(s.dispose).toHaveBeenCalledTimes(1);
  });

  it("reports a rerun timeout with its bound and still reads the result and disposes", async () => {
    const s = setup({ argv: async () => ({ code: -1, stdout: "", stderr: "", timedOut: true }) });
    const out = await s.recheck(REFERENCE, [FAIL_A], deadline(200_000));
    expect(out.kind).toBe("timed-out");
    expect(out.kind === "timed-out" ? out.boundMs : 0).toBeGreaterThan(0);
    expect(s.readResult).toHaveBeenCalledTimes(1);
    expect(s.dispose).toHaveBeenCalledTimes(1);
  });

  it("maps unplannable reruns: entry S6, planRerun S6 and NoAffected", async () => {
    const s6 = { unverifiable: true as const, code: "node-not-found" as const, reason: "node not found" };
    const a = setup({ recheck: { resolveEntry: async () => s6 } });
    expect(await a.recheck(REFERENCE, [FAIL_A], deadline(200_000))).toMatchObject({ kind: "unusable", cause: "rerun-unplannable" });
    const b = setup({ recheck: { planRerun: async () => s6 } });
    expect(await b.recheck(REFERENCE, [FAIL_A], deadline(200_000))).toMatchObject({ kind: "unusable", cause: "rerun-unplannable" });
    const c = setup({ recheck: { planRerun: async () => ({ noAffected: true, note: "nothing" }) } });
    expect(await c.recheck(REFERENCE, [FAIL_A], deadline(200_000))).toMatchObject({ kind: "unusable", cause: "rerun-unplannable" });
    for (const s of [a, b, c]) {
      expect(s.argv).not.toHaveBeenCalled();
      expect(s.dispose).toHaveBeenCalledTimes(1);
    }
  });

  it("never rejects: spawn, readResult, slot and seam errors become unusable error", async () => {
    const outcomes: RecheckOutcome[] = [];
    const spawn = setup({ argv: async () => { throw new Error("spawn EACCES"); } });
    outcomes.push(await spawn.recheck(REFERENCE, [FAIL_A], deadline(200_000)));
    const read = setup({ recheck: { readResult: async () => { throw new Error("EIO"); } } });
    outcomes.push(await read.recheck(REFERENCE, [FAIL_A], deadline(200_000)));
    const busy = setup({ acquire: async () => ({ busy: true }) });
    outcomes.push(await busy.recheck(REFERENCE, [FAIL_A], deadline(200_000)));
    const thrown = setup({ recheck: { materialize: async () => { throw new Error("boom"); } } });
    outcomes.push(await thrown.recheck(REFERENCE, [FAIL_A], deadline(200_000)));
    for (const out of outcomes) expect(out).toMatchObject({ kind: "unusable", cause: "error" });
    expect(busy.materialize).not.toHaveBeenCalled();
    expect(spawn.dispose).toHaveBeenCalledTimes(1);
    expect(read.dispose).toHaveBeenCalledTimes(1);
  });

  it("reports skipped-deadline when the deadline aborts before the rerun spawns", async () => {
    const d = deadline(200_000);
    const s = setup({ recheck: { planRerun: async (_r, files, cwd) => { d.abort(); return {
      runner: "vitest", mode: "rerun", file: "node", args: [...files], cwd, env: {}, reportPath: join(TMP, "r.json"),
      gitRoot: REF_DIR, entry: ENTRY.entry, inputs: [...files], inputsAreTests: true, workers: 2, notes: [],
    }; } } });
    expect((await s.recheck(REFERENCE, [FAIL_A], d)).kind).toBe("skipped-deadline");
    expect(s.argv).not.toHaveBeenCalled();
    expect(s.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("createDirectTestsPassHook (2.1.2.4)", () => {
  const TMP = process.platform === "win32" ? "C:\\omr-tmp" : "/omr-tmp";
  const ROOT = join(TMP, "repo");
  const FILE_A = join(ROOT, "test", "a.test.ts");
  const FILE_B = join(ROOT, "test", "b.test.ts");
  const REFERENCE: DispatchReference = {
    root: ROOT,
    head: "a".repeat(40),
    commit: "b".repeat(40),
    untracked: new Map(),
    tracked: new Map(),
    captureReasons: [],
    capturedAt: 0,
  };
  const TREE: TreeSnapshot = { cwd: ROOT, head: "a".repeat(40), fingerprint: "fp", dirty: true, files: [] };
  const SPEC: ScopedSpec = {
    runner: "vitest",
    mode: "related",
    file: "node",
    args: ["vitest.mjs", "related", "--run", FILE_A],
    cwd: ROOT,
    env: {},
    reportPath: join(TMP, "report.json"),
    gitRoot: ROOT,
    entry: join(ROOT, "node_modules", "vitest", "vitest.mjs"),
    inputs: [FILE_A],
    inputsAreTests: false,
    workers: 2,
    notes: [],
  };
  const GREEN: RunResult = { failingIds: [], failingFiles: [], collectionError: false, total: 4, complete: true, source: "report" };
  const FAILING: RunResult = {
    failingIds: ["test/a.test.ts > fails"],
    failingFiles: [FILE_A],
    collectionError: false,
    total: 4,
    complete: true,
    source: "report",
  };
  const EXACT: RecheckOutcome = { kind: "exact", result: undefined, ranFiles: [], absentFiles: ["test/a.test.ts"], notes: [] };

  function deadline(left: number): Deadline {
    const controller = new AbortController();
    return { budgetMs: left, remaining: () => left, bound: ms => Math.min(ms, left), signal: controller.signal };
  }

  interface Opts {
    plan?: ScopingPlan | Error;
    scoped?: ScopedOutcome | Error;
    shell?: CommandOutcome;
    live?: string[];
    failureRecheck?: boolean;
  }

  function setup(opts: Opts = {}) {
    const rechecker = vi.fn<Rechecker>(async () => EXACT);
    const execute = vi.fn<CheckScope["execute"]>(async () => {
      if (opts.scoped instanceof Error) throw opts.scoped;
      return opts.scoped ?? { kind: "ran", result: GREEN, exitCode: 0, spec: SPEC, notes: [] };
    });
    const runShell = vi.fn<CheckScope["runShell"]>(async () => opts.shell ?? { kind: "ran", exec: { code: 0, stdout: "", stderr: "" }, notes: [] });
    const runLint = vi.fn<CheckScope["runLint"]>(async () => ({ kind: "error", reason: "unused" }));
    const makeRechecker = vi.fn((_command: string, _cwd: string, _tree?: TreeSnapshot): Rechecker => rechecker);
    const close = vi.fn(async (): Promise<void> => {});
    const scope: CheckScope = { execute, rechecker: makeRechecker, runShell, runLint, close };
    const openScope = vi.fn((_meta: { readonly cwd: string; readonly command: string }): CheckScope => scope);
    const plan = vi.fn(async (_input: PlanScopedRunInput): Promise<ScopingPlan> => {
      if (opts.plan instanceof Error) throw opts.plan;
      return opts.plan ?? SPEC;
    });
    const live = new Set(opts.live ?? [FILE_A, FILE_B]);
    const plannerFs: PlannerFs = {
      fileExists: async p => live.has(p),
      readFile: async (p: string) => { throw new Error(`ENOENT: ${p}`); },
    };
    const search: TestSearchSeam = { findByName: async () => [], findByContent: async () => [] };
    const hook = createDirectTestsPassHook({
      openScope, plannerFs, search, plan, currentTree: TREE,
      budget: { maxWorkers: 2, failureRecheck: opts.failureRecheck ?? true },
      host: { platform: process.platform },
    });
    return { hook, openScope, plan, execute, runShell, makeRechecker, rechecker, close };
  }

  function request(over: Partial<TestsPassRequest> = {}): TestsPassRequest {
    return {
      command: "npx vitest run",
      cwd: ROOT,
      testScope: "affected",
      changedFiles: [{ path: join(ROOT, "src", "a.ts"), status: "modified" }],
      reference: { kind: "captured", reference: REFERENCE },
      deadline: deadline(300_000),
      ...over,
    };
  }

  it("returns no-affected without opening a scope or spawning", async () => {
    const s = setup({ plan: { noAffected: true, note: "no changed files, no affected tests" } });
    expect(await s.hook(request())).toEqual({ scoped: { kind: "no-affected", note: "no changed files, no affected tests" }, recheck: undefined });
    expect(s.openScope).not.toHaveBeenCalled();
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.runShell).not.toHaveBeenCalled();
  });

  it("returns an S6 outcome as unverifiable without opening a scope or spawning", async () => {
    const s = setup({ plan: { unverifiable: true, code: "composite", reason: "composite script" } });
    expect(await s.hook(request())).toEqual({ scoped: { kind: "unverifiable", code: "composite", reason: "composite script" }, recheck: undefined });
    expect(s.openScope).not.toHaveBeenCalled();
    expect(s.execute).not.toHaveBeenCalled();
  });

  it("plans with the injected fs, search, changed files and worker cap", async () => {
    const s = setup();
    const req = request();
    await s.hook(req);
    expect(s.plan).toHaveBeenCalledTimes(1);
    expect(s.plan.mock.calls[0][0]).toMatchObject({ command: req.command, cwd: ROOT, changedFiles: req.changedFiles, budget: { maxWorkers: 2 } });
  });

  it("runs a green scoped spec under one scope without a recheck, then closes", async () => {
    const s = setup();
    const req = request();
    const out = await s.hook(req);
    expect(out.scoped.kind).toBe("ran");
    expect(out.recheck).toBeUndefined();
    expect(s.openScope).toHaveBeenCalledTimes(1);
    expect(s.openScope).toHaveBeenCalledWith({ cwd: ROOT, command: "npx vitest run" });
    expect(s.execute).toHaveBeenCalledWith(SPEC, req.deadline);
    expect(s.makeRechecker).not.toHaveBeenCalled();
    expect(s.rechecker).not.toHaveBeenCalled();
    expect(s.close).toHaveBeenCalledTimes(1);
  });

  it("rechecks only the failing files at a captured reference, forwarding the current tree", async () => {
    const s = setup({ scoped: { kind: "ran", result: FAILING, exitCode: 1, spec: SPEC, notes: [] } });
    const req = request();
    const out = await s.hook(req);
    expect(out.recheck).toBe(EXACT);
    expect(s.makeRechecker).toHaveBeenCalledWith("npx vitest run", ROOT, TREE);
    expect(s.rechecker).toHaveBeenCalledTimes(1);
    expect(s.rechecker).toHaveBeenCalledWith(REFERENCE, [FILE_A], req.deadline);
    expect(s.close).toHaveBeenCalledTimes(1);
  });

  it("reports reference none as unusable no-reference without a Rechecker call", async () => {
    const s = setup({ scoped: { kind: "ran", result: FAILING, exitCode: 1, spec: SPEC, notes: [] } });
    const out = await s.hook(request({ reference: { kind: "none", reason: "the dispatch was not tracked" } }));
    expect(out.recheck).toEqual({ kind: "unusable", cause: "no-reference", reason: "the dispatch was not tracked" });
    expect(s.makeRechecker).not.toHaveBeenCalled();
    expect(s.rechecker).not.toHaveBeenCalled();
  });

  it("reports a disabled reference, or failureRecheck off, as disabled without a Rechecker call", async () => {
    const ran: ScopedOutcome = { kind: "ran", result: FAILING, exitCode: 1, spec: SPEC, notes: [] };
    const a = setup({ scoped: ran });
    expect((await a.hook(request({ reference: { kind: "disabled" } }))).recheck).toEqual({ kind: "disabled" });
    const b = setup({ scoped: ran, failureRecheck: false });
    expect((await b.hook(request())).recheck).toEqual({ kind: "disabled" });
    expect(a.rechecker).not.toHaveBeenCalled();
    expect(b.rechecker).not.toHaveBeenCalled();
  });

  it("does not recheck failing ids without an identified failing file, nor non-ran outcomes", async () => {
    const a = setup({ scoped: { kind: "ran", result: { ...FAILING, failingFiles: [] }, exitCode: 1, spec: SPEC, notes: [] } });
    expect((await a.hook(request())).recheck).toBeUndefined();
    const b = setup({ scoped: { kind: "slot-busy", waitedMs: 5, deadlineCut: false } });
    expect(await b.hook(request())).toEqual({ scoped: { kind: "slot-busy", waitedMs: 5, deadlineCut: false }, recheck: undefined });
    expect(a.rechecker).not.toHaveBeenCalled();
    expect(b.rechecker).not.toHaveBeenCalled();
    expect(b.close).toHaveBeenCalledTimes(1);
  });

  it("full mode runs the resolved command once through runShell, never plans or spawns a spec", async () => {
    const stdout = "FAIL test/a.test.ts > suite > fails\nFAIL test/gone.test.ts > x\n Tests  2 failed | 2 passed (4)\n";
    const s = setup({ shell: { kind: "ran", exec: { code: 1, stdout, stderr: "" }, notes: [] } });
    const req = request({ testScope: "full" });
    const out = await s.hook(req);
    expect(s.runShell).toHaveBeenCalledTimes(1);
    expect(s.runShell).toHaveBeenCalledWith("npx vitest run", ROOT, req.deadline);
    expect(s.plan).not.toHaveBeenCalled();
    expect(s.execute).not.toHaveBeenCalled();
    expect(out.scoped).toEqual({
      kind: "ran",
      exitCode: 1,
      notes: [],
      result: {
        failingIds: ["test/a.test.ts > suite > fails", "test/gone.test.ts > x"],
        failingFiles: [FILE_A],
        collectionError: false,
        total: undefined,
        complete: true,
        source: "text",
      },
    });
    // S2 applies to full too: only the failing files that exist in the live tree are rechecked.
    expect(s.rechecker).toHaveBeenCalledWith(REFERENCE, [FILE_A], req.deadline);
    expect(s.close).toHaveBeenCalledTimes(1);
  });

  it("full mode marks an unconfident parse incomplete and maps shell outcomes", async () => {
    const a = setup({ shell: { kind: "ran", exec: { code: 1, stdout: "boom", stderr: "" }, notes: [] } });
    const out = await a.hook(request({ testScope: "full" }));
    expect(out.scoped.kind === "ran" && out.scoped.result).toMatchObject({ complete: false, collectionError: true, failingIds: [] });
    expect(out.recheck).toBeUndefined();
    const b = setup({ shell: { kind: "timed-out", boundMs: 100, exec: { code: -1, stdout: "", stderr: "", timedOut: true } } });
    expect((await b.hook(request({ testScope: "full" }))).scoped).toEqual({ kind: "timed-out", boundMs: 100 });
  });

  it("never rejects: a throwing planner or executor becomes an error, and an opened scope is closed", async () => {
    const a = setup({ plan: new Error("planner exploded") });
    expect(await a.hook(request())).toEqual({ scoped: { kind: "error", reason: "testsPass hook errored: planner exploded" }, recheck: undefined });
    expect(a.openScope).not.toHaveBeenCalled();
    const b = setup({ scoped: new Error("executor exploded") });
    expect(await b.hook(request())).toEqual({ scoped: { kind: "error", reason: "testsPass hook errored: executor exploded" }, recheck: undefined });
    expect(b.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the scoped outcome when the Rechecker throws, and still closes", async () => {
    const s = setup({ scoped: { kind: "ran", result: FAILING, exitCode: 1, spec: SPEC, notes: [] } });
    s.rechecker.mockImplementation(async () => { throw new Error("recheck exploded"); });
    const out = await s.hook(request());
    expect(out.scoped.kind).toBe("ran");
    expect(out.recheck).toEqual({ kind: "unusable", cause: "error", reason: "the reference recheck errored: recheck exploded" });
    expect(s.close).toHaveBeenCalledTimes(1);
  });
});
