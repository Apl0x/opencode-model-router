// src/verify/pending.ts
// ===============================================================================================
// PENDING VERIFICATION REGISTRY: design (plan Phase 2.4, task 2.4.1; S7, sections 1.5-16..20)
//
// STATUS: design + exported API. Every function body throws "not implemented" until task 2.4.1b
// (R12) implements this header. Contract types used here come from the 2.1.1 block of
// src/verify/types.ts (ReferenceState, Verdict) and are never redefined.
// ===============================================================================================
//
// R1. PURPOSE AND NON-GOALS
//
//   A per-plugin-instance, in-memory registry of DEFERRED delegations (VERIFY:deferred, the
//   default): what a later `router_verify` call (2.4.3), the pending list (2.4.4) and background
//   mode (2.4.5) need to verify one delegation after its producer has returned.
//   - Pure in-memory state with an injected clock and an injected random source. It never spawns
//     a process, never runs git, never touches the filesystem and owns no timer.
//   - It does not run verifications. It records who may verify what, hands the in-flight run to
//     concurrent callers, and stores the settled result.
//   - It does not parse directives, compute changed files, assess risk or build the scoped run.
//     2.4.2 does that before `register`, and 2.4.3 runs the 2.1/2.2 pipeline after `markVerifying`.
//   - Required (VERIFY:required) delegations are NOT registered: they are gated synchronously by
//     2.1 and never produce a handle. A deferred delegation is never labelled accepted or verified
//     by anything in this module (R9).
//
// R2. HANDLES
//
//   - Format: `vrf_` + 24 lowercase hex chars = 12 bytes (96 bits) from `random(12)`, default
//     `crypto.randomBytes`. HANDLE_PATTERN = /^vrf_[0-9a-f]{24}$/. Unguessable, but a handle is NOT
//     a bearer token: every lookup is scoped by the calling session (R6). 96 bits keeps the footer
//     short while making a collision or a guess irrelevant in practice.
//   - Collision: a candidate equal to a live handle or a tombstone is redrawn, at most
//     HANDLE_MAX_DRAWS times; then `register` returns { ok: false, code: "handle-collision" }
//     (never throws: a registration failure must never fail the delegation, R9 footer variant).
//   - Input normalization (`normalizeHandle`, for router_verify arguments): trim, strip ONE pair of
//     surrounding backticks or quotes, lowercase, then HANDLE_PATTERN. Anything else is undefined
//     and reported as UNKNOWN_HANDLE_TEXT. router_verify dedupes normalized handles and accepts at
//     most MAX_HANDLES_PER_CALL (= MAX_ENTRIES_PER_SESSION); the excess is reported, not run.
//
// R3. ENTRY
//
//   Registration (PendingRegistration) is built by 2.4.2 when a deferred producer returns:
//     orchestratorSessionID  the session that called `task` / `delegate` (the hook's
//                            input.sessionID / the tool context's sessionID). NEVER the producer.
//     dispatchID             the dispatch key 2.1's store uses (opaque).
//     producerSessionID      the child session; must differ from orchestratorSessionID.
//     producerTier           canonical lowercase tier id (1.6 handoff item 8); used for
//                            buildForcingNote's next tier on a rejection. "" when untiered.
//     description            the orchestrator's `description` arg (or a prompt prefix);
//                            stored through sanitizeDescription (R9).
//     cwd                    absolute check cwd of the delegation.
//     root                   git top-level realpath (TreeSnapshot.root, 2.1.3a; 1.6 item 7), or
//                            undefined when unknown. Used only for lineage (R11).
//     dispatchedAt           clock value when the dispatch started (lineage, R11).
//     dod                    the delegation's DoD (it carries testsPass; else nothing is deferred).
//     reference              Promise<ReferenceState> from 2.1's per-dispatch capture. The registry
//                            stores `reference.then(s => s, () => ({ kind: "none", reason:
//                            REFERENCE_FAILED_REASON }))`, so the stored promise never rejects and
//                            an abandoned capture never raises an unhandled rejection.
//     changedFiles           ChangedPath[] with status/previousPath, or "unavailable" when
//                            attribution failed (never [] for a failure: QA-1.6-14). More than
//                            MAX_STORED_CHANGED_FILES paths are stored as "unavailable" with
//                            changedFilesDropped = the count: a later verification is then
//                            unverifiable (section 1.5-6), never scoped over a truncated set.
//     risk                   RiskAssessment computed by 2.4.2 (R10) BEFORE registration.
//     digests                optional Promise<FileDigests | undefined>: per-path content digests of
//                            the producer's files taken right after return (2.4.2, fs reads only,
//                            not awaited on the result path). Stored normalized to never reject.
//                            router_verify compares them with driftedPaths() for the section
//                            1.5-18 drift notice; undefined -> no drift claim either way.
//   Added by the registry: handle, createdAt = now() at registration (= the producer's return:
//   the TTL and "newest first" run from it), state, verifyingSince, result.
//   Snapshots: `get`/`list*` return frozen snapshot objects (PendingEntry); later transitions do
//   not mutate a snapshot a caller holds.
//   Release on a terminal settle (state "verified"): reference, changedFiles, digests and dod are
//   dropped from the record (reference -> resolved { kind: "none", reason: RELEASED_REASON },
//   changedFiles -> "unavailable"). Only metadata and the settled result stay until the TTL.
//
// R4. STATES AND TRANSITIONS
//
//   from          event                                      to            effect
//   ------------  -----------------------------------------  ------------  ---------------------
//   (none)        register                                   unverified    handle issued
//   unverified    markVerifying                              verifying     "claimed": new run
//   verifying     markVerifying (second caller)              verifying     "joined": same run
//   verifying     claim.settle(result, retryable: false)     verified      run resolves; release
//   verifying     claim.settle(result, retryable: true)      unverified    run resolves; kept for
//                                                                          a later call; result
//                                                                          stored as lastResult
//   verifying     reaped: verifyingSince + maxVerifyingMs    unverified    run resolves with
//                 <= now (lazy, R7)                                        ABANDONED result
//   verified      markVerifying                              verified      "settled": cached result,
//                                                                          no new run (no CPU)
//   any but       TTL (now - createdAt >= ttlMs), cap,       (tombstone)   onEvict(entry, cause)
//   verifying     forgetSession, dispose
//
//   - `retryable` is decided by the caller (2.4.3): true for results that say nothing about the
//     producer's work — slot busy, deadline/abort, timed out, executor error, a joiner cut by its
//     own deadline never settles anything. Everything else (pass, fail, S6 unverifiable,
//     approximate/unusable reference, no reference) is terminal.
//   - A verifying entry is never evicted (joiners await it). After its settle, an entry past its
//     TTL or doomed by forgetSession is evicted at once.
//   - claim.settle is single-use: it returns true once; false afterwards, and false when the
//     claim was reaped (a stale claimer can never overwrite a newer run). The run promise never
//     rejects. 2.4.3 MUST call settle in a `finally` (with a retryable result on an exception);
//     the reaper is only the backstop.
//
// R5. OPERATIONS (PendingRegistry)
//
//   register(reg)                 -> RegisterResult. Validates (non-empty session ids that differ,
//                                    else "invalid-input"), applies caps (R7) BEFORE inserting.
//   get(sessionID, handle)        -> Lookup: found | expired | unknown (R6). Reaps and TTL-evicts
//                                    lazily first, so an expired entry is never "found" even when
//                                    the throttled sweep has not run.
//   listUnverified(sid, limit?)   -> state "unverified" only, newest first (createdAt desc, then
//                                    registration order desc). limit undefined = all (<= cap).
//                                    Feeds buildPendingListBlock (2.4.4).
//   listOpen(sid)                 -> "unverified" + "verifying", newest first: the handle set of
//                                    router_verify `pending: true`, so a second concurrent
//                                    `pending: true` joins the in-flight runs instead of seeing
//                                    an empty list.
//   markVerifying(sid, handle)    -> ClaimResult: claimed { run, settle } | joined { run } |
//                                    settled { result } | expired | unknown.
//   sweep(nowMs?)                 -> TTL eviction + reaping. Wired as `() => pending.sweep()` into
//                                    the existing createIdleTtlSweeper list in index.ts (2.4.2);
//                                    no timer of its own. Returns the number evicted.
//   forgetSession(sid)            -> evicts the session's entries, tombstones and rejection records
//                                    (verifying ones are doomed and evicted at settle). For a
//                                    session-deletion event, if the host delivers one (pre-flight).
//   recordRejection(record)       -> lineage ledger (R11).
//   findLineage(query)            -> LineageMatch | undefined (R11).
//   stats()                       -> counts, for tests and the QA memory-bound assertions.
//   dispose()                     -> evicts everything (cause "disposed"); every in-flight run
//                                    resolves with the DISPOSED result; later settles return false.
//
// R6. SCOPING (plan 2.4.1 "Scoping"; QA focus "handle leakage across sessions")
//
//   - Storage is keyed by session first: Map<orchestratorSessionID, Map<handle, record>>. A lookup
//     for (sessionID, handle) consults only that session's map, so another session's live handle,
//     a producer session's attempt, a malformed string and a never-issued handle are the same
//     result: { kind: "unknown" } -> UNKNOWN_HANDLE_TEXT. Nothing distinguishes "exists elsewhere".
//   - Tombstones (evicted handles) remember their session: the same session gets "expired"
//     (EXPIRED_HANDLE_TEXT); any other session gets "unknown". Bounded FIFO, TOMBSTONE_MAX.
//   - A producer (subagent) calling router_verify runs under its own session id, which owns none
//     of the handles its orchestrator received; the footer reaches only the orchestrator. So a
//     subagent can neither verify nor list its own delegation (plan "Subagent cannot self-select").
//
// R7. TTL, ABANDONMENT, EVICTION, MEMORY BOUNDS
//
//   - TTL: ttlMs = pendingTtlMs (section 1.4, default 3600000), from createdAt. Checked lazily on
//     every get/list/markVerifying/register and by sweep(). Future stamps (clock skew) are never
//     expired (same rule as sessions.ts sweep).
//   - Abandonment: maxVerifyingMs = gateBudgetMs + VERIFYING_GRACE_MS (caller passes it). A
//     verifying entry older than that is reverted to unverified and its run resolved with the
//     ABANDONED result (retryable). Checked lazily like the TTL. No timer.
//   - Caps: MAX_ENTRIES_PER_SESSION = 32, MAX_ENTRIES_GLOBAL = 128, and a global weight
//     MAX_GLOBAL_WEIGHT = 100000, weight = stored changed paths + (once the reference resolves
//     "captured") reference.untracked.size + reference.tracked.size. The weight of a reference is
//     added in its settle callback, which may evict (a promise callback, not a timer).
//   - Eviction order when a cap would be exceeded (session cap: within the session; global caps:
//     across sessions): (1) every TTL-expired entry, (2) verified entries, oldest first, (3)
//     unverified entries, oldest first. Verifying entries are never evicted. If the new entry still
//     does not fit, register returns { ok: false, code: "registry-full" } and the footer says the
//     delegation has no handle (R9); the delegation itself is never blocked.
//   - Worst case: 128 entries, 100000 path strings of the registry's own weight (about 20 MB at
//     200 B per path), 512 tombstones, 16 x sessions rejection records of <= 50 ids each.
//   - Resources: a stored reference is data only (DispatchReference: commit ids and hash maps). The
//     `git stash create` commit is unreferenced and left to git's own pruning, as in 1.5; worktrees
//     exist only inside a VerificationScope and are disposed by its close() (2.1 T2 P9), never by
//     the registry. So eviction disposes nothing: it drops the record, tombstones the handle and
//     calls onEvict(entry, cause) for logging. An in-flight capture keeps running under 2.1's
//     baselineTimeoutMs; the registry only drops its promise.
//
// R8. CONCURRENCY
//
//   Single-threaded JS: every operation is synchronous and atomic with respect to the others.
//   The only asynchronous edges are the stored promises' settle callbacks (weight accounting) and
//   the run promises the registry resolves. markVerifying is the join point of section 1.5-18:
//   two router_verify calls for one handle -> exactly one "claimed", the rest "joined" (one run).
//   A joiner bounds its own wait by its own deadline (2.4.3); if its deadline passes first it
//   reports VERIFYING_ELSEWHERE_TEXT for that handle and settles nothing.
//
// R9. TEXT (stable; 2.4.6 tests assert it verbatim). All builders are pure.
//
//   Directive safety: no builder ever emits a literal `VERIFY:` / `VERIFY_WAIT:` / `CAP:`
//   directive. An orchestrator that quotes a footer or the pending list in a later dispatch must
//   not change that dispatch's mode (directives.ts router-example contract, QA-1.6-4/QA-1.6-5).
//   Label rule: the first token after `[router] ` of the footer's first line is always
//   `unverified`. Risk reasons may contain "verified" as prose (REASONS.unverifiable); tests assert
//   on the label, never on a bare substring.
//
//   buildDeferredFooter({ handle, risk })  (section 1.5-16), handle registered:
//     [router] unverified · <handle> · risk <level> (<r1>; <r2>; <r3>; +<k> more)
//     [router] Call `router_verify` with this handle before building on this work if the risk matters.
//   Without a handle (register returned ok: false):
//     [router] unverified · no handle (<code phrase>) · risk <level> (<reasons>)
//     [router] This delegation cannot be verified later; re-dispatch it with required verification if the risk matters.
//   <code phrase>: "invalid-input" -> "not registered", "registry-full" -> "pending registry
//   full", "handle-collision" -> "handle allocation failed".
//   The risk fragment is formatRisk(level, reasons, FOOTER_MAX_REASONS): `risk <level>`, then
//   ` (<reasons>)` with at most maxReasons reasons, each through sanitizeDescription's character
//   rules (no length cut), "; "-joined, `; +<k> more` only when k > 0. The parenthesis is omitted
//   when there are no reasons or maxReasons is 0 (the pending list uses 0). `·` is U+00B7 with
//   one space on each side.
//   appendRouterFooter(output, footer): output.trimEnd() + "\n\n" + footer, or footer alone when
//   the trimmed output is empty. The same call is used for the native `task` output
//   (tool.execute.after) and the `delegate` tool return (2.4.2).
//
//   buildPendingListBlock(entries)  (section 1.5-20; entries = listUnverified(sid), newest first):
//     undefined when entries is empty (the prompt does not grow for sessions that never defer);
//     otherwise, with n = entries.length and m = min(n, PENDING_LIST_LIMIT = 5):
//     [router] Unverified delegations in this session (newest first):
//     - <handle> · risk <level> · <description>          (m lines)
//     - ... and <n - m> more                              (only when n > m)
//     [router] Before your final answer, call `router_verify` with the handles that matter, or with `pending: true` for all of them.
//
//   buildLateNoticeBlock(notices)  (section 1.5-19, background mode only; 2.4.5 owns the queue):
//     undefined when empty; otherwise
//     [router] Background verification found introduced failures:
//     - <handle> · <description> · failing: <id>, <id> (+<k> more)   (ids capped at 10)
//     [router] Nothing was retried; decide whether to re-dispatch.
//
//   sanitizeDescription(text): every C0/C1 control, U+2028/U+2029 and tab -> space; backtick ->
//   `'`; runs of whitespace -> one space; trim; longer than MAX_DESCRIPTION_CHARS -> the first
//   MAX_DESCRIPTION_CHARS - 1 code points + `…`; empty -> "(no description)". Code-point safe
//   (never splits a surrogate pair). Keeps each list item on one line.
//
//   Phrases for router_verify results (2.4.3): UNKNOWN_HANDLE_TEXT, EXPIRED_HANDLE_TEXT,
//   VERIFYING_ELSEWHERE_TEXT, and the reasons ABANDONED_REASON / DISPOSED_REASON of the synthetic
//   retryable results (Verdict { pass: false, outcome: "unverifiable", method: "deterministic",
//   reasons: [<reason>], caveats: [<reason>] }).
//
// R10. RISK INPUTS (2.4.2 computes the risk; handoffs from docs/qa/.../phase-1.6.md)
//
//   assessRisk({ changedFiles, reference, producerTier, scopingPlan, root }) with:
//   - changedFiles: the tree-snapshot ChangedPath[] with status and previousPath (2.1.3a). When
//     attribution failed, do NOT call assessRisk with []: use unattributedRisk() = { level:
//     "high", reasons: [UNATTRIBUTED_RISK_REASON] } and register changedFiles "unavailable".
//   - reference: true only when the reference promise has ALREADY settled as "captured" at return
//     time (2.4.2 tracks the settled value; it never awaits: 0 ms result latency). A capture still
//     in flight counts as absent: the risk is raised one step, conservatively. The stored promise
//     is still the one router_verify awaits later.
//   - producerTier: canonical lowercase id (only exact "fast" triggers row 11).
//   - scopingPlan: planStaticScoping (1.3, no spawn) for the stored changed files.
//   - root: git top-level realpath (TreeSnapshot.root), never the delegation cwd.
//   The risk is fixed at registration; it is advice (section 1.5-17) and is not recomputed.
//
// R11. T11 LINEAGE (a native `task` re-dispatch after a rejection)
//
//   Problem (2.1 deterministic.ts T11): after a rejection, a native `task` re-dispatch captures a
//   new reference that already contains the failed attempt's changes. A test the first attempt
//   broke then fails at the new reference too, is classified pre-existing, and passes with the
//   "no worse than before" note.
//   Decision: pending.ts keeps a small per-orchestrator-session ledger of proven-introduced ids,
//   and 2.4 downgrades such a pass to UNVERIFIABLE with a caveat naming the earlier delegation.
//   It does NOT link the re-dispatch to the original reference, because the router cannot tell a
//   retry from a new delegation in the native path (no retry marker, and section 1.5-15 closes
//   the directive set): with the old reference a third party's break between the two dispatches
//   would be blamed on the retry (section 1.2, second guarantee), and a failure fixed and broken
//   again in between would be excused (a false pass). The downgrade instead only removes passes
//   for ids that are both pre-existing at the new reference and proven introduced earlier in the
//   same session: it can never create a pass and never creates a fail, which is exactly section
//   1.2's third guarantee ("cannot tell them apart" -> unverifiable).
//   - recordRejection({ orchestratorSessionID, root, label, landedAt, introduced }) — called by
//     claim.settle automatically for a terminal result with introduced ids and a known root
//     (label = handle, landedAt = entry.createdAt), and by 2.4.2 for a rejected REQUIRED gate in
//     the native path (label "dispatch <dispatchID>", landedAt = the producer's return).
//     introduced is capped at MAX_LEDGER_IDS; MAX_LEDGER_PER_SESSION records per session, oldest
//     dropped; records expire with ttlMs.
//   - findLineage({ orchestratorSessionID, root, dispatchedAt, preexisting }) -> the newest record
//     of the same session and root with landedAt <= dispatchedAt whose introduced ids intersect
//     `preexisting`: { label, ids } (ids in `preexisting` order). A record never matches its own
//     delegation (its landedAt is after its dispatchedAt).
//   - buildLineageCaveat(match): "<ids> failed after <label> in this session and still fail; the
//     reference of this delegation already contained that change, so pre-existing cannot be told
//     apart from not fixed". <ids> as in 2.1 T7 (at most 10, then " (+<k> more)").
//   - Precondition (2.4 pre-flight): the merged 2.1 must expose TestsPassJudgement.failures on the
//     gate result that 2.4 code sees. If it does not, 2.4 does not edit 2.1-owned internals: it
//     deletes recordRejection/findLineage/buildLineageCaveat from this file (no dead code) and the
//     2.4 QA report keeps T11 as a residual.
//
// R12. IMPLEMENTATION TASKS (each <= ~20 tool calls; commit + push each green; scoped tests only)
//
//   2.4.1b  (now, parallel with 2.1.2+ and 2.2) Implement this file per R2-R11 and add
//           test/unit/pending.test.ts: handle format + collision redraw (fake random), R6 scoping
//           matrix (other session / producer session / malformed / never issued -> unknown; own
//           tombstone -> expired), R4 transition table row by row, join (N markVerifying -> one
//           claimed), single-use settle, reaping, TTL at read without sweep, caps and eviction
//           order (verifying never evicted, registry-full), weight added on reference resolution,
//           release on terminal settle, rejected reference promise normalized, forgetSession,
//           dispose resolves joiners, every R9 text verbatim (empty list -> undefined, cap 5,
//           "+k more", no directive tokens, label rule), lineage matrix (other session, other
//           root, landedAt after dispatchedAt, no intersection -> undefined). typecheck.
//   2.4.2a  (after 2.1 + 2.2.3 merge) wiring.ts: parse directives from the orchestrator prompt
//           only; VERIFY_WAIT replaces captureWaitMs in the bounded capture wait; a deferred-finish
//           helper (snapshot -> changedFiles | "unavailable", planStaticScoping, risk per R10,
//           digests, register, footer). Tests in deferred-verification.test.ts (zero spawns).
//   2.4.2b  index.ts native `task` path: mode routing in tool.execute.before/after; required ->
//           2.1 gate unchanged; deferred -> footer appended; recordRejection on required
//           rejections (R11); sweep wired into createIdleTtlSweeper.
//   2.4.2c  index.ts `delegate` path: same routing, footer on the tool return, no ladder for
//           deferred.
//   2.4.3a  wiring.ts: verifyHandles(sessionID, handles | "pending", deps): normalize, claim/join,
//           one Deadline, one batch through the 2.2 coordinator, drift via driftedPaths, verdict
//           per handle with forcing note + next tier on rejection, lineage caveat, settle in
//           finally; no retry ever dispatched.
//   2.4.3b  index.ts: register `router_verify` next to `delegate` whenever verification is
//           enabled (independent of enableDelegateTool). Tests: router-verify-tool.test.ts.
//   2.4.4   index.ts system transform: buildPendingListBlock(listUnverified(sid)) appended only
//           when defined. Tests: cap 5, newest first, leaves on verify/TTL, per-session.
//   2.4.5   background (only when background: true): the queue factory in this file, coalescing,
//           same coordinator/slot/caps, late notices via buildLateNoticeBlock once per handle;
//           the queue is never constructed when false (assert). Tests: the plan's background set.
//   2.4.6   remaining plan tests (latency under fake timers, capture after the wait, subagent
//           cannot self-select, 50 deferred delegations spawn nothing).
//
// R13. RESIDUAL RISKS (accepted; QA may challenge)
//
//   - A producer can end its final text with a fake `[router] …` line. The real footer is always
//     appended last; the 2.3 protocol text says only the last `[router]` footer counts.
//   - Drift digests are taken just after the producer returns (not atomically with it): an edit
//     in those milliseconds is attributed to the producer, not reported as drift.
//   - The registry lives in one plugin instance: a restarted opencode process loses its handles
//     (router_verify then says "unknown handle"); nothing persists across processes by design.
//   - Lineage (R11) is id-based: a renamed test id escapes it (the pass keeps 2.1's n2 note).
// ===============================================================================================

