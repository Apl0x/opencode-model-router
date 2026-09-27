/**
 * The impure corner of Layer 2.
 *
 * Together with tree.ts this owns verification I/O. The gate, the DoD schema, the
 * deterministic checks and the grader protocol all take their side effects as
 * injected deps. This module is where those deps are actually built out of a
 * child_process, a filesystem and an opencode client, so the impurity lives in
 * one named place instead of spread through the plugin factory.
 *
 * Config is read through a getter rather than captured. `cfg` in index.ts is a
 * `let` that is reassigned whenever a command reloads it, so a snapshot taken
 * at construction would leave the grader pinned to the models and enforcement
 * settings that were active when the plugin loaded, and `/preset` would
 * silently stop applying to graded work.
 */
import { createHash } from "node:crypto";
import { access, readdir, readFile as fsReadFile, realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createBatchCoordinator, type BatchCoordinatorOptions, type BatchPlanner } from "./batch";
import {
  createDeadline,
  createDirectTestsPassHook,
  createMutexRegistry,
  createScopeOpener,
  DEFAULT_ALLOWLIST,
  isCommandAllowed,
  RECHECK_MIN_REMAINING_MS,
  resolveRepoCommand,
} from "./deterministic";
import { parseVerifyDirectives, type VerifyDirectives } from "./directives";
import {
  ABSENT_DIGEST as PENDING_ABSENT_DIGEST,
  buildDeferredFooter,
  buildLineageCaveat,
  createPendingRegistry,
  MAX_STORED_CHANGED_FILES,
  unattributedRisk,
  VERIFYING_GRACE_MS,
  type FileDigests,
  type PendingRegistry,
  type PendingRegistryOptions,
} from "./pending";
import { assessRisk, type RiskAssessment } from "./risk";
import { resolveBaseDir } from "./paths";
import { DEFAULT_IDLE_TTL_MS } from "../router/idle-sweep";
import {
  tierModel,
  type ChangedFile,
  type createChangedFileStore,
  type DispatchCaptureDeps,
  type TreeSnapshot,
} from "./dispatch";
import { runArgv, runShell } from "./exec";
import { snapshotTree } from "./tree";
import { captureReference, DEFAULT_CAPTURE_TIMEOUT_MS, gcStaleReferences, nodeReferenceFs } from "./reference";
import type { PluginLogger } from "../router/logger";
import { REFERENCE_NONE } from "./baseline";
import { scrubText } from "../guard/scrub";
import type { DoD } from "./dod";
import type { ArgvSeam, Deadline, ExecOptions, ExecResult as SeamResult, ExecSeam, ReferenceState, TestsPassHook } from "./types";
import { planScopedRun, planStaticScoping, type ChangedPath, type RunnerFs, type StaticScoping, type TestSearchSeam } from "./runner";
import {
  DEFAULT_GATE_BUDGET_MS,
  graderTimeoutMs,
  withTimeout,
} from "./timeout";
import { resolveVerifyBudget, type RouterConfig, type VerifyBudget } from "../router/config";
import { gateResult, type GateDeps, type GateResult } from "./gate";
// The grader request shape is owned by checker.ts, which builds it. Re-exported
// here because this module is where it is consumed, and because keeping a
// second local copy is exactly how `cwd` got dropped: the checker set it, the
// wiring's narrower structural type silently discarded it, and the grader ran
// against the router's directory while claiming to check the producer's.
import type { GraderRequest } from "./checker";
export type { GraderRequest };

/**
 * Upper bound on the disposal memo. Far above the number of child sessions any
 * one delegation can have in flight, and small enough that the memo can never
 * become a meaningful retention for a long-lived plugin instance.
 */
export const DISPOSED_MEMO_MAX = 512;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Join the text parts of an opencode prompt response. Tolerant of a missing or
 * malformed body by design: every call site is fail-closed, and an empty string
 * reads downstream as "the grader said nothing", which is not a pass.
 */
