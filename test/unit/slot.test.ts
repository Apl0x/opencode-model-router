import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireSlot, withSlot, type SlotDeps, type SlotHandle, type SlotResult } from "../../src/verify/slot";

// Every test uses its own slot dir, never the real shared one, so parallel runs
// cannot interfere. Timing constants are scaled down through the deps seam.
const SLOT_TS = resolve(__dirname, "../../src/verify/slot.ts");
const HOLDER = resolve(__dirname, "../fixtures/slot/holder.mjs");
const dirs: string[] = [];
const children: ChildProcess[] = [];
const handles: SlotHandle[] = [];

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "omr-slot-"));
  dirs.push(d);
  return d;
}
function fast(dir: string, extra: SlotDeps = {}): SlotDeps {
  return { dir, heartbeatMs: 100, staleMs: 1_000, corruptGraceMs: 200, backoffMinMs: 20, backoffMaxMs: 100, unlinkRetryMs: 5, ...extra };
}
const meta = { cwd: "/x", command: "vitest" };
function held(r: SlotResult): SlotHandle {
  if ("busy" in r) throw new Error("expected a slot, got busy");
  handles.push(r);
  return r;
}
function writeLock(path: string, over: Record<string, unknown>, ageMs = 0): void {
  writeFileSync(path, JSON.stringify({ pid: process.pid, hostname: hostname(), token: "other", startedAt: 0, cwd: "", command: "", ...over }));
  if (ageMs) setAge(path, ageMs);
}
function setAge(path: string, ageMs: number): void {
  const t = new Date(Date.now() - ageMs);
  utimesSync(path, t, t);
}
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
  return Number(r.stdout.toString());
}
function killHard(child: ChildProcess): void {
  if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)]);
  else child.kill("SIGKILL");
}
function runHolder(cfg: Record<string, unknown>): { child: ChildProcess; line: Promise<string>; exit: Promise<number | null> } {
  const child = spawn(process.execPath, [HOLDER, SLOT_TS, JSON.stringify(cfg)], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let out = "";
  let err = "";
  const line = new Promise<string>((res) => {
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      if (out.includes("\n")) res(out.trim());
    });
    child.on("exit", () => res(out.trim() || `EXIT ${err}`));
  });
  child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
  const exit = new Promise<number | null>((res) => child.on("exit", (c) => res(c)));
  return { child, line, exit };
}

afterEach(async () => {
  for (const h of handles.splice(0)) await h.release();
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) killHard(c);
});
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function intervals(log: string): Array<[number, number]> {
  const enter = new Map<string, number>();
  const out: Array<[number, number]> = [];
  for (const l of readFileSync(log, "utf8").trim().split("\n")) {
    const [id, kind, t] = l.split(" ");
    if (kind === "enter") enter.set(id, Number(t));
    else out.push([enter.get(id)!, Number(t)]);
  }
  return out;
}
function maxOverlap(iv: Array<[number, number]>): number {
  const ev = iv.flatMap(([a, b]) => [[a, 1], [b, -1]] as Array<[number, number]>).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of ev) max = Math.max(max, (cur += d));
  return max;
}

describe("slot: multi-process exclusion", () => {
  it.each([1, 2])("max=%i: never more than max holders across 6 processes", async (max) => {
    const dir = freshDir();
    const log = join(dir, "log.txt");
    writeFileSync(log, "");
    const runs = Array.from({ length: 6 }, (_, i) =>
      runHolder({ dir, max, waitMs: 20_000, holdMs: 120, log, id: `p${i}`, mode: "cycle", deps: { backoffMinMs: 10, backoffMaxMs: 60 } }),
    );
    const codes = await Promise.all(runs.map((r) => r.exit));
    expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
    const iv = intervals(log);
    expect(iv).toHaveLength(6);
    expect(maxOverlap(iv)).toBeLessThanOrEqual(max);
    if (max === 2) expect(maxOverlap(iv)).toBe(2); // the second slot is actually used
  }, 30_000);

  it("a crashed holder (hard kill) is reclaimed by the next waiter within the backoff window", async () => {
    const dir = freshDir();
    const h = runHolder({ dir, max: 1, waitMs: 1_000, mode: "hang" });
    expect(await h.line).toBe("HELD");
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir))).toEqual({ busy: true });
    killHard(h.child);
    await h.exit;
    const t0 = Date.now();
    held(await acquireSlot({ max: 1, waitMs: 5_000, meta }, { dir, backoffMinMs: 250, backoffMaxMs: 2_000 }));
    expect(Date.now() - t0).toBeLessThan(2_500);
  }, 15_000);

  it("the heartbeat timer is unref'd: a holder exits on its own and the exit hook frees the slot", async () => {
    const dir = freshDir();
    const h = runHolder({ dir, max: 1, waitMs: 1_000, mode: "exit", deps: { heartbeatMs: 50 } });
    expect(await h.line).toBe("HELD");
    expect(await h.exit).toBe(0);
    expect(existsSync(join(dir, "slot-0.lock"))).toBe(false);
  }, 15_000);
});

