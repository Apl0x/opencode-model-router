import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { open as fsOpen, unlink as fsUnlink, utimes as fsUtimes } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  acquireSlot,
  exitReleaseFailures,
  isPidAlive,
  reapClaimPath,
  releaseAllSlotsSync,
  withSlot,
  type FileSnapshot,
  type SlotDeps,
  type SlotHandle,
  type SlotResult,
} from "../../src/verify/slot";

// Every test uses its own slot dir, never the real shared one, so parallel runs
// cannot interfere. Timing constants are scaled down through the deps seam.
const SLOT_TS = resolve(__dirname, "../../src/verify/slot.ts");
const HOLDER = resolve(__dirname, "../fixtures/slot/holder.mjs");
const dirs: string[] = [];
const children: ChildProcess[] = [];
const handles: SlotHandle[] = [];
/** JS build of slot.ts for the child processes (Node 20 has no type stripping). */
let slotJs = "";

beforeAll(async () => {
  // The real slot.ts, transpiled with the oxc transformer that vitest's vite already ships.
  const { transformWithOxc } = await import("vite");
  const out = await transformWithOxc(readFileSync(SLOT_TS, "utf8"), SLOT_TS, { lang: "ts" });
  slotJs = join(freshDir(), "slot.mjs");
  writeFileSync(slotJs, out.code);
});

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
function tokenAt(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const v: unknown = JSON.parse(readFileSync(path, "utf8"));
  return typeof v === "object" && v !== null && "token" in v ? String(v.token) : undefined;
}
function setAge(path: string, ageMs: number): void {
  const t = new Date(Date.now() - ageMs);
  utimesSync(path, t, t);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitUntil(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(10);
  }
}
/** The default read of slot.ts, for seams that wrap it. */
async function realRead(path: string): Promise<FileSnapshot> {
  const fh = await fsOpen(path, "r");
  try {
    const st = await fh.stat();
    return { text: await fh.readFile("utf8"), mtimeMs: st.mtimeMs, size: st.size };
  } finally {
    await fh.close();
  }
}
/** Claim files (`slot-<i>.lock.reap-<hash>`) present in `dir`. */
function claimsIn(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.includes(".reap-"));
}
/** A PID that is not running now (Windows reuses PIDs quickly, so check it). */
async function deadPid(): Promise<number> {
  for (;;) {
    const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
    const pid = Number(r.stdout.toString());
    for (let i = 0; i < 50 && isPidAlive(pid); i++) await sleep(20);
    if (!isPidAlive(pid)) return pid;
  }
}
function killHard(child: ChildProcess): void {
  if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)]);
  else child.kill("SIGKILL");
}
interface Holder {
  child: ChildProcess;
  /** Resolves with the first stdout line matching `want`, or "EXIT <stdout> <stderr>" if the child exits first. */
  waitFor(want: RegExp): Promise<string>;
  exit: Promise<number | null>;
}
function runHolder(cfg: Record<string, unknown>): Holder {
  const child = spawn(process.execPath, [HOLDER, slotJs, JSON.stringify(cfg)], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const lines: string[] = [];
  let buf = "";
  let err = "";
  let exited = false;
  const wake: Array<() => void> = [];
  const poke = () => {
    for (const w of wake.splice(0)) w();
  };
  child.stdout!.on("data", (d: Buffer) => {
    buf += d.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      lines.push(buf.slice(0, i).trim());
      buf = buf.slice(i + 1);
    }
    poke();
  });
  child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
  const exit = new Promise<number | null>((res) =>
    child.on("exit", (c) => {
      exited = true;
      poke();
      res(c);
    }),
  );
  const waitFor = (want: RegExp) =>
    new Promise<string>((res) => {
      const check = () => {
        const hit = lines.find((l) => want.test(l));
        if (hit !== undefined) res(hit);
        else if (exited) res(`EXIT ${lines.join("|")} ${err}`);
        else wake.push(check);
      };
      check();
    });
  return { child, waitFor, exit };
}
/** Start children behind a barrier: each loads the module, prints READY, then waits for the go file. */
async function startTogether(dir: string, cfgs: Array<Record<string, unknown>>): Promise<Holder[]> {
  const go = join(dir, "go");
  const hs = cfgs.map((c) => runHolder({ ...c, go }));
  expect(await Promise.all(hs.map((h) => h.waitFor(/^READY$/)))).toEqual(cfgs.map(() => "READY"));
  writeFileSync(go, "");
  return hs;
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

async function cycleSix(dir: string, max: number, holdMs: number): Promise<void> {
  const log = join(dir, "log.txt");
  writeFileSync(log, "");
  const hs = await startTogether(
    dir,
    Array.from({ length: 6 }, (_, i) => ({ dir, max, waitMs: 20_000, holdMs, log, id: `p${i}`, mode: "cycle", deps: { backoffMinMs: 10, backoffMaxMs: 60 } })),
  );
  const codes = await Promise.all(hs.map((h) => h.exit));
  expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
  const iv = intervals(log);
  expect(iv).toHaveLength(6);
  expect(maxOverlap(iv)).toBeLessThanOrEqual(max);
  if (max === 2) expect(maxOverlap(iv)).toBe(2); // the second slot is actually used
}

describe("slot: multi-process exclusion", () => {
  it.each([
    [1, 150],
    [2, 500],
  ])("max=%i: never more than max holders across 6 processes (hold %i ms)", async (max, holdMs) => {
    await cycleSix(freshDir(), max, holdMs);
  }, 30_000);

  it("a crashed holder (hard kill) is reclaimed by a waiter that was already waiting, within the backoff window", async () => {
    const dir = freshDir();
    const h = runHolder({ dir, max: 1, waitMs: 1_000, mode: "hang" });
    expect(await h.waitFor(/^(HELD|BUSY)$/)).toBe("HELD");
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir))).toEqual({ busy: true });
    // The waiter starts first (production backoff 250 ms -> 2 s) and is in backoff when the holder dies.
    const waiting = acquireSlot({ max: 1, waitMs: 10_000, meta }, { dir });
    await sleep(700);
    killHard(h.child);
    await h.exit;
    const t0 = Date.now();
    held(await waiting);
    expect(Date.now() - t0).toBeLessThan(3_000);
  }, 20_000);

  it("the heartbeat timer is unref'd: a holder exits on its own and the exit hook frees the slot", async () => {
    const dir = freshDir();
    const h = runHolder({ dir, max: 1, waitMs: 1_000, mode: "exit", deps: { heartbeatMs: 50 } });
    expect(await h.waitFor(/^(HELD|BUSY)$/)).toBe("HELD");
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
    const deps = fast(dir, { staleMs: 2_000, heartbeatMs: 100 });
    const a = held(await acquireSlot({ max: 1, waitMs: 0, meta }, deps));
    expect(await acquireSlot({ max: 1, waitMs: 6_000, meta }, deps)).toEqual({ busy: true });
    await a.release();
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, deps));
  }, 15_000);

  it("a foreign host lock is never judged by PID: fresh heartbeat kept, old heartbeat reclaimed after confirmation", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    writeLock(p, { hostname: "some-other-host", pid: await deadPid() });
    expect(await acquireSlot({ max: 1, waitMs: 400, meta }, fast(dir, { staleMs: 5_000 }))).toEqual({ busy: true });
    setAge(p, 6_000);
    // One look is not enough: the same (token, mtime) must be seen for 2 heartbeats (2 x 100 ms).
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { staleMs: 5_000 }))).toEqual({ busy: true });
    const t0 = Date.now();
    held(await acquireSlot({ max: 1, waitMs: 3_000, meta }, fast(dir, { staleMs: 5_000 })));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
  });

  it("same host + dead PID is stale immediately, even with a fresh heartbeat", async () => {
    const dir = freshDir();
    writeLock(join(dir, "slot-0.lock"), { pid: await deadPid() });
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { staleMs: 60_000 })));
  });

  it.each([["empty", ""], ["corrupt", "{not json"], ["wrong shape", '{"pid":"x"}']])("a %s lock file is stale (after the write grace)", async (_n, body) => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    writeFileSync(p, body);
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { corruptGraceMs: 300 }))).toEqual({ busy: true });
    const t0 = Date.now();
    held(await acquireSlot({ max: 1, waitMs: 3_000, meta }, fast(dir, { corruptGraceMs: 300 })));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });
});