export function extractAssistantText(res: any): string {
  const parts: any[] = res?.data?.parts ?? [];
  return parts
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

/** P0 (deterministic.ts header, T2): what a gate needs from its dispatch. */
export interface PreparedVerification {
  /**
   * The producer's changed files: the tool-observed paths of every attempt judged against this
   * dispatch (QA-2.1-1), the paths the current snapshot added since dispatch, and the paths dirty
   * or untracked at dispatch whose content digest changed or which left the listing (QA-2.1-2);
   * each with the snapshot's status letters and rename source when the snapshot lists it.
   */
  changedFiles: ChangedFile[];
  changeBaseline: "available" | "unavailable";
  /** Settled: the dispatch reference, or why there is none. */
  reference: ReferenceState;
  /** The current tree snapshot (materialize's drift check); undefined when unavailable. */
  snapshot: TreeSnapshot | undefined;
}

/**
 * QA-2.1-11: the start-up reference GC runs this long after plugin start, so the start itself never
 * holds the project directory with a git child process.
 */
export const REFERENCE_GC_START_DELAY_MS = 45_000;
/** How long the gate-time tree snapshot may take (bounded further by a gate deadline). */
export const GRADE_SNAPSHOT_TIMEOUT_MS = 10_000;
/** T3: each git test search, bounded further by a gate deadline. */
export const TEST_SEARCH_TIMEOUT_MS = 10_000;
/** QA-2.1-12: the `git diff <dispatch head> HEAD` of a gate whose HEAD moved, bounded further by a gate deadline. */
export const COMMIT_DIFF_TIMEOUT_MS = 10_000;
/**
 * QA-2.2-21: the effective batch window is at most gateBudgetMs / this. config.ts accepts any
 * batchWindowMs up to the timer limit, and a window close to the gate budget would spend most of
 * it waiting (batch.ts W3 still keeps each member's recheck reserve).
 */
export const BATCH_WINDOW_BUDGET_DIVISOR = 10;

/** QA-2.2-21: batchWindowMs, capped at a tenth of the gate budget; <= 0 disables batching. */
export function effectiveBatchWindowMs(budget: Pick<VerifyBudget, "batchWindowMs" | "gateBudgetMs">): number {
  return Math.min(budget.batchWindowMs, Math.floor(budget.gateBudgetMs / BATCH_WINDOW_BUDGET_DIVISOR));
}

// -----------------------------------------------------------------------------------------------
// 2.4.2 deferred verification (plan Phase 2.4, sections 1.5-14..17; pending.ts R3, R10, R11)
// -----------------------------------------------------------------------------------------------

/**
 * phase-2.4.md gather item 11: the bound on a deferred finish (tree snapshot, commit diff, static
 * scoping). On expiry the change set is "unavailable" and the risk is unattributedRisk(), never [].
 */
export const DEFERRED_FINISH_MS = 2_000;
/** Upper bound on remembered native `task` dispatch starts (before hook -> after hook). */
export const DISPATCH_STARTS_MAX = 1_024;
/** Drift digests read at most this many bytes in total (tree.ts MAX_DIGEST_BYTES); beyond it: no digests. */
export const DRIFT_DIGEST_MAX_BYTES = 64 * 1024 * 1024;
/** Static scoping could not finish inside DEFERRED_FINISH_MS: counted as impossible (conservative). */
export const STATIC_SCOPING_UNFINISHED_REASON = "static scoping did not finish within the deferred-finish bound";
/** Section 1.4 pendingTtlMs default, used when the config cannot be read at plugin start. */
export const DEFAULT_PENDING_TTL_MS = 3_600_000;

/** What the orchestrator asked for at dispatch (directives.ts, parsed from its own prompt only). */
export interface DispatchStart {
  readonly directives: VerifyDirectives;
  /** Clock value when the dispatch started (pending.ts R3 dispatchedAt, R11 lineage). */
  readonly dispatchedAt: number;
}

/** What a deferred producer's return hands to finishDeferred (pending.ts R3). */
export interface DeferredFinishInput {
  readonly dispatchID: string;
  /** The session that called `task` / `delegate`; never the producer. */
  readonly orchestratorSessionID: string;
  readonly producerSessionID: string;
  /** As received; canonicalised here (canonicalTier, 1.6 handoff item 8). */
  readonly producerTier: string;
  readonly description: string;
  readonly cwd: string | undefined;
  readonly dod: DoD;
  readonly dispatchedAt: number;
}

export interface DeferredFinish {
  /** The section 1.5-16 footer; always present, also when registration failed. */
  readonly footer: string;
  /** undefined when the registry refused the entry (the footer then says "no handle"). */
  readonly handle: string | undefined;
  readonly risk: RiskAssessment;
}

/** What R11 lineage needs from a required gate's dispatch. */
export interface LineageContext {
  readonly orchestratorSessionID: string;
  /** Git top-level of the gate-time snapshot (TreeSnapshot.root); undefined -> no lineage either way. */
  readonly root: string | undefined;
  readonly dispatchID: string;
  readonly dispatchedAt: number;
  /** When the producer returned: the landedAt of a rejection recorded now. */
  readonly returnedAt: number;
  readonly strictUnverifiable: boolean | undefined;
}

/** 1.6 handoff item 8: the canonical tier id is lowercase and trimmed. */
export function canonicalTier(tier: string): string {
  return tier.trim().toLowerCase();
}

/**
 * The text directives are parsed from: the orchestrator-authored `prompt` argument, or its
 * `description` when the prompt is blank (the prompt-repair hook copies it in that case). Never a
 * tool result or a subagent's text (directives.ts SECURITY).
 */
export function dispatchDirectiveText(prompt: string | undefined, description: string | undefined): string {
  return prompt !== undefined && prompt.trim() !== "" ? prompt : (description ?? "");
}

/** A DoD whose deferral section 1.5-14/16 governs: it carries a testsPass check. */
export function hasTestsPass(dod: DoD): boolean {
  return dod.checks.some(c => c.kind === "testsPass");
}

/**
 * pending.ts R3 `digests`: sha256 hex of each path's bytes, ABSENT_DIGEST for a missing path.
 * fs reads only. Undefined (no drift claim either way) when a path is not a regular file or cannot
 * be read, or when the set exceeds MAX_STORED_CHANGED_FILES paths or DRIFT_DIGEST_MAX_BYTES bytes.
 * Never rejects. 2.4.3 computes the "after" side with the same function.
 */
export async function digestFiles(paths: readonly string[]): Promise<FileDigests | undefined> {
  if (paths.length > MAX_STORED_CHANGED_FILES) return undefined;
  const out = new Map<string, string>();
  let total = 0;
  for (const path of paths) {
    try {
      const info = await stat(path);
      if (!info.isFile()) return undefined;
      total += info.size;
      if (total > DRIFT_DIGEST_MAX_BYTES) return undefined;
      out.set(path, createHash("sha256").update(await fsReadFile(path)).digest("hex"));
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        out.set(path, PENDING_ABSENT_DIGEST);
        continue;
      }
      return undefined;
    }
  }
  return out;
}
/** A full object name (SHA-1 or SHA-256); anything else (e.g. an unborn HEAD) is an unknown head. */
const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * QA-2.1-12: parses `git diff --name-status -z -M` into absolute paths under `root`: one status
 * token, then one path, or two (source, destination) for a rename or copy. Undefined when malformed.
 */
export function parseNameStatusZ(out: string, root: string): ChangedFile[] | undefined {
  const tokens = out.split("\0");
  if (tokens[tokens.length - 1] === "") tokens.pop();
  const files: ChangedFile[] = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++];
    if (!/^[A-Z][0-9]*$/.test(status)) return undefined;
    const letter = status[0];
    if (letter === "R" || letter === "C") {
      const source = tokens[i++];
      const dest = tokens[i++];
      if (!source || !dest) return undefined;
      files.push({ path: resolve(root, dest), status: letter, previousPath: resolve(root, source) });
    } else {
      const path = tokens[i++];
      if (!path) return undefined;
      files.push({ path: resolve(root, path), status: letter });
    }
  }
  return files;
}
/** P5: the per-check timeout (DeterministicDeps.timeoutMs default). */
const CHECK_TIMEOUT_MS = 120_000;

