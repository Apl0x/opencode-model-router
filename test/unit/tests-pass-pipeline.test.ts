import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import type { VerifyBudget } from "../../src/router/config";
import type { RunnerFs, ScopedSpec } from "../../src/verify/runner";
import type { acquireSlot } from "../../src/verify/slot";
import type { ArgvSeam, Deadline, ExecSeam } from "../../src/verify/types";
import {
  ABORTED_BEFORE_RUN,
  ABORTED_DURING_RUN,
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