import type { DoD } from "./dod";
import type { RiskAssessment, RiskLevel } from "./risk";
import type { ChangedPath } from "./runner";
import type { ReferenceState, Verdict } from "./types";

// ---------------------------------------------------------------------------------------------
// Constants (R2, R7, R9)
// ---------------------------------------------------------------------------------------------

export const HANDLE_PREFIX = "vrf_";
/** 12 random bytes -> 24 lowercase hex chars (R2). */
export const HANDLE_RANDOM_BYTES = 12;
export const HANDLE_PATTERN = /^vrf_[0-9a-f]{24}$/;
export const HANDLE_MAX_DRAWS = 4;

export const MAX_ENTRIES_PER_SESSION = 32;
export const MAX_ENTRIES_GLOBAL = 128;
/** Global weight in path strings: stored changed paths + captured reference untracked/tracked sizes (R7). */
export const MAX_GLOBAL_WEIGHT = 100_000;
/** Above this, changedFiles is stored as "unavailable" (never truncated, R3). */
export const MAX_STORED_CHANGED_FILES = 500;
export const TOMBSTONE_MAX = 512;
export const MAX_HANDLES_PER_CALL = MAX_ENTRIES_PER_SESSION;
/** Added to gateBudgetMs by the caller to form maxVerifyingMs (R7). */
export const VERIFYING_GRACE_MS = 30_000;

