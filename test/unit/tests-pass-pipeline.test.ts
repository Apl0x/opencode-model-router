import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
