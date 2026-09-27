/**
 * Machine-wide verification slot (S3): a cross-process counting semaphore.
 *
 * At most `max` verification commands run at a time across every opencode
 * process on the machine. Each held slot is a lock file
 * `<tmp>/opencode-model-router/verify-slots/slot-<i>.lock`, created with
 * `open(path, "wx")` (atomic create-or-fail on NTFS and ext4, see the Phase 1.4
 * pre-flight) and holding `{pid, hostname, token, startedAt, cwd, command}`.
 *
 * Crash recovery: the holder refreshes the file's mtime every 5 s (unref'd
 * timer). A lock is stale when its host is this host and its PID is dead, or
 * when its heartbeat is older than 30 s whatever the host (a foreign PID space
 * is never probed). A corrupt/empty lock is stale once it is older than a short
 * grace, because a creator writes the JSON right after the exclusive create.
 *
 * TOCTOU between "judged stale" and "deleted": every delete of a slot file (a
 * reap of a stale lock, or an owner's release) happens under a per-slot reap
 * lock (`slot-<i>.lock.reap`, also `wx`) and re-reads the file under it,
 * deleting only when the token is still the one judged stale. Creation needs
 * the slot file to be absent and only deleters remove it, so under the reap
 * lock the file cannot change identity between the re-read and the unlink.
 * Unlink failures from antivirus/indexer handles (EBUSY/EPERM/EACCES) are
 * retried and never reported as success.
 *
 * Clock note: age is `now - mtime`. An mtime in the future (clock moved back)
 * counts as fresh, so a clock change can delay reclaiming a crashed foreign
 * holder but never makes a live holder look stale; same-host crashes are still
 * caught by the PID probe.
 *
 * If the temp dir is unwritable the module degrades to an in-process semaphore
 * with the same API and logs that once per slot dir. No process is spawned here.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, open, readFile, stat, unlink, utimes } from "node:fs/promises";
import { hostname as osHostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginLogger } from "../router/logger";

export interface SlotMeta {
  cwd: string;
  command: string;
}

export interface SlotOptions {
  max: number;
  waitMs: number;
  signal?: AbortSignal;
  meta: SlotMeta;
}

export interface SlotHandle {
  release(): Promise<void>;
}

export type SlotResult = SlotHandle | { busy: true };

/** Test seams. Defaults are the production values of plan 1.4.1. */
export interface SlotDeps {
  /** Slot directory. Default: `<os.tmpdir()>/opencode-model-router/verify-slots`. */
  dir?: string;
  logger?: Pick<PluginLogger, "warn">;
  now?: () => number;
  random?: () => number;
  hostname?: string;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
  heartbeatMs?: number;
  staleMs?: number;
  corruptGraceMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  reapStaleMs?: number;
  unlink?: (path: string) => Promise<void>;
  unlinkRetries?: number;
  unlinkRetryMs?: number;
  /** Called on every wake-up of the wait loop (attempt), for busy-wait assertions. */
  onAttempt?: () => void;
}

export const SLOT_DEFAULTS = {
  heartbeatMs: 5_000,
  staleMs: 30_000,
  corruptGraceMs: 2_000,
  backoffMinMs: 250,
  backoffMaxMs: 2_000,
  reapStaleMs: 10_000,
  unlinkRetries: 6,
  unlinkRetryMs: 50,
} as const;

export function defaultSlotDir(): string {
  return join(tmpdir(), "opencode-model-router", "verify-slots");
}

interface LockInfo {
  pid: number;
  hostname: string;
  token: string;
  startedAt: number;
  cwd: string;
  command: string;
}

type LockState =
  | { kind: "missing" }
  | { kind: "ok"; info: LockInfo; mtimeMs: number }
  | { kind: "corrupt"; mtimeMs: number };

type Cfg = Required<Omit<SlotDeps, "logger" | "onAttempt">> & Pick<SlotDeps, "logger" | "onAttempt">;

function errCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

const RETRYABLE_UNLINK = new Set(["EBUSY", "EPERM", "EACCES"]);
const UNWRITABLE = new Set(["EACCES", "EPERM", "EROFS", "ENOTDIR", "ENOENT", "EEXIST"]);

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else (verified on Windows
    // and the documented POSIX behaviour). Anything but ESRCH is treated as alive.
    return errCode(e) !== "ESRCH";
  }
}