describe("slot: clock changes and suspend/resume (QA-1.4-1, QA-1.4-8)", () => {
  it("production defaults: a live holder whose file looks 31 s old (resume from sleep) or a waiter whose clock jumped +31 s does not reap it", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, { dir }));
    setAge(p, 31_000);
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, { dir })).toEqual({ busy: true });
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, { dir, now: () => Date.now() + 31_000 })).toEqual({ busy: true });
    expect(existsSync(p)).toBe(true);
  });

  it("a live holder keeps its slot against a waiting observer with an aged file or a stepped clock", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { heartbeatMs: 100 })));
    const mine = tokenAt(p);
    setAge(p, 31_000);
    // The observer confirms over 2 of its heartbeats (2 x 500 ms); the holder beats every 100 ms.
    const observer = fast(dir, { heartbeatMs: 500, staleMs: 1_000 });
    expect(await acquireSlot({ max: 1, waitMs: 1_500, meta }, observer)).toEqual({ busy: true });
    expect(await acquireSlot({ max: 1, waitMs: 1_500, meta }, { ...observer, now: () => Date.now() + 31_000 })).toEqual({ busy: true });
    expect(tokenAt(p)).toBe(mine);
  }, 10_000);

  it("a lock whose mtime is in the future (clock stepped back) is reclaimed once seen unchanged for staleMs of monotonic time", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    writeLock(p, { hostname: "some-other-host" });
    const future = new Date(Date.now() + 3_600_000);
    utimesSync(p, future, future);
    const t0 = Date.now();
    held(await acquireSlot({ max: 1, waitMs: 5_000, meta }, fast(dir, { staleMs: 600 })));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
  });

  it("the wait deadline is monotonic: wall-clock steps neither cut a wait short nor extend it", async () => {
    const dir = freshDir();
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir)));
    // The observers confirm staleness over 2 x 1 s, longer than the wait: only the deadline ends it.
    let calls = 0;
    const forward = () => Date.now() + (calls++ > 1 ? 3_600_000 : 0);
    let t0 = Date.now();
    expect(await acquireSlot({ max: 1, waitMs: 600, meta }, fast(dir, { heartbeatMs: 1_000, now: forward }))).toEqual({ busy: true });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
    calls = 0;
    const backward = () => Date.now() - (calls++ > 1 ? 3_600_000 : 0);
    t0 = Date.now();
    expect(await acquireSlot({ max: 1, waitMs: 600, meta }, fast(dir, { heartbeatMs: 1_000, now: backward }))).toEqual({ busy: true });
    expect(Date.now() - t0).toBeLessThan(2_000);
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
    const b = held(await acquireSlot({ max: 1, waitMs: 2_000, meta }, fast(dir, { staleMs: 1_000 })));
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
    expect(warns.some((w) => w.includes("release incomplete"))).toBe(true);
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