export const MAX_LEDGER_PER_SESSION = 16;
export const MAX_LEDGER_IDS = 50;

export const MAX_DESCRIPTION_CHARS = 80;
export const PENDING_LIST_LIMIT = 5;
export const FOOTER_MAX_REASONS = 3;
export const LATE_NOTICE_MAX_IDS = 10;

export const UNKNOWN_HANDLE_TEXT = "unknown handle";
export const EXPIRED_HANDLE_TEXT = "expired handle: older than pendingTtlMs or evicted; it can no longer be verified";
export const VERIFYING_ELSEWHERE_TEXT =
  "still being verified by another router_verify call; call again for its verdict";
export const REFERENCE_FAILED_REASON = "reference capture failed";
export const RELEASED_REASON = "reference released after verification";
export const ABANDONED_REASON = "verification run abandoned before it settled";
export const DISPOSED_REASON = "verification registry disposed";
export const UNATTRIBUTED_RISK_REASON = "changed files could not be attributed";

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type PendingState = "unverified" | "verifying" | "verified";

/** Absolute path -> sha256 hex of the file bytes, or ABSENT_DIGEST for a missing path (R3). */
export type FileDigests = ReadonlyMap<string, string>;
export const ABSENT_DIGEST = "absent";

/** What 2.4.2 hands to `register` when a deferred producer returns (R3). */
export interface PendingRegistration {
  readonly orchestratorSessionID: string;
  readonly dispatchID: string;
  readonly producerSessionID: string;
  /** Canonical lowercase tier id; "" when the producer is untiered. */
  readonly producerTier: string;
  /** Raw; the registry stores sanitizeDescription(description). */
  readonly description: string;
  readonly cwd: string;
  /** Git top-level realpath (TreeSnapshot.root), or undefined when unknown. */
  readonly root: string | undefined;
  /** Clock value when the dispatch started. */
  readonly dispatchedAt: number;
  readonly dod: DoD;
  readonly reference: Promise<ReferenceState>;
  /** "unavailable" when attribution failed; never [] for a failure (QA-1.6-14). */
  readonly changedFiles: readonly ChangedPath[] | "unavailable";
  readonly risk: RiskAssessment;
  readonly digests?: Promise<FileDigests | undefined>;
}