export interface VerificationWiring {
  /**
   * Starts the dispatch's background work: the tree snapshot and, only for a DoD with an
   * allowlisted testsPass check and failureRecheck on, a git-only reference capture bounded by
   * baselineTimeoutMs. Resolves when both settled; never rejects. No test command runs (G6).
   */
  beginVerification(store: ReturnType<typeof createChangedFileStore>, id: string, cwd: string | undefined, dod: DoD): Promise<void>;
  /**
   * 2.1.5b: beginVerification, awaited for at most `waitMs` (2.4.2a: the dispatch's VERIFY_WAIT;
   * default captureWaitMs). The capture keeps running (up to baselineTimeoutMs) in the store after
   * a timeout; a timeout or error only means "no reference yet" and is logged. Never rejects.
   */
  beginVerificationBounded(
    store: ReturnType<typeof createChangedFileStore>,
    id: string,
    cwd: string | undefined,
    dod: DoD,
    waitMs?: number,
  ): Promise<void>;
  /**
   * 2.4.2a: parseVerifyDirectives over `text` with the config defaults (defaultVerify,
   * captureWaitMs, baselineTimeoutMs). `text` MUST be the orchestrator's own prompt
   * (dispatchDirectiveText). Unknown values are logged. Never throws: when the config cannot be
   * read, the mode is "required" (today's gate) and the wait 0.
   */
  resolveDirectives(text: string): VerifyDirectives;
  /**
   * 2.4.2a: resolveDirectives, then beginVerificationBounded for at most the directives' waitMs
   * (section 1.5-14: VERIFY_WAIT, 0 allowed). `remember` keeps the start for takeDispatch (the
   * native `task` after hook). Never rejects.
   */
  startDispatch(
    store: ReturnType<typeof createChangedFileStore>,
    id: string,
    cwd: string | undefined,
    dod: DoD,
    text: string,
    remember: boolean,
  ): Promise<DispatchStart>;
  /**
   * 2.4.2b: the start remembered by startDispatch, forgotten on read. When none is remembered (the
   * before hook did not run, or the entry was swept), `text` is parsed again (same orchestrator
   * prompt) and dispatchedAt is now: a later dispatchedAt can only widen R11 lineage (fewer
   * passes), never narrow it.
   */
  takeDispatch(id: string, text: string): DispatchStart;
  /**
   * 2.4.2a: whether this delegation defers (section 1.5-16): mode "deferred", a testsPass check
   * in the DoD, and verification not disabled (`require: "never"`). Everything else is gated
   * exactly as before 2.4.
   */
  isDeferred(dod: DoD, directives: VerifyDirectives): boolean;
  /**
   * 2.4.2a: the deferred finish. No gate, no test command, no slot: a tree snapshot and the commit
   * diff (git only, as prepareVerification) under DEFERRED_FINISH_MS, the static scoping plan
   * (runner.ts: no spawn), the risk (pending.ts R10), the drift digests (fs reads, not awaited),
   * `pending.register`, and the section 1.5-16 footer. The dispatch's reference promise is
   * registered un-awaited, and the dispatch record is cleared only after it settles (clearing it
   * earlier would abort the capture). Never rejects: any failure still yields a footer.
   */
  finishDeferred(store: ReturnType<typeof createChangedFileStore>, input: DeferredFinishInput): Promise<DeferredFinish>;
  /**
   * 2.4.2b/c, pending.ts R11 on a required gate's result:
   * - outcome "fail" with proven-introduced ids -> pending.recordRejection (label
   *   "dispatch <id>", landedAt = returnedAt); the result is returned unchanged;
   * - otherwise, proven pre-existing ids that an earlier rejection of the same session and root
   *   introduced (findLineage) -> the verdict becomes unverifiable with buildLineageCaveat; it
   *   stays accepted unless strictUnverifiable. It never creates a pass or a fail.
   * A verdict without `failures` (checker verdicts, a timed-out gate) and an unknown root are
   * returned unchanged and record nothing.
   */
  applyLineage(res: GateResult, ctx: LineageContext): GateResult;
  /** 2.4.1: the plugin instance's pending registry (sweep, forgetSession, dispose are wired in index.ts). */
  pending: PendingRegistry;
  /**
   * 2.1.5b: the crash GC of stale reference dirs, fire-and-forget. QA-2.1-11: it runs `delayMs`
   * (default REFERENCE_GC_START_DELAY_MS) after the call, on an unref'd timer, so plugin start
   * never spawns a git process in the project directory (a process's cwd holds the directory on
   * Windows: EBUSY for whoever removes it). Returns a cancel function for plugin dispose: it
   * clears a pending timer and aborts the git calls of a GC in flight. Never throws.
   */
  startReferenceGc(delayMs?: number): () => void;
  /** P0: the snapshot, the changed files and the settled reference, each bounded by `deadline` when given. */
  prepareVerification(
    store: ReturnType<typeof createChangedFileStore>,
    id: string,
    childID: string,
    cwd?: string,
    deadline?: Deadline,
  ): Promise<PreparedVerification>;
  /** Session ids currently running a grader prompt, so hooks can skip them. */
  graderSessions: Set<string>;
  /** Abort then delete a plugin-created child session. Never throws. */
  disposeChildSession(sid: string): Promise<void>;
  /** Run one grader turn, parented to the caller's session when given. */
  dispatchGrader(
    req: GraderRequest,
    parentSessionID?: string,
    inFlight?: Set<string>,
  ): Promise<{ sessionID: string; text: string }>;
  /**
   * Deps for the acceptance gate; graders are parented to parentSessionID.
   *
   * `inFlight`, when supplied, receives the id of every grader session this
   * gate invocation currently has open, and loses it again the moment that
   * grader finishes. A caller enforcing a gate budget aborts THAT set — never
   * the wiring-global one, which belongs to every concurrent delegation at
   * once.
   *
   * `prepared` supplies the testsPass inputs (changed files, reference, current tree); without it
   * the changed files are "unavailable" and the reference is the untracked default. `deadline`
   * bounds every testsPass step (T3); without it each testsPass check owns one of gateBudgetMs.
   */
  buildGateDeps(parentSessionID?: string, inFlight?: Set<string>, prepared?: PreparedVerification, deadline?: Deadline): GateDeps;
  /**
   * 2.2.3: the idle-TTL sweep's hook into the plugin's one S5 batch coordinator (batch.ts B11):
   * evicts windows with no live member and batches whose seam hung past BATCH_STALE_GRACE_MS.
   * Returns the number evicted. Never throws.
   */
  sweepVerification(): number;
  /**
   * 2.2.3: plugin dispose. Settles pending batched requests, kills running batches and awaits
   * their scope closes (batch.ts B11). Idempotent; never rejects.
   */
  disposeVerification(): Promise<void>;
}

