/**
 * Machine-wide verification slot (S3): a cross-process counting semaphore.
 *
 * At most `max` verification commands run at a time across every opencode
 * process on the machine. Each held slot is a lock file
 * `<tmp>/opencode-model-router/verify-slots/slot-<i>.lock`, created with
 * `open(path, "wx")` (atomic create-or-fail on NTFS and ext4, see the Phase 1.4
 * pre-flight) and holding `{pid, hostname, token, startedAt, cwd, command}`.
 * The creator re-reads the file after writing it and holds the slot only if its
 * own token is there (a creator stalled between the create and the write may
 * have been reaped as an empty file).
 *
 * Staleness. The holder refreshes the file's mtime every `heartbeatMs` (5 s,
 * unref'd timer). A lock is stale when
 *   (a) its host is this host and its PID is dead (immediately), or
 *   (b) its heartbeat is older than `staleMs` (30 s) by the wall clock, AND this
 *       process has seen the same (token, mtime) for at least 2 heartbeats of its
 *       own monotonic clock (`performance.now()`), with no gap longer than 2
 *       heartbeats between two observations.
 * A suspend/resume or a clock step makes a live holder's file look old, but the
 * holder heartbeats within one interval after it runs again, which changes the
 * mtime and restarts the observation; a gap in the observations (the observer
 * slept) restarts it too. A lock seen unchanged for `staleMs` of monotonic time
 * is stale whatever its mtime says (an mtime in the future after the clock
 * stepped back). A foreign host is never judged by PID. A corrupt/empty lock uses
 * rule (b) with the short `corruptGraceMs` for both the age and the observation,
 * because a creator writes the JSON right after the exclusive create.
 *
 * Deletion. Every delete of a lock file whose identity is K (its token; for a
 * corrupt file its mtime and size) runs under the claim file
 * `slot-<i>.lock.reap-<hash(K)>`, created with `wx`. That includes the owner's
 * own release and the exit hook. The claim holder re-reads the file before every
 * unlink attempt and deletes it only while it is still K. K is never reused and
 * only a K-claim holder deletes K's file, so the file cannot be deleted and
 * re-created between the re-read and the unlink (no ABA, no time lease).
 * A claim holds `{pid, hostname, token}` and is removed by its owner. A crashed
 * claimer's claim is removed the same way, under the claim for *its* token, when
 * its owner is provably dead (same host, dead PID) or when it is older than
 * `staleMs` and has been seen unchanged for 2 x `claimHoldMaxMs`. A claimer never
 * deletes anything after holding its claim for `claimHoldMaxMs` of its monotonic
 * clock (self-fencing), so the second rule never removes the claim of a claimer
 * that still acts. Transient antivirus/indexer errors (EBUSY/EPERM/EACCES) are
 * retried, and a failed delete is never reported as success.
 *
 * Loss. When the heartbeat finds the holder's file gone or owned by another token,
 * the handle's `lost` becomes true, `onLost` is called and a warning is logged,
 * once. A failing `utimes` is retried like an unlink.
 *
 * Residual risk: every check-then-act on a file system has a window between the
 * last check and the syscall. A process frozen exactly there (SIGSTOP, a debugger)
 * for longer than the stale rules allow can still act late. A holder that stops
 * heartbeating for 2 intervals while its lock looks older than `staleMs` is
 * reaped; that is the plan's heartbeat contract.
 *
 * If the temp dir is unwritable the module degrades to an in-process semaphore
 * with the same API and logs that once per slot dir. No process is spawned here.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { mkdir, open, unlink, utimes, type FileHandle } from "node:fs/promises";
import { hostname as osHostname, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
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
  /**
   * Called once if the heartbeat finds this holder's lock file gone or owned by
   * another token (the slot was reclaimed while held: two holders may be running).
   */
  onLost?: () => void;
}

export interface SlotHandle {
  /** Deletes this holder's lock file. Idempotent; never rejects. */
  release(): Promise<void>;
  /** True once the heartbeat found that another process reclaimed this slot. */
  readonly lost: boolean;
}

export type SlotResult = SlotHandle | { busy: true };