/** What a verification of one handle produced (2.4.3 builds it from the gate result). */
export interface VerificationResult {
  readonly verdict: Verdict;
  /** true -> the entry returns to "unverified" (R4); false -> "verified" (terminal). */
  readonly retryable: boolean;
  /** Proven-introduced test ids (TestsPassJudgement.failures.introduced); feeds R11. */
  readonly introduced?: readonly string[];
  /** Producer paths modified after it returned (driftedPaths); drives the drift notice. */
  readonly driftedPaths?: readonly string[];
  /** buildForcingNote's suggested next tier on a rejection. */
  readonly nextTier?: string;
}

export interface SettledVerification extends VerificationResult {
  readonly handle: string;
  readonly settledAt: number;
}

/** A frozen snapshot of one entry (R3). */
export interface PendingEntry {
  readonly handle: string;
  readonly orchestratorSessionID: string;
  readonly dispatchID: string;
  readonly producerSessionID: string;
  readonly producerTier: string;
  readonly description: string;
  readonly cwd: string;
  readonly root: string | undefined;
  readonly dispatchedAt: number;
  /** undefined once released by a terminal settle. */
  readonly dod: DoD | undefined;
  /** Never rejects. Resolves { kind: "none", reason: RELEASED_REASON } once released. */
  readonly reference: Promise<ReferenceState>;
  readonly changedFiles: readonly ChangedPath[] | "unavailable";
  /** Paths dropped because the set exceeded MAX_STORED_CHANGED_FILES; 0 otherwise. */
  readonly changedFilesDropped: number;
  readonly risk: RiskAssessment;
  /** Never rejects; undefined when not provided or released. */
  readonly digests: Promise<FileDigests | undefined> | undefined;
  readonly createdAt: number;
  readonly state: PendingState;
  /** Set while state is "verifying". */
  readonly verifyingSince: number | undefined;
  /** The last settled result: terminal when "verified", retryable when back to "unverified". */
  readonly result: SettledVerification | undefined;
}