describe("slot: claims replace the time-leased reap lock (QA-1.4-2, QA-1.4-11)", () => {
  it("a crashed reaper's claim (dead PID) is cleared and the dead lock reaped at once", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    writeLock(p, { pid: await deadPid(), token: "dead-holder" });
    writeLock(reapClaimPath(p, "dead-holder"), { pid: await deadPid(), token: "dead-reaper", command: "reap" });
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir)));
    expect(claimsIn(dir)).toEqual([]);
  });

  it("a live claimer's claim survives one look and a stepped clock; it is removed only once inert", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    writeLock(p, { pid: await deadPid(), token: "dead-holder" });
    const claim = reapClaimPath(p, "dead-holder");
    writeLock(claim, { pid: process.ppid, token: "live-claimer", command: "reap" }, 60_000);
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, { dir })).toEqual({ busy: true });
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, { dir, now: () => Date.now() + 10_500 })).toEqual({ busy: true });
    expect(existsSync(claim)).toBe(true);
    // Inert: older than staleMs and seen unchanged for 2 x claimHoldMaxMs (2 x 100 ms here).
    const t0 = Date.now();
    held(await acquireSlot({ max: 1, waitMs: 3_000, meta }, fast(dir, { claimHoldMaxMs: 100 })));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
    expect(claimsIn(dir)).toEqual([]);
  });

  it("a reaper held inside its claim by EBUSY retries keeps it against a waiter whose clock jumped (P3)", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    writeLock(p, { pid: await deadPid(), token: "dead-holder" });
    let blocking = true;
    const stuck = async (path: string) => {
      if (path === p && blocking) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      await fsUnlink(path);
    };
    const a = acquireSlot({ max: 1, waitMs: 5_000, meta }, fast(dir, { unlink: stuck, unlinkRetryMs: 40 }));
    await waitUntil(() => claimsIn(dir).length === 1);
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { now: () => Date.now() + 10_500 }))).toEqual({ busy: true });
    blocking = false;
    held(await a);
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir))).toEqual({ busy: true });
    expect(claimsIn(dir)).toEqual([]);
  });

  it("6 processes against a planted dead lock: never two holders", async () => {
    const dir = freshDir();
    writeLock(join(dir, "slot-0.lock"), { pid: await deadPid(), token: "planted" });
    await cycleSix(dir, 1, 150);
    expect(claimsIn(dir)).toEqual([]);
  }, 30_000);

  it("6 processes against a planted dead lock plus a crashed reaper's claim and legacy reap/tombstone files", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    writeLock(p, { pid: await deadPid(), token: "planted" });
    writeLock(reapClaimPath(p, "planted"), { pid: await deadPid(), token: "dead-reaper", command: "reap" }, 11_000);
    writeFileSync(`${p}.reap`, "legacy");
    writeFileSync(`${p}.reap.dead-0`, "tombstone");
    await cycleSix(dir, 1, 150);
    expect(claimsIn(dir)).toEqual([]);
  }, 30_000);
});