/** One consistent read of a lock file: content and stat from the same open file. */
export interface FileSnapshot {
  text: string;
  mtimeMs: number;
  size: number;
}

/** Test seams. Defaults are the production values of plan 1.4.1. */
export interface SlotDeps {
  /** Slot directory. Default: `<os.tmpdir()>/opencode-model-router/verify-slots`. */
  dir?: string;
  logger?: Pick<PluginLogger, "warn">;
  /** Wall clock (ms). Compared with file mtimes and written into new files, nothing else. */
  now?: () => number;
  /** Monotonic clock (ms). Wait deadlines, observation windows and claim fencing. */
  mono?: () => number;
  random?: () => number;
  hostname?: string;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
  heartbeatMs?: number;
  staleMs?: number;
  corruptGraceMs?: number;
  /** A claimer stops deleting after holding its claim this long (self-fencing). */
  claimHoldMaxMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  unlink?: (path: string) => Promise<void>;
  read?: (path: string) => Promise<FileSnapshot>;
  utimes?: (path: string, time: Date) => Promise<void>;
  unlinkRetries?: number;
  unlinkRetryMs?: number;
  /** Called on every wake-up of the wait loop (attempt), for busy-wait assertions. */
  onAttempt?: () => void;
}

export const SLOT_DEFAULTS = {
  heartbeatMs: 5_000,
  staleMs: 30_000,
  corruptGraceMs: 2_000,
  claimHoldMaxMs: 5_000,
  backoffMinMs: 250,
  backoffMaxMs: 2_000,
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
  | { kind: "unreadable"; code: string }
  | { kind: "ok"; info: LockInfo; mtimeMs: number }
  | { kind: "corrupt"; mtimeMs: number; size: number };
type Present = Extract<LockState, { kind: "ok" | "corrupt" }>;

type Cfg = Required<Omit<SlotDeps, "logger" | "onAttempt">> & Pick<SlotDeps, "logger" | "onAttempt">;

function errCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

/** Sharing violations from antivirus/indexer handles: retried, never a verdict. */
const TRANSIENT = new Set(["EBUSY", "EPERM", "EACCES"]);
const UNWRITABLE = new Set(["EACCES", "EPERM", "EROFS", "ENOTDIR", "ENOENT", "EEXIST"]);

/** Failures of the logger itself (a throwing logger must not break slot bookkeeping). */
export let loggerFailures = 0;

function warn(cfg: Cfg, msg: string, data: Record<string, unknown>): void {
  try {
    cfg.logger?.warn(msg, data);
  } catch {
    loggerFailures++;
  }
}

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

async function readSnapshot(path: string): Promise<FileSnapshot> {
  const fh = await open(path, "r");
  try {
    const st = await fh.stat();
    const text = await fh.readFile("utf8");
    return { text, mtimeMs: st.mtimeMs, size: st.size };
  } finally {
    await fh.close();
  }
}

function resolveCfg(deps: SlotDeps = {}): Cfg {
  return {
    dir: deps.dir ?? defaultSlotDir(),
    now: deps.now ?? Date.now,
    mono: deps.mono ?? (() => performance.now()),
    random: deps.random ?? Math.random,
    hostname: deps.hostname ?? osHostname(),
    pid: deps.pid ?? process.pid,
    isPidAlive: deps.isPidAlive ?? isPidAlive,
    heartbeatMs: deps.heartbeatMs ?? SLOT_DEFAULTS.heartbeatMs,
    staleMs: deps.staleMs ?? SLOT_DEFAULTS.staleMs,
    corruptGraceMs: deps.corruptGraceMs ?? SLOT_DEFAULTS.corruptGraceMs,
    claimHoldMaxMs: deps.claimHoldMaxMs ?? SLOT_DEFAULTS.claimHoldMaxMs,
    backoffMinMs: deps.backoffMinMs ?? SLOT_DEFAULTS.backoffMinMs,
    backoffMaxMs: deps.backoffMaxMs ?? SLOT_DEFAULTS.backoffMaxMs,
    unlink: deps.unlink ?? unlink,
    read: deps.read ?? readSnapshot,
    utimes: deps.utimes ?? ((p, t) => utimes(p, t, t)),
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

/** Missing, unreadable (a scanner holds it: unknown, never stale), or present. */
async function readLock(path: string, cfg: Cfg): Promise<LockState> {
  let snap: FileSnapshot;
  try {
    snap = await cfg.read(path);
  } catch (e) {
    const code = errCode(e);
    if (code === "ENOENT") return { kind: "missing" };
    if (code !== undefined && TRANSIENT.has(code)) return { kind: "unreadable", code };
    throw e;
  }
  const info = parseLock(snap.text);
  return info ? { kind: "ok", info, mtimeMs: snap.mtimeMs } : { kind: "corrupt", mtimeMs: snap.mtimeMs, size: snap.size };
}

/** What a file is: its token, or for a corrupt file its mtime and size. Names its claim. */
function identity(s: Present): string {
  return s.kind === "ok" ? s.info.token : `corrupt:${s.mtimeMs}:${s.size}`;
}
/** Identity plus mtime: what must stay unchanged for a staleness verdict to hold. */
function observedKey(s: Present): string {
  return `${identity(s)}@${s.mtimeMs}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- staleness ----------------------------------------------------------------

interface Observation {
  key: string;
  first: number;
  last: number;
}
/** Per process: since when (monotonic) each file has been seen with the same key, without gaps. */
const observations = new Map<string, Observation>();

/** Record that `path` is seen with `key` now. Returns for how long it has been seen unchanged. */
function observe(path: string, key: string, cfg: Cfg): number {
  const t = cfg.mono();
  const maxGap = 2 * cfg.heartbeatMs;
  const o = observations.get(path);
  if (!o || o.key !== key || t - o.last > maxGap || t < o.last) {
    if (observations.size > 256) for (const [p, x] of observations) if (t - x.last > maxGap) observations.delete(p);
    observations.set(path, { key, first: t, last: t });
    return 0;
  }
  o.last = t;
  return t - o.first;
}

/** Same host and the PID is gone: provably dead, no confirmation needed. */
function ownerDead(s: Present, cfg: Cfg): boolean {
  return s.kind === "ok" && s.info.hostname === cfg.hostname && !cfg.isPidAlive(s.info.pid);
}

/** Old by the wall clock (or by the observation alone), and seen unchanged for `confirmMs`. */
function observedStale(path: string, s: Present, cfg: Cfg, ageMs: number, confirmMs: number): boolean {
  const span = observe(path, observedKey(s), cfg);
  return span >= confirmMs && (cfg.now() - s.mtimeMs > ageMs || span >= ageMs);
}

function lockStale(path: string, s: Present, cfg: Cfg): boolean {
  if (s.kind === "corrupt") return observedStale(path, s, cfg, cfg.corruptGraceMs, cfg.corruptGraceMs);
  return ownerDead(s, cfg) || observedStale(path, s, cfg, cfg.staleMs, 2 * cfg.heartbeatMs);
}

function claimStale(path: string, s: Present, cfg: Cfg): boolean {
  if (s.kind === "corrupt") return observedStale(path, s, cfg, cfg.corruptGraceMs, cfg.corruptGraceMs);
  return ownerDead(s, cfg) || observedStale(path, s, cfg, cfg.staleMs, 2 * cfg.claimHoldMaxMs);
}

// ---- exclusive create and claimed delete --------------------------------------

/**
 * Create `path` exclusively with `info`, then re-read it: true only when it
 * still holds `info.token`. An unreadable re-read (a scanner) counts as ours:
 * nobody else can have created the file, and a reaper needs it to be seen
 * unchanged for a while first.
 */
async function createOwned(path: string, info: LockInfo, cfg: Cfg): Promise<boolean> {
  let fh: FileHandle;
  try {
    fh = await open(path, "wx");
  } catch (e) {
    const code = errCode(e);
    if (code === "EEXIST" || (code !== undefined && TRANSIENT.has(code))) return false;
    throw e;
  }
  try {
    await fh.writeFile(JSON.stringify(info), "utf8");
  } finally {
    await fh.close();
  }
  const s = await readLock(path, cfg);
  return s.kind === "unreadable" || (s.kind === "ok" && s.info.token === info.token);
}

/** Claims currently held by this process (claim path -> claim token), for the exit hook. */
const activeClaims = new Map<string, string>();
const MAX_CLAIM_DEPTH = 3;

/** The claim file under which the file with identity `id` (in slot `slotPath`'s family) is deleted. */
export function reapClaimPath(slotPath: string, id: string): string {
  return `${slotPath}.reap-${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}

type Removal = "removed" | "gone" | "changed" | "contended" | "failed";

/**
 * Unlink `target` while `stillVictim` holds, re-reading it before every attempt.
 * Gives up (without deleting) at the monotonic `deadline`.
 */
async function unlinkWhile(target: string, deadline: number, cfg: Cfg, stillVictim: (s: Present) => boolean): Promise<Removal> {
  let last = "";
  for (let i = 0; ; i++) {
    if (cfg.mono() > deadline) {
      warn(cfg, "verification slot: claim held too long, delete abandoned", { path: target, code: last });
      return "failed";
    }
    const cur = await readLock(target, cfg);
    if (cur.kind === "missing") return "gone";
    if (cur.kind === "unreadable") last = cur.code;
    else if (!stillVictim(cur)) return "changed";
    else {
      try {
        await cfg.unlink(target);
        return "removed";
      } catch (e) {
        const code = errCode(e) ?? String(e);
        if (code === "ENOENT") return "gone";
        last = code;
        if (!TRANSIENT.has(code)) break;
      }
    }
    if (i >= cfg.unlinkRetries) break;
    await sleep(cfg.unlinkRetryMs * 2 ** i);
  }
  warn(cfg, "verification slot: could not delete lock file", { path: target, code: last });
  return "failed";
}

/**
 * Delete `target` (identity `id`) under its claim, only while `stillVictim`
 * holds. A dead claimer's leftover claim is cleared first (one level up).
 */
async function removeUnderClaim(
  slotPath: string,
  target: string,
  id: string,
  stillVictim: (s: Present) => boolean,
  cfg: Cfg,
  depth = 0,
): Promise<Removal> {
  const claim = reapClaimPath(slotPath, id);
  for (let round = 0; round < 2; round++) {
    const token = randomUUID();
    const info: LockInfo = { pid: cfg.pid, hostname: cfg.hostname, token, startedAt: cfg.now(), cwd: "", command: "reap" };
    if (await createOwned(claim, info, cfg)) {
      const since = cfg.mono();
      activeClaims.set(claim, token);
      try {
        return await unlinkWhile(target, since + cfg.claimHoldMaxMs, cfg, stillVictim);
      } finally {
        activeClaims.delete(claim);
        // Dropping the claim is safe until another process could judge it stale (2 x claimHoldMaxMs).
        await unlinkWhile(claim, since + 1.5 * cfg.claimHoldMaxMs, cfg, (c) => c.kind === "ok" && c.info.token === token);
      }
    }
    if (depth >= MAX_CLAIM_DEPTH || !(await reclaimClaim(slotPath, claim, cfg, depth + 1))) return "contended";
  }
  return "contended";
}

/** Remove a claim whose owner is dead or that is inert. True when the claim path is free. */
async function reclaimClaim(slotPath: string, claim: string, cfg: Cfg, depth: number): Promise<boolean> {
  const s = await readLock(claim, cfg);
  if (s.kind === "missing") return true;
  if (s.kind === "unreadable" || !claimStale(claim, s, cfg)) return false;
  const key = observedKey(s);
  const r = await removeUnderClaim(slotPath, claim, identity(s), (c) => observedKey(c) === key, cfg, depth);
  if (r !== "removed" && r !== "gone") return false;
  observations.delete(claim);
  return true;
}

// ---- held slots, released synchronously on process exit ----------------------

interface Held {
  path: string;
  token: string;
  pid: number;
  hostname: string;
}
const held = new Set<Held>();
let exitHooked = false;
/** Exit-time release failures (observable in tests; nothing can log at exit). */
export let exitReleaseFailures = 0;
export let lastExitReleaseError: string | undefined;

function unlinkIfTokenSync(path: string, token: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (errCode(e) === "ENOENT") return;
    throw e;
  }
  if (parseLock(text)?.token === token) unlinkSync(path);
}

/** The exit-time release follows the claim protocol, synchronously. */
function releaseOneSync(h: Held): void {
  const claim = reapClaimPath(h.path, h.token);
  if (activeClaims.has(claim)) {
    // Our own async release holds the claim right now; the loop below drops it.
    unlinkIfTokenSync(h.path, h.token);
    return;
  }
  const token = randomUUID();
  let fd: number;
  try {
    fd = openSync(claim, "wx");
  } catch (e) {
    if (errCode(e) === "EEXIST") return; // another process is reaping this lock and deletes it
    throw e;
  }
  try {
    try {
      writeSync(fd, JSON.stringify({ pid: h.pid, hostname: h.hostname, token, startedAt: Date.now(), cwd: "", command: "exit" }));
    } finally {
      closeSync(fd);
    }
    unlinkIfTokenSync(h.path, h.token);
  } finally {
    unlinkIfTokenSync(claim, token);
  }
}

function noteExitFailure(e: unknown): void {
  exitReleaseFailures++;
  lastExitReleaseError = errCode(e) ?? String(e);
}

function releaseAllSync(): void {
  for (const h of held) {
    try {
      releaseOneSync(h);
    } catch (e) {
      // Best effort at exit: the heartbeat stops with the process and the PID
      // probe reclaims the slot. Nothing can be logged asynchronously here.
      noteExitFailure(e);
    }
  }
  held.clear();
  for (const [claim, token] of activeClaims) {
    try {
      unlinkIfTokenSync(claim, token);
    } catch (e) {
      noteExitFailure(e);
    }
  }
  activeClaims.clear();
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
      lost: false,
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

function slotPathOf(dir: string, i: number): string {
  return join(dir, `slot-${i}.lock`);
}

async function tryAcquireOnce(opts: SlotOptions, cfg: Cfg): Promise<SlotHandle | undefined> {
  for (let i = 0; i < opts.max; i++) {
    const path = slotPathOf(cfg.dir, i);
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = randomUUID();
      const info: LockInfo = { pid: cfg.pid, hostname: cfg.hostname, token, startedAt: cfg.now(), cwd: opts.meta.cwd, command: opts.meta.command };
      if (await createOwned(path, info, cfg)) return makeFileHandle(path, token, opts, cfg);
      const cur = await readLock(path, cfg);
      if (cur.kind === "missing") continue; // released meanwhile: create again
      if (cur.kind === "unreadable" || !lockStale(path, cur, cfg)) break;
      const key = observedKey(cur);
      const r = await removeUnderClaim(path, path, identity(cur), (c) => observedKey(c) === key, cfg);
      if (r !== "removed" && r !== "gone") break;
      observations.delete(path);
    }
  }
  return undefined;
}

function makeFileHandle(path: string, token: string, opts: SlotOptions, cfg: Cfg): SlotHandle {
  hookExit();
  const entry: Held = { path, token, pid: cfg.pid, hostname: cfg.hostname };
  held.add(entry);
  // held -> releasing (an attempt runs) -> done, or -> deferred (retried on a timer) -> ...
  let phase: "held" | "releasing" | "deferred" | "done" = "held";
  let lost = false;
  let tick: Promise<void> | undefined;
  let attempt: Promise<void> | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let deferrals = 0;
  let beatWarned = false;
  const beating = () => phase === "held" || phase === "deferred";
  const maxDeferrals = Math.max(1, Math.ceil(cfg.staleMs / cfg.heartbeatMs));

  const finish = () => {
    phase = "done";
    clearInterval(hb);
    clearTimeout(retryTimer);
    held.delete(entry);
  };

  /** The file is gone or someone else's. While held, that is a loss; while a release is pending, it is done. */
  const notOurs = () => {
    const wasHeld = phase === "held";
    finish();
    if (!wasHeld) return;
    lost = true;
    warn(cfg, "verification slot lost: another process reclaimed it while it was held", { path });
    try {
      opts.onLost?.();
    } catch (e) {
      warn(cfg, "verification slot: onLost callback threw", { path, error: String(e) });
    }
  };

  const beat = async (): Promise<void> => {
    const cur = await readLock(path, cfg);
    if (!beating() || cur.kind === "unreadable") return; // a scanner has it open: next tick
    if (cur.kind !== "ok" || cur.info.token !== token) return notOurs();
    for (let i = 0; ; i++) {
      if (!beating()) return; // a release began: never touch the file again
      try {
        await cfg.utimes(path, new Date(cfg.now()));
        beatWarned = false;
        return;
      } catch (e) {
        const code = errCode(e) ?? String(e);
        if (code === "ENOENT") {
          if (beating()) notOurs();
          return;
        }
        if (!TRANSIENT.has(code) || i >= cfg.unlinkRetries) {
          if (!beatWarned) warn(cfg, "verification slot: heartbeat failed", { path, code });
          beatWarned = true;
          return;
        }
      }
      await sleep(cfg.unlinkRetryMs * 2 ** i);
    }
  };
  const hb = setInterval(() => {
    if (tick || !beating()) return;
    tick = beat()
      .catch((e: unknown) => warn(cfg, "verification slot: heartbeat failed", { path, code: errCode(e) ?? String(e) }))
      .finally(() => {
        tick = undefined;
      });
  }, cfg.heartbeatMs);
  hb.unref();

  /** One delete of our own file under its claim. True when the file is no longer ours. */
  const deleteOwn = async (): Promise<boolean> => {
    for (let n = 0; ; n++) {
      const r = await removeUnderClaim(path, path, token, (s) => s.kind === "ok" && s.info.token === token, cfg);
      // "contended": a process judging us stale holds the claim for a moment; it deletes our file.
      if (r === "contended" && n < cfg.unlinkRetries) {
        await sleep(cfg.unlinkRetryMs * 2 ** n);
        continue;
      }
      return r === "removed" || r === "gone" || r === "changed";
    }
  };

  const runAttempt = async (): Promise<void> => {
    phase = "releasing";
    clearTimeout(retryTimer);
    if (tick) await tick;
    let settled = false;
    try {
      settled = await deleteOwn();
    } catch (e) {
      warn(cfg, "verification slot: release failed", { path, code: errCode(e) ?? String(e) });
    }
    if (settled) return finish();
    // Not confirmed: keep the file ours (heartbeat and exit hook) and retry in the background.
    phase = "deferred";
    if (++deferrals > maxDeferrals) {
      finish();
      warn(cfg, "verification slot: release gave up, slot left to stale detection", { path });
      return;
    }
    if (deferrals === 1) warn(cfg, "verification slot: release incomplete, retrying in the background", { path });
    retryTimer = setTimeout(() => void release(), cfg.heartbeatMs);
    retryTimer.unref();
  };

  const release = (): Promise<void> => {
    if (phase === "done") return Promise.resolve();
    attempt ??= runAttempt().finally(() => {
      attempt = undefined;
    });
    return attempt;
  };

  return {
    release,
    get lost() {
      return lost;
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
      warn(cfg, "verification slot: temp dir unwritable, using an in-process semaphore", { dir: cfg.dir });
    }
    return acquireLocal(o, cfg);
  }
  const deadline = cfg.mono() + Math.max(0, opts.waitMs);
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
    const remaining = deadline - cfg.mono();
    if (remaining <= 0 || opts.signal?.aborted) return { busy: true };
    const base = Math.min(cfg.backoffMaxMs, cfg.backoffMinMs * 2 ** k);
    const jittered = Math.max(1, Math.round(base * (0.5 + cfg.random() * 0.5)));
    // Observations need a wake-up at least every 2 heartbeats to stay unbroken.
    const delay = Math.min(remaining, cfg.heartbeatMs, jittered);
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
  let out: { value: T };
  try {
    out = { value: await fn() };
  } finally {
    // release() never rejects (a failed delete is retried in the background and
    // logged), so it can neither replace fn's error nor mask its value.
    await s.release();
  }
  return out;
}

/** Synchronous variant of the exit hook, exported for tests. */
export const releaseAllSlotsSync = releaseAllSync;