export type RegisterResult =
  | { readonly ok: true; readonly handle: string; readonly evicted: readonly string[] }
  | {
      readonly ok: false;
      readonly code: "invalid-input" | "registry-full" | "handle-collision";
      readonly detail: string;
    };

export type Lookup =
  | { readonly kind: "found"; readonly entry: PendingEntry }
  /** Evicted (TTL, cap, forgetSession) and issued to THIS session. */
  | { readonly kind: "expired"; readonly handle: string }
  /** Malformed, never issued, or issued to another session (R6). */
  | { readonly kind: "unknown"; readonly handle: string };

export type ClaimResult =
  | {
      readonly kind: "claimed";
      readonly entry: PendingEntry;
      /** Resolves when `settle` is called, the claim is reaped, or the registry is disposed. Never rejects. */
      readonly run: Promise<SettledVerification>;
      /** Single use; false when already settled, reaped or disposed (R4). */
      settle(result: VerificationResult): boolean;
    }
  | { readonly kind: "joined"; readonly entry: PendingEntry; readonly run: Promise<SettledVerification> }
  | { readonly kind: "settled"; readonly entry: PendingEntry; readonly result: SettledVerification }
  | { readonly kind: "expired"; readonly handle: string }
  | { readonly kind: "unknown"; readonly handle: string };

