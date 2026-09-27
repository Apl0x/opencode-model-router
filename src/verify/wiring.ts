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
import { access, readdir, readFile as fsReadFile, realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  createDirectTestsPassHook,
  createMutexRegistry,
  createScopeOpener,
  DEFAULT_ALLOWLIST,
  isCommandAllowed,
  resolveRepoCommand,
} from "./deterministic";
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
import type { ArgvSeam, Deadline, ExecOptions, ExecResult as SeamResult, ExecSeam, ReferenceState } from "./types";
import type { RunnerFs, TestSearchSeam } from "./runner";
import {
  graderTimeoutMs,
  withTimeout,
} from "./timeout";
import { resolveVerifyBudget, type RouterConfig, type VerifyBudget } from "../router/config";
import type { GateDeps } from "./gate";
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
   * 2.1.5b: beginVerification, awaited for at most captureWaitMs. The capture keeps running (up to
   * baselineTimeoutMs) in the store after a timeout; a timeout or error only means "no reference
   * yet" and is logged. Never rejects.
   */
  beginVerificationBounded(store: ReturnType<typeof createChangedFileStore>, id: string, cwd: string | undefined, dod: DoD): Promise<void>;
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
}): VerificationWiring {
  const { client, directory, getConfig } = deps;
  const logger: WiringLogger = deps.logger ?? { warn: (message, extra) => console.warn(message, extra ?? "") };
  const graderSessions = new Set<string>();
  /** Child sessions already torn down; see disposeChildSession. */
  const disposed = new Set<string>();
  const mutex = createMutexRegistry();

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
    const openScope = createScopeOpener({ argv: argvSeam, exec: execSeam, fs: fsSeam, budget, checkTimeoutMs: CHECK_TIMEOUT_MS });
    const testsPass = createDirectTestsPassHook({
      openScope,
      plannerFs: fsSeam,
      search: testSearch(budget, deadline),
      budget,
      ...(prepared?.snapshot !== undefined ? { currentTree: prepared.snapshot } : {}),
    });
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
    await store.beginDispatch(id, resolve(directory, cwd || "."), deps);
  };

  return {
    beginVerification,
    async beginVerificationBounded(store, id, cwd, dod) {
      let waitMs: number;
      let begun: Promise<void>;
      try {
        waitMs = resolveVerifyBudget(getConfig()).captureWaitMs;
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
    },
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
      const reference = await store.reference(id, deadline?.signal);
      return { ...store.delta(id, childID, snapshot, base), reference, snapshot };
    },
    graderSessions,
    disposeChildSession,
    dispatchGrader,
    buildGateDeps,
  };
}