function resolveCfg(deps: SlotDeps = {}): Cfg {
  return {
    dir: deps.dir ?? defaultSlotDir(),
    now: deps.now ?? Date.now,
    random: deps.random ?? Math.random,
    hostname: deps.hostname ?? osHostname(),
    pid: deps.pid ?? process.pid,
    isPidAlive: deps.isPidAlive ?? isPidAlive,
    heartbeatMs: deps.heartbeatMs ?? SLOT_DEFAULTS.heartbeatMs,
    staleMs: deps.staleMs ?? SLOT_DEFAULTS.staleMs,
    corruptGraceMs: deps.corruptGraceMs ?? SLOT_DEFAULTS.corruptGraceMs,
    backoffMinMs: deps.backoffMinMs ?? SLOT_DEFAULTS.backoffMinMs,
    backoffMaxMs: deps.backoffMaxMs ?? SLOT_DEFAULTS.backoffMaxMs,
    reapStaleMs: deps.reapStaleMs ?? SLOT_DEFAULTS.reapStaleMs,
    unlink: deps.unlink ?? unlink,
    unlinkRetries: deps.unlinkRetries ?? SLOT_DEFAULTS.unlinkRetries,
    unlinkRetryMs: deps.unlinkRetryMs ?? SLOT_DEFAULTS.unlinkRetryMs,
    logger: deps.logger,
    onAttempt: deps.onAttempt,
  };
}

function parseLock(text: string): LockInfo | undefined {
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== "object" || v === null) return undefined;
    const o = v as Record<string, unknown>;
    if (typeof o.pid !== "number" || typeof o.hostname !== "string" || typeof o.token !== "string") return undefined;
    return {
      pid: o.pid,
      hostname: o.hostname,
      token: o.token,
      startedAt: typeof o.startedAt === "number" ? o.startedAt : 0,
      cwd: typeof o.cwd === "string" ? o.cwd : "",
      command: typeof o.command === "string" ? o.command : "",
    };
  } catch (e) {
    if (e instanceof SyntaxError) return undefined;
    throw e;
  }
}

async function readLock(path: string): Promise<LockState> {
  try {
    const st = await stat(path);
    const text = await readFile(path, "utf8");
    const info = parseLock(text);
    return info ? { kind: "ok", info, mtimeMs: st.mtimeMs } : { kind: "corrupt", mtimeMs: st.mtimeMs };
  } catch (e) {
    const code = errCode(e);
    if (code === "ENOENT") return { kind: "missing" };
    // Held open/locked by a scanner: unknown, so treat as present and fresh.
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") return { kind: "corrupt", mtimeMs: Number.POSITIVE_INFINITY };
    throw e;
  }
}