export type EvictionCause = "ttl" | "session-cap" | "global-cap" | "weight-cap" | "session-gone" | "disposed";

/** A proven-introduced rejection, for R11 lineage. */
export interface RejectionRecord {
  readonly orchestratorSessionID: string;
  readonly root: string;
  /** The handle, or "dispatch <dispatchID>" for a required gate. */
  readonly label: string;
  /** When the rejected producer's changes were in the tree (its return time). */
  readonly landedAt: number;
  readonly introduced: readonly string[];
}

export interface LineageQuery {
  readonly orchestratorSessionID: string;
  readonly root: string;
  readonly dispatchedAt: number;
  /** TestsPassJudgement.failures.preexisting of the delegation being judged. */
  readonly preexisting: readonly string[];
}

export interface LineageMatch {
  readonly label: string;
  /** The intersection, in `preexisting` order. */
  readonly ids: readonly string[];
}

export interface PendingRegistryStats {
  readonly entries: number;
  readonly sessions: number;
  readonly verifying: number;
  readonly weight: number;
  readonly tombstones: number;
  readonly rejections: number;
}

export interface PendingRegistryOptions {
  /** pendingTtlMs (section 1.4). */
  readonly ttlMs: number;
  /** gateBudgetMs + VERIFYING_GRACE_MS. */
  readonly maxVerifyingMs: number;
  /** Injected clock; default Date.now. */
  readonly now?: () => number;
  /** Injected random source; default crypto.randomBytes. */
  readonly random?: (bytes: number) => Uint8Array;
  readonly maxPerSession?: number;
  readonly maxGlobal?: number;
  readonly maxWeight?: number;
  /** Logging hook; never throws into the registry (a throwing hook is ignored). */
  readonly onEvict?: (entry: PendingEntry, cause: EvictionCause) => void;
}