/** How a bounded wait ended (awaitBounded). */
export type BoundedOutcome = { kind: "settled" } | { kind: "timeout" } | { kind: "error"; error: unknown };

/**
 * Wait for `promise` for at most `ms`. Never rejects; clears its timer; the timer is unref'd so a
 * pending wait never keeps the process alive. The promise itself keeps running after a timeout.
 */
export function awaitBounded(promise: Promise<unknown>, ms: number): Promise<BoundedOutcome> {
  return new Promise<BoundedOutcome>(resolveOutcome => {
    let done = false;
    const finish = (outcome: BoundedOutcome): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveOutcome(outcome);
    };
    const timer = setTimeout(() => finish({ kind: "timeout" }), Math.max(0, ms));
    timer.unref?.();
    promise.then(() => finish({ kind: "settled" }), (error: unknown) => finish({ kind: "error", error }));
  });
}

/** Logging for the dispatch-time wait and the start-up GC. `debug` is optional (PluginLogger has none). */
export type WiringLogger = Pick<PluginLogger, "warn"> & { debug?: (message: string, extra?: Record<string, unknown>) => void };

function splitZ(out: string): string[] {
  return out.split("\0").filter(s => s.length > 0);
}

function errorText(err: unknown): string {
  return scrubText(err instanceof Error ? err.message : String(err));
}