describe("slot: release never fails the caller (QA-1.4-4, QA-1.4-6, QA-1.4-17)", () => {
  const eio = async (path: string) => {
    if (/slot-\d+\.lock$/.test(path)) throw Object.assign(new Error("io"), { code: "EIO" });
    await fsUnlink(path);
  };

  it("release never rejects and does not cache a failure; withSlot keeps fn's value and error", async () => {
    const dir = freshDir();
    const warns: string[] = [];
    const a = held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { unlink: eio, logger: { warn: (m) => warns.push(m) } })));
    await expect(a.release()).resolves.toBeUndefined();
    await expect(a.release()).resolves.toBeUndefined();
    expect(warns.some((w) => w.includes("release incomplete"))).toBe(true);

    let breakReads = false;
    const read = async (path: string) => {
      if (breakReads) throw Object.assign(new Error("io"), { code: "EIO" });
      return realRead(path);
    };
    const b = held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(freshDir(), { read })));
    breakReads = true;
    await expect(b.release()).resolves.toBeUndefined();
    breakReads = false;

    expect(await withSlot({ max: 1, waitMs: 0, meta }, async () => 42, fast(freshDir(), { unlink: eio }))).toEqual({ value: 42 });
    await expect(
      withSlot({ max: 1, waitMs: 0, meta }, async () => { throw new Error("boom"); }, fast(freshDir(), { unlink: eio })),
    ).rejects.toThrow("boom");
  });

  it("transient sharing violations on the lock and claim files during release are retried, and the file is deleted", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    let busyReads = 0;
    const read = async (path: string) => {
      if (busyReads > 0 && (path === p || path.includes(".reap-"))) {
        busyReads--;
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      }
      return realRead(path);
    };
    const warns: string[] = [];
    const a = held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { read, logger: { warn: (m) => warns.push(m) } })));
    busyReads = 4;
    await a.release();
    expect(existsSync(p)).toBe(false);
    expect(claimsIn(dir)).toEqual([]);
    expect(warns).toEqual([]);
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir)));
  });

  it("a release that cannot read its lock keeps the slot, warns, and deletes it in the background later", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    let locked = false;
    const read = async (path: string) => {
      if (locked && path === p) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      return realRead(path);
    };
    const warns: string[] = [];
    const a = held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { read, unlinkRetries: 2, logger: { warn: (m) => warns.push(m) } })));
    locked = true;
    await a.release();
    expect(existsSync(p)).toBe(true);
    expect(warns.some((w) => w.includes("release incomplete"))).toBe(true);
    expect(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir))).toEqual({ busy: true });
    locked = false;
    await waitUntil(() => !existsSync(p));
    held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir)));
  });

  it("a heartbeat tick in flight when release starts never touches the file afterwards", async () => {
    const dir = freshDir();
    const p = join(dir, "slot-0.lock");
    let arm = false;
    let gate: () => void = () => undefined;
    let started: () => void = () => undefined;
    const tickStarted = new Promise<void>((r) => (started = r));
    const read = async (path: string) => {
      if (arm && path === p) {
        arm = false;
        started();
        await new Promise<void>((r) => (gate = r));
      }
      return realRead(path);
    };
    let touches = 0;
    const utimes = async (path: string, t: Date) => {
      touches++;
      await fsUtimes(path, t, t);
    };
    const a = held(await acquireSlot({ max: 1, waitMs: 0, meta }, fast(dir, { heartbeatMs: 50, read, utimes })));
    arm = true;
    await tickStarted;
    const before = touches;
    const releasing = a.release();
    gate();
    await releasing;
    await sleep(200);
    expect(touches).toBe(before);
    expect(existsSync(p)).toBe(false);
  });

  it("the exit hook follows the claim protocol: it deletes its own file and leaves one a live reaper has claimed", async () => {
    const dir = freshDir();
    const p0 = join(dir, "slot-0.lock");
    const p1 = join(dir, "slot-1.lock");
    const deps = fast(dir, { heartbeatMs: 1_000_000 });
    held(await acquireSlot({ max: 2, waitMs: 0, meta }, deps));
    held(await acquireSlot({ max: 2, waitMs: 0, meta }, deps));
    const foreign = reapClaimPath(p1, tokenAt(p1)!);
    writeLock(foreign, { pid: process.ppid, token: "reaper", command: "reap" });
    const failures = exitReleaseFailures;
    releaseAllSlotsSync();
    expect(existsSync(p0)).toBe(false);
    expect(existsSync(p1)).toBe(true);
    expect(claimsIn(dir)).toEqual([foreign.slice(dir.length + 1)]);
    expect(exitReleaseFailures).toBe(failures);
    rmSync(foreign);
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
