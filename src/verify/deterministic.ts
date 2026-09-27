// src/verify/deterministic.ts
// Deterministic verifier: runs DoD checks using injected seams (no real fs/exec imports).
// PURE: no I/O-capable Node built-ins; all I/O goes through DeterministicDeps
// seams. ./paths is pure path math (node:path only) and keeps that contract.

import type { Check, DoD } from "./dod";
import type {
  Verdict,
  DeterministicDeps,
  MutexRegistry,
  ExecResult,
  Deadline,
  ArgvSeam,
  ExecOptions,
  ExecSeam,
  OpenVerificationScope,
  Rechecker,
  ScopedExecutor,
  ScopedOutcome,
  VerificationScope,
} from "./types";
import type { LintSpec, RunnerFs, RunnerHost, RunResult } from "./runner";
import type { VerifyBudget } from "../router/config";
import type { PluginLogger } from "../router/logger";
import { scrubText } from "../guard/scrub";
import { resolveAgainst } from "./paths";
import { isAbsolute } from "node:path";
import { compareTests, observeTests } from "./baseline";
import { readResult } from "./runner";
import { acquireSlot, type SlotHandle } from "./slot";

// ---------------------------------------------------------------------------
// MutexRegistry — per-key serialization via promise-chaining
// ---------------------------------------------------------------------------

export function createMutexRegistry(): MutexRegistry {
  const chains = new Map<string, Promise<unknown>>();
  return {
    runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const prev = chains.get(key) ?? Promise.resolve();
      const run = prev.then(() => fn(), () => fn());
      // Tail swallows errors so the lock never wedges; run still rejects/resolves with fn's result.
      chains.set(key, run.then(() => {}, () => {}));
      return run;
    },
  };
}

// ---------------------------------------------------------------------------
// Command validation
// ---------------------------------------------------------------------------

export const DEFAULT_ALLOWLIST = [
  "npm", "npx", "pnpm", "yarn", "bun", "node",
  "tsc", "tsx", "vitest", "jest", "eslint", "prettier", "pytest",
];

