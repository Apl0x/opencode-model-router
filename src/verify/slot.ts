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
 * Clock. Every duration is measured on `mono`, a machine clock in ms. The one
 * counter that every process of a boot reads alike, on every runtime, is the OS
 * uptime (`os.uptime()`): GetTickCount64 on Windows (15.6 ms steps; Node 24 and
 * Bun 1.3 read the same `wall - uptime` within 15 ms), CLOCK_BOOTTIME on Linux,
 * the wall clock minus the boot time on macOS. Some runtimes round it to whole
 * seconds. `process.hrtime` is not such a counter everywhere: Node reads a boot
 * clock (QueryPerformanceCounter, CLOCK_MONOTONIC, mach time), but Bun, the
 * runtime that loads opencode plugins, counts from the process start (a fresh Bun
 * process reads about 0.4 s). So at its first use each process takes `hrtime` as
 * is when it reads within 2 s of the uptime, and otherwise anchors it to the
 * uptime: `mono = hrtime + max(uptime - hrtime)` over its reads. That never goes
 * back, is as fine as `hrtime` within the process, and agrees with the other
 * processes within the uptime's resolution; after a suspend that the uptime counts
 * and `hrtime` does not, it jumps ahead with the uptime. Whether the clocks count
 * a Windows sleep is not documented, and Modern Standby pauses desktop processes
 * while every clock runs, so no rule assumes that the clock stops while the
 * processes are frozen (see "witnessed"). The wall clock is compared with file
 * mtimes, and it tells clock origins apart (below); nothing else.
 *
 * Shared observation. Staleness needs a file to be seen unchanged over time, and
 * one call may be too short for that (`slotWaitMs: 0`). So every look is
 * recorded in a sidecar `slot-<i>.lock.seen-<hash(file, identity, host)>` holding
 * the file's `key` (identity@mtime) and one view per clock origin, `{boot, bootAt,
 * slack, first, from, last}`, with stamps on that origin's `mono`. A look's origin
 * is its boot (the Linux boot id) and its boot instant `bootAt = wall - mono`, read
 * together. A look uses the view of its boot whose `bootAt` is within its slack
 * (1 s, the uptime's resolution budget; a fifth of the heartbeat when that is
 * shorter, in tests) of its own, or starts a new view, and compares its `mono`
 * with that view's stamps only. So clocks with different
 * origins never mix: Bun's per-process `hrtime` if it were used, a process whose
 * `hrtime` stopped during a suspend, a wall-clock step. Two stamps of one view
 * disagree by at most the two slacks (the look's and the largest of the view's
 * writers', 2 s), and every `mono` threshold below adds that, so it never shortens
 * a margin. `first` is the view's first sighting of the key, `last` its latest
 * look, and `from` the first look after the latest gap between two looks of more
 * than 2 heartbeats minus this look's slack and the view's (8 s in production:
 * 2 x 5 s - 2 x 1 s). So `span = now - first` is how long the file has been
 * unchanged, and `witnessed = now - from` how long it has been watched without a
 * gap. A new key drops every view; a stamp from the future (another boot's clock)
 * restarts one. The host is part of the name, so hosts sharing a dir never mix
 * clocks. A stamp that survives a reboot can only be for a file whose holder died
 * with the reboot (tokens are never reused). Sidecar I/O is advisory: a failure
 * only loses evidence, which delays a reclaim and never causes one.
 *
 * Staleness. The holder refreshes its file's mtime every `heartbeatMs` (5 s,
 * unref'd timer). A lock is stale when
 *   (a) its host is this host and its PID is dead (immediately), or this process
 *       created it and never held it (below, "Errors"), or
 *   (b) it is old (its heartbeat is older than `staleMs`, 30 s, by the wall
 *       clock, or its span is at least `staleMs`) AND it has been witnessed
 *       unchanged for 2 heartbeats (both plus the view's slack).
 * A suspend, a freeze or a clock step makes a live holder's file look old. But
 * the holder heartbeats within one interval once it runs again, which changes the
 * key, and a gap in the looks (everyone was frozen, or nobody looked) restarts
 * the witness, so the holder always gets 2 heartbeats of running time first. A
 * foreign host is never judged by PID. A corrupt/empty lock uses the short
 * `corruptGraceMs` for both the age and the witness, because a creator writes the
 * JSON right after the exclusive create.
 *
 * Watch. A call that gives up at its deadline while a lock is old but not yet
 * witnessed long enough keeps looking at it in the background, every heartbeat
 * (unref'd timer), until the lock is reaped or changes, or for at most
 * `staleMs + 2 x (heartbeatMs + claimHoldMaxMs)`. So a process calling with
 * `waitMs: 0` once a minute still reclaims a lock whose owner is not provably
 * dead (a reused PID, another host, a hung holder). Short-lived processes that
 * each look once do it through the sidecar when their looks are less than 2
 * heartbeats minus this look's slack and the view's apart (8 s in production: 2 x 5 s - 2 x 1 s),
 * and their clocks share a view.
 *
 * Residual (accepted in QA-1.4-21): looks further apart than that (8 s) cannot
 * tell a dead holder from a frozen machine. So a lock whose owner is not provably
 * dead is reclaimed only by a caller that waits, or stays alive, for 2 heartbeats
 * after its look (10 s plus the slack), or by callers that look often enough
 * together. Until then every caller is told busy. The Phase 2.x callers are
 * opencode plugin processes, alive for a whole session, so their watches do it.
 *
 * Deletion. Every delete of a lock file whose identity is K (its token; for a
 * corrupt file its mtime and size) runs under the claim file
 * `slot-<i>.lock.reap-<hash(K)>`, created with `wx` and holding `{pid, hostname,
 * token, target, victim: K}`. That includes the owner's own release and the exit
 * hook. A claimer holds its claim only after a readable re-read shows its own
 * token; an unconfirmed claim is never used and is left to the rules below. The
 * claim holder re-reads the target before every unlink attempt and deletes it
 * only while it is still K. K is never reused and only a K-claim holder deletes
 * K's file, so the file cannot be deleted and re-created between the re-read and
 * the unlink (no ABA). A claim is removed by its owner. A crashed claimer's claim
 * is removed the same way, under the claim for *its* token, when its owner is
 * provably dead (same host, dead PID) or when it is inert: span >= `staleMs` AND
 * witnessed >= 2 x `claimHoldMaxMs` (both plus the view's slack). The wall clock
 * plays no part, because claims are never refreshed. A claimer deletes its target
 * only within `claimHoldMaxMs` (5 s) of `mono`, counted from just before it
 * created the claim, and checked again right before each unlink, and drops its
 * own claim only within 1.5 x that (7.5 s). That includes a claim it created but
 * could not confirm (a scanner held the re-read): the process remembers its token
 * and drops it at its next readable look within those 7.5 s, and at exit only within them too (QA-1.4-32); after
 * that it is left to the rules above. So a claimer acts on a claim judged inert
 * only if it freezes for more than 25 s (target) or 22.5 s (drop) between that
 * last check and the unlink syscall; when every process was frozen together, the
 * witness gives it 10 s of running time after the thaw. Transient
 * antivirus/indexer errors (EBUSY/EPERM/EACCES) are retried, and a failed delete
 * is never reported as success.
 *
 * Fairness. A caller that waits files a ticket `wait-<startedAt>-<uuid>.ticket`
 * (`{pid, hostname, token}`), refreshes it every heartbeat (unref'd timer) and on
 * every wake-up, and tries the slots only while fewer than `max` live tickets are
 * older than its own. That is strict FIFO for max=1; for max>1 the `max` oldest
 * waiters compete. A caller that does not wait defers while `max` live tickets
 * exist, so a releaser that re-acquires at once queues behind the waiters. A
 * ticket is dead when its PID is dead (same host), or when it has not been
 * refreshed for 2 heartbeats (by its mtime, or seen unchanged that long by this
 * process). A live PID proves nothing, because PIDs are reused. A live waiter
 * misjudged dead re-creates its ticket under its old name at its next refresh.
 * Tickets only order the attempts: exclusion never depends on them, and a ticket
 * I/O failure lets the caller try.
 *
 * Housekeeping. At most every 10 minutes per dir, a caller deletes orphaned files
 * older than 1 hour. Probes, observation sidecars and the legacy `.reap` and
 * `.reap.dead-*` files go by path, since they are unique or advisory. Claims go
 * under the claim protocol when their target no longer holds their victim or when
 * they are empty/corrupt. A claim without `target`/`victim` is left alone.
 *
 * Loss. When the heartbeat finds the holder's file gone or owned by another token,
 * the handle's `lost` becomes true, `onLost` is called and a warning is logged,
 * once. A failing `utimes` is retried like an unlink.
 *
 * Errors. `acquireSlot` never rejects. If the slot dir has disappeared (a temp
 * cleaner), it is re-created once and the attempt repeated; if that fails, the
 * dir verdict is dropped. Any other unexpected file-system error (EMFILE, ENOSPC,
 * EIO, ...) resolves `{busy:true}` with one warning per dir and code, and drops
 * the dir verdict, so the next call probes again. A slot is never granted
 * without its lock file, so exclusion holds. A lock that the call created before
 * such an error is removed under its claim (own token) before the busy result; if
 * that fails too, the process remembers it, and its next look at the slot reaps
 * it at once, as does the exit hook. A non-finite `waitMs` counts as 0.
 *
 * Residual risk: every check-then-act on a file system has a window between the
 * last check and the syscall; its bounds are above. A single process frozen there
 * (SIGSTOP, a debugger) for longer can still act late. A holder that stops
 * heartbeating for 2 intervals while its lock looks old is reaped; that is the
 * plan's heartbeat contract, and the holder is told through `lost`.
 *
 * If the temp dir is unwritable the module degrades to an in-process semaphore
 * with the same API and logs that once per slot dir. No process is spawned here.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { mkdir, open, readdir, readFile, stat, unlink, utimes, writeFile, type FileHandle } from "node:fs/promises";
import { hostname as osHostname, tmpdir, uptime as osUptime } from "node:os";
import { basename, join } from "node:path";
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
  /**
   * Machine clock (ms): wait deadlines, shared observations and claim fencing.
   * The default is `process.hrtime`, anchored to `os.uptime()` where it counts
   * from the process start (Bun), see `machineClockFrom`. Observations compare
   * only stamps of one clock origin (`now() - mono()`, see the header).
   */
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

/** Housekeeping: files older than this (wall clock) may be collected when orphaned. */
const ORPHAN_AGE_MS = 3_600_000;
/** Housekeeping runs at most this often per dir and process (monotonic). */
const HOUSEKEEPING_EVERY_MS = 600_000;
/**
 * Clocks whose boot instants (`wall - mono`) agree within this share an observation
 * view: the uptime's resolution (up to 1 s) plus read jitter. Scaled down with the
 * heartbeat (a fifth of it), so that tests with short heartbeats keep short pads.
 */
const ORIGIN_SLACK_MS = 1_000;
/** `hrtime` within this of the uptime reads the boot clock; else it is anchored to the uptime. */
const HRTIME_IS_UPTIME_MS = 2_000;
/** Views kept per sidecar; the oldest goes first. */
const MAX_VIEWS = 4;

export function defaultSlotDir(): string {
  return join(tmpdir(), "opencode-model-router", "verify-slots");
}

function hrtimeMs(): number {
  return Number(process.hrtime.bigint() / 1_000n) / 1_000;
}
function uptimeMs(): number {
  return osUptime() * 1_000;
}

/**
 * The machine clock of one process, from its `hrtime` and the OS uptime (both in
 * ms, see the header). An `hrtime` within 2 s of the uptime at the first read is
 * the boot clock and is returned as is (Node). Otherwise (Bun: it counts from the
 * process start) it is anchored to the uptime: `hr + max(uptime - hr)` over every
 * read, the uptime read first, so each sample is a lower bound. Never goes back.
 * Exported for tests.
 */
export function machineClockFrom(hr: () => number, uptime: () => number): () => number {
  const u0 = uptime();
  const h0 = hr();
  if (Math.abs(h0 - u0) <= HRTIME_IS_UPTIME_MS) return hr;
  let offset = u0 - h0;
  return () => {
    const u = uptime();
    const h = hr();
    if (u - h > offset) offset = u - h;
    return h + offset;
  };
}

let machineClock: (() => number) | undefined;

/** The default `mono`: chosen once per process, at its first use. */
function machineMonoMs(): number {
  machineClock ??= machineClockFrom(hrtimeMs, uptimeMs);
  return machineClock();
}

interface LockInfo {
  pid: number;
  hostname: string;
  token: string;
  startedAt: number;
  cwd: string;
  command: string;
  /** Claims only: the basename of the file this claim deletes, and that file's identity. */
  target?: string;
  victim?: string;
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
/** `mkdir`/create errors that can mean "unwritable dir"; only the final ones count at once. */
const UNWRITABLE = new Set(["EACCES", "EPERM", "EBUSY", "EROFS", "ENOTDIR", "ENOENT", "EEXIST"]);
const FINAL_UNWRITABLE = new Set(["EROFS", "ENOTDIR", "EEXIST"]);

function isTransient(e: unknown): boolean {
  const code = errCode(e);
  return code !== undefined && TRANSIENT.has(code);
}

/** Failures of the logger itself (a throwing logger must not break slot bookkeeping). */
export let loggerFailures = 0;

function warn(cfg: Cfg, msg: string, data: Record<string, unknown>): void {
  try {
    cfg.logger?.warn(msg, data);
  } catch {
    loggerFailures++;
  }
}

const ioWarned = new Set<string>();

/** Advisory files (observations, housekeeping): a failure only loses evidence. Said once per dir and kind. */
function ioTrouble(cfg: Cfg, what: string, path: string, e: unknown): void {
  const k = `${cfg.dir}\n${what}`;
  if (ioWarned.has(k)) return;
  ioWarned.add(k);
  warn(cfg, `verification slot: ${what} I/O failed`, { path, code: errCode(e) ?? String(e) });
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
    mono: deps.mono ?? machineMonoMs,
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
      ...(typeof o.target === "string" ? { target: o.target } : {}),
      ...(typeof o.victim === "string" ? { victim: o.victim } : {}),
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

function hash32(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 32);
}

/** The claim file under which the file with identity `id` (in slot `slotPath`'s family) is deleted. */
export function reapClaimPath(slotPath: string, id: string): string {
  return `${slotPath}.reap-${hash32(id)}`;
}

/** The shared observation sidecar of `target` (identity `id`) as seen from host `host`. */
function seenPath(slotPath: string, target: string, id: string, host: string): string {
  return `${slotPath}.seen-${hash32(`${basename(target)}\n${id}\n${host}`)}`;
}

// ---- shared observation and staleness ----------------------------------------

let bootIdCache: string | undefined;

/** The Linux boot id; "" where there is none (the boot-instant check then stands alone). */
function bootId(): string {
  if (bootIdCache === undefined) {
    bootIdCache = "";
    if (process.platform === "linux") {
      try {
        bootIdCache = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      } catch (e) {
        // No procfs (a sandbox): every process of the host fails alike, so "" still
        // matches between them, and the boot-instant check remains.
        if (errCode(e) === undefined) throw e;
      }
    }
  }
  return bootIdCache;
}

/** The looks of one clock origin at one key. Stamps are on that origin's `mono`. */
interface SeenView {
  boot: string;
  /** `wall - mono` of the look that started the view: the origin of its clock. */
  bootAt: number;
  /** The largest slack of the looks that wrote the view. */
  slack: number;
  first: number;
  from: number;
  last: number;
}

interface SeenRecord {
  key: string;
  views: SeenView[];
}

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

function parseView(v: unknown): SeenView | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const { boot, bootAt, slack, first, from, last } = v as Record<string, unknown>;
  if (typeof boot !== "string" || !isNum(bootAt) || !isNum(slack) || !isNum(first) || !isNum(from) || !isNum(last)) return undefined;
  return { boot, bootAt, slack, first, from, last };
}

function parseSeen(text: string): SeenRecord | undefined {
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== "object" || v === null) return undefined;
    const { key, views } = v as Record<string, unknown>;
    if (typeof key !== "string" || !Array.isArray(views)) return undefined;
    return { key, views: views.map(parseView).filter((x): x is SeenView => x !== undefined) };
  } catch (e) {
    // A torn read of a concurrent write: no evidence, the record restarts.
    if (e instanceof SyntaxError) return undefined;
    throw e;
  }
}

interface Look {
  /** How long the file has had its current key (mono), since the view's first sighting. */
  span: number;
  /** How long it has been watched without a gap of more than 2 heartbeats minus this look's slack and the view's. */
  witnessed: number;
  /** How far two stamps of the view may disagree: every threshold adds it. */
  errMs: number;
}
const NO_LOOK: Look = { span: 0, witnessed: 0, errMs: 0 };

/** This look's origin slack (see `ORIGIN_SLACK_MS`). */
function originSlackMs(cfg: Cfg): number {
  return Math.min(ORIGIN_SLACK_MS, cfg.heartbeatMs / 5);
}

/**
 * Record a look at `target` (state `s`, read at `at`, taken before the read) in
 * its shared sidecar, in the view of this look's clock origin, and return what
 * that view's looks establish. Stamps of other views are never read.
 */
async function observe(slotPath: string, target: string, s: Present, at: number, cfg: Cfg): Promise<Look> {
  const file = seenPath(slotPath, target, identity(s), cfg.hostname);
  let prev: SeenRecord | undefined;
  try {
    prev = parseSeen(await readFile(file, "utf8"));
  } catch (e) {
    if (errCode(e) !== "ENOENT") {
      if (!isTransient(e)) ioTrouble(cfg, "observation", file, e);
      return NO_LOOK;
    }
  }
  const key = observedKey(s);
  const boot = bootId();
  const bootAt = cfg.now() - cfg.mono(); // read together: the origin of this look's clock
  const slack = originSlackMs(cfg);
  const maxGap = 2 * cfg.heartbeatMs;
  const views = prev?.key === key ? prev.views : []; // a new key: every view restarts
  const i = views.findIndex((v) => v.boot === boot && Math.abs(v.bootAt - bootAt) <= slack);
  const old = i >= 0 ? views[i] : undefined;
  let view: SeenView;
  // A stamp far in the future is another boot's clock: the view restarts.
  if (old !== undefined && at >= old.last - maxGap) {
    view = { ...old, slack: Math.max(old.slack, slack), from: at - old.last > maxGap - (slack + old.slack) ? at : old.from, last: Math.max(old.last, at) };
  } else {
    view = { boot, bootAt, slack, first: at, from: at, last: at };
  }
  const rec: SeenRecord = { key, views: [...views.filter((_, j) => j !== i).slice(-(MAX_VIEWS - 1)), view] };
  try {
    await writeFile(file, JSON.stringify(rec));
  } catch (e) {
    // The verdict of this look stands; only later looks lose it.
    if (errCode(e) !== "ENOENT" && !isTransient(e)) ioTrouble(cfg, "observation", file, e);
  }
  return { span: Math.max(0, at - view.first), witnessed: Math.max(0, at - view.from), errMs: slack + view.slack };
}

/** Delete the sidecar of a file that is gone. Advisory: a leftover is collected by housekeeping. */
async function dropSeen(slotPath: string, target: string, id: string, cfg: Cfg): Promise<void> {
  const file = seenPath(slotPath, target, id, cfg.hostname);
  try {
    await cfg.unlink(file);
  } catch (e) {
    if (errCode(e) !== "ENOENT" && !isTransient(e)) ioTrouble(cfg, "observation", file, e);
  }
}

/** Same host and the PID is gone: provably dead, no confirmation needed. */
function ownerDead(s: Present, cfg: Cfg): boolean {
  return s.kind === "ok" && s.info.hostname === cfg.hostname && !cfg.isPidAlive(s.info.pid);
}

/** stale: reap it; aged: old but not witnessed long enough yet; fresh: leave it. */
type Verdict = "stale" | "aged" | "fresh";

async function lockVerdict(slotPath: string, s: Present, at: number, cfg: Cfg): Promise<Verdict> {
  if (ownerDead(s, cfg) || isStray(slotPath, s)) return "stale";
  const corrupt = s.kind === "corrupt";
  const oldMs = corrupt ? cfg.corruptGraceMs : cfg.staleMs;
  const confirmMs = corrupt ? cfg.corruptGraceMs : 2 * cfg.heartbeatMs;
  const look = await observe(slotPath, slotPath, s, at, cfg);
  if (!(cfg.now() - s.mtimeMs > oldMs || look.span >= oldMs + look.errMs)) return "fresh";
  return look.witnessed >= confirmMs + look.errMs ? "stale" : "aged";
}

/** A claim is inert by observation only (claims are never refreshed, so a wall age says nothing). */
async function claimInert(slotPath: string, claim: string, s: Present, at: number, cfg: Cfg): Promise<boolean> {
  if (ownerDead(s, cfg)) return true;
  const corrupt = s.kind === "corrupt";
  const oldMs = corrupt ? cfg.corruptGraceMs : cfg.staleMs;
  const confirmMs = corrupt ? cfg.corruptGraceMs : 2 * cfg.claimHoldMaxMs;
  const look = await observe(slotPath, claim, s, at, cfg);
  return look.span >= oldMs + look.errMs && look.witnessed >= confirmMs + look.errMs;
}

// ---- exclusive create and claimed delete --------------------------------------

/**
 * Create `path` exclusively with `info`, then re-read it (an unreadable re-read,
 * a scanner, is retried on the unlink schedule): true only when it holds
 * `info.token`. A re-read that stays unreadable counts as ours only when
 * `trustUnreadable` (a slot lock, whose heartbeat re-checks the token within one
 * interval), never for a claim, which nothing re-checks. When the file was
 * created but is not held, `stray` runs first: after an unexpected error (before
 * it propagates, QA-1.4-28) and for an unconfirmed claim (QA-1.4-29).
 */
async function createOwned(
  path: string,
  info: LockInfo,
  cfg: Cfg,
  trustUnreadable: boolean,
  stray: () => Promise<void> | void,
): Promise<boolean> {
  let fh: FileHandle;
  try {
    fh = await open(path, "wx");
  } catch (e) {
    const code = errCode(e);
    if (code === "EEXIST" || (code !== undefined && TRANSIENT.has(code))) return false;
    throw e;
  }
  try {
    try {
      await fh.writeFile(JSON.stringify(info), "utf8");
    } finally {
      await fh.close();
    }
    for (let i = 0; ; i++) {
      const s = await readLock(path, cfg);
      if (s.kind !== "unreadable") return s.kind === "ok" && s.info.token === info.token;
      if (i >= cfg.unlinkRetries) break;
      await sleep(cfg.unlinkRetryMs * 2 ** i);
    }
  } catch (e) {
    await stray();
    throw e;
  }
  if (trustUnreadable) return true;
  await stray();
  return false;
}

/** Claims currently held by this process (claim path -> claim token), for the exit hook. */
const activeClaims = new Map<string, string>();
const MAX_CLAIM_DEPTH = 3;

/** A claim this process created but could not confirm (QA-1.4-29), until its drop fence (on its `mono`). */
interface Unconfirmed {
  token: string;
  dropBy: number;
  /** The clock `dropBy` is on, so the exit hook can apply the same fence (QA-1.4-32). */
  mono: () => number;
}
/** Claim path -> this process's unconfirmed claim there. Dropped at the next readable look, or at exit while within its fence. */
const unconfirmedClaims = new Map<string, Unconfirmed>();
const MAX_UNCONFIRMED = 64;

function noteUnconfirmed(claim: string, token: string, since: number, cfg: Cfg): void {
  hookExit();
  if (unconfirmedClaims.size >= MAX_UNCONFIRMED) {
    const oldest = unconfirmedClaims.keys().next();
    if (!oldest.done) unconfirmedClaims.delete(oldest.value);
  }
  unconfirmedClaims.set(claim, { token, dropBy: since + 1.5 * cfg.claimHoldMaxMs, mono: cfg.mono });
}

/**
 * The claim at `claim` (seen as `s`) is this process's own unconfirmed one: drop
 * it by its token, within the same fence as a held claim. Undefined when it is not
 * ours (or no longer droppable); else whether the claim path is now free.
 */
async function dropUnconfirmed(slotPath: string, claim: string, s: Present, cfg: Cfg): Promise<boolean | undefined> {
  const own = unconfirmedClaims.get(claim);
  if (own === undefined) return undefined;
  if (s.kind !== "ok" || s.info.token !== own.token || cfg.mono() > own.dropBy) {
    // Replaced (ours is gone), or past the fence: from now on the rules for any claim apply.
    unconfirmedClaims.delete(claim);
    return undefined;
  }
  const r = await unlinkWhile(claim, own.dropBy, cfg, (c) => c.kind === "ok" && c.info.token === own.token);
  if (r !== "failed") unconfirmedClaims.delete(claim);
  if (r === "removed") await dropSeen(slotPath, claim, own.token, cfg);
  return r === "removed" || r === "gone";
}

type Removal = "removed" | "gone" | "changed" | "contended" | "failed";

/**
 * Unlink `target` while `stillVictim` holds, re-reading it before every attempt.
 * Gives up (without deleting) at the monotonic `deadline`, which is checked
 * again after the re-read, right before the unlink.
 */
async function unlinkWhile(target: string, deadline: number, cfg: Cfg, stillVictim: (s: Present) => boolean): Promise<Removal> {
  let last = "";
  const late = (): Removal => {
    warn(cfg, "verification slot: claim held too long, delete abandoned", { path: target, code: last });
    return "failed";
  };
  for (let i = 0; ; i++) {
    if (cfg.mono() > deadline) return late();
    const cur = await readLock(target, cfg);
    if (cur.kind === "missing") return "gone";
    if (cur.kind === "unreadable") last = cur.code;
    else if (!stillVictim(cur)) return "changed";
    else if (cfg.mono() > deadline) return late();
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
    const info: LockInfo = {
      pid: cfg.pid,
      hostname: cfg.hostname,
      token,
      startedAt: cfg.now(),
      cwd: "",
      command: "reap",
      target: basename(target),
      victim: id,
    };
    // The fence starts before the create: other processes may see the claim from then on.
    const since = cfg.mono();
    let mine: boolean;
    try {
      mine = await createOwned(claim, info, cfg, false, () => noteUnconfirmed(claim, token, since, cfg));
    } catch (e) {
      if (errCode(e) === "ENOENT") return "gone"; // no dir: the target went with it
      throw e;
    }
    if (mine) {
      activeClaims.set(claim, token);
      let r: Removal = "failed";
      try {
        r = await unlinkWhile(target, since + cfg.claimHoldMaxMs, cfg, stillVictim);
        return r;
      } finally {
        activeClaims.delete(claim);
        // Dropping the claim is safe well before anyone could judge it inert (staleMs).
        const drop = await unlinkWhile(claim, since + 1.5 * cfg.claimHoldMaxMs, cfg, (c) => c.kind === "ok" && c.info.token === token);
        if (drop === "removed") await dropSeen(slotPath, claim, token, cfg);
        if (r === "removed" || r === "gone") await dropSeen(slotPath, target, id, cfg);
      }
    }
    if (depth >= MAX_CLAIM_DEPTH || !(await reclaimClaim(slotPath, claim, cfg, depth + 1))) return "contended";
  }
  return "contended";
}

/** Remove a claim whose owner is dead or that is inert. True when the claim path is free. */
async function reclaimClaim(slotPath: string, claim: string, cfg: Cfg, depth: number): Promise<boolean> {
  const at = cfg.mono();
  const s = await readLock(claim, cfg);
  if (s.kind === "missing") return true;
  if (s.kind === "unreadable") return false;
  const own = await dropUnconfirmed(slotPath, claim, s, cfg);
  if (own !== undefined) return own;
  if (!(await claimInert(slotPath, claim, s, at, cfg))) return false;
  const key = observedKey(s);
  const r = await removeUnderClaim(slotPath, claim, identity(s), (c) => observedKey(c) === key, cfg, depth);
  return r === "removed" || r === "gone";
}

/** Reap the slot lock `path`, seen as `cur`, under its claim. */
function reap(path: string, cur: Present, cfg: Cfg): Promise<Removal> {
  const key = observedKey(cur);
  return removeUnderClaim(path, path, identity(cur), (c) => observedKey(c) === key, cfg);
}

// ---- held slots, released synchronously on process exit ----------------------

interface Held {
  path: string;
  token: string;
  pid: number;
  hostname: string;
}
const held = new Set<Held>();
/** Slot locks this process created but never held (an error after the create, QA-1.4-28): path -> lock. */
const strays = new Map<string, Held>();
let exitHooked = false;

/** This process's own stray at `path`: stale at once. A different file there means ours is gone. */
function isStray(path: string, s: Present): boolean {
  const own = strays.get(path);
  if (own === undefined) return false;
  if (s.kind === "ok" && s.info.token === own.token) return true;
  if (s.kind === "ok") strays.delete(path);
  return false;
}

/** Remove a slot lock that this process created and does not hold, under its claim; else remember it. */
async function dropStray(path: string, token: string, cfg: Cfg): Promise<void> {
  hookExit();
  strays.set(path, { path, token, pid: cfg.pid, hostname: cfg.hostname });
  const r = await removeUnderClaim(path, path, token, (s) => s.kind === "ok" && s.info.token === token, cfg).catch(
    (): Removal => "failed", // the error being surfaced says why; the next look or the exit hook retries
  );
  // "contended": a reaper holds the claim and deletes it.
  if (r !== "failed") strays.delete(path);
}
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
      const info: LockInfo = { pid: h.pid, hostname: h.hostname, token, startedAt: Date.now(), cwd: "", command: "exit", target: basename(h.path), victim: h.token };
      writeSync(fd, JSON.stringify(info));
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
  for (const h of [...held, ...strays.values()]) {
    try {
      releaseOneSync(h);
    } catch (e) {
      // Best effort at exit: the heartbeat stops with the process and the PID
      // probe reclaims the slot. Nothing can be logged asynchronously here.
      noteExitFailure(e);
    }
  }
  held.clear();
  strays.clear();
  // An unconfirmed claim only within its drop fence, like the normal drop path: past it, another
  // process may already be removing it as inert, and a late delete here could free a third reaper's claim (QA-1.4-32).
  const unconfirmed = [...unconfirmedClaims].filter(([, u]) => u.mono() <= u.dropBy).map(([c, u]) => [c, u.token] as const);
  for (const [claim, token] of [...activeClaims, ...unconfirmed]) {
    try {
      unlinkIfTokenSync(claim, token);
    } catch (e) {
      noteExitFailure(e);
    }
  }
  activeClaims.clear();
  unconfirmedClaims.clear();
  for (const t of tickets) {
    try {
      unlinkSync(t);
    } catch (e) {
      if (errCode(e) !== "ENOENT") noteExitFailure(e);
    }
  }
  tickets.clear();
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

/** Unlink a uniquely named file (no identity to check), retrying transient errors. */
async function unlinkRetry(path: string, cfg: Cfg): Promise<boolean> {
  for (let i = 0; ; i++) {
    try {
      await cfg.unlink(path);
      return true;
    } catch (e) {
      const code = errCode(e) ?? String(e);
      if (code === "ENOENT") return true;
      if (!TRANSIENT.has(code) || i >= cfg.unlinkRetries) {
        warn(cfg, "verification slot: could not delete file", { path, code });
        return false;
      }
    }
    await sleep(cfg.unlinkRetryMs * 2 ** i);
  }
}

/** Per slot dir: file slots and local slots never mix for one dir. Dropped on unexpected errors. */
const dirVerdicts = new Map<string, Promise<boolean>>();

function dirWritable(cfg: Cfg): Promise<boolean> {
  const dir = cfg.dir;
  let verdict = dirVerdicts.get(dir);
  if (!verdict) {
    verdict = probeDir(cfg);
    dirVerdicts.set(dir, verdict);
    // An unexpected error is not a verdict: the next call probes again.
    verdict.catch(() => dirVerdicts.delete(dir));
  }
  return verdict;
}

/**
 * Judge the dir only from `mkdir`/exclusive-create errors. Once the probe file
 * exists the dir is writable; removing the probe is housekeeping (retried, and a
 * residual failure is logged, never a verdict). EACCES/EPERM/EBUSY/ENOENT can be
 * transient (antivirus, a concurrent removal), so they are retried before they
 * count; EROFS/ENOTDIR/EEXIST are final.
 */
async function probeDir(cfg: Cfg): Promise<boolean> {
  for (let i = 0; ; i++) {
    const probe = join(cfg.dir, `.probe-${randomUUID()}`);
    let code: string | undefined;
    try {
      await mkdir(cfg.dir, { recursive: true });
      await (await open(probe, "wx")).close();
    } catch (e) {
      code = errCode(e);
      if (code === undefined || !UNWRITABLE.has(code)) throw e;
    }
    if (code === undefined) {
      await unlinkRetry(probe, cfg);
      return true;
    }
    if (FINAL_UNWRITABLE.has(code) || i >= 2) return false;
    await sleep(cfg.unlinkRetryMs * 2 ** i);
  }
}

/** The dir vanished at use time (a temp cleaner): re-create it once. On failure the verdict is dropped. */
async function recreateDir(cfg: Cfg): Promise<boolean> {
  try {
    await mkdir(cfg.dir, { recursive: true });
    return true;
  } catch (e) {
    dirVerdicts.delete(cfg.dir);
    warn(cfg, "verification slot: could not re-create the slot dir", { dir: cfg.dir, code: errCode(e) ?? String(e) });
    return false;
  }
}

const fsWarned = new Set<string>();

/** An unexpected file-system error: never a rejection, never a slot. Busy, one warning per dir and code. */
function fsFailure(cfg: Cfg, e: unknown): SlotResult {
  dirVerdicts.delete(cfg.dir);
  const code = errCode(e) ?? String(e);
  const k = `${cfg.dir}\n${code}`;
  if (!fsWarned.has(k)) {
    fsWarned.add(k);
    warn(cfg, "verification slot: file-system error, reporting busy", { dir: cfg.dir, code });
  }
  return { busy: true };
}

// ---- housekeeping -------------------------------------------------------------

const PROBE_NAME = /^\.probe-[0-9a-f-]{36}$/;
const SEEN_NAME = /^slot-\d+\.lock\.seen-[0-9a-f]{32}$/;
const LEGACY_NAME = /^slot-\d+\.lock\.reap(\.dead-.*)?$/;
const CLAIM_NAME = /^(slot-\d+\.lock)\.reap-[0-9a-f]{32}$/;
/** What a claim may target: a slot lock or another claim of its family. */
const TARGET_NAME = /^slot-\d+\.lock(\.reap-[0-9a-f]{32})?$/;
const housekeptAt = new Map<string, number>();

async function olderThanOrphanAge(path: string, cfg: Cfg): Promise<boolean> {
  try {
    return cfg.now() - (await stat(path)).mtimeMs > ORPHAN_AGE_MS;
  } catch (e) {
    if (errCode(e) === "ENOENT") return false;
    throw e;
  }
}

/** One file of the dir listing: collected when orphaned and older than 1 hour. */
async function collectOne(name: string, cfg: Cfg): Promise<void> {
  const path = join(cfg.dir, name);
  if (PROBE_NAME.test(name) || SEEN_NAME.test(name) || LEGACY_NAME.test(name)) {
    // Unique (probes) or advisory (sidecars, legacy files the protocol ignores): by path.
    if (!(await olderThanOrphanAge(path, cfg))) return;
    try {
      await cfg.unlink(path);
    } catch (e) {
      if (errCode(e) !== "ENOENT") throw e;
    }
    return;
  }
  const m = CLAIM_NAME.exec(name);
  if (!m?.[1] || !(await olderThanOrphanAge(path, cfg))) return;
  const s = await readLock(path, cfg);
  if (s.kind === "missing" || s.kind === "unreadable") return;
  if (s.kind === "ok") {
    const { target, victim } = s.info;
    if (target === undefined || victim === undefined || !TARGET_NAME.test(target)) return; // nothing says what it guards
    const t = await readLock(join(cfg.dir, target), cfg);
    // Still guarding its victim: that is the reaping path's business, not housekeeping's.
    if (t.kind === "unreadable" || (t.kind !== "missing" && identity(t) === victim)) return;
  }
  // The victim is gone for good (identities are never reused), or the claim is empty/corrupt
  // (never held: a claimer holds only after reading its token back). Removed under the protocol.
  const key = observedKey(s);
  await removeUnderClaim(join(cfg.dir, m[1]), path, identity(s), (c) => observedKey(c) === key, cfg);
}

async function housekeep(names: string[], cfg: Cfg): Promise<void> {
  const t = cfg.mono();
  const lastRun = housekeptAt.get(cfg.dir);
  if (lastRun !== undefined && t >= lastRun && t - lastRun < HOUSEKEEPING_EVERY_MS) return;
  housekeptAt.set(cfg.dir, t);
  for (const name of names) {
    try {
      await collectOne(name, cfg);
    } catch (e) {
      if (!isTransient(e)) ioTrouble(cfg, "housekeeping", join(cfg.dir, name), e);
    }
  }
}

// ---- fairness: FIFO waiter tickets ------------------------------------------

interface Ticket {
  path: string;
  name: string;
  body: string;
  /** Set once the wait is over: nothing may re-create the ticket after that. */
  dropped: boolean;
  /** The refresh in flight, if any (the heartbeat timer and the wake-ups share it). */
  refreshing?: Promise<void>;
}
const TICKET_NAME = /^wait-\d{15}-[0-9a-f-]{36}\.ticket$/;
/** Tickets of the waits in progress in this process, for the exit hook. */
const tickets = new Set<string>();
const ticketWarned = new Set<string>();

/** Tickets only order the attempts; exclusion never depends on them. Say so once per dir. */
function ticketTrouble(cfg: Cfg, path: string, e: unknown): void {
  if (ticketWarned.has(cfg.dir)) return;
  ticketWarned.add(cfg.dir);
  warn(cfg, "verification slot: waiter ticket I/O failed, fairness is best effort", { path, code: errCode(e) ?? String(e) });
}

async function writeTicket(t: Ticket, cfg: Cfg): Promise<void> {
  for (let retried = false; ; retried = true) {
    try {
      await writeFile(t.path, t.body, { flag: "wx" });
      return;
    } catch (e) {
      const code = errCode(e);
      if (code === "EEXIST") return;
      if (code === "ENOENT" && !retried && (await recreateDir(cfg))) continue;
      ticketTrouble(cfg, t.path, e);
      return;
    }
  }
}

async function createTicket(cfg: Cfg): Promise<Ticket> {
  const startedAt = Math.max(0, Math.floor(cfg.now()));
  const name = `wait-${String(startedAt).padStart(15, "0")}-${randomUUID()}.ticket`;
  const info: LockInfo = { pid: cfg.pid, hostname: cfg.hostname, token: randomUUID(), startedAt, cwd: "", command: "wait" };
  const t: Ticket = { path: join(cfg.dir, name), name, body: JSON.stringify(info), dropped: false };
  hookExit();
  tickets.add(t.path);
  await writeTicket(t, cfg);
  return t;
}

/**
 * Refresh the ticket's mtime: every heartbeat and on every wake-up. A ticket
 * deleted by someone who judged it dead comes back under its old name (same place).
 */
function refreshTicket(t: Ticket, cfg: Cfg): Promise<void> {
  t.refreshing ??= (async () => {
    try {
      await cfg.utimes(t.path, new Date(cfg.now()));
    } catch (e) {
      if (errCode(e) !== "ENOENT") ticketTrouble(cfg, t.path, e);
      else if (!t.dropped) await writeTicket(t, cfg);
    }
  })().finally(() => {
    t.refreshing = undefined;
  });
  return t.refreshing;
}

async function dropTicket(t: Ticket, cfg: Cfg): Promise<void> {
  t.dropped = true;
  tickets.delete(t.path);
  if (t.refreshing) await t.refreshing;
  await unlinkRetry(t.path, cfg);
}

/** Per process: since when (mono) each ticket has been seen with the same key. Tickets are advisory. */
const ticketSeen = new Map<string, { key: string; first: number }>();

function ticketUnchangedMs(path: string, key: string, cfg: Cfg): number {
  const t = cfg.mono();
  const o = ticketSeen.get(path);
  if (o && o.key === key && t >= o.first) return t - o.first;
  if (ticketSeen.size > 256) ticketSeen.clear();
  ticketSeen.set(path, { key, first: t });
  return 0;
}

/** Live while refreshed within 2 heartbeats, by its mtime and by this process's looks; a dead same-host PID ends it at once. */
function ticketLive(path: string, s: LockState, cfg: Cfg): boolean {
  if (s.kind === "missing") return false;
  if (s.kind === "unreadable") return true;
  if (ownerDead(s, cfg)) return false;
  const ttl = s.kind === "corrupt" ? cfg.corruptGraceMs : 2 * cfg.heartbeatMs;
  // The second test catches an mtime that looks fresh because the clock stepped back.
  return cfg.now() - s.mtimeMs <= ttl && ticketUnchangedMs(path, observedKey(s), cfg) < ttl;
}

/**
 * FIFO: true when fewer than `max` live tickets are older than `own` (than any
 * ticket, for a caller that does not wait). Dead tickets are deleted; their names
 * are unique, so a delete by path cannot hit another ticket. The same listing
 * drives the housekeeping.
 */
async function eligible(own: Ticket | undefined, max: number, cfg: Cfg): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(cfg.dir);
  } catch (e) {
    const code = errCode(e);
    // No dir (a temp cleaner) means no tickets either; the attempt re-creates it.
    if (code !== "ENOENT" && code !== "ENOTDIR") ticketTrouble(cfg, cfg.dir, e);
    return true;
  }
  await housekeep(names, cfg);
  let ahead = 0;
  for (const name of names.filter((n) => TICKET_NAME.test(n)).sort()) {
    if (own && name >= own.name) break;
    const path = join(cfg.dir, name);
    let s: LockState;
    try {
      s = await readLock(path, cfg);
    } catch (e) {
      ticketTrouble(cfg, path, e);
      continue;
    }
    if (ticketLive(path, s, cfg)) {
      if (++ahead >= max) return false;
    } else if (s.kind !== "missing") {
      ticketSeen.delete(path);
      try {
        await cfg.unlink(path);
      } catch (e) {
        if (errCode(e) !== "ENOENT") ticketTrouble(cfg, path, e);
      }
    }
  }
  return true;
}

// ---- file slots -------------------------------------------------------------

function slotPathOf(dir: string, i: number): string {
  return join(dir, `slot-${i}.lock`);
}

/** One pass over the slots. `aged` collects the locks that are old but not yet confirmed stale. */
async function tryAcquireOnce(opts: SlotOptions, cfg: Cfg, aged: Set<string>): Promise<SlotHandle | undefined> {
  for (let i = 0; i < opts.max; i++) {
    const path = slotPathOf(cfg.dir, i);
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = randomUUID();
      const info: LockInfo = { pid: cfg.pid, hostname: cfg.hostname, token, startedAt: cfg.now(), cwd: opts.meta.cwd, command: opts.meta.command };
      if (await createOwned(path, info, cfg, true, () => dropStray(path, token, cfg))) return makeFileHandle(path, token, opts, cfg);
      const at = cfg.mono();
      const cur = await readLock(path, cfg);
      if (cur.kind === "missing") {
        strays.delete(path); // ours, if any, is gone too
        continue; // released meanwhile: create again
      }
      if (cur.kind === "unreadable") break;
      const v = await lockVerdict(path, cur, at, cfg);
      if (v !== "stale") {
        if (v === "aged") aged.add(path);
        break;
      }
      const r = await reap(path, cur, cfg);
      if (r !== "removed" && r !== "gone") {
        if (r === "contended") aged.add(path);
        break;
      }
    }
  }
  return undefined;
}

/** Slot paths this process keeps watching after a call gave up on them (see the header). */
const watched = new Set<string>();

/** One background look: reap the lock if it is stale. True while it is still worth watching. */
async function watchPass(path: string, cfg: Cfg): Promise<boolean> {
  const at = cfg.mono();
  const cur = await readLock(path, cfg);
  if (cur.kind === "missing") return false;
  if (cur.kind === "unreadable") return true;
  const v = await lockVerdict(path, cur, at, cfg);
  if (v !== "stale") return v === "aged";
  return (await reap(path, cur, cfg)) === "contended";
}

function watchAged(path: string, cfg: Cfg): void {
  if (watched.has(path)) return;
  watched.add(path);
  const until = cfg.mono() + cfg.staleMs + 2 * (cfg.heartbeatMs + cfg.claimHoldMaxMs);
  const schedule = (): void => {
    const t = setTimeout(() => {
      void watchPass(path, cfg)
        .catch((e: unknown) => {
          warn(cfg, "verification slot: background reclaim failed", { path, code: errCode(e) ?? String(e) });
          return false;
        })
        .then((again) => {
          if (again && cfg.mono() < until) schedule();
          else watched.delete(path);
        });
    }, cfg.heartbeatMs);
    t.unref();
  };
  schedule();
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
 * Delay before wake-up `attempt` (0-based): exponential from `minMs` to `maxMs`,
 * with upward-only jitter (x1 to x1.5) capped at `maxMs`, so never below `minMs`
 * (plan 1.4.1.d: 250 ms -> 2 s).
 */
export function nextBackoffMs(attempt: number, random: number, minMs: number, maxMs: number): number {
  const base = Math.min(maxMs, minMs * 2 ** Math.min(attempt, 30));
  return Math.max(1, Math.round(Math.min(maxMs, base * (1 + random * 0.5))));
}

/** The file-slot wait loop. Unexpected errors propagate to `acquireSlot`, which turns them into busy. */
async function acquireFile(o: SlotOptions, cfg: Cfg): Promise<SlotResult> {
  const deadline = cfg.mono() + Math.max(0, o.waitMs);
  const ticket = o.waitMs > 0 ? await createTicket(cfg) : undefined;
  let ticketBeat: NodeJS.Timeout | undefined;
  let aged = new Set<string>();
  let recreated = false;
  try {
    if (ticket) {
      // Tickets are heartbeated while waiting, so a long attempt never lets them expire.
      ticketBeat = setInterval(() => void refreshTicket(ticket, cfg), cfg.heartbeatMs);
      ticketBeat.unref();
    }
    for (let k = 0; ; k++) {
      cfg.onAttempt?.();
      if (ticket && k > 0) await refreshTicket(ticket, cfg);
      if (await eligible(ticket, o.max, cfg)) {
        aged = new Set();
        let h: SlotHandle | undefined;
        try {
          h = await tryAcquireOnce(o, cfg, aged);
        } catch (e) {
          // The dir vanished (a temp cleaner): re-create it once and try again.
          if (errCode(e) !== "ENOENT" || recreated) throw e;
          recreated = true;
          if (!(await recreateDir(cfg))) throw e;
          h = await tryAcquireOnce(o, cfg, aged);
        }
        if (h) {
          if (o.signal?.aborted) {
            await h.release();
            return { busy: true };
          }
          return h;
        }
      }
      const remaining = deadline - cfg.mono();
      if (o.signal?.aborted) return { busy: true };
      if (remaining <= 0) {
        // Out of time with an old lock not yet confirmed: keep looking in the background.
        for (const path of aged) watchAged(path, cfg);
        return { busy: true };
      }
      // Observations need a wake-up at least every 2 heartbeats to stay unbroken;
      // the last wait is cut to the deadline.
      const delay = Math.min(remaining, cfg.heartbeatMs, nextBackoffMs(k, cfg.random(), cfg.backoffMinMs, cfg.backoffMaxMs));
      const aborted = await new Promise<boolean>((resolve) => {
        const onAbort = () => {
          clearTimeout(t);
          resolve(true);
        };
        const t = setTimeout(() => {
          o.signal?.removeEventListener("abort", onAbort);
          resolve(false);
        }, delay);
        o.signal?.addEventListener("abort", onAbort, { once: true });
      });
      if (aborted) return { busy: true };
    }
  } finally {
    clearInterval(ticketBeat);
    if (ticket) await dropTicket(ticket, cfg);
  }
}

/**
 * Acquire one of `max` machine-wide verification slots, waiting up to `waitMs`
 * with exponential backoff and jitter. Resolves `{busy:true}` on timeout or
 * abort, and on an unexpected file-system error (logged); never rejects.
 */
export async function acquireSlot(opts: SlotOptions, deps?: SlotDeps): Promise<SlotResult> {
  const cfg = resolveCfg(deps);
  if (opts.signal?.aborted) return { busy: true };
  const max = Math.max(1, Math.floor(opts.max));
  // QA-1.4-31 (validated by Phase 1.1): NaN would never reach the deadline.
  const waitMs = Number.isFinite(opts.waitMs) ? Math.max(0, opts.waitMs) : 0;
  const o = { ...opts, max, waitMs };
  let writable: boolean;
  try {
    writable = await dirWritable(cfg);
  } catch (e) {
    return fsFailure(cfg, e);
  }
  if (!writable) {
    if (!degradedLogged.has(cfg.dir)) {
      degradedLogged.add(cfg.dir);
      warn(cfg, "verification slot: temp dir unwritable, using an in-process semaphore", { dir: cfg.dir });
    }
    return acquireLocal(o, cfg);
  }
  try {
    return await acquireFile(o, cfg);
  } catch (e) {
    return fsFailure(cfg, e);
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