export function createVerificationWiring(deps: {
  client: any;
  /** Project root; relative paths in checks resolve against it. */
  directory: string;
  getConfig: () => RouterConfig;
  /** Default: console.warn, no debug output. */
  logger?: WiringLogger;
  /** Test seams of the S5 batch coordinator (clock, timers, platform, maximum window size). */
  batch?: Omit<BatchCoordinatorOptions, "logger">;
  /** Test seams of the pending registry (clock, random source). */
  pending?: Pick<PendingRegistryOptions, "now" | "random">;
}): VerificationWiring {
  const { client, directory, getConfig } = deps;
  const logger: WiringLogger = deps.logger ?? { warn: (message, extra) => console.warn(message, extra ?? "") };
  const graderSessions = new Set<string>();
  /** Child sessions already torn down; see disposeChildSession. */
  const disposed = new Set<string>();
  const mutex = createMutexRegistry();
  /**
   * 2.2.3: one S5 batch coordinator per plugin instance (batch.ts D6). Each gate hands it its own
   * runtime, so a config reload reaches the next window without a new coordinator.
   */
  const coordinator = createBatchCoordinator({ ...deps.batch, logger });
  /**
   * 2.4.1/2.4.2a: one pending registry per plugin instance. Its TTL and abandonment bound are read
   * from the config at plugin start (a reload applies after a restart; the registry holds no timer).
   */
  let pendingBudget: Pick<VerifyBudget, "pendingTtlMs" | "gateBudgetMs">;
  try {
    pendingBudget = resolveVerifyBudget(getConfig());
  } catch (err) {
    // Plugin start never fails on config: the section 1.4 defaults.
    logger.debug?.("[verify] pending registry uses default bounds: config unreadable", { error: errorText(err) });
    pendingBudget = { pendingTtlMs: DEFAULT_PENDING_TTL_MS, gateBudgetMs: DEFAULT_GATE_BUDGET_MS };
  }
  const pending = createPendingRegistry({
    ttlMs: pendingBudget.pendingTtlMs,
    maxVerifyingMs: pendingBudget.gateBudgetMs + VERIFYING_GRACE_MS,
    ...deps.pending,
    onEvict: (entry, cause) => logger.debug?.("[verify] pending delegation evicted", { handle: entry.handle, cause }),
  });
  const pendingNow = deps.pending?.now ?? Date.now;
  /** 2.4.2b: native `task` dispatch starts, before hook -> after hook (bounded FIFO, swept). */
  const dispatchStarts = new Map<string, DispatchStart>();
  /**
   * pending.ts R10: the settled value of each dispatch reference promise, recorded when it settles,
   * so a deferred finish can tell "already captured at return" without awaiting (0 ms). Keyed by
   * the promise object (the store returns the same one), so it holds nothing once the store drops it.
   */
  const settledReferences = new WeakMap<Promise<ReferenceState>, ReferenceState>();

  const abs = (p: string): string => (isAbsolute(p) ? p : join(directory, p));

  // QA-1.2-13: lowPriority and env reach the process; no per-call maxBuffer (QA-1.5-25).
  const execSeam: ExecSeam = (command: string, opts?: ExecOptions): Promise<ExecResult> =>
    runShell(command, {
      cwd: opts?.cwd ?? directory,
      timeoutMs: opts?.timeoutMs ?? CHECK_TIMEOUT_MS,
      signal: opts?.signal,
      lowPriority: opts?.lowPriority,
      env: opts?.env,
    });

  const argvSeam: ArgvSeam = (file, args, opts) =>
    runArgv(file, args, {
      cwd: opts?.cwd ?? directory,
      timeoutMs: opts?.timeoutMs ?? CHECK_TIMEOUT_MS,
      signal: opts?.signal,
      lowPriority: opts?.lowPriority,
      env: opts?.env,
    });

  // T9 1.3: PlannerFs + unlink over fs.promises. realpath is the native one; fileExists accepts
  // directories (access does).
  const fsSeam: RunnerFs = {
    async fileExists(p: string): Promise<boolean> {
      try {
        await access(abs(p));
        return true;
      } catch {
        return false;
      }
    },
    async readFile(p: string): Promise<string> {
      return await fsReadFile(abs(p), "utf-8");
    },
    realpath: p => realpath(abs(p)),
    async stat(p) {
      const s = await stat(abs(p), { bigint: true });
      return { isFile: s.isFile(), size: s.size, dev: s.dev, ino: s.ino };
    },
    readdir: p => readdir(abs(p)),
    async unlink(p) {
      try {
        await unlink(abs(p));
      } catch (err) {
        // Already gone resolves (RunnerFs contract); anything else is the caller's to report.
        if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
      }
    },
  };

  /**
   * QA-2.1-12: the files of the commits made since the dispatch snapshot. A shell edit to a file
   * clean at dispatch, then committed, is invisible to `git status`. Undefined when HEAD did not
   * move (nothing is spawned) or either snapshot is missing (delta is unavailable then anyway).
   * "unavailable" when HEAD moved and the diff failed, timed out, or could not run, or when either
   * head is unknown (e.g. an unborn repository at dispatch).
   */
  const committedSinceDispatch = async (
    before: TreeSnapshot | undefined,
    now: TreeSnapshot | undefined,
    deadline: Deadline | undefined,
  ): Promise<ChangedFile[] | "unavailable" | undefined> => {
    if (!before || !now || before.head === now.head) return undefined;
    const root = now.root;
    if (!root || !OBJECT_NAME.test(before.head) || !OBJECT_NAME.test(now.head)) return "unavailable";
    const timeoutMs = deadline ? deadline.bound(COMMIT_DIFF_TIMEOUT_MS) : COMMIT_DIFF_TIMEOUT_MS;
    if (timeoutMs <= 0 || deadline?.signal.aborted) return "unavailable";
    try {
      const r = await argvSeam("git", ["--no-optional-locks", "-C", root, "diff", "--name-status", "-z", "-M", before.head, "HEAD"], {
        cwd: root,
        timeoutMs,
        lowPriority: resolveVerifyBudget(getConfig()).lowPriority,
        ...(deadline ? { signal: deadline.signal } : {}),
      });
      if (r.timedOut === true || r.code !== 0) return "unavailable";
      return parseNameStatusZ(r.stdout, root) ?? "unavailable";
    } catch {
      return "unavailable"; // The diff could not run: never the same as "no commit touched a file".
    }
  };

  /** T9 1.3: the planners' git searches through the argv seam; no shell, no optional locks. */
  const testSearch = (budget: VerifyBudget, deadline: Deadline | undefined): TestSearchSeam => {
    const git = async (root: string, args: readonly string[]): Promise<SeamResult | undefined> => {
      const timeoutMs = deadline ? deadline.bound(TEST_SEARCH_TIMEOUT_MS) : TEST_SEARCH_TIMEOUT_MS;
      if (timeoutMs <= 0 || deadline?.signal.aborted) return undefined;
      try {
        const r = await argvSeam("git", ["--no-optional-locks", "-C", root, ...args], {
          cwd: root,
          timeoutMs,
          lowPriority: budget.lowPriority,
          ...(deadline ? { signal: deadline.signal } : {}),
        });
        return r.timedOut === true ? undefined : r;
      } catch {
        return undefined; // The search could not run: never the same as "no match".
      }
    };
    return {
      async findByName(gitRoot, names) {
        const r = await git(gitRoot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...names.map(n => `:(glob)**/${n}`)]);
        return r && r.code === 0 ? splitZ(r.stdout).map(rel => resolve(gitRoot, rel)) : undefined;
      },
      async findByContent(gitRoot, needle, globs) {
        const r = await git(gitRoot, ["grep", "-l", "-z", "-F", "--untracked", "-e", needle, "--", ...globs]);
        if (!r) return undefined;
        if (r.code === 1) return [];
        return r.code === 0 ? splitZ(r.stdout).map(rel => resolve(gitRoot, rel)) : undefined;
      },
    };
  };

  // Best-effort disposal of a plugin-created child session: abort any in-flight
  // work, then delete it so it does not linger forever as a top-level session in
  // the TUI. Fail-soft by contract — never throws, so it is safe to call from a
  // finally without masking the original error.
  const disposeChildSession = async (sid: string): Promise<void> => {
    // Idempotent, not merely fail-soft. Several paths legitimately dispose the
    // same session — the per-attempt teardown in the delegate ladder and the
    // end-of-execute safety net both do, and a timeout racing a late completion
    // can too. Re-issuing abort+delete was harmless but not free, and it made
    // "disposed exactly once" unassertable, which is precisely the property the
    // time-box work has to be able to prove.
    if (disposed.has(sid)) return;
    // Bounded: the memo only has to outlive the handful of callers that can
    // race over one session (per-attempt teardown, the end-of-execute safety
    // net, a timeout beaten by a late completion), all of which happen within a
    // single delegate call. A plugin instance lives for the whole editor
    // session, so an unbounded Set would be a slow leak. Insertion order is
    // specified for Set, so dropping from the front evicts the oldest ids.
    if (disposed.size >= DISPOSED_MEMO_MAX) {
      let toDrop = disposed.size - DISPOSED_MEMO_MAX + 1;
      for (const old of disposed) {
        disposed.delete(old);
        if (--toDrop <= 0) break;
      }
    }
    disposed.add(sid);
    try {
      await client.session.abort({ path: { id: sid } });
    } catch {
      // best-effort: the session may already have completed or been removed
    }
    try {
      await client.session.delete({ path: { id: sid } });
    } catch {
      // best-effort: cleanup must never break the run
    }
  };

  const dispatchGrader = async (
    req: GraderRequest,
    parentSessionID?: string,
    inFlight?: Set<string>,
  ): Promise<{ sessionID: string; text: string }> => {
    // Scope the grader session to the producer's working directory when one was
    // declared. Naming the directory in the prompt is not enough: the grader
    // has real tools, and an unscoped session resolves every read and command
    // against the router's own cwd, so it would happily report "file not found"
    // for work that exists exactly where it was asked for.
    const created: any = await client.session.create({
      body: { ...(parentSessionID ? { parentID: parentSessionID } : {}) },
      ...(req.cwd ? { query: { directory: req.cwd } } : {}),
    });
    const sid: string | undefined = created?.data?.id;
    if (!sid) return { sessionID: "", text: "" };
    graderSessions.add(sid);
    inFlight?.add(sid);
    try {
      const cfg = getConfig();
      const model = tierModel(cfg, req.tier) ?? undefined;
      // Time-boxed for the same reason as the producer prompt, but with a
      // sharper edge: a grader that never answers must not be able to hold the
      // gate open. The RouterTimeoutError is deliberately allowed to propagate
      // to runChecker, which returns unverifiable with the timeout reason.
      // The gate decides acceptance using strictUnverifiable; no producer
      // escalation is warranted when the grader itself could not finish.
      //
      // No abort is issued here: the finally below already calls
      // disposeChildSession, which aborts before it deletes, so a second abort
      // on this path would be a redundant round trip that cancels nothing extra.
      // (The gate-budget path in index.ts does issue a raw abort, deliberately:
      // it fires while this call is still suspended, before the finally has had
      // a chance to run at all.)
      const res: any = await withTimeout(
        client.session.prompt({
          path: { id: sid },
          body: {
            ...(model ? { model } : {}),
            system: req.system,
            parts: [{ type: "text", text: req.prompt }],
          },
        }),
        graderTimeoutMs(req.tier, cfg.enforcement?.verify?.graderTimeoutMs),
        "grader prompt",
      );
      return { sessionID: sid, text: extractAssistantText(res) };
    } finally {
      graderSessions.delete(sid);
      inFlight?.delete(sid);
      await disposeChildSession(sid);
    }
  };

  /** What beginDispatch captures for `dod` under the current config (T9 1.1: resolveVerifyBudget). */
  const captureDepsFor = (dod: DoD): DispatchCaptureDeps => {
    const cfg = getConfig();
    const budget = resolveVerifyBudget(cfg);
    // Only a dispatch that will be judged by testsPass captures a reference (G6: a git-only
    // capture, never a test run). Read-only fan-outs capture nothing.
    const judgedByTests = cfg.enforcement?.verify?.require !== "never" && dod.checks.some(
      c => c.kind === "testsPass" && isCommandAllowed(resolveRepoCommand(c, "testsPass", undefined), DEFAULT_ALLOWLIST),
    );
    const base = { snapshot: snapshotTree, timeoutMs: budget.baselineTimeoutMs };
    if (!judgedByTests) return { ...base, uncaptured: { kind: "none", reason: REFERENCE_NONE.notRequested } };
    if (!budget.failureRecheck) return { ...base, uncaptured: { kind: "disabled" } };
    // QA-1.2-13: the capture's git processes run at the configured priority too.
    const argv: ArgvSeam = (file, args, opts) => argvSeam(file, args, { ...opts, lowPriority: budget.lowPriority });
    return {
      ...base,
      capture: (at, signal) => captureReference(at, signal, { argv, fs: nodeReferenceFs, timeoutMs: budget.baselineTimeoutMs }),
    };
  };

  const buildGateDeps = (
    parentSessionID?: string,
    inFlight?: Set<string>,
    prepared?: PreparedVerification,
    deadline?: Deadline,
  ): GateDeps => {
    const cfg = getConfig();
    const budget = resolveVerifyBudget(cfg);
    // QA-2.1-5: the recheck's git processes (GC, materialize, dispose) run at the configured
    // priority too, like the capture and the start-up GC (QA-1.2-13).
    const referenceArgv: ArgvSeam = (file, args, opts) => argvSeam(file, args, { ...opts, lowPriority: budget.lowPriority });
    const openScope = createScopeOpener({
      argv: argvSeam, exec: execSeam, fs: fsSeam, budget, checkTimeoutMs: CHECK_TIMEOUT_MS,
      reference: { argv: referenceArgv },
    });
    const currentTree = prepared?.snapshot !== undefined ? { currentTree: prepared.snapshot } : {};
    const direct = createDirectTestsPassHook({
      openScope,
      plannerFs: fsSeam,
      search: testSearch(budget, deadline),
      budget,
      ...currentTree,
    });
    // 2.2.3 (S5): with a batch window, concurrent testsPass checks of this plugin instance meet in
    // the coordinator; the direct hook stays behind it for "full" scope and single requests (B2).
    // The planner is the direct hook's (planScopedRun over the same PlannerFs and budget), with
    // its git searches bound to whichever deadline the coordinator plans under (B6).
    let testsPass: TestsPassHook = direct;
    const batchWindowMs = effectiveBatchWindowMs(budget);
    if (batchWindowMs > 0) {
      const plan: BatchPlanner = (input, planDeadline) => planScopedRun({
        command: input.command,
        cwd: input.cwd,
        changedFiles: input.changedFiles,
        budget: { maxWorkers: budget.maxWorkers },
        fs: fsSeam,
        search: testSearch(budget, planDeadline),
      });
      testsPass = coordinator.hook({
        direct,
        plan,
        openScope,
        batchWindowMs,
        recheckMinRemainingMs: RECHECK_MIN_REMAINING_MS,
        failureRecheck: budget.failureRecheck,
        ...currentTree,
      });
    }
    return {
      deterministic: {
        exec: execSeam,
        fs: fsSeam,
        cwd: directory,
        mutex,
        argv: argvSeam,
        budget,
        openScope,
        testsPass,
        // Section 1.5-6: without a change baseline, shell edits are unattributed.
        changedFiles: prepared?.changeBaseline === "available" ? prepared.changedFiles : "unavailable",
        ...(prepared !== undefined ? { reference: prepared.reference } : {}),
        ...(deadline !== undefined ? { deadline } : {}),
      },
      checker: {
        dispatchGrader: (req: GraderRequest) =>
          dispatchGrader(req, parentSessionID, inFlight),
        ladder: ["fast", "medium", "heavy"],
        minGraderTier: cfg.enforcement?.verify?.minGraderTier ?? null,
      },
      require: cfg.enforcement?.verify?.require,
      strictUnverifiable: cfg.enforcement?.verify?.strictUnverifiable,
    };
  };

  const beginVerification: VerificationWiring["beginVerification"] = async (store, id, cwd, dod) => {
    let deps: DispatchCaptureDeps;
    try {
      deps = captureDepsFor(dod);
    } catch (err) {
      // Never blocks or fails the dispatch: snapshot only, and no reference.
      deps = {
        snapshot: snapshotTree,
        timeoutMs: DEFAULT_CAPTURE_TIMEOUT_MS,
        uncaptured: { kind: "none", reason: `${REFERENCE_NONE.failed} (${errorText(err)})` },
      };
    }
    const begun = store.beginDispatch(id, resolve(directory, cwd || "."), deps);
    // pending.ts R10: remember the reference's settled value (the store hands out one promise).
    const reference = store.reference(id);
    if (!settledReferences.has(reference)) void reference.then(state => settledReferences.set(reference, state));
    await begun;
  };

  /**
   * The producer's change since the dispatch: the gate-time snapshot (bounded by `deadline`), the
   * commits since the dispatch head, and the store's delta. Shared by prepareVerification and the
   * deferred finish, so both attribute exactly the same files.
   */
  const observeChange = async (
    store: ReturnType<typeof createChangedFileStore>,
    id: string,
    childID: string,
    cwd: string | undefined,
    deadline: Deadline | undefined,
  ): Promise<Omit<PreparedVerification, "reference">> => {
    const base = resolve(directory, cwd || ".");
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    deadline?.signal.addEventListener("abort", onAbort, { once: true });
    let snapshot: TreeSnapshot | undefined;
    try {
      const bound = deadline ? deadline.bound(GRADE_SNAPSHOT_TIMEOUT_MS) : GRADE_SNAPSHOT_TIMEOUT_MS;
      // QA-2.1-2: digest exactly the paths the dispatch snapshot digested (<= MAX_DIGEST_FILES),
      // so delta can tell which already-dirty file a shell edit changed.
      const digests = store.baselineSnapshot(id)?.digests;
      const options = digests === undefined ? {} : { digestPaths: digests === "unavailable" ? [] : [...digests.keys()] };
      snapshot = bound > 0 && !controller.signal.aborted
        ? await withTimeout(snapshotTree(base, controller.signal, options), bound, "grade fingerprint")
        : undefined;
    } catch {
      snapshot = undefined; // Explicit unavailable disclaimer, never a raw tree.
    } finally {
      deadline?.signal.removeEventListener("abort", onAbort);
      controller.abort();
    }
    const committed = await committedSinceDispatch(store.baselineSnapshot(id), snapshot, deadline);
    return { ...store.delta(id, childID, snapshot, base, committed), snapshot };
  };

  const beginVerificationBounded: VerificationWiring["beginVerificationBounded"] = async (store, id, cwd, dod, waitOverrideMs) => {
    let waitMs: number;
    let begun: Promise<void>;
    try {
      waitMs = waitOverrideMs ?? resolveVerifyBudget(getConfig()).captureWaitMs;
      begun = beginVerification(store, id, cwd, dod);
    } catch (err) {
      logger.warn("[verify] dispatch reference capture could not start", { id, error: errorText(err) });
      return;
    }
    const outcome = await awaitBounded(begun, waitMs);
    if (outcome.kind === "timeout") {
      logger.debug?.("[verify] dispatch reference not ready; proceeding without waiting further", { id, waitMs });
    } else if (outcome.kind === "error") {
      logger.warn("[verify] dispatch reference capture failed; proceeding without a reference", { id, error: errorText(outcome.error) });
    }
  };

  const resolveDirectives = (text: string): VerifyDirectives => {
    try {
      const budget = resolveVerifyBudget(getConfig());
      return parseVerifyDirectives(
        text,
        { defaultVerify: budget.defaultVerify, captureWaitMs: budget.captureWaitMs, baselineTimeoutMs: budget.baselineTimeoutMs },
        message => logger.warn(message),
      );
    } catch (err) {
      // No config, no deferral: today's synchronous gate, and no wait (the gate awaits the
      // reference under its own deadline).
      logger.warn("[verify] dispatch directives could not be resolved; verifying synchronously", { error: errorText(err) });
      return { mode: "required", waitMs: 0, modeSource: "default", waitSource: "default" };
    }
  };

  /**
   * Section 1.5-17 "scoping impossible", decided with no process (runner.ts:11): planStaticScoping
   * for each testsPass check, with the command and cwd the gate would use. The first S6 result wins;
   * a command outside the allowlist is S6 too (the gate reports it unverifiable). Bounded by the
   * deferred-finish deadline; an unfinished plan counts as impossible (raises the risk, never lowers it).
   */
  const staticScoping = async (
    dod: DoD,
    cwd: string | undefined,
    changedFiles: readonly ChangedPath[],
    deadline: Deadline,
  ): Promise<StaticScoping> => {
    const unfinished: StaticScoping = { unverifiable: true, code: "search-failed", reason: STATIC_SCOPING_UNFINISHED_REASON };
    const budget = resolveVerifyBudget(getConfig());
    const at = resolveBaseDir(cwd, directory);
    const plans: StaticScoping[] = [];
    for (const check of dod.checks) {
      if (check.kind !== "testsPass") continue;
      const command = resolveRepoCommand(check, "testsPass", undefined);
      if (!isCommandAllowed(command, DEFAULT_ALLOWLIST)) {
        plans.push({ unverifiable: true, code: "unsupported-command", reason: `command not allowlisted: ${scrubText(command)}` });
        continue;
      }
      const ms = deadline.remaining();
      if (ms <= 0) {
        plans.push(unfinished);
        continue;
      }
      try {
        plans.push(await withTimeout(
          planStaticScoping({ command, cwd: at, changedFiles, budget: { maxWorkers: budget.maxWorkers }, fs: fsSeam }),
          ms,
          "static scoping",
        ));
      } catch {
        plans.push(unfinished);
      }
    }
    return plans.find(p => "unverifiable" in p) ?? plans[0] ?? unfinished;
  };

  const finishDeferred: VerificationWiring["finishDeferred"] = async (store, input) => {
    const producerTier = canonicalTier(input.producerTier);
    // The live reference promise (no signal: never awaited here). Its settled value at this moment
    // is the R10 `reference` input; a capture still in flight counts as absent.
    const reference = store.reference(input.dispatchID);
    const referenceCaptured = settledReferences.get(reference)?.kind === "captured";
    const deadline = createDeadline(DEFERRED_FINISH_MS);
    let risk: RiskAssessment = unattributedRisk();
    try {
      const change = await observeChange(store, input.dispatchID, input.producerSessionID, input.cwd, deadline);
      let changedFiles: ChangedPath[] | "unavailable" = "unavailable";
      let digests: Promise<FileDigests | undefined> | undefined;
      // Section 1.5-6 / QA-1.6-14: without a change baseline the set is unknown, never [].
      if (change.changeBaseline === "available" && !deadline.signal.aborted) {
        const paths: ChangedPath[] = change.changedFiles.map(f => ({
          path: f.path,
          status: f.status,
          ...(f.previousPath !== undefined ? { previousPath: f.previousPath } : {}),
        }));
        changedFiles = paths;
        const scopingPlan = await staticScoping(input.dod, input.cwd, paths, deadline);
        risk = assessRisk({ changedFiles: paths, reference: referenceCaptured, producerTier, scopingPlan, root: change.snapshot?.root });
        digests = digestFiles(paths.map(p => p.path));
      }
      const reg = pending.register({
        orchestratorSessionID: input.orchestratorSessionID,
        dispatchID: input.dispatchID,
        producerSessionID: input.producerSessionID,
        producerTier,
        description: input.description,
        cwd: resolveBaseDir(input.cwd, directory),
        root: change.snapshot?.root,
        dispatchedAt: input.dispatchedAt,
        dod: input.dod,
        reference,
        changedFiles,
        risk,
        ...(digests !== undefined ? { digests } : {}),
      });
      if (!reg.ok) {
        logger.warn("[verify] deferred delegation not registered", { code: reg.code, detail: reg.detail });
        return { footer: buildDeferredFooter({ handle: undefined, risk, unregistered: reg.code }), handle: undefined, risk };
      }
      return { footer: buildDeferredFooter({ handle: reg.handle, risk }), handle: reg.handle, risk };
    } catch (err) {
      logger.warn("[verify] deferred finish failed; the delegation has no handle", { error: errorText(err) });
      return { footer: buildDeferredFooter({ handle: undefined, risk, unregistered: "invalid-input" }), handle: undefined, risk };
    } finally {
      deadline.dispose();
      // The dispatch record goes once the finish has read it (delta) AND its reference settled:
      // clearing it earlier aborts an in-flight capture (dispatch.ts evict) and ends its
      // contamination tracking (section 1.5-14).
      void reference.then(() => store.clear(input.dispatchID));
    }
  };

  const applyLineage: VerificationWiring["applyLineage"] = (res, ctx) => {
    const failures = res.verdict.failures;
    if (failures === undefined || ctx.root === undefined || ctx.orchestratorSessionID === "") return res;
    const outcome = res.verdict.outcome ?? (res.verdict.pass ? "pass" : "fail");
    if (outcome === "fail") {
      if (failures.introduced.length > 0) {
        pending.recordRejection({
          orchestratorSessionID: ctx.orchestratorSessionID,
          root: ctx.root,
          label: `dispatch ${ctx.dispatchID}`,
          landedAt: ctx.returnedAt,
          introduced: failures.introduced,
        });
      }
      return res;
    }
    if (failures.preexisting.length === 0) return res;
    const match = pending.findLineage({
      orchestratorSessionID: ctx.orchestratorSessionID,
      root: ctx.root,
      dispatchedAt: ctx.dispatchedAt,
      preexisting: failures.preexisting,
    });
    if (match === undefined) return res;
    const caveat = buildLineageCaveat(match);
    return gateResult(
      { ...res.verdict, pass: false, outcome: "unverifiable", caveats: [...(res.verdict.caveats ?? []), caveat] },
      res.dodSource,
      ctx.strictUnverifiable ?? false,
    );
  };

  return {
    beginVerification,
    resolveDirectives,
    async startDispatch(store, id, cwd, dod, text, remember) {
      const start: DispatchStart = { directives: resolveDirectives(text), dispatchedAt: pendingNow() };
      if (remember) {
        dispatchStarts.delete(id);
        dispatchStarts.set(id, start);
        while (dispatchStarts.size > DISPATCH_STARTS_MAX) {
          const oldest = dispatchStarts.keys().next();
          if (oldest.done === true) break;
          dispatchStarts.delete(oldest.value);
        }
      }
      await beginVerificationBounded(store, id, cwd, dod, start.directives.waitMs);
      return start;
    },
    takeDispatch(id, text) {
      const start = dispatchStarts.get(id);
      if (start !== undefined) {
        dispatchStarts.delete(id);
        return start;
      }
      return { directives: resolveDirectives(text), dispatchedAt: pendingNow() };
    },
    isDeferred(dod, directives) {
      if (directives.mode !== "deferred" || !hasTestsPass(dod)) return false;
      try {
        return getConfig().enforcement?.verify?.require !== "never";
      } catch {
        return false;
      }
    },
    finishDeferred,
    applyLineage,
    pending,
    beginVerificationBounded,
    startReferenceGc(delayMs = REFERENCE_GC_START_DELAY_MS) {
      if (!directory) {
        logger.debug?.("[verify] reference GC skipped: plugin root unknown");
        return () => undefined;
      }
      const stop = new AbortController();
      const run = (): void => {
        if (stop.signal.aborted) return;
        try {
          const budget = resolveVerifyBudget(getConfig());
          // Low priority (QA-1.2-13), and every git call dies with the plugin (dispose).
          const argv: ArgvSeam = (file, args, opts) => argvSeam(file, args, {
            ...opts,
            lowPriority: budget.lowPriority,
            signal: opts?.signal ? AbortSignal.any([opts.signal, stop.signal]) : stop.signal,
          });
          gcStaleReferences(directory, { argv, fs: nodeReferenceFs, logger }).then(
            report => {
              if (report.removed.length > 0) logger.debug?.("[verify] reference GC removed stale dirs", { removed: report.removed.length });
            },
            (err: unknown) => logger.warn("[verify] reference GC failed", { error: errorText(err) }),
          );
        } catch (err) {
          logger.warn("[verify] reference GC failed", { error: errorText(err) });
        }
      };
      const timer = setTimeout(run, Math.max(0, delayMs));
      timer.unref?.();
      return () => {
        clearTimeout(timer);
        stop.abort();
      };
    },
    async prepareVerification(store, id, childID, cwd, deadline) {
      const change = await observeChange(store, id, childID, cwd, deadline);
      const reference = await store.reference(id, deadline?.signal);
      return { ...change, reference };
    },
    graderSessions,
    disposeChildSession,
    dispatchGrader,
    buildGateDeps,
    sweepVerification: () => {
      // Native task starts whose after hook never came (the call was cancelled), past the idle TTL.
      const at = pendingNow();
      let evicted = 0;
      for (const [id, start] of [...dispatchStarts]) {
        if (at - start.dispatchedAt >= DEFAULT_IDLE_TTL_MS) {
          dispatchStarts.delete(id);
          evicted += 1;
        }
      }
      return evicted + coordinator.sweep();
    },
    disposeVerification: () => {
      dispatchStarts.clear();
      return coordinator.dispose();
    },
  };
}