describe("slot: stale detection", () => {
  it("a live but unrelated PID whose heartbeat stopped is reclaimed only after the stale threshold", async () => {
    const dir = freshDir();
    writeLock(join(dir, "slot-0.lock"), { pid: process.pid }); // live PID, fresh mtime, not ours
    const t0 = Date.now();
    held(await acquireSlot({ max: 1, waitMs: 5_000, meta }, fast(dir, { staleMs: 600 })));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
  });

  it("a long hold (3x the stale threshold) keeps its slot because the heartbeat is fresh", async () => {
    const dir = freshDir();
    const deps = fast(dir, { staleMs: 400, heartbeatMs: 80 });
    const a = held(await acquireSlot({ max: 1, waitMs: 0, meta }, deps));
    expect(await acquireSlot({ max: 1, waitMs: 1_200, meta }, deps)).toEqual({ busy: true });
    await a.release();
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, deps));
  });

  it("a foreign host lock is never judged by PID: fresh heartbeat kept, old heartbeat reclaimed", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    writeLock(p, { hostname: "some-other-host", pid: deadPid() });
    expect(await acquireSlot({ max: 1, waitMs: 400, meta }, fast(dir, { staleMs: 5_000 }))).toEqual({ busy: true });
    setAge(p, 6_000);
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { staleMs: 5_000 })));
  });

  it("same host + dead PID is stale immediately, even with a fresh heartbeat", async () => {
    const dir = freshDir();
    writeLock(join(dir, "slot-0.lock"), { pid: deadPid() });
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { staleMs: 60_000 })));
  });

  it.each([["empty", ""], ["corrupt", "{not json"], ["wrong shape", '{"pid":"x"}']])("a %s lock file is stale (after the write grace)", async (_n, body) => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    writeFileSync(p, body);
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { corruptGraceMs: 5_000 }))).toEqual({ busy: true });
    setAge(p, 6_000);
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { corruptGraceMs: 5_000 })));
  });
});

describe("slot: release", () => {
  it("release is idempotent and stops the heartbeat", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    const a = held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { heartbeatMs: 30 })));
    await a.release();
    await a.release();
    expect(existsSync(p)).toBe(false);
    // Plant a lock with the same path; a still-running heartbeat would touch it.
    writeLock(p, { token: "someone" }, 10_000);
    const before = statSync(p).mtimeMs;
    await new Promise((r) => setTimeout(r, 150));
    expect(statSync(p).mtimeMs).toBe(before);
  });

  it("release after the slot was reclaimed as stale does not delete the new owner's file", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    const a = held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { heartbeatMs: 1_000_000 })));
    setAge(p, 10_000);
    const b = held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { staleMs: 1_000 })));
    const owner = readFileSync(p, "utf8");
    await a.release();
    expect(readFileSync(p, "utf8")).toBe(owner);
    await b.release();
    expect(existsSync(p)).toBe(false);
  });

  it("EBUSY/EPERM on unlink is retried; a persistent failure is not treated as success", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    const { unlink } = await import("node:fs/promises");
    let fails = 2;
    const flaky = async (path: string) => {
      if (path === p && fails-- > 0) throw Object.assign(new Error("busy"), { code: fails % 2 ? "EBUSY" : "EPERM" });
      await unlink(path);
    };
    const a = held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { unlink: flaky })));
    await a.release();
    expect(existsSync(p)).toBe(false);

    const warns: string[] = [];
    const never = async (path: string) => {
      if (path === p) throw Object.assign(new Error("locked"), { code: "EPERM" });
      await unlink(path);
    };
    const b = held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { unlink: never, unlinkRetries: 2, logger: { warn: (m) => warns.push(m) } })));
    await b.release();
    expect(existsSync(p)).toBe(true);
    expect(warns.some((w) => w.includes("could not delete"))).toBe(true);
    // Still ours and still held: another acquirer is busy until it goes stale.
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir))).toEqual({ busy: true });
  });

  it("every exit path releases: success, throw, abort", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    const deps = fast(dir);
    expect(await withSlot({ max: 1, waitMs: 0, meta }, async () => 7, deps)).toEqual({ value: 7 });
    expect(existsSync(p)).toBe(false);
    await expect(withSlot({ max: 1, waitMs: 0, meta }, async () => { throw new Error("boom"); }, deps)).rejects.toThrow("boom");
    expect(existsSync(p)).toBe(false);
    const ac = new AbortController();
    await expect(
      withSlot({ max: 1, waitMs: 0, meta, signal: ac.signal }, async () => {
        ac.abort();
        throw ac.signal.reason;
      }, deps),
    ).rejects.toBeDefined();
    expect(existsSync(p)).toBe(false);
  });
});