function isStale(s: LockState, cfg: Cfg): boolean {
  if (s.kind === "missing") return false;
  const age = cfg.now() - s.mtimeMs;
  if (s.kind === "corrupt") return age > cfg.corruptGraceMs;
  if (age > cfg.staleMs) return true;
  return s.info.hostname === cfg.hostname && !cfg.isPidAlive(s.info.pid);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Unlink, retrying transient Windows sharing violations. True when the file is gone. */
async function unlinkRetry(path: string, cfg: Cfg): Promise<boolean> {
  for (let i = 0; ; i++) {
    try {
      await cfg.unlink(path);
      return true;
    } catch (e) {
      const code = errCode(e);
      if (code === "ENOENT") return true;
      if (!code || !RETRYABLE_UNLINK.has(code) || i >= cfg.unlinkRetries) {
        cfg.logger?.warn("verification slot: could not delete lock file", { path, code: code ?? String(e) });
        return false;
      }
      await sleep(cfg.unlinkRetryMs * 2 ** i);
    }
  }
}

/** Create `path` exclusively with `content`. True when this call created it. */
async function createExclusive(path: string, content: string): Promise<boolean> {
  let fh;
  try {
    fh = await open(path, "wx");
  } catch (e) {
    const code = errCode(e);
    if (code === "EEXIST" || code === "EBUSY" || code === "EPERM" || code === "EACCES") return false;
    throw e;
  }
  try {
    await fh.writeFile(content, "utf8");
  } finally {
    await fh.close();
  }
  return true;
}

/** Run `fn` under the per-slot reap lock. Returns undefined when the lock is busy. */
async function withReapLock<T>(slotPath: string, cfg: Cfg, fn: () => Promise<T>): Promise<T | undefined> {
  const reapPath = `${slotPath}.reap`;
  const token = randomUUID();
  if (!(await createExclusive(reapPath, token))) {
    // A reaper that crashed under the lock: reclaim by age only.
    const st = await stat(reapPath).catch((e: unknown) => (errCode(e) === "ENOENT" ? undefined : Promise.reject(e)));
    if (st && cfg.now() - st.mtimeMs > cfg.reapStaleMs) await unlinkRetry(reapPath, cfg);
    return undefined;
  }
  try {
    return await fn();
  } finally {
    const cur = await readFile(reapPath, "utf8").catch((e: unknown) => (errCode(e) === "ENOENT" ? "" : Promise.reject(e)));
    if (cur === token) await unlinkRetry(reapPath, cfg);
  }
}

/** Delete `path` if it still holds the lock `observed` (same token, still stale when `requireStale`). */
async function compareAndDelete(path: string, token: string | undefined, cfg: Cfg, requireStale: boolean): Promise<boolean> {
  const res = await withReapLock(path, cfg, async () => {
    const cur = await readLock(path);
    if (cur.kind === "missing") return false;
    if (token === undefined ? cur.kind !== "corrupt" : cur.kind !== "ok" || cur.info.token !== token) return false;
    if (requireStale && !isStale(cur, cfg)) return false;
    return unlinkRetry(path, cfg);
  });
  return res === true;
}

// ---- held slots, released synchronously on process exit ----------------------

interface Held {
  path: string;
  token: string;
}
const held = new Set<Held>();
let exitHooked = false;
/** Exit-time release failures (observable in tests; nothing can log at exit). */
export let exitReleaseFailures = 0;
export let lastExitReleaseError: string | undefined;

function releaseAllSync(): void {
  for (const h of held) {
    try {
      const info = parseLock(readFileSync(h.path, "utf8"));
      if (info?.token === h.token) unlinkSync(h.path);
    } catch (e) {
      // Best effort at exit: the heartbeat stops with the process and the PID
      // probe reclaims the slot. Nothing can be logged asynchronously here.
      exitReleaseFailures++;
      lastExitReleaseError = errCode(e) ?? String(e);
    }
  }
  held.clear();
}

function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", releaseAllSync);
}

// ---- in-process fallback ------------------------------------------------------

interface LocalSem {
  count: number;
  waiters: Array<() => void>;
}
const localSems = new Map<string, LocalSem>();
const degradedLogged = new Set<string>();

function acquireLocal(opts: SlotOptions, cfg: Cfg): Promise<SlotResult> {
  let sem = localSems.get(cfg.dir);
  if (!sem) {
    sem = { count: 0, waiters: [] };
    localSems.set(cfg.dir, sem);
  }
  const s = sem;
  const makeHandle = (): SlotHandle => {
    let done = false;
    return {
      release: async () => {
        if (done) return;
        done = true;
        const next = s.waiters.shift();
        if (next) next();
        else s.count--;
      },
    };
  };
  if (s.count < opts.max) {
    s.count++;
    return Promise.resolve(makeHandle());
  }
  if (opts.waitMs <= 0 || opts.signal?.aborted) return Promise.resolve({ busy: true });
  return new Promise((resolve) => {
    const grant = () => {
      cleanup();
      resolve(makeHandle());
    };
    const giveUp = () => {
      const i = s.waiters.indexOf(grant);
      if (i >= 0) s.waiters.splice(i, 1);
      cleanup();
      resolve({ busy: true });
    };
    const timer = setTimeout(giveUp, opts.waitMs);
    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", giveUp);
    };
    opts.signal?.addEventListener("abort", giveUp, { once: true });
    s.waiters.push(grant);
  });
}

async function dirWritable(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true });
    const probe = join(dir, `.probe-${randomUUID()}`);
    const fh = await open(probe, "wx");
    await fh.close();
    await unlink(probe);
    return true;
  } catch (e) {
    const code = errCode(e);
    if (code && UNWRITABLE.has(code)) return false;
    throw e;
  }
}

// ---- file slots -------------------------------------------------------------

function startHeartbeat(path: string, token: string, cfg: Cfg): NodeJS.Timeout {
  const timer = setInterval(() => {
    void (async () => {
      const cur = await readLock(path);
      if (cur.kind !== "ok" || cur.info.token !== token) return;
      const t = new Date(cfg.now());
      await utimes(path, t, t);
    })().catch((e: unknown) => cfg.logger?.warn("verification slot: heartbeat failed", { path, code: errCode(e) ?? String(e) }));
  }, cfg.heartbeatMs);
  timer.unref();
  return timer;
}