export interface PendingRegistry {
  register(reg: PendingRegistration): RegisterResult;
  get(sessionID: string, handle: string): Lookup;
  listUnverified(sessionID: string, limit?: number): readonly PendingEntry[];
  listOpen(sessionID: string): readonly PendingEntry[];
  markVerifying(sessionID: string, handle: string): ClaimResult;
  sweep(nowMs?: number): number;
  forgetSession(sessionID: string): void;
  recordRejection(record: RejectionRecord): void;
  findLineage(query: LineageQuery): LineageMatch | undefined;
  stats(): PendingRegistryStats;
  dispose(): void;
}

export interface FooterInput {
  /** undefined when register returned ok: false. */
  readonly handle: string | undefined;
  readonly risk: RiskAssessment;
  /** register's failure code, required when handle is undefined. */
  readonly unregistered?: "invalid-input" | "registry-full" | "handle-collision";
}

export interface LateNotice {
  readonly handle: string;
  readonly description: string;
  readonly introduced: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// API (stubs until task 2.4.1b)
// ---------------------------------------------------------------------------------------------

function notImplemented(name: string): never {
  throw new Error(`not implemented: pending.ts ${name} (plan task 2.4.1b)`);
}

/** R2-R8, R11. */
export function createPendingRegistry(options: PendingRegistryOptions): PendingRegistry {
  void options;
  return notImplemented("createPendingRegistry");
}

/** R2: trimmed, one pair of surrounding backticks/quotes stripped, lowercased, HANDLE_PATTERN. */
export function normalizeHandle(text: string): string | undefined {
  void text;
  return notImplemented("normalizeHandle");
}

/** R9. */
export function sanitizeDescription(text: string): string {
  void text;
  return notImplemented("sanitizeDescription");
}

/** R10: the risk of a delegation whose changed files could not be attributed. */
export function unattributedRisk(): RiskAssessment {
  return notImplemented("unattributedRisk");
}

/** R9, section 1.5-16. */
export function buildDeferredFooter(input: FooterInput): string {
  void input;
  return notImplemented("buildDeferredFooter");
}

/** R9. */
export function appendRouterFooter(output: string, footer: string): string {
  void output;
  void footer;
  return notImplemented("appendRouterFooter");
}

/** R9, section 1.5-20. `entries` = listUnverified(sessionID), newest first. undefined when empty. */
export function buildPendingListBlock(entries: readonly PendingEntry[]): string | undefined {
  void entries;
  return notImplemented("buildPendingListBlock");
}

/** R9, section 1.5-19 (background mode only). undefined when empty. */
export function buildLateNoticeBlock(notices: readonly LateNotice[]): string | undefined {
  void notices;
  return notImplemented("buildLateNoticeBlock");
}

/**
 * R3, section 1.5-18: paths of `before` whose digest differs in `after` (a path missing from
 * `after` counts as drifted), sorted. Pure.
 */
export function driftedPaths(before: FileDigests, after: FileDigests): string[] {
  void before;
  void after;
  return notImplemented("driftedPaths");
}

/** R11. */
export function buildLineageCaveat(match: LineageMatch): string {
  void match;
  return notImplemented("buildLineageCaveat");
}

/** R9: the risk fragment shared by the footer and the pending list. */
export function formatRisk(level: RiskLevel, reasons: readonly string[], maxReasons: number): string {
  void level;
  void reasons;
  void maxReasons;
  return notImplemented("formatRisk");
}