// Any shell-chaining / redirection / substitution metacharacter.
// eslint-disable-next-line no-useless-escape
export const FORBIDDEN_SHELL = /[;&|`$><\n]|\$\(|&&|\|\|/;

// Interpreters that can execute arbitrary inline code via a flag. An allowlisted
// interpreter must not be turned into an arbitrary-code runner (e.g. `node -e ...`).
const INTERPRETERS = new Set([
  "node", "deno", "bun", "tsx", "ts-node", "python", "python3", "ruby", "perl",
]);
// Inline-eval / inline-print flags: -e, -c, -p, --eval, --print (with optional =value).
const EVAL_FLAG_RE = /^-(e|c|p)$|^--(eval|print)(=|$)/i;

export function isCommandAllowed(command: string, allowlist: string[]): boolean {
  const trimmed = command.trim();
  if (!trimmed || FORBIDDEN_SHELL.test(command)) return false;
  const tokens = trimmed.split(/\s+/);
  const firstToken = tokens[0];
  const parts = firstToken.split(/[/\\]/);
  const basename = parts[parts.length - 1];
  // `uv` is never allowlisted as such: only `uv run pytest ...` passes, and only when pytest is
  // allowed. This runs before the generic check so a user allowlist containing "uv" cannot widen it.
  if (basename.replace(/\.(exe|cmd|bat)$/i, "") === "uv") {
    return allowlist.includes("pytest") && tokens[1] === "run" && tokens[2] === "pytest";
  }
  if (!allowlist.includes(basename)) return false;
  // Strip a Windows executable suffix before the interpreter check.
  const interpreterBase = basename.replace(/\.(exe|cmd|bat)$/i, "");
  if (INTERPRETERS.has(interpreterBase)) {
    for (const t of tokens.slice(1)) {
      if (EVAL_FLAG_RE.test(t)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Shape check (exported for unit testing)
// ---------------------------------------------------------------------------

export function shapeMismatch(
  schemaVal: unknown,
  targetVal: unknown,
  path = "",
): string | null {
  if (schemaVal !== null && typeof schemaVal === "object" && !Array.isArray(schemaVal)) {
    // schema is a plain object
    if (targetVal === null || typeof targetVal !== "object" || Array.isArray(targetVal)) {
      return `${path || "<root>"}: expected object`;
    }
    const schemaObj = schemaVal as Record<string, unknown>;
    const targetObj = targetVal as Record<string, unknown>;
    for (const k of Object.keys(schemaObj)) {
      if (!(k in targetObj)) return `${path}${k}: missing`;
      const nested = shapeMismatch(schemaObj[k], targetObj[k], `${path}${k}.`);
      if (nested !== null) return nested;
    }
    return null;
  } else if (Array.isArray(schemaVal)) {
    if (!Array.isArray(targetVal)) return `${path || "<root>"}: expected array`;
    return null; // presence of array suffices; elements/length not checked
  } else {
    // primitive
    if (typeof schemaVal !== typeof targetVal) {
      return `${path || "<root>"}: expected ${typeof schemaVal}, got ${typeof targetVal}`;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal runner result
// ---------------------------------------------------------------------------

interface CheckResult {
  ok: boolean;
  note?: string;
  unverifiable?: boolean;
  reason?: string;
  evidence?: string;
}

// ---------------------------------------------------------------------------
// Per-kind runners
// ---------------------------------------------------------------------------

async function runFileExists(check: Check, deps: DeterministicDeps): Promise<CheckResult> {
  try {
    if (!check.path) return { ok: false, reason: "fileExists check missing 'path'" };
    if (!deps.cwd && !isAbsolute(check.path)) return { ok: false, unverifiable: true, reason: `fileExists path cannot be resolved without a declared working directory: ${check.path}` };
    const resolved = resolveAgainst(deps.cwd, check.path);
    const ok = await deps.fs.fileExists(resolved);
    if (ok) return { ok: true, evidence: `exists: ${check.path}` };
    // An absolute check path ignores deps.cwd entirely, so claiming the file
    // was missing "in <cwd>" would name a directory the check never looked in.
    return isAbsolute(check.path)
      ? { ok: false, reason: `file not found: ${resolved}` }
      : { ok: false, reason: `file not found in ${deps.cwd}: ${check.path}` };
  } catch (err) {
    return { ok: false, reason: `fileExists check errored: ${scrubText(String(err))}` };
  }
}

async function runRun(
  check: Check,
  deps: DeterministicDeps,
  allowlist: string[],
  timeoutMs: number,
): Promise<CheckResult> {
  try {
    if (!check.command) return { ok: false, reason: "run check missing 'command'" };
    if (!isCommandAllowed(check.command, allowlist)) {
      return { ok: false, unverifiable: true, reason: `command not allowlisted: ${check.command}` };
    }
    const r: ExecResult = await deps.exec(check.command, { cwd: deps.cwd, timeoutMs });
    if (r.timedOut) {
      return { ok: false, reason: `run timed out after ${timeoutMs}ms: ${check.command}` };
    }
    const out = r.stdout + "\n" + r.stderr;
    if (check.expect !== undefined && !out.includes(check.expect)) {
      return {
        ok: false,
        reason: `expected substring not found: "${check.expect}"`,
        evidence: out.slice(0, 2000),
      };
    }
    const ok = r.code === 0;
    if (!ok) {
      return {
        ok: false,
        reason: `command exited ${r.code}: ${check.command}`,
        evidence: out.slice(0, 2000),
      };
    }
    return { ok: true, evidence: `exit 0: ${check.command}` };
  } catch (err) {
    return { ok: false, reason: `run check errored: ${scrubText(String(err))}` };
  }
}

export function resolveRepoCommand(
  check: Check,
  kind: "testsPass" | "buildPasses" | "lintClean",
  defaults: DeterministicDeps["defaults"],
): string {
  if (check.command) return check.command;
  if (kind === "testsPass") return defaults?.testCommand ?? "npm test";
  if (kind === "buildPasses") return defaults?.buildCommand ?? "npm run build";
  return defaults?.lintCommand ?? "npm run lint";
}

// ===============================================================================================
// testsPass PIPELINE: design and verdict algebra (plan Phase 2.1, task 2.1.1)
//
// Contract types: src/verify/types.ts, block "testsPass pipeline contract" (Deadline,
// ReferenceState, ScopedOutcome, RecheckOutcome, FailureClassification, TestsPassJudgement,
// ScopedExecutor, Rechecker, VerificationScope, TestsPassRequest/Run/Hook, JudgeScoped). That
// block is cherry-picked onto vrb/p22 (2.2 batch.ts) and vrb/p24 (2.4 pending.ts): later 2.1 tasks
// must NOT edit it (a different copy on both sides conflicts at merge); 2.1-internal types go
// elsewhere. Plan: docs/plans/verification-resource-budget-plan.md sections 1.2, 1.4, 1.5, 1.6.
// Record: docs/qa/verification-resource-budget/phase-2.1.md.
//
// -----------------------------------------------------------------------------------------------
// T1. GUARANTEES (plan section 1.2), as invariants of judgeScoped and the pipeline
//
//   G1 Excuse. A failing scoped run passes ("no worse than before") ONLY when all hold: the scoped
//      result is complete and has no collection error; the recheck is "exact" (reference exact,
//      unreproduced inert, rerun complete, no collection error, total > 0); and EVERY failing id
//      is failing at the reference. Anything less is unverifiable or fail, never pass.
//   G2 Reject. testsPass reports fail ONLY when at least one failing id is PROVEN introduced
//      against an "exact" recheck (T5). One proof suffices, so rejecting does not need a complete
//      scoped inventory. Every other non-pass is unverifiable, never fail.
//   G3 No false green. A scoped run passes without a recheck only when it ran, did not time out,
//      is complete, has no collection error and lists no failing id. readResult's zero-test guard
//      (runner.ts I step 2a) already turned untrustworthy zero-test runs into complete = false.
//   G4 unverifiable is a caveat: gate.ts accepts it with caveats, or rejects it under
//      strictUnverifiable, unchanged. A rejection keeps today's onFailure and escalation ladder.
//   G5 No full suite. Only testScope "full" runs the resolved command unscoped. S6 never falls
//      back to it. With no TestsPassHook in the deps, testsPass is unverifiable, never a run.
//   G6 No test command at dispatch time: dispatch captures a git reference only (captureReference).
//   G7 A deferred (unverified) delegation is never reported as verified. That is 2.4's footer.
//
// -----------------------------------------------------------------------------------------------
// T2. PIPELINE STEPS (one testsPass check of one gate or router_verify call)
//
//   step                           owner (task)                    Wave-1 function used
//   -----------------------------  ------------------------------  ------------------------------
//   S0 deadline + AbortController  index.ts both gate sites        withTimeout (timeout.ts);
//      per gate invocation         (2.1.5a); router_verify 2.4     createDeadline (2.1.2.1)
//   P0 prepare: tree snapshot,     wiring.prepareVerification      snapshotTree (tree.ts),
//      changed files, reference    (2.1.3), bounded by the deadline captureReference result
//   P1 command + allowlist         runCommandCheck (2.1.2.4)       resolveRepoCommand,
//                                                                  isCommandAllowed
//   P2 S1 scoping                  TestsPassHook (2.1.2.4; 2.2     planScopedRun (runner.ts)
//                                  swaps in the batch coordinator)
//   P3 S6 fail-closed decisions    TestsPassHook                   isUnverifiable, isNoAffected
//   P4 S3 slot, once per scope     VerificationScope (2.1.2.2)     acquireSlot (slot.ts)
//   P5 S4 caps, low priority,      ScopedExecutor (2.1.2.2)        runArgv (exec.ts); the worker
//      abort; run                                                  cap is already in spec.args
//   P6 readResult, on EVERY path   ScopedExecutor                  readResult (runner.ts)
//   P7 S2 recheck at the dispatch  Rechecker (2.1.2.3)             gcStaleReferences, materialize,
//      reference                                                   MaterializedReference.toRefPath/
//                                                                  dispose (reference.ts);
//                                                                  detectRunner, resolveEntry,
//                                                                  planRerun, readResult (runner.ts)
//   P8 verdict                     judgeScoped (baseline.ts,       -
//                                  2.1.4), then runDeterministic
//                                  and gate.ts as today
//   P9 cleanup                     VerificationScope.close         SlotHandle.release, dispose
//
//   P0  The deadline exists before prepareVerification, so the snapshot and the wait for a
//       still-pending capture are bounded by it. ReferenceState is settled when the request is
//       built: "captured" | "disabled" (failureRecheck off) | "none" (with a reason, T7 u4).
//   P1  Not allowlisted -> unverifiable "command not allowlisted: <command>" (as today).
//       testsPass does NOT run inside deps.mutex: that per-cwd lock would serialize exactly the
//       concurrent gates that 2.2 must batch. buildPasses and run keep the mutex.
//   P2  planScopedRun({ command, cwd, changedFiles, budget: { maxWorkers }, fs: PlannerFs,
//       search: TestSearchSeam, host }). changedFiles is ChangedPath[] (tree-snapshot status,
//       previousPath for renames) or "unavailable". fs and search are built in wiring.ts
//       (2.1.3, T9). testScope "full": no planning; the resolved command runs as written (P5f).
//   P3  NoAffected -> ScopedOutcome "no-affected" (pass with its note). Unverifiable ->
//       "unverifiable" (code + reason). Neither takes the slot nor spawns anything.
//   P4  scope = openScope({ cwd, command }). The first execute() calls acquireSlot({ max:
//       budget.maxConcurrentVerifications, waitMs: deadline.bound(budget.slotWaitMs), signal:
//       deadline.signal, meta, onLost }). busy -> "slot-busy" { waitedMs, deadlineCut:
//       deadline.remaining() === 0 }. Later calls on a busy scope return the same outcome at once.
//       The hold covers the scoped run AND the recheck (QA-1.4-18), and is never nested: the
//       process holds at most one scope per check, and runDeterministic awaits a check's close()
//       before the next check starts (T8).
//   P5  argv(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, lowPriority:
//       budget.lowPriority, signal: deadline.signal, timeoutMs: deadline.bound(checkTimeoutMs) }),
//       checkTimeoutMs = deps.timeoutMs ?? 120000. Specs are never run through a shell.
//       timedOut -> "timed-out" { boundMs } when deadline.signal did not abort, else "aborted"
//       { reason: "gate budget exhausted during the scoped run" }. A signal already aborted
//       before the spawn -> "aborted", with no spawn.
//   P5f testScope "full": runShell-backed exec(command, { cwd, lowPriority, signal, timeoutMs })
//       under the same scope (user text keeps shell + allowlist, section 1.5-1). Its RunResult is
//       synthesized from observeTests(execResult): source "text", failingIds = obs.failures,
//       failingFiles = the id file parts (T5 fileKeyOfId) resolved against cwd, complete =
//       obs.complete, collectionError = (code !== 0 && failures empty), total = undefined.
//   P6  readResult(spec, execResult, runnerFs) after EVERY spawn attempt: exit, timeout, abort,
//       and a spawn that threw (with { code: -1, stdout: "", stderr: <message> }), because it
//       deletes the report file (QA-1.3-16). An executor exception -> "error".
//   P7  The recheck runs only for "ran" with >= 1 failing id and >= 1 failing file (T4).
//   P8  judgeScoped(scoped, recheck) -> TestsPassJudgement, returned as the check's CheckResult.
//   P9  scope.close() waits for pending disposals, then releases the slot; never rejects. The
//       verdict path does not wait for the LAST close of a gate (void scope.close()), so a slow
//       dispose never costs a verdict; earlier checks' closes are awaited (T8).
//
// -----------------------------------------------------------------------------------------------
// T3. DEADLINE SEMANTICS (section 1.5-13)
//
//   - One Deadline per gate invocation (delegate tool AND native task) and per router_verify
//     call, created with budget.gateBudgetMs. Its signal aborts at expiry, or when the owner's
//     withTimeout(accept(...), gateBudgetMs, "verification gate") rejects (index.ts aborts the
//     controller, then returns unverifiableGateResult as today).
//   - Every step is bounded by deadline.bound(ownBudget) and receives deadline.signal:
//       test search call      bound(10_000) each (git ls-files / git grep, low priority)
//       slot wait             bound(slotWaitMs): a 60 s slot wait under a 5 s budget waits <= 5 s
//       scoped run            bound(checkTimeoutMs)
//       recheck sub-deadline  rd = deriveDeadline(deadline, recheckTimeoutMs): recheckTimeoutMs
//                             bounds GC + materialize + rerun together, never past the gate
//       GC                    rd.bound(5_000)
//       materialize           rd.bound(DEFAULT_MATERIALIZE_TIMEOUT_MS)
//       rerun                 rd.bound(recheckTimeoutMs)
//       batch wait (2.2)      bound(batchWindowMs)
//     A step whose bound is 0 is not started: the slot reports busy (deadlineCut), a spawn
//     reports aborted, a recheck reports skipped-deadline.
//   - Recheck threshold: RECHECK_MIN_REMAINING_MS = 10_000. The Rechecker checks
//     deadline.remaining() FIRST; below it -> "skipped-deadline" (u7 "gate budget exhausted
//     before recheck"), with nothing materialized or spawned.
//   - Abort kills the tree: runArgv/runShell kill the whole process tree on signal abort
//     (exec.ts, 1.2); acquireSlot returns busy on an aborted signal; materialize and GC stop at
//     their next check. dispose runs only after the rerun tree has exited.
//   - The dispatch-side capture is NOT under a gate deadline. It is bounded by
//     baselineTimeoutMs, and the dispatch awaits it for at most captureWaitMs (clamped to
//     baselineTimeoutMs; 2.4 replaces it with VERIFY_WAIT). A timeout or error there means
//     "no reference" and never blocks or fails the dispatch.
//   - Deadline is fake-timer friendly: createDeadline uses an injected clock and setTimeout, and
//     dispose() clears its timer, so no timer outlives the gate. It owns the gate's
//     AbortController (plan 2.1.5.a): the owner calls abort() when withTimeout rejects.
//
// -----------------------------------------------------------------------------------------------
// T4. RECHECK (S2), steps of the Rechecker returned by scope.rechecker(command, liveCwd)
//
//   Decided by the hook before any Rechecker call (no spawn):
//     ReferenceState "disabled" -> { kind: "disabled" }.
//     ReferenceState "none"     -> { kind: "unusable", cause: "no-reference", reason }.
//   Inside the Rechecker(reference, failingFiles, deadline), in this order:
//     a. deadline.remaining() < RECHECK_MIN_REMAINING_MS -> "skipped-deadline".
//     b. runner = detectRunner(command, liveCwd). S6 -> unusable "rerun-unplannable".
//        runner.kind "pytest" -> unusable "runner-unsupported" (reference.ts OPEN RISKS: an
//        editable install imports the LIVE tree's sources, so a pytest reference run can neither
//        excuse nor prove; running it would only spend CPU).
//     c. gcStaleReferences(reference.root, refDeps with rd.bound(5_000)) INSIDE the hold, before
//        materialize (QA-1.5-10). Its report is logged; it never fails the recheck.
//     d. materialize(reference, currentSnapshot, rd.signal, refDeps with the T3 bound) INSIDE the
//        hold. ok:false "commit-missing" -> unusable "reference-vanished"; any other ok:false ->
//        unusable "materialize-failed" (reason = its detail).
//     e. !exact -> { kind: "approximate", inexactReasons }. Dispose; no rerun (it could neither
//        excuse nor prove, section 1.5-7).
//     f. Any unreproduced entry that is not inert -> unusable "unreproduced-inputs" (QA-1.5-7).
//        Dispose; no rerun. INERT_UNREPRODUCED, matched on the entry's last segment (a dir ends
//        in "/"), case-insensitive on win32:
//          dirs   coverage/ .nyc_output/ logs/ .idea/ .vscode/ .pytest_cache/ __pycache__/
//                 .mypy_cache/ .ruff_cache/
//          files  *.log .DS_Store Thumbs.db desktop.ini .eslintcache *.pyc
//        Never inert: .env*, build output (dist/ build/ out/ .next/), generated sources, and
//        anything not listed. Additions need evidence that tests cannot read them.
//     g. For each failing file f (absolute live path): r = toRefPath(f). undefined (outside the
//        root) -> f stays unclassified. !fileExists(r) -> absentFiles. Else -> the rerun list.
//     h. Rerun list empty -> { kind: "exact", result: undefined, ranFiles: [], absentFiles }.
//     i. entry = resolveEntry(runner, liveCwd) on the LIVE tree (the reference links its
//        node_modules); spec = planRerun(runner, rerunList, toRefPath(runner.runnerCwd), budget,
//        { fs, entry, host }). S6, or NoAffected (contradicts g) -> unusable "rerun-unplannable".
//     j. Run it exactly as P5/P6 with timeoutMs = rd.bound(recheckTimeoutMs). A timeout or an
//        abort -> { kind: "timed-out", boundMs }.
//     k. After readResult: lstat(reference.dir) gone -> unusable "reference-vanished" (QA-1.5-4);
//        complete === false -> "incomplete"; collectionError -> "collection-error" (1.5-8);
//        total === 0 -> "no-tests" (QA-1.3-17). Otherwise { kind: "exact", result, ranFiles,
//        absentFiles, notes }.
//     l. dispose() once the rerun tree has exited; the scope tracks it and close() awaits it.
//   File keys (ranFiles, absentFiles) live in id space: P.relative(spec.cwd, abs) with "/"
//   separators, the construction readResult uses for ids. ranFiles use the rerun spec's cwd;
//   absentFiles use runner.runnerCwd (the live spec's cwd). A spelling mismatch can only leave
//   an id unclassified, which is unverifiable, never pass.
//
// -----------------------------------------------------------------------------------------------
// T5. VERDICT ALGEBRA: judgeScoped(scoped, recheck) (baseline.ts, 2.1.4). Pure and total.
//
//   fileKeyOfId(id) = the part before the first " > ", else before the first "::", else id.
//   C = scoped.result (kind "ran").
//   1. Planning, slot, timeout, abort and error kinds -> their row (T6); the recheck is ignored.
//   2. C.complete && !C.collectionError && C.failingIds empty -> pass (row R1).
//   3. C.failingIds empty -> unverifiable (row R4: incomplete without identities; R3 when
//      C.collectionError).
//   4. recheck undefined -> unverifiable (u11 when C.collectionError, else u9). Non-exact kinds ->
//      their column (T6).
//   5. Exact: classify each x in C.failingIds, with R = recheck.result and f = fileKeyOfId(x):
//        f in absentFiles                                   -> introduced (new test file)
//        f in ranFiles and x in R.failingIds                -> preexisting
//        f in ranFiles and C.source === "report"            -> introduced (id-level: same format)
//        f in ranFiles and no id of R has file key f        -> introduced (file-level: the file
//                                                              collected and passed at the reference)
//        otherwise                                          -> unknown
//      A bare-file id (collection error now) is never preexisting: a comparable rerun has no
//      collection error, hence no bare ids. It is introduced when its file ran or is absent.
//   6. introduced non-empty -> fail r1 (G2), naming ONLY the introduced ids.
//      else unknown empty && C.complete && !C.collectionError -> pass n2 (G1).
//      else -> unverifiable (u8 when unknown is non-empty, else u10).
//
// -----------------------------------------------------------------------------------------------
// T6. TRUTH TABLE
//
//   Cell = ok / unverifiable, then the T7 code of the reason or note.
//     P = ok:true  unverifiable:false     F = ok:false unverifiable:false (reject, escalate)
//     V = ok:false unverifiable:true (caveat; rejected only under strictUnverifiable)
//   Recheck columns:
//     --  not attempted (recheck undefined)       X+ exact, every failing id preexisting
//     X-  exact, >= 1 id introduced                X? exact, none introduced, >= 1 unknown
//     A   approximate                              U  unusable (any cause, incl. no reference)
//     D   disabled (failureRecheck off)            T  rerun timed out     S  skipped for deadline
//
//   scoped row                      --      X+      X-      X?      A      U      D      T      S
//   ------------------------------  ------  ------  ------  ------  -----  -----  -----  -----  -----
//   R0 no-affected                  P n0    not attempted: a supplied recheck is ignored -> P n0
//   R1 green                        P e1    not attempted: a supplied recheck is ignored -> P e1
//                                           (plus note n1 when total === 0)
//   R2 failures, complete           V u9    P n2    F r1    V u8    V u3   V u4   V u5   V u6   V u7
//   R2i failures, incomplete        V u9    V u10   F r1    V u8    V u3   V u4   V u5   V u6   V u7
//       inventory (complete false)
//   R3 collection error             V u11   V u10*  F r1    V u8    V u3   V u4   V u5   V u6   V u7
//   R4 incomplete, no failing id    V u12   not attempted: nothing to recheck -> V u12
//   R5 timed out / aborted          V u13   not attempted -> V u13
//   R6 slot busy                    V u14   not attempted -> V u14
//   R7 S6 unverifiable              V u15   not attempted -> V u15
//   R8 executor error               V u16   not attempted -> V u16
//
//   --: for R2/R2i/R3 the recheck is not attempted when no failing file is identified (u9; u11
//     for a collection error). A pipeline defect that skips it is caught the same way.
//   X+ in R3 (*): cannot occur for a bare-file id (T5.5). With only non-bare ids, all
//     preexisting, the collection error still leaves the inventory incomplete -> u10.
//   R2 x X+ is the only pass that has failures (G1). Every F cell rests on a proven id (G2).
//
// -----------------------------------------------------------------------------------------------
// T7. WORDING (stable; tests assert it verbatim). <ids> = at most 10 ids, then " (+<k> more)".
//     Every V and F reason of rows R2, R2i and R3 ends with "; observed failures: <ids>".
//
//   n0  the NoAffected note, verbatim (runner.ts M.2), e.g. "no changed files, no affected tests"
//   e1  evidence "testsPass: affected tests passed (<runner>, <total> tests)"
//   n1  note "testsPass: no affected tests ran"
//   n2  note "testsPass: no worse than before; pre-existing failures: <ids>; suite is NOT green
//       (affected tests checked against the exact dispatch reference)"
//   r1  reason "testsPass: introduced failures: <introduced>", plus the note "testsPass: also
//       failing at the dispatch reference: <preexisting>" when that list is non-empty
//   u3  "testsPass: cannot attribute failures: the dispatch reference is approximate
//       (<cause> <path>, ...)"
//   u4  no-reference: "testsPass: no reference: pre-existing failures cannot be told apart
//       (<ReferenceState reason>)"; other causes: "testsPass: cannot attribute failures:
//       reference unusable (<cause>): <reason>"
//       ReferenceState "none" reasons: "the dispatch-time capture failed or timed out", "an edit
//       was observed in an overlapping directory before the capture resolved", "the dispatch
//       was not tracked", "the capture had not resolved within the gate budget"
//   u5  "testsPass: cannot attribute failures: failureRecheck is off, pre-existing failures
//       cannot be told apart"
//   u6  "testsPass: cannot attribute failures: the reference rerun timed out after <n>ms"
//   u7  "testsPass: gate budget exhausted before recheck"
//   u8  "testsPass: cannot prove failures predate dispatch: <unknown>"
//   u9  "testsPass: cannot attribute failures: no failing test file identified, recheck not
//       attempted"
//   u10 "testsPass: the scoped failure inventory is incomplete (<C.note or 'collection error'>);
//       known failures predate dispatch, others may not"
//   u11 "testsPass: collection error without failing test files: <C.note>"
//   u12 "testsPass: the scoped result is incomplete: <C.note> (exit <code>)"
//   u13 "testsPass timed out after <boundMs>ms: <command>" | "testsPass: <aborted reason>"
//   u14 "verification slot busy (waited <n>ms)" | "gate budget exhausted waiting for the
//       verification slot" (deadlineCut)
//   u15 "testsPass: scoping impossible (<code>): <reason>"
//   u16 "testsPass check errored: <scrubbed reason>"
//
// -----------------------------------------------------------------------------------------------
// T8. OTHER COMMAND CHECKS UNDER S3/S4 (2.1.2.5)
//
//   buildPasses, lintClean and run each open their own scope (never nested: runDeterministic is
//   sequential and awaits each check's close() before the next check). Low priority,
//   deadline.signal, timeoutMs = deadline.bound(checkTimeoutMs). Slot busy -> unverifiable u14.
//   Their timeouts and exit codes keep today's meaning (fail). lintClean: planScopedLint ->
//   LintSpec (argv, exit code decides) | NoAffected (pass, note) | Unscoped (the resolved
//   command through the shell, as today). run: section 1.5-12, as written.
//
// -----------------------------------------------------------------------------------------------
// T9. WAVE-1 HANDOFFS (verified against docs/qa/verification-resource-budget/phase-1.*.md)
//
//   1.1  wiring.ts `baselineTimeoutMs ?? 60000` and the two testBaseline === false reads ->
//        resolveVerifyBudget(cfg).baselineTimeoutMs / .failureRecheck (2.1.3). index.ts: drop
//        the DEFAULT_GATE_BUDGET_MS import and read resolveVerifyBudget(cfg).gateBudgetMs
//        (2.1.5c). timeout.ts:37 is outside 2.1's write-set and stays. tiers.json: remove
//        `"gateBudgetMs": 90000` so the code default applies (2.1.5c).
//        warnDeprecatedVerifyKeys(cfg, logger) after every loadConfig() (2.1.5c).
//        resolveVerifyBudget clamps captureWaitMs to baselineTimeoutMs (QA-1.6-8, 2.1.5c).
//        QA-1.4-21 residual stated in the slotWaitMs JSDoc (2.1.5c).
//   1.2  QA-1.2-13: every verification spawn passes lowPriority, and specs pass spec.env
//        (2.1.2.2). Specs use runArgv; full and legacy commands use runShell (2.1.2.2/.4/.5).
//   1.3  QA-1.3-16: readResult on every path (P6). QA-1.3-17: complete false or collectionError
//        are not comparable, and a rerun with 0 tests is unusable (T4.k, T5).
//        PlannerFs: fs.promises.realpath, stat(p, { bigint: true }) mapped to FileStat, readdir,
//        and a fileExists that accepts directories (2.1.3). TestSearchSeam over the ArgvSeam:
//        `git -C <root> ls-files -z --cached --others --exclude-standard -- :(glob)**/<name>...`
//        and `git -C <root> grep -l -z -F --untracked -e <needle> -- <globs>`; grep exit 1 -> [],
//        any other failure or timeout -> undefined (2.1.3). previousPath from the porcelain rename
//        source (tree.ts, 2.1.3). planRerun(deps.entry) with the live entry (T4.i). node comes
//        from host.nodePath/PATH: never pass process.execPath (Bun 1.3.14 hosts the plugin).
//        pytest specs keep the adapter's --rootdir (no rewriting of spec.args anywhere).
//   1.4  QA-1.4-18: one hold per scope, held across the recheck, never nested (P4, T8).
//        onLost: a note "verification slot was reclaimed during the run" and a warning; the
//        verdict stands. QA-1.4-19/31: max and waitMs come from the validated budget.
//   1.5  QA-1.5-7: inert allowlist (T4.f). QA-1.5-10: GC before materialize, both inside the
//        hold (T4.c/d); gcStaleReferences at plugin start (2.1.5b). QA-1.5-4: vanished ->
//        unusable (T4.d/k). QA-1.5-25: 2.1 passes no per-call maxBuffer; a future one must be
//        Math.floor'ed. materialize failure -> unusable (T4.d).
//   1.6  QA-1.6-13: previousPath (2.1.3). QA-1.6-22: TreeSnapshot.root = realpath of
//        `git rev-parse --show-toplevel` (tree.ts, 2.1.3); 2.4 passes it as the risk root.
//        Tool-observed files never carry deletions: prepareVerification takes each path's status
//        and previousPath from the current tree snapshot when it lists the path (2.1.3). 2.4
//        parses only the orchestrator's prompt (not 2.1).
//
// -----------------------------------------------------------------------------------------------
// T10. IMPLEMENTATION TASKS (2.1.2-2.1.6; each <= ~20 tool calls; commit + push each green)
//
//   Order: .1 -> 2.1.4 -> .2 -> .3 -> .4 -> 2.1.3a -> 2.1.3b (cut-over) -> .5 -> 2.1.5a/b/c
//   -> 2.1.6a/b/c. Tests run scoped: npx vitest run <files>.
//
//   2.1.2.1 deterministic.ts: export createDeadline(budgetMs, { now? }): Deadline & { abort(reason?:
//           string): void; dispose(): void }, deriveDeadline(parent, ownMs): Deadline,
//           RECHECK_MIN_REMAINING_MS = 10_000, INERT_UNREPRODUCED + isInertUnreproduced(entry,
//           platform), fileKeyOfId(id). Tests: test/unit/tests-pass-pipeline.test.ts (new),
//           fake timers: bound/remaining/abort/dispose, derive never exceeds the parent.
//   2.1.4   baseline.ts: export judgeScoped: JudgeScoped per T5/T6/T7. Keep observeTests;
//           compareTests stays until the cut-over deletes it. Tests: a table-driven block in
//           test/unit/baseline.test.ts with one case per T6 cell, T5 classification edge cases
//           (bare ids, text source, absent files, id-level vs file-level) and the <ids> cap.
//   2.1.2.2 deterministic.ts: export createScopeOpener(deps: { argv: ArgvSeam; exec: ExecSeam;
//           fs: RunnerFs; acquire?: typeof acquireSlot; budget: VerifyBudget; checkTimeoutMs:
//           number; host?: Partial<RunnerHost>; logger? }) returning an OpenVerificationScope
//           whose scopes also offer the 2.1-internal runShell(command, cwd, deadline) and
//           runLint(spec, deadline) (a CheckScope interface in deterministic.ts). execute per
//           P4-P6. Tests: busy, deadlineCut, abort before spawn (zero spawns), timeout (the argv
//           seam sees an aborted signal), a spawn throw still unlinks the report, onLost note,
//           lowPriority and env reach the seam, one acquire across several execute calls.
//   2.1.2.3 deterministic.ts: the Rechecker behind scope.rechecker(command, cwd), steps T4.a-l,
//           with injectable materialize/gc/detectRunner/resolveEntry/planRerun seams (defaults
//           from reference.ts/runner.ts) and dispose tracking in close(). Tests: every
//           RecheckOutcome kind and cause, GC-before-materialize order, no rerun for approximate,
//           non-inert unreproduced and pytest, the vanished dir, disposal before release.
//   2.1.2.4 deterministic.ts: export createDirectTestsPassHook(deps): TestsPassHook (P2, P3,
//           P5f, then the T4 pre-decisions and the recheck, then close). Tests: planning outcomes
//           spawn nothing, full mode runs once with the synthesized RunResult, green -> no
//           Rechecker call, failures -> exactly one.
//   2.1.3a  tree.ts: keep the rename source as previousPath; add root (realpath of
//           show-toplevel). dispatch.ts: TreeSnapshot gains root; ChangedFile gains
//           previousPath?. Additive. Tests: extend test/unit/baseline-wiring.test.ts snapshot cases.
//   2.1.3b  CUT-OVER, one commit: DeterministicDeps (types.ts, outside the 2.1.1 block) drops
//           testBaseline and gains testsPass?: TestsPassHook, openScope?, argv?, changedFiles?,
//           reference?, budget?, deadline? (a missing hook -> testsPass unverifiable, G5).
//           runCommandCheck's testsPass branch calls deps.testsPass, then judgeScoped, outside
//           the mutex. dispatch.ts: the store keeps bySession/delta/record/observeEdit/sweep,
//           replaces cache/baselines/baseline() with a per-dispatch Promise<ReferenceState> made
//           by an injected capture, and observeEdit contaminates an in-flight capture. wiring.ts:
//           beginVerification is async (capture only for a testsPass DoD with failureRecheck
//           on); prepareVerification(store, id, childID, cwd, deadline) returns { changedFiles:
//           ChangedPath[], changeBaseline, reference: ReferenceState, snapshot }; buildGateDeps
//           takes the deadline and wires the hook, the scope opener, the PlannerFs and the
//           TestSearchSeam. index.ts: only the two `.testBaseline =` lines change. Delete
//           compareTests and TestBaseline. Update baseline(-wiring).test.ts for the removed APIs.
//   2.1.2.5 deterministic.ts: buildPasses, lintClean (planScopedLint) and run through per-check
//           scopes (T8). Tests: the slot is taken once per check, never nested; lint scoping.
//   2.1.5a  index.ts: a Deadline + AbortController per gate in both sites; the native task
//           accept() gets the same withTimeout + abort + unverifiableGateResult as delegate.
//   2.1.5b  index.ts: await beginVerification for at most captureWaitMs in the task before-hook
//           and the delegate dispatch; call gcStaleReferences once at plugin start
//           (fire-and-forget, failures logged).
//   2.1.5c  config.ts: clamp captureWaitMs to baselineTimeoutMs; slotWaitMs JSDoc gets the
//           QA-1.4-21 residual. index.ts: resolveVerifyBudget for gateBudgetMs; drop the
//           DEFAULT_GATE_BUDGET_MS import; warnDeprecatedVerifyKeys after every loadConfig().
//           tiers.json: drop gateBudgetMs. Tests: the clamp, and a warning on reload.
//   2.1.6a  test/unit/baseline.test.ts: rewrite to the new model, keeping the escalation
//           assertions (a rejected verdict still climbs the ladder exactly as before).
//   2.1.6b  test/unit/baseline-wiring.test.ts: read-only dispatch (no reference, no command);
//           implementation dispatch (a reference, zero test commands); bounded capture wait (2 s
//           -> 2 s, 20 s -> 5 s and still usable); contamination; a throwing capture; retry reuses
//           the first reference; failureRecheck false (and testBaseline false): no capture, no
//           worktree ever.
//   2.1.6c  test/unit/tests-pass-pipeline.test.ts: the plan's deadline cases (5 s budget cuts a
//           60 s slot wait; 8 s left skips the recheck; no step outlives the deadline, by seam
//           timestamps), the native task budget, the gate abort killing the tree, full mode, and
//           the acceptance greps (no dispatch-time run; every spawned argv is scoped).
//
// -----------------------------------------------------------------------------------------------
// T11. RESIDUAL RISKS (accepted; QA may challenge)
//
//   - Flaky tests: failing now and passing at the reference reads as introduced (as with 1.14).
//   - Id identity only: a test failing at the reference and failing now for a new cause is
//     preexisting. The note says the suite is not green.
//   - A native `task` re-dispatch after a rejection captures a new reference that contains the
//     failed attempt's changes. The router cannot link it to the earlier dispatch (the delegate
//     ladder can, and keeps its first reference). The n2 note still names the failures and says
//     the suite is not green. Candidate mitigation: 2.4's registry, which knows the orchestrator.
//   - A vitest `related` run aborted by a syntax error writes no report: no file identity, so
//     the result is unverifiable (u11), not a rejection.
//   - Concurrent agents editing the same files: attribution is per session (ADR 0002 D3); a
//     reference cannot separate two producers' changes to one file.
// ===============================================================================================

export { fileKeyOfId } from "./baseline";

/** T3: below this many milliseconds left, the Rechecker skips (u7) without materializing or spawning. */
export const RECHECK_MIN_REMAINING_MS = 10_000;

/** A Deadline plus its owner's controls (T3, plan 2.1.5.a). */
export interface OwnedDeadline extends Deadline {
  /** Aborts `signal` now (the owner's withTimeout rejected). Idempotent. */
  abort(reason?: string): void;
  /** Clears the expiry timer; no timer outlives the gate. Idempotent. */
  dispose(): void;
}

export interface DeadlineOptions {
  /** Injected clock in ms; default Date.now. */
  now?: () => number;
}

/** setTimeout clamps delays above this to 1 ms, so longer waits are chained. */
const MAX_TIMER_MS = 2_147_483_647;

function clampMs(ms: number): number {
  return Number.isNaN(ms) ? 0 : Math.max(0, ms);
}

function makeDeadline(
  budgetMs: number,
  now: () => number,
  parent: Deadline | undefined,
  defaultReason: string,
): OwnedDeadline {
  const budget = clampMs(budgetMs);
  const endsAt = now() + budget;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ownLeft = (): number => Math.max(0, endsAt - now());
  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const onParentAbort = (): void => abort("parent deadline aborted");
  const abort = (reason?: string): void => {
    clear();
    parent?.signal.removeEventListener("abort", onParentAbort);
    if (!controller.signal.aborted) controller.abort(new Error(reason ?? defaultReason));
  };
  const schedule = (): void => {
    const left = ownLeft();
    if (left === Infinity) return;
    if (left <= 0) {
      abort(defaultReason);
      return;
    }
    timer = setTimeout(schedule, Math.min(left, MAX_TIMER_MS));
    timer.unref?.();
  };
  const remaining = (): number => {
    if (controller.signal.aborted) return 0;
    return parent ? Math.min(ownLeft(), parent.remaining()) : ownLeft();
  };
  if (parent?.signal.aborted) {
    abort("parent deadline aborted");
  } else {
    parent?.signal.addEventListener("abort", onParentAbort, { once: true });
    schedule();
  }
  return {
    budgetMs: budget,
    remaining,
    bound: (ownBudgetMs: number): number => Math.min(clampMs(ownBudgetMs), remaining()),
    signal: controller.signal,
    abort,
    dispose: (): void => {
      clear();
      parent?.signal.removeEventListener("abort", onParentAbort);
    },
  };
}

/**
 * One deadline per gate invocation or router_verify call (T3). Its signal aborts at expiry (the
 * timer is unref'd) or on abort(); dispose() clears the timer.
 */
export function createDeadline(budgetMs: number, opts: DeadlineOptions = {}): OwnedDeadline {
  return makeDeadline(budgetMs, opts.now ?? Date.now, undefined, "gate budget exhausted");
}

/**
 * A sub-deadline of `ownMs` that never outlives `parent` (T3 recheck sub-deadline): remaining() is
 * min(own, parent), and its signal aborts at its own expiry or when the parent aborts.
 */
export function deriveDeadline(parent: Deadline, ownMs: number, opts: DeadlineOptions = {}): OwnedDeadline {
  return makeDeadline(Math.min(clampMs(ownMs), parent.remaining()), opts.now ?? Date.now, parent, "recheck budget exhausted");
}

/**
 * T4.f: `unreproduced` entries tests cannot read. Matched on the entry's last segment (a directory
 * ends in "/"), case-insensitive on win32. Additions need evidence that tests cannot read them.
 */
export const INERT_UNREPRODUCED: readonly string[] = [
  "coverage/", ".nyc_output/", "logs/", ".idea/", ".vscode/", ".pytest_cache/", "__pycache__/",
  ".mypy_cache/", ".ruff_cache/",
  "*.log", ".DS_Store", "Thumbs.db", "desktop.ini", ".eslintcache", "*.pyc",
];

export function isInertUnreproduced(entry: string, platform: string): boolean {
  const normalized = entry.replace(/\\/g, "/");
  const isDir = normalized.endsWith("/");
  const segments = normalized.split("/").filter(s => s !== "");
  const last = segments[segments.length - 1];
  if (last === undefined) return false;
  const fold = (s: string): string => (platform === "win32" ? s.toLowerCase() : s);
  const name = fold(last);
  for (const raw of INERT_UNREPRODUCED) {
    const pattern = fold(raw);
    if (pattern.endsWith("/")) {
      if (isDir && `${name}/` === pattern) return true;
    } else if (!isDir) {
      if (pattern.startsWith("*.")) {
        const ext = pattern.slice(1);
        if (name.length > ext.length && name.endsWith(ext)) return true;
      } else if (name === pattern) {
        return true;
      }
    }
  }
  return false;
}

// -----------------------------------------------------------------------------------------------
// Verification scopes (2.1.2.2): S3 slot, S4 caps, run and readResult (T2 P4-P6, P9)
// -----------------------------------------------------------------------------------------------

/** T7 u13 / P5: the stable abort phrases. */
export const ABORTED_BEFORE_RUN = "gate budget exhausted before the scoped run";
export const ABORTED_DURING_RUN = "gate budget exhausted during the scoped run";
/** T9 1.4: the note on an outcome whose slot was reclaimed while it ran. */
export const SLOT_LOST_NOTE = "verification slot was reclaimed during the run";

/** What a non-spec command (buildPasses, run, lint, testScope "full") produced under a scope. */
export type CommandOutcome =
  | Extract<ScopedOutcome, { kind: "slot-busy" | "aborted" | "error" }>
  | { readonly kind: "ran"; readonly exec: ExecResult; readonly notes: readonly string[] }
  | { readonly kind: "timed-out"; readonly boundMs: number; readonly exec: ExecResult };

/** A VerificationScope plus the 2.1-internal non-spec runs (P5f, T8), all under the same hold. */
export interface CheckScope extends VerificationScope {
  /** The resolved command through the shell seam (user text keeps shell + allowlist). Never rejects. */
  runShell(command: string, cwd: string, deadline: Deadline): Promise<CommandOutcome>;
  /** A scoped eslint spec through the argv seam. Never rejects. */
  runLint(spec: LintSpec, deadline: Deadline): Promise<CommandOutcome>;
}

export type OpenCheckScope = (meta: Parameters<OpenVerificationScope>[0]) => CheckScope;

export interface ScopeOpenerDeps {
  argv: ArgvSeam;
  exec: ExecSeam;
  fs: RunnerFs;
  acquire?: typeof acquireSlot;
  budget: VerifyBudget;
  /** deps.timeoutMs ?? 120000 (P5). */
  checkTimeoutMs: number;
  host?: Partial<RunnerHost>;
  logger?: Pick<PluginLogger, "warn">;
  /** Clock for slot-busy waitedMs; default Date.now. */
  now?: () => number;
}

type Blocked = Extract<ScopedOutcome, { kind: "slot-busy" | "aborted" | "error" }>;
type Hold = { readonly ok: true; readonly handle: SlotHandle } | { readonly ok: false; readonly outcome: Blocked };
interface Spawned {
  readonly kind: "spawned";
  readonly exec: ExecResult;
  /** Set when the seam threw; exec is then the synthesized { code: -1, stderr: <message> }. */
  readonly threw?: string;
  readonly boundMs: number;
  /** The deadline's signal had aborted by the time the run ended. */
  readonly cut: boolean;
  readonly notes: readonly string[];
}

function errorText(err: unknown): string {
  return scrubText(err instanceof Error ? err.message : String(err));
}

function toCommandOutcome(a: Blocked | Spawned): CommandOutcome {
  if (a.kind !== "spawned") return a;
  if (a.threw !== undefined) return { kind: "error", reason: `command failed to start: ${a.threw}` };
  if (a.exec.timedOut) {
    return a.cut ? { kind: "aborted", reason: "gate budget exhausted during the run" } : { kind: "timed-out", boundMs: a.boundMs, exec: a.exec };
  }
  return { kind: "ran", exec: a.exec, notes: a.notes };
}

/**
 * P4-P6, P9: each opened scope takes at most one slot hold (lazily, on its first run; never nested,
 * QA-1.4-18), runs every process at low priority under the deadline, calls readResult after every
 * spec spawn attempt (QA-1.3-16) and releases the hold on close(). Nothing here rejects.
 */
export function createScopeOpener(deps: ScopeOpenerDeps): OpenCheckScope {
  const { argv, exec, fs, budget, checkTimeoutMs, host, logger } = deps;
  const acquire = deps.acquire ?? acquireSlot;
  const now = deps.now ?? Date.now;

  return (meta): CheckScope => {
    let holdP: Promise<Hold> | undefined;
    let lost = false;
    let closed = false;
    let closing: Promise<void> | undefined;
    const inflight = new Set<Promise<unknown>>();

    const onLost = (): void => {
      lost = true;
      logger?.warn(`${SLOT_LOST_NOTE}: ${scrubText(meta.command)}`);
    };

    const acquireHold = async (deadline: Deadline): Promise<Hold> => {
      if (deadline.signal.aborted || deadline.remaining() === 0) {
        return { ok: false, outcome: { kind: "slot-busy", waitedMs: 0, deadlineCut: true } };
      }
      const started = now();
      try {
        const r = await acquire({
          max: budget.maxConcurrentVerifications,
          waitMs: deadline.bound(budget.slotWaitMs),
          signal: deadline.signal,
          meta: { cwd: meta.cwd, command: meta.command },
          onLost,
        });
        if ("busy" in r) {
          return {
            ok: false,
            outcome: { kind: "slot-busy", waitedMs: Math.max(0, now() - started), deadlineCut: deadline.remaining() === 0 },
          };
        }
        return { ok: true, handle: r };
      } catch (err) {
        return { ok: false, outcome: { kind: "error", reason: `verification slot failed: ${errorText(err)}` } };
      }
    };

    const attempt = async (deadline: Deadline, launch: (opts: ExecOptions) => Promise<ExecResult>): Promise<Blocked | Spawned> => {
      if (closed) return { kind: "error", reason: "verification scope already closed" };
      holdP ??= acquireHold(deadline);
      const hold = await holdP;
      if (!hold.ok) return hold.outcome;
      const boundMs = deadline.bound(checkTimeoutMs);
      if (deadline.signal.aborted || boundMs <= 0) return { kind: "aborted", reason: ABORTED_BEFORE_RUN };

      // A per-run signal linked to the deadline: aborting it after a timeout or a failed spawn
      // makes the seam kill whatever tree is left (T3).
      const run = new AbortController();
      const onAbort = (): void => run.abort(deadline.signal.reason);
      deadline.signal.addEventListener("abort", onAbort, { once: true });
      let execResult: ExecResult;
      let threw: string | undefined;
      try {
        execResult = await launch({ lowPriority: budget.lowPriority, signal: run.signal, timeoutMs: boundMs });
      } catch (err) {
        threw = errorText(err);
        execResult = { code: -1, stdout: "", stderr: threw };
      }
      deadline.signal.removeEventListener("abort", onAbort);
      if (threw !== undefined || execResult.timedOut === true) {
        run.abort(new Error(threw ?? `run exceeded its ${boundMs}ms bound`));
      }
      return {
        kind: "spawned",
        exec: execResult,
        ...(threw !== undefined ? { threw } : {}),
        boundMs,
        cut: deadline.signal.aborted,
        notes: lost || hold.handle.lost ? [SLOT_LOST_NOTE] : [],
      };
    };

    const track = <T>(p: Promise<T>): Promise<T> => {
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
      return p;
    };

    const runSpec = async (spec: Parameters<ScopedExecutor>[0], deadline: Deadline): Promise<ScopedOutcome> => {
      try {
        const a = await attempt(deadline, opts => argv(spec.file, spec.args, { ...opts, cwd: spec.cwd, env: { ...spec.env } }));
        if (a.kind !== "spawned") return a;
        let result: RunResult;
        try {
          // P6: on EVERY path after a spawn attempt; it deletes the report file (QA-1.3-16).
          result = await readResult(spec, a.exec, fs, host);
        } catch (err) {
          return { kind: "error", reason: `reading the scoped result failed: ${errorText(err)}` };
        }
        if (a.threw !== undefined) return { kind: "error", reason: `scoped run failed to start: ${a.threw}` };
        if (a.exec.timedOut) {
          return a.cut ? { kind: "aborted", reason: ABORTED_DURING_RUN } : { kind: "timed-out", boundMs: a.boundMs, result };
        }
        const notes = [...spec.notes, ...a.notes, ...(result.note !== undefined ? [result.note] : [])];
        return { kind: "ran", result, exitCode: a.exec.code, spec, notes };
      } catch (err) {
        return { kind: "error", reason: `scoped run errored: ${errorText(err)}` };
      }
    };

    const runCommand = async (deadline: Deadline, launch: (opts: ExecOptions) => Promise<ExecResult>): Promise<CommandOutcome> => {
      try {
        return toCommandOutcome(await attempt(deadline, launch));
      } catch (err) {
        return { kind: "error", reason: `command errored: ${errorText(err)}` };
      }
    };

    // 2.1.2.3 replaces this with the T4 Rechecker; until then a recheck is never usable (fail-closed).
    const rechecker = (): Rechecker => async () => ({
      kind: "unusable",
      cause: "error",
      reason: "the reference recheck is not available",
    });

    const close = (): Promise<void> => {
      closing ??= (async (): Promise<void> => {
        closed = true;
        await Promise.allSettled([...inflight]);
        if (holdP === undefined) return;
        const hold = await holdP;
        if (!hold.ok) return;
        try {
          await hold.handle.release();
        } catch (err) {
          logger?.warn(`verification slot release failed: ${errorText(err)}`);
        }
      })();
      return closing;
    };

    return {
      execute: (spec, deadline) => track(runSpec(spec, deadline)),
      rechecker,
      runShell: (command, cwd, deadline) => track(runCommand(deadline, opts => exec(command, { ...opts, cwd }))),
      runLint: (spec, deadline) =>
        track(runCommand(deadline, opts => argv(spec.file, spec.args, { ...opts, cwd: spec.cwd, env: { ...spec.env } }))),
      close,
    };
  };
}

async function runCommandCheck(
  check: Check,
  kind: "testsPass" | "buildPasses" | "lintClean",
  deps: DeterministicDeps,
  allowlist: string[],
  timeoutMs: number,
): Promise<CheckResult> {
  let command = resolveRepoCommand(check, kind, deps.defaults);
  if (kind === "buildPasses" && !check.command && !deps.defaults?.buildCommand) {
    try {
      const packagePath = resolveAgainst(deps.cwd, "package.json");
      let hasBuild = false;
      if (await deps.fs.fileExists(packagePath)) {
        const pkg: unknown = JSON.parse(await deps.fs.readFile(packagePath));
        if (pkg && typeof pkg === "object" && "scripts" in pkg) {
          const scripts = pkg.scripts;
          hasBuild = !!(scripts && typeof scripts === "object" && "build" in scripts && typeof scripts.build === "string" && scripts.build.trim());
        }
      }
      if (hasBuild) command = "npm run build";
      else if (await deps.fs.fileExists(resolveAgainst(deps.cwd, "tsconfig.json"))) command = "npx tsc --noEmit";
      else return { ok: false, unverifiable: true, reason: "buildPasses: no build script or root tsconfig.json" };
    } catch (err) {
      return { ok: false, unverifiable: true, reason: `buildPasses probe failed: ${scrubText(String(err))}` };
    }
  }

  const fn = async (): Promise<CheckResult> => {
    try {
      if (!isCommandAllowed(command, allowlist)) {
        return { ok: false, unverifiable: true, reason: `command not allowlisted: ${command}` };
      }
      const baseline = kind === "testsPass" ? await deps.testBaseline?.(command) : undefined;
      const r: ExecResult = await deps.exec(command, { cwd: deps.cwd, timeoutMs });
      if (r.timedOut) {
        if (kind === "testsPass") {
          const observed = compareTests(observeTests(r));
          return { ...observed, reason: `${kind} timed out after ${timeoutMs}ms: ${command}; ${observed.reason}` };
        }
        return { ok: false, reason: `${kind} timed out after ${timeoutMs}ms: ${command}` };
      }
      if (kind === "testsPass") return compareTests(observeTests(r), baseline);
      const out = r.stdout + "\n" + r.stderr;
      const ok = r.code === 0;
      if (!ok) {
        return {
          ok: false,
          reason: `command exited ${r.code}: ${command}`,
          evidence: out.slice(0, 2000),
        };
      }
      return { ok: true, evidence: `exit 0: ${command}` };
    } catch (err) {
      return { ok: false, ...(kind === "testsPass" ? { unverifiable: true } : {}), reason: `${kind} check errored: ${scrubText(String(err))}` };
    }
  };

  if (deps.mutex) {
    return deps.mutex.runExclusive(deps.cwd, fn);
  }
  return fn();
}

async function runSchemaMatch(check: Check, deps: DeterministicDeps): Promise<CheckResult> {
  try {
    if (!check.path || !check.schema) {
      return { ok: false, reason: "schemaMatch requires 'path' and 'schema'" };
    }
    if (!deps.cwd && (!isAbsolute(check.path) || (!check.schema.trim().startsWith("{") && !isAbsolute(check.schema)))) {
      return { ok: false, unverifiable: true, reason: "schemaMatch path cannot be resolved without a declared working directory" };
    }

    const targetRaw = await deps.fs.readFile(resolveAgainst(deps.cwd, check.path));
    let targetVal: unknown;
    try {
      targetVal = JSON.parse(targetRaw);
    } catch {
      return { ok: false, reason: `target is not valid JSON: ${check.path}` };
    }

    let schemaVal: unknown;
    if (check.schema.trim().startsWith("{")) {
      try {
        schemaVal = JSON.parse(check.schema);
      } catch {
        return { ok: false, reason: "schema is not valid JSON" };
      }
    } else {
      const schemaRaw = await deps.fs.readFile(resolveAgainst(deps.cwd, check.schema));
      try {
        schemaVal = JSON.parse(schemaRaw);
      } catch {
        return { ok: false, reason: "schema is not valid JSON" };
      }
    }

    const mismatch = shapeMismatch(schemaVal, targetVal);
    if (mismatch !== null) {
      return { ok: false, reason: `schema mismatch at ${mismatch}`, evidence: mismatch };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `schemaMatch check errored: ${scrubText(String(err))}` };
  }
}

// ---------------------------------------------------------------------------
// runDeterministic
// ---------------------------------------------------------------------------

export async function runDeterministic(dod: DoD, deps: DeterministicDeps): Promise<Verdict> {
  const checks = dod.checks ?? [];

  if (checks.length === 0) {
    return {
      pass: false,
      method: "none",
      skipped: true,
      reasons: ["no deterministic checks to run"],
    };
  }

  const timeoutMs = deps.timeoutMs ?? 120000;
  const allowlist = deps.allowlist ?? DEFAULT_ALLOWLIST;
  const results: CheckResult[] = [];

  // Sequential for deterministic mutex semantics and stable evidence order.
  for (const check of checks) {
    let result: CheckResult;

    switch (check.kind) {
      case "fileExists":
        result = await runFileExists(check, deps);
        break;
      case "run":
        result = await runRun(check, deps, allowlist, timeoutMs);
        break;
      case "testsPass":
      case "buildPasses":
      case "lintClean":
        result = await runCommandCheck(check, check.kind, deps, allowlist, timeoutMs);
        break;
      case "schemaMatch":
        result = await runSchemaMatch(check, deps);
        break;
      default: {
        // Defensive: TypeScript proves this is unreachable; guards runtime extensions.
        const exhaustive: never = check.kind;
        result = { ok: false, reason: `unknown check kind: ${exhaustive}` };
        break;
      }
    }

    results.push(result);
    if (!result.ok && !result.unverifiable) {
      deps.onFailure?.(scrubText(result.reason ?? "check failed"));
    }
  }

  const allPass = results.every(r => r.ok);
  const failed = results.some(r => !r.ok && !r.unverifiable);
  const caveats = results.filter(r => r.unverifiable).map(r => scrubText(r.reason ?? "check unavailable"));
  const notes = results.flatMap(r => r.note ? [scrubText(r.note)] : []);

  const reasons: string[] = allPass
    ? [`all ${checks.length} deterministic checks passed`]
    : results
        .filter(r => !r.ok)
        .map(r => scrubText(r.reason ?? "check failed"));

  const evidenceParts = results.map(r => r.evidence ?? "").filter(e => e.length > 0);
  const rawEvidence = evidenceParts.length > 0 ? evidenceParts.join("\n---\n") : undefined;
  const evidence = rawEvidence !== undefined ? scrubText(rawEvidence) : undefined;

  return {
    pass: allPass,
    outcome: failed ? "fail" : allPass ? "pass" : "unverifiable",
    ...(caveats.length ? { caveats } : {}),
    ...(notes.length ? { notes } : {}),
    method: "deterministic",
    reasons,
    ...(evidence !== undefined ? { evidence } : {}),
  };
}