async function tryAcquireOnce(opts: SlotOptions, cfg: Cfg): Promise<SlotHandle | undefined> {
  for (let i = 0; i < opts.max; i++) {
    const path = join(cfg.dir, `slot-${i}.lock`);
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = randomUUID();
      const info: LockInfo = {
        pid: cfg.pid,
        hostname: cfg.hostname,
        token,
        startedAt: cfg.now(),
        cwd: opts.meta.cwd,
        command: opts.meta.command,
      };
      if (await createExclusive(path, JSON.stringify(info))) return makeFileHandle(path, token, cfg);
      const cur = await readLock(path);
      if (cur.kind === "missing") continue; // released meanwhile: retry the create once
      if (!isStale(cur, cfg)) break;
      if (!(await compareAndDelete(path, cur.kind === "ok" ? cur.info.token : undefined, cfg, true))) break;
    }
  }
  return undefined;
}

function makeFileHandle(path: string, token: string, cfg: Cfg): SlotHandle {
  hookExit();
  const entry: Held = { path, token };
  held.add(entry);
  const hb = startHeartbeat(path, token, cfg);
  let releasing: Promise<void> | undefined;
  return {
    release: () => {
      releasing ??= (async () => {
        clearInterval(hb);
        held.delete(entry);
        // Wait briefly for a concurrent reaper; then delete under the reap lock.
        for (let i = 0; i < 20; i++) {
          const r = await withReapLock(path, cfg, async () => {
            const cur = await readLock(path);
            if (cur.kind !== "ok" || cur.info.token !== token) return true; // reclaimed: not ours any more
            return unlinkRetry(path, cfg);
          });
          if (r !== undefined) return;
          await sleep(cfg.unlinkRetryMs);
        }
        cfg.logger?.warn("verification slot: reap lock busy, slot left to stale detection", { path });
      })();
      return releasing;
    },
  };
}

/**
 * Acquire one of `max` machine-wide verification slots, waiting up to `waitMs`
 * with exponential backoff and jitter. Resolves `{busy:true}` on timeout or
 * abort; never rejects for contention.
 */
export async function acquireSlot(opts: SlotOptions, deps?: SlotDeps): Promise<SlotResult> {
  const cfg = resolveCfg(deps);
  if (opts.signal?.aborted) return { busy: true };
  const max = Math.max(1, Math.floor(opts.max));
  const o = { ...opts, max };
  if (!(await dirWritable(cfg.dir))) {
    if (!degradedLogged.has(cfg.dir)) {
      degradedLogged.add(cfg.dir);
      cfg.logger?.warn("verification slot: temp dir unwritable, using an in-process semaphore", { dir: cfg.dir });
    }
    return acquireLocal(o, cfg);
  }
  const deadline = cfg.now() + Math.max(0, opts.waitMs);
  for (let k = 0; ; k++) {
    cfg.onAttempt?.();
    const h = await tryAcquireOnce(o, cfg);
    if (h) {
      if (opts.signal?.aborted) {
        await h.release();
        return { busy: true };
      }
      return h;
    }
    const remaining = deadline - cfg.now();
    if (remaining <= 0 || opts.signal?.aborted) return { busy: true };
    const base = Math.min(cfg.backoffMaxMs, cfg.backoffMinMs * 2 ** k);
    const delay = Math.min(remaining, Math.max(1, Math.round(base * (0.5 + cfg.random() * 0.5))));
    const aborted = await new Promise<boolean>((resolve) => {
      const onAbort = () => {
        clearTimeout(t);
        resolve(true);
      };
      const t = setTimeout(() => {
        opts.signal?.removeEventListener("abort", onAbort);
        resolve(false);
      }, delay);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    });
    if (aborted) return { busy: true };
  }
}

/** Run `fn` while holding a slot; the slot is released on every exit path. */
export async function withSlot<T>(
  opts: SlotOptions,
  fn: () => Promise<T>,
  deps?: SlotDeps,
): Promise<{ busy: true } | { value: T }> {
  const s = await acquireSlot(opts, deps);
  if ("busy" in s) return s;
  try {
    return { value: await fn() };
  } finally {
    await s.release();
  }
}

/** Synchronous variant of the exit hook, exported for tests. */
export const releaseAllSlotsSync = releaseAllSync;