describe("slot: waiting", () => {
  it("waitMs=0 returns busy immediately", async () => {
    const dir = freshDir();
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir)));
    const t0 = Date.now();
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir))).toEqual({ busy: true });
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("an abort while waiting resolves busy promptly and leaks no timers", async () => {
    const dir = freshDir();
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { heartbeatMs: 1_000_000 })));
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const before = timers();
    const ac = new AbortController();
    const p = acquireSlot({ max: 1, waitMs: 60_000, meta, signal: ac.signal }, { dir, backoffMinMs: 2_000, backoffMaxMs: 2_000 });
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    ac.abort();
    expect(await p).toEqual({ busy: true });
    expect(Date.now() - t0).toBeLessThan(100);
    expect(timers()).toBeLessThanOrEqual(before);
    expect(await acquireSlot({ max: 1, waitMs: 1_000, meta, signal: AbortSignal.abort() }, fast(dir))).toEqual({ busy: true });
  });

  it("no busy-wait: a long wait wakes up a bounded number of times (exponential backoff)", async () => {
    const dir = freshDir();
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { heartbeatMs: 1_000_000 })));
    let wakes = 0;
    // Plan values scaled by 1/10: 25 ms -> 200 ms over a 1 s wait (10 s at real scale).
    const r = await acquireSlot({ max: 1, waitMs: 1_000, meta }, { dir, backoffMinMs: 25, backoffMaxMs: 200, onAttempt: () => wakes++ });
    expect(r).toEqual({ busy: true });
    expect(wakes).toBeGreaterThan(2);
    expect(wakes).toBeLessThan(20);
  });
});

describe("slot: unwritable temp dir", () => {
  it("falls back to an in-process semaphore with the same API and logs once", async () => {
    const base = freshDir();
    const file = join(base, "not-a-dir");
    writeFileSync(file, "");
    const dir = join(file, "verify-slots"); // mkdir under a file fails (ENOTDIR/ENOENT)
    const warns: string[] = [];
    const deps: SlotDeps = { dir, logger: { warn: (m) => warns.push(m) } };
    const a = held(await acquireSlot({ max: 1, waitMs: 0, meta }, deps));
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, deps)).toEqual({ busy: true });
    const waiting = acquireSlot({ max: 1, waitMs: 2_000, meta }, deps);
    await a.release();
    await a.release();
    const b = held(await waiting);
    const ac = new AbortController();
    const aborted = acquireSlot({ max: 1, waitMs: 5_000, meta, signal: ac.signal }, deps);
    ac.abort();
    expect(await aborted).toEqual({ busy: true });
    expect(await acquireSlot({ max: 1, waitMs: 50, meta }, deps)).toEqual({ busy: true });
    await b.release();
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, deps));
    expect(warns.filter((w) => w.includes("in-process"))).toHaveLength(1);
  });
});
