// src/verify/batch.ts
// S5 batching coordinator (plan Phase 2.2). The header below is the design of task 2.2.1; the
// pure helpers (2.2.2.b) and createBatchCoordinator (2.2.2.c, 2.2.2.d) implement it.
//
// ===============================================================================================
// BATCHING COORDINATOR: design (plan Phase 2.2, task 2.2.1)
//
// Consumes only the 2.1.1 contract in src/verify/types.ts, block "testsPass pipeline contract"
// (cherry-picked from vrb/p21 as 5be8c85 and never edited here): Deadline, ScopedOutcome,
// RecheckOutcome, VerificationScope, OpenVerificationScope, TestsPassRequest, TestsPassRun,
// TestsPassHook. Runner facts come from src/verify/runner.ts sections G, H, I (step 2a), J and
// Q 2.2. The pipeline and the verdict algebra are specified in the "testsPass PIPELINE" header of
// src/verify/deterministic.ts (vrb/p21, 7cd793d), cited below as 2.1-T<n>. Plan: section 1.3 (S5),
// 1.4 (batchWindowMs), 1.5-13 (deadline), 1.5-18/19 (router_verify and background mode reuse this
// coordinator), Phase 2.2. Record: docs/qa/verification-resource-budget/phase-2.2.md.
//
// -----------------------------------------------------------------------------------------------
// B1. GOAL AND GUARANTEES
//
//   Concurrent testsPass checks that would run the same program with the same options become one
//   scoped run over the union of their changed files. Each requester still gets the TestsPassRun
//   it would have got running alone. hook(runtime) returns exactly a TestsPassHook, so 2.2.3 swaps
//   the coordinator in behind 2.1's direct hook with no signature change. router_verify (2.4.3)
//   and background mode (2.4.5) reach it through the same hook.
//
//   B-G1 Equivalence. Under a deterministic runner, with no deadline expiry and no slot
//        contention, each request's TestsPassRun judges (2.1-T5) to the same ok, the same
//        unverifiable and the same introduced/preexisting/unknown sets as the direct hook gives
//        that request alone (B12).
//   B-G2 Only toward caution. When the runner is not deterministic (flaky tests), the batch may
//        turn a would-be pass into unverifiable. It never turns anything into a pass (B7.5).
//   B-G3 One slot hold per batch (QA-1.4-18). Each batch opens one VerificationScope, once, and
//        holds it across the union run, the attribution runs and every recheck. Scopes are never
//        nested.
//   B-G4 A requester's own deadline bounds every step it waits for. One requester's expiry or
//        abort never cancels the batch for the others. When every requester is gone, the running
//        tree is killed.
//   B-G5 The hook never rejects (TestsPassHook contract). Any internal failure becomes a
//        ScopedOutcome "error" for the requests it affects (fail-closed, 2.1-T6 R8).
//   B-G6 State is bounded. No timer outlives its window, and nothing outlives dispose().
//
// -----------------------------------------------------------------------------------------------
// B2. BYPASSES (no window, no union), checked in this order on arrival
//
//   1. The coordinator is disposed -> { scoped: aborted BATCH_REASONS.disposed }.
//   2. request.testScope === "full" -> runtime.direct(request). The resolved command runs as
//      written (2.1-T2 P5f). It cannot be merged, and S6 forbids widening a scoped run into it.
//   3. runtime.batchWindowMs <= 0 -> runtime.direct(request). "batchWindowMs: 0 disables
//      batching": every request runs alone, still scoped.
//   4. request.deadline.signal is already aborted -> aborted BATCH_REASONS.beforeRun. Nothing is
//      planned or spawned.
//   5. plan = runtime.plan(request, request.deadline), that is, planScopedRun (B6). Then:
//        NoAffected    -> { scoped: { kind: "no-affected", note }, recheck: undefined }
//        Unverifiable  -> { scoped: { kind: "unverifiable", code, reason }, recheck: undefined }
//                         (S6; changedFiles "unavailable" lands here as attribution-unavailable)
//        rejection     -> { scoped: { kind: "error", reason }, recheck: undefined }
//      These are exactly 2.1-T2 P3: none of them takes the slot or waits for a window.
//   6. ScopedSpec -> the request joins the window of batchKey(spec) (B3, B4).
//
// -----------------------------------------------------------------------------------------------
// B3. BATCH KEY
//
//   batchKey(spec) = JSON of [gitRoot, runner, entry, file, cwd, envSignature(spec.env),
//   argvTemplate(spec)], with every path folded to lower case on win32.
//     - gitRoot, runner, entry and envSignature (key-sorted JSON of spec.env) are the plan's key
//       (runner.ts Q 2.2).
//     - Three fields are added (deviation D1): file (node, or the native pytest/uv), cwd (the
//       runnerCwd, which is also the id key space, runner.ts I) and argvTemplate. Two commands
//       that resolve to the same entry can still differ in their kept arguments (-t, --project,
//       -k, -m), in the worker cap, or in pytest's pinned -c/--rootdir (runner.ts D.4). A union
//       run with one request's options would not be the run the other request gets alone (B-G1).
//     - argvTemplate(spec) = spec.args with every element equal to one of spec.inputs removed,
//       and every occurrence of spec.reportPath replaced by "<report>". Inputs are absolute and
//       canonical (runner.ts N.2), so they never collide with an option token.
//   Requests with equal keys run the same program, in the same directory, with the same options
//   and environment. Only their inputs differ.
//
// -----------------------------------------------------------------------------------------------
// B4. WINDOWS
//
//   W1 A window opens when the first request for a key finishes planning with a ScopedSpec. Its
//      close time is fixed at that moment: openedAt + batchWindowMs, using the opener's runtime
//      value. A config reload does not stretch a window that is already open. Each window has
//      exactly one timer.
//   W2 The window closes at that time, or at once when it holds maxBatchSize requests
//      (BATCH_MAX_REQUESTS = 8 by default), whichever comes first. The close time never moves:
//      arrivals do not push it back (no debounce). So a steady stream cannot keep a window open,
//      and no request waits in a window for longer than batchWindowMs (2.1-T3's bound for the
//      batch wait). This is the starvation bound.
//   W3 A joining request whose deadline.remaining() does not exceed the time left until the
//      close closes the window at once. Waiting would only turn it into an abort.
//   W4 At close, the window is removed from the key map before anything asynchronous happens. A
//      request for the same key that finishes planning later opens the NEXT window. "Later"
//      covers the whole life of the batch: planning its union, waiting for the slot, running,
//      rechecking. A running union is never extended; its inputs are fixed at close.
//   W5 A request whose deadline aborts while it waits in a window is settled at once with
//      aborted BATCH_REASONS.window, and removed. A window left empty clears its timer and is
//      deleted.
//   W6 Batches for different keys (roots, runners, templates) are independent. Each opens its
//      own scope and competes for the machine-wide slot like any other verification, so they run
//      in parallel only as far as maxConcurrentVerifications allows. Two batches for the SAME
//      key (window N running, window N+1 closed) are just as independent, and serialize on the
//      slot when there is only one.
//
// -----------------------------------------------------------------------------------------------
// B5. BATCH RUN SEQUENCE
//
//   At close, with members M (in arrival order) and the batch deadline D (B9):
//   1. |M| = 1: skip step 2. Step 4 runs the member's own spec with the member's own deadline.
//      Steps 5 and 7 have nothing to do, and step 8 is a single-member recheck. This is exactly
//      the direct path.
//   2. Union planning (B6), bounded by D: runtime.plan({ command and cwd of the first member,
//      changedFiles: unionChangedFiles(M) }, D). The batch splits (step 6) in three cases: the
//      result is not a ScopedSpec; batchKey(unionSpec) differs from the batch key; or its inputs
//      are not exactly the union of the members' inputs (set equality on platform keys).
//   3. scope = runtime.openScope({ cwd, command }) of the first member. It is opened once, and
//      every execute and rechecker below goes through it (B10).
//   4. U = scope.execute(unionSpec, D). By kind:
//        slot-busy        -> every member gets U. (The scope would report it again without
//                            waiting anyway.)
//        aborted          -> D aborted, so every member was already settled (B9).
//        ran              -> attribution per member (B7).
//        timed-out, error -> every member is "own-run".
//   5. Own runs: the members marked "own-run", earliest deadline first, one after the other:
//      scope.execute(memberSpec, member.deadline). The outcome is the member's scoped outcome,
//      verbatim. A member settled in the meantime (an abort) is skipped, and nothing is spawned
//      for it.
//   6. Split: every member is "own-run" (step 5), and there is no union run. The cost is the
//      same as without batching, and the verdicts are the same by construction. The split is
//      logged once per batch.
//   7. Flaky taint (B7.5), once every run of steps 4 and 5 has returned.
//   8. Rechecks (B8), for the members whose scoped outcome is "ran" with >= 1 failing id and >= 1
//      failing file (2.1-T2 P7). A member that needs no recheck settles as soon as step 7 is
//      done. A green member of a green union therefore settles right after step 4.
//   9. Every remaining member settles. Then `void scope.close()`: a requester never waits for
//      the close (2.1-T2 P9). The batch leaves the registry.
//
// -----------------------------------------------------------------------------------------------
// B6. UNION SPEC AND DEDUPLICATION
//
//   unionChangedFiles(M) takes each member's ChangedPath entries and resolves path and
//   previousPath against THAT member's request.cwd. ChangedPath paths may be relative to the
//   planner's cwd, and members with the same runnerCwd can have different check cwds. Entries
//   are deduplicated by the platform key of (path, previousPath), in first-seen order, keeping
//   the first entry's status (it is informational: runner.ts G.6 decides existence through the
//   fs). A file edited by two producers appears once.
//   The union is planned by planScopedRun itself (runner.ts Q 2.2), never assembled by hand. That
//   keeps argv construction, the argv-length cap, config triggers and pytest pinning in one
//   place. The step-2 consistency checks catch every way the union plan can differ from the
//   members' plans:
//     - a union-only S6: argv-too-long, too-many-searches, config-too-large;
//     - a pytest pin computed from a different common ancestor;
//     - a search that answered differently;
//     - a file that changed between the plans.
//   Each of these falls back to the split, never to a different run.
//   Cost: union planning repeats the members' test searches (git only, low priority, bounded by
//   D). Merging the members' plans instead would need a new runner.ts entry point (rejected, see
//   phase-2.2.md).
//
// -----------------------------------------------------------------------------------------------
// B7. ATTRIBUTION
//
//   Mode B (runner.ts J, Spike C). vitest has no non-executing related listing, and a jest-only
//   listing (mode A) was rejected. pytest needs no process at all: its spec inputs ARE the test
//   files (inputsAreTests), so a failing file belongs to the members whose inputs contain it.
//   attributeUnion(U.result, counts, memberSpec) decides for each member between "derived" (a
//   RunResult computed from the union's) and "own-run" (the member's own planScopedRun spec runs,
//   B5.5).
//   Keys: fileKeyOf(spec.cwd, abs) is the id-space file key (cwd-relative, "/" separators), the
//   construction readResult uses. idFileKey(id) is 2.1-T5's fileKeyOfId (the part before " > ",
//   else before "::", else the whole id). It stays a private copy here until 2.2.3 can import
//   2.1's.
//
//   7.1 Not comparable: !U.complete, U.collectionError, or U.source !== "report" -> own-run
//       (cause "not-comparable"). A vitest syntax error in any test file aborts `related` without
//       a report, which gives a text source and a collection error. Each member's own run then
//       shows whether that member hits the error alone.
//   7.2 Green union (complete, no collection error, no failing id):
//       a. A member that is not guard-sensitive -> derived green: no ids, complete, total =
//          U.total, exit 0. isGuardSensitive is false when the spec has no lexicalPaths, is not
//          inputsAreTests, and has no JS test file among its inputs (runner.ts G.8 rule). The
//          member's own related set is a subset of the union's (related is monotone in its
//          inputs, and vitest and jest run each test file in its own module scope), so its own
//          run is green too. Its own total may be 0: that is a pass with note n1 instead of
//          evidence e1, which is the same verdict.
//       b. A guard-sensitive member. Its own run would be made incomplete by readResult's
//          zero-test guard (runner.ts I 2a) if IT ran 0 tests, and the union's total cannot show
//          that. With per-file counts (counts = U.testsByFile, prerequisite P1 below):
//            inputsAreTests (pytest): n = the sum of counts over its inputs. n > 0 -> derived
//              green with total n. n = 0 -> derived incomplete with the guard's own note "<runner>
//              ran no tests although a test file was passed", which is exactly its own result.
//            JS test-file inputs (a test file given to related runs itself, runner.ts R): n = the
//              sum of counts over its test-file inputs. n > 0 -> derived green. n = 0 -> own-run
//              (cause "zero-test-ambiguous"): its source inputs may or may not have related tests.
//            lexicalPaths: as the JS rule. Keys that do not match give n = 0, hence own-run.
//          Without counts (P1 not landed, or a text source) -> own-run. This is the
//          "confirmation run".
//   7.3 Failing union (complete, no collection error, >= 1 failing id):
//       a. inputsAreTests (pytest, static attribution): ids = the U.failingIds whose file key is
//          one of the member's input keys; files = the U.failingFiles among its inputs. ids
//          non-empty -> derived, with complete, no collection error, exit 1, and total = the
//          count sum when counts exist (else U.total). ids empty -> the pytest rule of 7.2b (its
//          files all passed, or ran nothing).
//          This is only sound because the union's ids name the file that really ran each case:
//          runner.ts I step 3 maps a classname by its exact rootdir-relative path, and a classname
//          two inputs could own makes the union incomplete (7.1), never a guess (QA-2.2-1: with
//          "the first input wins", tests/test_x.py's failure landed on sub/tests/test_x.py).
//       b. vitest/jest -> own-run (cause "mode-b"). vitest cannot intersect `related` with a file
//          filter, so the member's own spec runs, covering its whole affected set. That run
//          contains exactly the failures the member would see alone.
//   7.4 So every member's final scoped outcome is one of two things. Either it is its own run's
//       outcome, verbatim. Or it is a derived "ran" outcome that judges the same: its spec is
//       the member's own spec, and its notes are the member's plan notes plus
//       "batched: 1 run for <n> requests".
//   7.5 Flaky taint (B-G2). When U had failing ids, unreproduced = U.failingIds minus every
//       member's final failingIds. If that set is non-empty, some union failure was reproduced
//       by no member's own run. Then taintUnreproduced makes EVERY member's "ran" result
//       complete = false, with the note "batched run failure not reproduced by any request's own
//       run: <ids>". Per 2.1-T6, complete = false never passes (R4 u12; R2i u10 or u8), and a
//       proven introduced id still rejects (R2i x X- = F r1). The unreproduced id could belong to
//       any member's related set, and for vitest/jest a green own run cannot rule that out.
//
//   P1. Proposed write-set addition in runner.ts (task 2.2.2.a); it enables the cheap path of
//       7.2b. RunResult gains `testsByFile?: Readonly<Record<string, number>>`: the number of
//       tests the report lists for each file key, so that the values sum to total. vitest/jest:
//       assertionResults.length of each suite. pytest: the testcases mapped to each input,
//       without the collection pseudo-cases. Only report sources fill it; the text fallback
//       leaves it undefined. The change is additive, and 2.1's judgeScoped ignores it.
//       Without P1 the coordinator is still correct, but it pays one confirmation run for each
//       guard-sensitive member of a green batch. Implementation delegations usually touch test
//       files, so that would remove most of the saving.
//
// -----------------------------------------------------------------------------------------------
// B8. SHARED RECHECK (S2)
//
//   Only members whose scoped outcome is "ran" with >= 1 failing id and >= 1 failing file take
//   part.
//   1. Pre-decisions for each member, with no spawn (2.1-T4), in 2.1's direct-hook order:
//      ReferenceState "disabled", OR the member's own gate-time runtime.failureRecheck is off ->
//      { kind: "disabled" }; "none" -> { kind: "unusable", cause: "no-reference", reason }.
//      failureRecheck is read from the runtime of the hook that submitted the member, never from
//      the window opener's (QA-2.2-2): a reference captured at dispatch while the setting was on
//      is disabled when the setting is off at the gate (a config reload, or a later
//      router_verify), as the direct hook does.
//   2. "captured" members are grouped by referenceKey(reference): root, commit, and the sorted
//      untracked, tracked and captureReasons entries (capturedAt is excluded). A recheck at one
//      reference proves nothing about another, so ONE recheck is shared per distinct reference,
//      not per batch (deviation D3). These share one reference:
//        - the members of one dispatch (an escalation retry keeps the first reference, and
//          router_verify may name several handles of one dispatch);
//        - captures of the same clean HEAD with the same untracked files.
//      Distinct stash commits never share.
//   3. Groups run one at a time under the scope, ordered by their earliest deadline. A member
//      whose deadline.remaining() is below runtime.recheckMinRemainingMs (2.1's
//      RECHECK_MIN_REMAINING_MS, injected) gets { kind: "skipped-deadline", remainingMs } and
//      leaves its group, as it would alone (2.1-T3).
//   4. A group of one member -> scope.rechecker(command, cwd)(reference, its failingFiles, its
//      own deadline). This is the direct path.
//   5. A group of several members:
//        files  = the deduplicated union of their failingFiles;
//        Rg     = a batch deadline over the group (B9);
//        shared = scope.rechecker(first member's command, cwd)(reference, files, Rg).
//      Each member's outcome is deriveSharedRecheck(shared, counts, its failingFiles,
//      its spec.cwd):
//        - approximate, disabled, timed-out, skipped-deadline, and unusable with a
//          reference-level cause (no-reference, materialize-failed, reference-vanished,
//          unreproduced-inputs, runner-unsupported, error) -> the same outcome for every member.
//        - unusable with a run-level cause (incomplete, collection-error, no-tests,
//          rerun-unplannable) -> "split". Another member's files may be the cause: a collection
//          error at the reference, or argv-too-long for the union list. Each member then gets
//          its own recheck (step 4), in deadline order.
//        - exact -> ranFiles and absentFiles are intersected with the member's file keys; the
//          result is filtered to the ids and files with those keys (still complete and without a
//          collection error, as "exact" requires); it is undefined when all of the member's files
//          are absent. Zero-test check, as in 7.2b:
//            with counts, a member whose ran files hold 0 tests at the reference gets unusable
//            "incomplete", because its own rerun would have tripped the rerun zero-test guard
//            (QA-1.3-17);
//            without counts, a member that has ran files but no failing id among them at the
//            reference -> "split".
//   6. pytest: 2.1's Rechecker returns unusable "runner-unsupported" without spawning (2.1
//      decision 5), so sharing it costs nothing.
//   Recheck calls per window: one per distinct reference among the failing members, plus any
//   split rechecks. The plan's "single shared recheck" holds when the members share a reference.
//
// -----------------------------------------------------------------------------------------------
// B9. DEADLINES AND CANCELLATION
//
//   - Each member keeps its own Deadline (request.deadline: one per gate or router_verify call,
//     1.5-13). Nothing extends it.
//   - The batch deadline D = createBatchDeadline(members):
//       remaining()  the largest remaining() among the members not yet settled (0 when none);
//       bound(x)     min(x, remaining());
//       budgetMs     the largest member budget;
//       signal       aborts once every member still attached has aborted, or at dispose.
//     A settled member is released from D, so a requester that is done never keeps the batch
//     alive with its long budget. D has no timer of its own: when the last attached member's
//     signal aborts at its expiry, D aborts too. dispose() removes every listener.
//   - Which deadline bounds what:
//       union planning and the union run       D
//       a member's own run                     that member's deadline, exactly as alone
//       a single-member recheck                that member's deadline, exactly as alone
//       a shared recheck                       Rg, D restricted to the group
//   - A member whose signal aborts is settled at once. The result depends on its phase:
//       waiting in the window                  aborted BATCH_REASONS.window
//       union planning or union run            aborted BATCH_REASONS.run (2.1-T2 P5's phrase)
//       its own run is running                 that run's outcome (the executor kills it and
//                                              reports aborted)
//       queued for its own run                 aborted BATCH_REASONS.attribution
//       waiting for its recheck                { scoped: its outcome, recheck: { kind:
//                                              "timed-out", boundMs: its remaining() when the
//                                              recheck started } }, as 2.1-T4.j reports an
//                                              aborted rerun
//     The member is then released from D, and the batch continues for the others.
//   - When all members have aborted, D aborts. The running execute or rechecker kills its tree
//     (exec.ts), and nothing more is spawned: an aborted signal never spawns. The batch then
//     finishes and closes its scope.
//   - A batch that runs longer than one requester's budget therefore costs that requester an
//     unverifiable verdict at its deadline (2.1-T6 R5 u13, or u6 during the recheck). It never
//     makes the requester wait past its deadline.
//
// -----------------------------------------------------------------------------------------------
// B10. SLOT DISCIPLINE (S3, QA-1.4-18)
//
//   Each batch has one VerificationScope: runtime.openScope of the first member, with that
//   member's cwd and command as meta. The first execute takes the hold. The union run, the own
//   runs and every recheck then run inside it, one command at a time, and close() follows the
//   last of them. The coordinator never opens a scope while it waits on another (no nesting),
//   and no requester's gate waits for a batch's close. Batches for different keys hold separate
//   slots, but only as far as maxConcurrentVerifications allows (W6). A batch never waits for
//   another batch, so batches cannot deadlock each other.
//
// -----------------------------------------------------------------------------------------------
// B11. MEMORY AND DISPOSAL
//
//   State:
//     - windows: a Map from key to window, each with <= maxBatchSize members and one timer;
//     - running batches: a Set;
//     - per member: the request, its plan and its resolver.
//   Everything is dropped when the member settles or the batch ends. Memory is O(live requests),
//   and no window outlives its timer.
//   sweep() is called by the wiring's TTL sweep (2.2.3). It evicts defensively:
//     - windows with no live member;
//     - batches whose members are all settled but whose seam never returned (a hung executor
//       that ignored its signal) for longer than BATCH_STALE_GRACE_MS.
//   It logs each eviction and returns the number of evictions.
//   dispose():
//     1. marks the coordinator disposed (later requests get B2.1);
//     2. clears every window timer;
//     3. settles every pending member with aborted BATCH_REASONS.disposed;
//     4. aborts every batch deadline, which kills the running trees;
//     5. awaits the batches' scope closes.
//   It is idempotent and never rejects. The default timers are unref'd, so an open window never
//   keeps the process alive.
//
// -----------------------------------------------------------------------------------------------
// B12. THE EQUIVALENCE PROPERTY AND ITS TEST
//
//   Statement (B-G1): for any set of requests submitted inside one window, and every member R,
//   judge(coordinator(R)) equals judge(direct(R)) on ok, on unverifiable and on the three
//   FailureClassification sets. direct(R) is the one-request path.
//   It holds under three conditions: the runner is deterministic (each file's outcome does not
//   depend on which other files run), no deadline expires, and there is no slot contention.
//   Timing outcomes (slot-busy, timed-out, aborted, skipped-deadline) are outside it, and so are
//   texts (the count in e1, notes).
//   Test (2.2.2.e, test/unit/batch.test.ts): >= 300 cases from a seeded PRNG (mulberry32, as in
//   test/unit/guards.test.ts).
//     - Fake repo: sources S and test files T; related(s) is a subset of T, and every test file
//       relates to itself. Each test file has a test count >= 0 and a failing set, both now and
//       at each reference; some files are absent at a reference. The runner is vitest-like
//       (related) or pytest-like (inputs are tests). Change sets are random and may overlap.
//       References are random too: shared or distinct, captured, none or disabled.
//     - Fake seams, each counting its calls:
//         plan: inputs = the existing changed files; S6 for a trigger file; NoAffected for none.
//         openScope: execute returns the model's RunResult, applies readResult's zero-test guard
//           and fills testsByFile; rechecker returns exact/absent/ran from the model.
//     - direct(R) is the test's own one-request path over the same seams.
//     - judge: until 2.2.3, an oracle of 2.1-T5/T6 written in the test; from 2.2.3 on, 2.1's
//       judgeScoped as well, and both must agree.
//     - Each case asserts: equal judgements; exactly one scope per batch; spawns within the
//       cost model (B13); no leaked timers after dispose (vi.getTimerCount() === 0).
//   A flaky variant adds a failure that appears only in the union run, and asserts B-G2: no
//   member judges ok.
//
// -----------------------------------------------------------------------------------------------
// B13. COST MODEL (spawns through the argv seam, per window of n members)
//
//   green union, P1 present           1 scoped run, +1 for each zero-test-ambiguous member (7.2b)
//   green union, P1 absent            1 + the number of guard-sensitive members
//   pytest, failing, report complete  1 scoped run; rechecks spawn nothing (runner-unsupported)
//   vitest/jest, failing              1 + n scoped runs (mode B), + 1 recheck per distinct
//                                     reference among the failing members
//   split (union inconsistent)        n scoped runs, as without batching
//   n = 1                             exactly the direct path
//   The plan's acceptance criterion, "<= 1 scoped run + <= 1 recheck per window", is asserted on
//   the green and pytest paths and with a shared reference. On the vitest/jest failing path the
//   test asserts 1 + n runs and one recheck per distinct reference (deviation D2).
//
// -----------------------------------------------------------------------------------------------
// B14. DEVIATIONS FROM THE PLAN
//
//   D1 The batch key adds file, cwd and the argv template (B3).
//   D2 On a failing vitest/jest union, mode B spends n attribution runs, so the plan's "<= 1
//      scoped run per window" holds on the green and static paths only. Mode B's per-request run
//      is the request's own planScopedRun spec, not "only the failing files": `related` cannot
//      be intersected with a file filter (runner.ts J).
//   D3 One shared recheck per distinct reference, not one per batch (B8.2).
//   D4 The maximum window size is a coordinator option (BATCH_MAX_REQUESTS = 8), not a config
//      key. config.ts and the section 1.4 surface are outside 2.2's write set, and the value
//      only bounds the worst-case slot hold (1 + 8 runs).
//   D5 A guard-sensitive member of a green batch needs per-file counts (P1, runner.ts) or a
//      confirmation run.
//   D6 One coordinator exists per plugin instance, but it receives its runtime per gate
//      (hook(runtime)). A config reload therefore reaches new windows without a new coordinator.
//
// -----------------------------------------------------------------------------------------------
// B15. RESIDUAL RISKS (accepted; QA may challenge)
//
//   - Cross-file state. pytest runs all of the union's files in one process, so a test that
//     pollutes another file's state can change outcomes compared with a run alone. vitest and
//     jest isolate each file by default; a config that turns isolation off carries the same
//     risk. A failure caused by pollution makes the member unverifiable, because pytest failures
//     are never proven introduced (2.1 decision 5). Pollution that hides a failure is a risk the
//     user's own suite run has too.
//   - Flaky tests on the own-run path. A failure that appears only in a member's own run is
//     judged exactly as it would be alone (2.1-T11's flaky row).
//   - Distinct stash commits never share a recheck, even when their trees are identical. A
//     tree-hash key would need git at capture time, which is out of scope.
//   - A config reload in the middle of a window keeps the opener's window length and scope
//     options.
//
// -----------------------------------------------------------------------------------------------
// B16. IMPLEMENTATION TASKS (each <= ~20 tool calls; commit and push each one green)
//
//   2.2.2 runs on vrb/p22, in parallel with 2.1.2-2.1.6. It does not touch wiring.ts, index.ts or
//   deterministic.ts. Tests run scoped: npx vitest run test/unit/batch.test.ts.
//   2.2.2.a runner.ts P1, only with the orchestrator's approval of the write-set addition;
//           otherwise skip it and keep the confirmation-run path. readResult fills
//           RunResult.testsByFile for JSON and junit reports. Tests in test/unit/runner.test.ts
//           on the Spike C reports in test/fixtures/runner/reports: the sum equals total, the
//           text fallback leaves it undefined, and pytest pseudo-cases are excluded.
//   2.2.2.b batch.ts pure helpers: envSignature, argvTemplate, batchKey, referenceKey,
//           unionChangedFiles, isGuardSensitive, fileKeyOf, attributeUnion, deriveSharedRecheck,
//           taintUnreproduced and createBatchDeadline. Table tests for each:
//             - win32 and posix keys;
//             - relative ChangedPath resolution;
//             - every attributeUnion row;
//             - every deriveSharedRecheck kind and cause;
//             - D's release, abort and dispose, with no listener left behind.
//   2.2.2.c createBatchCoordinator core: B2 bypasses, W1-W6, B5 steps 1-4 and 6, B9 and B11, with
//           injected timers and clock. Tests (fake timers):
//             - 5 requests -> 1 union run and 5 results;
//             - different keys -> separate scopes;
//             - window 0 -> direct;
//             - an arrival during a running batch -> the next window;
//             - max size closes the window early; so does W3;
//             - an abort in the window;
//             - one member aborts mid-run -> the others still get results;
//             - all abort -> the execute seam sees an aborted signal, and nothing is spawned
//               afterwards;
//             - dispose -> 0 timers, pending requests settled;
//             - the hook never rejects when a seam throws.
//   2.2.2.d attribution and recheck: B5 steps 5 and 7-9, B7 and B8. Tests:
//             - the union fails in a file of one member -> only that member's own run fails;
//             - a failing file shared by two members -> both are rechecked;
//             - a pre-existing failure shared by all members with one reference -> one recheck,
//               and every member derives "exact";
//             - distinct references -> one recheck each;
//             - a run-level unusable recheck -> split;
//             - skipped-deadline below the threshold;
//             - the flaky taint;
//             - pytest static attribution, with and without counts;
//             - deduplication of an overlapping change set.
//   2.2.2.e the property test (B12), coverage >= 90% of batch.ts lines and branches, and the QA
//           report section in phase-2.2.md.
//   2.2.3 starts after 2.1 is merged into vrb/wave-2. It writes wiring.ts, whose only writer it is
//   at that point.
//   2.2.3.a wiring.ts:
//             - one coordinator per plugin instance (createBatchCoordinator);
//             - per gate, runtime = {
//                 direct: 2.1's createDirectTestsPassHook(...),
//                 plan: planScopedRun with the gate's PlannerFs, a TestSearchSeam bound to the
//                   given deadline, the budget and the host,
//                 openScope: 2.1's scope opener,
//                 batchWindowMs: budget.batchWindowMs,
//                 recheckMinRemainingMs: RECHECK_MIN_REMAINING_MS };
//             - buildGateDeps' testsPass hook becomes coordinator.hook(runtime);
//             - the existing TTL sweep also calls coordinator.sweep();
//             - plugin disposal, if the host offers one, calls dispose().
//           batch.ts: replace the private idFileKey with 2.1's fileKeyOfId.
//   2.2.3.b test/unit/batch-wiring.test.ts, with 5 concurrent testsPass gates through
//           buildGateDeps:
//             - the argv seam sees 1 scoped run per window (+ <= 1 recheck with a shared
//               reference) on the green and pytest paths, and 1 + n on the vitest failing path;
//             - verdicts equal those with batchWindowMs: 0;
//             - the B12 property with 2.1's judgeScoped next to the oracle;
//             - one slot acquisition per batch, never nested.
// ===============================================================================================

import { posix, win32 } from "node:path";
import type { PluginLogger } from "../router/logger";
import type { DispatchReference } from "./reference";
import type { ChangedPath, RunResult, ScopedSpec, ScopingPlan } from "./runner";
import type {
  Deadline,
  OpenVerificationScope,
  RecheckOutcome,
  ScopedOutcome,
  TestsPassHook,
  TestsPassRequest,
  TestsPassRun,
  VerificationScope,
} from "./types";

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** W2: the default maximum number of members in one window (deviation D4). */
export const BATCH_MAX_REQUESTS = 8;

/** B11: how long sweep() tolerates a batch whose members are all settled but whose seam never returned. */
export const BATCH_STALE_GRACE_MS = 60_000;

/** Stable ScopedOutcome "aborted" reasons (B2, B9). They reach the orchestrator through 2.1-T7 u13. */
export const BATCH_REASONS = {
  disposed: "verification coordinator disposed",
  beforeRun: "gate budget exhausted before the scoped run",
  window: "gate budget exhausted waiting for the batch window",
  run: "gate budget exhausted during the scoped run",
  attribution: "gate budget exhausted during batch attribution",
} as const;

// ---------------------------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------------------------

/** What the planner needs from a request (B2.5, B6). */
export type BatchPlanInput = Pick<TestsPassRequest, "command" | "cwd" | "changedFiles">;

/**
 * planScopedRun bound to one deadline. The wiring (2.2.3) supplies the PlannerFs with the native
 * realpath, a TestSearchSeam whose calls use deadline.bound(10_000) and deadline.signal, the
 * RunnerBudget and the host. It may reject; the coordinator turns a rejection into a ScopedOutcome
 * "error" (B2.5).
 */
export type BatchPlanner = (input: BatchPlanInput, deadline: Deadline) => Promise<ScopingPlan>;

/** The seams and settings of one gate (deviation D6). The window opener's values apply to its batch. */
export interface BatchRuntime {
  /** 2.1's one-request hook, used for testScope "full" and batchWindowMs <= 0 (B2). */
  readonly direct: TestsPassHook;
  readonly plan: BatchPlanner;
  readonly openScope: OpenVerificationScope;
  /** enforcement.verify.batchWindowMs (VerifyBudget). <= 0 disables batching. */
  readonly batchWindowMs: number;
  /** 2.1's RECHECK_MIN_REMAINING_MS (B8.3), injected so this module has no runtime import of deterministic.ts. */
  readonly recheckMinRemainingMs: number;
  /**
   * The gate-time enforcement.verify.failureRecheck (VerifyBudget), read per request (B8.1,
   * QA-2.2-2): off turns every reference, even a captured one, into "disabled", exactly as 2.1's
   * direct hook decides at the gate.
   */
  readonly failureRecheck: boolean;
}

/** Timer seam for the window timers (W1). */
export interface BatchTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface BatchCoordinatorOptions {
  /** W2. Default BATCH_MAX_REQUESTS; a value that is not a safe integer >= 1 means 1 (no batching). */
  readonly maxBatchSize?: number;
  /** Path-key folding (case-insensitive on win32). Default: process.platform. */
  readonly platform?: NodeJS.Platform;
  /** Clock for W3 and B11. Default: Date.now. */
  readonly now?: () => number;
  /** Default: the global setTimeout/clearTimeout, with each handle unref'd (B11). */
  readonly timers?: BatchTimers;
  readonly logger?: Pick<PluginLogger, "warn">;
}

/** Live state and cumulative counters, for tests and QA (B11, B13). */
export interface BatchStats {
  readonly openWindows: number;
  readonly runningBatches: number;
  /** Requests submitted to a window and not yet settled. */
  readonly pendingRequests: number;
  /** Cumulative since creation. */
  readonly unionRuns: number;
  readonly ownRuns: number;
  readonly rechecks: number;
  readonly splits: number;
  readonly taints: number;
}

export interface BatchCoordinator {
  /** The S5 hook for one gate's runtime. It is exactly a TestsPassHook and never rejects (B-G5). */
  hook(runtime: BatchRuntime): TestsPassHook;
  /** B11 defensive eviction. Returns the number of windows and batches evicted. */
  sweep(): number;
  stats(): BatchStats;
  /** B11. Idempotent; never rejects. */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Coordinator (tasks 2.2.2.c and 2.2.2.d)
// ---------------------------------------------------------------------------------------------

/**
 * Where a member stands; B9's table maps each phase to what an abort settles it with.
 *   window   waiting in a window (W5);
 *   run      union planning or the union run (B5 steps 2-4);
 *   queued   waiting for its own run, or holding its outcome until the flaky taint (B5 steps 5-7);
 *   own-run  its own run is running: the executor kills it and reports (B9);
 *   recheck  waiting for its recheck (B8).
 */
type MemberPhase = "window" | "run" | "queued" | "own-run" | "recheck";

type RanOutcome = Extract<ScopedOutcome, { readonly kind: "ran" }>;

interface Member {
  readonly request: TestsPassRequest;
  /** The member's own planScopedRun spec. */
  readonly spec: ScopedSpec;
  /** B8.1 (QA-2.2-2): the submitting gate's runtime.failureRecheck, not the window opener's. */
  readonly failureRecheck: boolean;
  /** Arrival order: the tie-break of every deadline ordering. */
  readonly seq: number;
  phase: MemberPhase;
  settled: boolean;
  window: BatchWindow | undefined;
  batch: Batch | undefined;
  /** The member's scoped outcome once known (B5 steps 4-7). */
  scoped: ScopedOutcome | undefined;
  /** B9: its remaining() when its recheck started, reported if it aborts while waiting for it. */
  recheckBoundMs: number;
  readonly resolve: (run: TestsPassRun) => void;
  readonly onAbort: () => void;
}

interface BatchWindow {
  readonly key: string;
  /** The opener's runtime (W1, D6). */
  readonly runtime: BatchRuntime;
  /** Fixed at opening (W1, W2). */
  readonly closeAt: number;
  readonly members: Member[];
  timer: unknown;
  closed: boolean;
}

interface Batch {
  readonly key: string;
  readonly runtime: BatchRuntime;
  /** Fixed at close, in arrival order (W4). */
  readonly members: readonly Member[];
  /** D (B9). */
  readonly deadline: BatchDeadline;
  /** Rg of the shared recheck in flight (B8.5). */
  group: BatchDeadline | undefined;
  scope: VerificationScope | undefined;
  closing: Promise<void> | undefined;
  /** When the last member settled (B11 sweep). */
  settledAt: number | undefined;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function abortedRun(reason: string): TestsPassRun {
  return { scoped: { kind: "aborted", reason }, recheck: undefined };
}

function errorRun(reason: string): TestsPassRun {
  return { scoped: { kind: "error", reason }, recheck: undefined };
}

/** 2.1-T2 P7: a recheck is attempted for a "ran" outcome with >= 1 failing id and >= 1 failing file. */
function needsRecheck(scoped: ScopedOutcome): scoped is RanOutcome {
  return scoped.kind === "ran" && scoped.result.failingIds.length > 0 && scoped.result.failingFiles.length > 0;
}

/** Deadline order (B5.5, B8.3): the least remaining first, then arrival order. */
function byDeadline(a: Member, b: Member): number {
  return a.request.deadline.remaining() - b.request.deadline.remaining() || a.seq - b.seq;
}

/** A member that takes part in the recheck step (B8), with its final scoped outcome. */
interface Candidate {
  readonly m: Member;
  readonly scoped: RanOutcome;
  readonly reference: DispatchReference;
}

function byCandidateDeadline(a: Candidate, b: Candidate): number {
  return byDeadline(a.m, b.m);
}

/**
 * A member's own deadline that also aborts with `kill` (the batch deadline D, which aborts at
 * dispose or when every member is gone), so that dispose() kills own runs and single rechecks too
 * (B11.4). While the member is attached to D, D aborts only at dispose or after the member's own
 * signal, so the result bounds exactly as the member's deadline alone.
 */
function linkDeadline(base: Deadline, kill: AbortSignal): { readonly deadline: Deadline; unlink(): void } {
  const controller = new AbortController();
  const onAbort = () => {
    unlink();
    controller.abort();
  };
  const unlink = () => {
    base.signal.removeEventListener("abort", onAbort);
    kill.removeEventListener("abort", onAbort);
  };
  if (base.signal.aborted || kill.aborted) controller.abort();
  else {
    base.signal.addEventListener("abort", onAbort, { once: true });
    kill.addEventListener("abort", onAbort, { once: true });
  }
  const remaining = () => (controller.signal.aborted ? 0 : base.remaining());
  return {
    deadline: { budgetMs: base.budgetMs, remaining, bound: (ownBudgetMs) => Math.min(ownBudgetMs, remaining()), signal: controller.signal },
    unlink,
  };
}

/** B11: the global timers, each handle unref'd so that an open window never keeps the process alive. */
const defaultTimers: BatchTimers = {
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
  },
};

/** One coordinator per plugin instance (2.2.3). */
export function createBatchCoordinator(options: BatchCoordinatorOptions = {}): BatchCoordinator {
  const requestedSize = options.maxBatchSize ?? BATCH_MAX_REQUESTS;
  const maxBatchSize = Number.isSafeInteger(requestedSize) && requestedSize >= 1 ? requestedSize : 1;
  const platform = options.platform ?? process.platform;
  const now = options.now ?? (() => Date.now());
  const timers = options.timers ?? defaultTimers;
  const logger = options.logger;

  const windows = new Map<string, BatchWindow>();
  const running = new Set<Batch>();
  const closing = new Set<Promise<void>>();
  const counters = { unionRuns: 0, ownRuns: 0, rechecks: 0, splits: 0, taints: 0 };
  let disposed = false;
  let pending = 0;
  let arrivals = 0;

  const warn = (text: string, extra?: Record<string, unknown>) => logger?.warn(text, extra);
  const live = (b: Batch) => b.members.filter((m) => !m.settled);

  // -- settlement ------------------------------------------------------------------------------

  function settle(m: Member, run: TestsPassRun): void {
    if (m.settled) return;
    m.settled = true;
    pending--;
    m.request.deadline.signal.removeEventListener("abort", m.onAbort);
    const b = m.batch;
    if (b !== undefined) {
      // B9: a settled member no longer keeps the batch alive. Two members may share one Deadline
      // (one router_verify call naming several handles): it is released with the last of them.
      const deadline = m.request.deadline;
      if (!b.members.some((x) => !x.settled && x.request.deadline === deadline)) {
        b.group?.release(deadline);
        b.deadline.release(deadline);
      }
      if (b.members.every((x) => x.settled)) b.settledAt = now();
    }
    m.resolve(run);
  }

  /** B9's table. */
  function onAbort(m: Member): void {
    if (m.settled) return;
    switch (m.phase) {
      case "window":
        leaveWindow(m);
        settle(m, abortedRun(BATCH_REASONS.window));
        return;
      case "run":
        settle(m, abortedRun(BATCH_REASONS.run));
        return;
      case "queued":
        settle(m, abortedRun(BATCH_REASONS.attribution));
        return;
      case "own-run":
        // The executor kills the run on the member's signal and reports it (runOwn settles).
        return;
      case "recheck":
        settle(
          m,
          m.scoped === undefined
            ? abortedRun(BATCH_REASONS.attribution)
            : { scoped: m.scoped, recheck: { kind: "timed-out", boundMs: m.recheckBoundMs } },
        );
        return;
    }
  }

  // -- windows (B4) ----------------------------------------------------------------------------

  function leaveWindow(m: Member): void {
    const w = m.window;
    if (w === undefined) return;
    m.window = undefined;
    const i = w.members.indexOf(m);
    if (i >= 0) w.members.splice(i, 1);
    // W5: a window left empty clears its timer and is deleted.
    if (w.members.length === 0 && !w.closed) {
      w.closed = true;
      timers.clearTimeout(w.timer);
      if (windows.get(w.key) === w) windows.delete(w.key);
    }
  }

  function join(runtime: BatchRuntime, request: TestsPassRequest, spec: ScopedSpec): Promise<TestsPassRun> {
    const key = batchKey(spec, platform);
    return new Promise<TestsPassRun>((resolve) => {
      const member: Member = {
        request,
        spec,
        failureRecheck: runtime.failureRecheck,
        seq: arrivals++,
        phase: "window",
        settled: false,
        window: undefined,
        batch: undefined,
        scoped: undefined,
        recheckBoundMs: 0,
        resolve,
        onAbort: () => onAbort(member),
      };
      let w = windows.get(key);
      if (w === undefined) {
        // W1: the close time is fixed now, with the opener's window length.
        const opened: BatchWindow = { key, runtime, closeAt: now() + runtime.batchWindowMs, members: [], timer: undefined, closed: false };
        opened.timer = timers.setTimeout(() => closeWindow(opened), runtime.batchWindowMs);
        windows.set(key, opened);
        w = opened;
      }
      member.window = w;
      w.members.push(member);
      pending++;
      request.deadline.signal.addEventListener("abort", member.onAbort, { once: true });
      // W2 (size) and W3 (a joiner that could not outlive the wait).
      if (w.members.length >= maxBatchSize || request.deadline.remaining() <= w.closeAt - now()) closeWindow(w);
    });
  }

  /** W2, W4: close, leave the key map before anything asynchronous, and start the batch. */
  function closeWindow(w: BatchWindow): void {
    if (w.closed) return;
    w.closed = true;
    timers.clearTimeout(w.timer);
    if (windows.get(w.key) === w) windows.delete(w.key);
    const members = w.members.filter((m) => !m.settled);
    if (members.length === 0) return;
    const b: Batch = {
      key: w.key,
      runtime: w.runtime,
      members,
      deadline: createBatchDeadline(members.map((m) => m.request.deadline)),
      group: undefined,
      scope: undefined,
      closing: undefined,
      settledAt: undefined,
    };
    for (const m of members) {
      m.window = undefined;
      m.batch = b;
      // B5.1: a batch of one runs the member's own spec at once.
      m.phase = members.length === 1 ? "own-run" : "run";
    }
    running.add(b);
    void runBatch(b);
  }

  // -- the batch (B5) --------------------------------------------------------------------------

  async function runBatch(b: Batch): Promise<void> {
    try {
      await runSteps(b);
    } catch (e) {
      // B-G5: fail closed for every member the failure affects.
      warn("verify batch: internal failure", { error: message(e) });
      for (const m of b.members) settle(m, errorRun(`verification batch failed: ${message(e)}`));
    } finally {
      for (const m of b.members) settle(m, errorRun("verification batch ended without an outcome"));
      running.delete(b);
      b.group?.dispose();
      b.deadline.dispose();
      void closeScope(b);
    }
  }

  async function runSteps(b: Batch): Promise<void> {
    const first = b.members[0];
    let own: Member[] = [];
    let unionSpec: ScopedSpec | undefined;
    if (b.members.length === 1) {
      own = [first];
    } else {
      // Step 2.
      const planned = await planUnion(b);
      if (b.deadline.signal.aborted) return;
      if (typeof planned === "string") {
        // Step 6.
        counters.splits++;
        warn("verify batch: split into own runs", { members: b.members.length, cause: planned });
        own = queue(live(b));
      } else {
        unionSpec = planned;
      }
    }
    // Everyone is gone, or the coordinator was disposed: open nothing.
    if (b.deadline.signal.aborted) return;

    // Step 3.
    const scope = b.runtime.openScope({ cwd: first.request.cwd, command: first.request.command });
    b.scope = scope;

    // Step 4.
    let unionRan: RanOutcome | undefined;
    if (unionSpec !== undefined) {
      counters.unionRuns++;
      const union = await execute(scope, unionSpec, b.deadline);
      switch (union.kind) {
        case "ran":
          unionRan = union;
          own = attribute(b, union);
          break;
        case "slot-busy":
        case "aborted":
          for (const m of live(b)) settle(m, { scoped: union, recheck: undefined });
          return;
        default:
          own = queue(live(b));
      }
    }

    // Step 5.
    for (const m of [...own].sort(byDeadline)) {
      if (!m.settled) await runOwn(b, scope, m);
    }

    // Step 7.
    if (unionRan !== undefined && unionRan.result.failingIds.length > 0) taint(b, unionRan);

    // Steps 8 and 9.
    await rechecks(b, scope);
  }

  function queue(members: Member[]): Member[] {
    for (const m of members) m.phase = "queued";
    return members;
  }

  /** B6 and the step-2 consistency checks. Returns the union spec, or the cause of a split. */
  async function planUnion(b: Batch): Promise<ScopedSpec | string> {
    const changes: BatchMemberChanges[] = [];
    for (const m of b.members) {
      const changedFiles = m.request.changedFiles;
      if (changedFiles === "unavailable") return "a member's change set is unavailable";
      changes.push({ cwd: m.request.cwd, changedFiles });
    }
    const first = b.members[0];
    let plan: ScopingPlan;
    try {
      plan = await b.runtime.plan(
        { command: first.request.command, cwd: first.request.cwd, changedFiles: unionChangedFiles(changes, platform) },
        b.deadline,
      );
    } catch (e) {
      return `union planning failed: ${message(e)}`;
    }
    if ("noAffected" in plan) return "the union plan found nothing to run";
    if ("unverifiable" in plan) return `the union cannot be scoped (${plan.code})`;
    if (batchKey(plan, platform) !== b.key) return "the union plan runs a different command";
    const want = new Set(b.members.flatMap((m) => m.spec.inputs.map((f) => fold(f, platform))));
    const got = new Set(plan.inputs.map((f) => fold(f, platform)));
    if (want.size !== got.size || [...want].some((k) => !got.has(k))) return "the union plan's inputs differ from the members' inputs";
    return plan;
  }

  /**
   * B7 for every live member after a "ran" union, with the union's per-file counts (P1). A member
   * marked own-run runs its own spec (B5.5: mode B, or a confirmation run). A derived member
   * settles at once when the union is green, since there is nothing to taint (B5.8); otherwise it
   * holds its outcome until the flaky taint (B5.7).
   */
  function attribute(b: Batch, union: RanOutcome): Member[] {
    const own: Member[] = [];
    const n = b.members.length;
    const green = union.result.failingIds.length === 0;
    for (const m of live(b)) {
      const a = attributeUnion(union.result, union.result.testsByFile, m.spec, platform);
      if (a.kind === "own-run") {
        m.phase = "queued";
        own.push(m);
        continue;
      }
      // B7.4: the member's own spec, its plan notes and the batch note.
      const scoped: RanOutcome = {
        kind: "ran",
        result: a.result,
        exitCode: a.exitCode,
        spec: m.spec,
        notes: [...m.spec.notes, `batched: 1 run for ${n} requests`],
      };
      m.scoped = scoped;
      if (green) settle(m, { scoped, recheck: undefined });
      else m.phase = "queued";
    }
    return own;
  }

  /**
   * B7.5 (B-G2): union failures that no member's final outcome reproduces make every member's
   * "ran" result incomplete, so none of them can pass on the strength of the batch.
   */
  function taint(b: Batch, union: RanOutcome): void {
    const reproduced = new Set<string>();
    for (const m of b.members) {
      const s = m.scoped;
      if (s?.kind === "ran") for (const id of s.result.failingIds) reproduced.add(id);
    }
    const unreproduced = union.result.failingIds.filter((id) => !reproduced.has(id));
    if (unreproduced.length === 0) return;
    counters.taints++;
    warn("verify batch: a batched run failure was not reproduced by any request's own run", { ids: unreproduced });
    for (const m of live(b)) {
      const s = m.scoped;
      if (s?.kind === "ran") m.scoped = { ...s, result: taintUnreproduced(s.result, unreproduced) };
    }
  }

  /** B5.5: the member's own spec under its own deadline; the outcome is its scoped outcome, verbatim. */
  async function runOwn(b: Batch, scope: VerificationScope, m: Member): Promise<void> {
    m.phase = "own-run";
    counters.ownRuns++;
    const link = linkDeadline(m.request.deadline, b.deadline.signal);
    const out = await execute(scope, m.spec, link.deadline);
    link.unlink();
    if (m.settled) return;
    m.scoped = out;
    if (out.kind !== "ran") {
      settle(m, { scoped: out, recheck: undefined });
    } else if (m.request.deadline.signal.aborted) {
      // Its deadline ended during its own run: it waits for nothing more, as alone (B-G4).
      settle(m, { scoped: out, recheck: needsRecheck(out) ? lateRecheck(m) : undefined });
    } else {
      m.phase = "queued";
    }
  }

  // -- rechecks (B8) ---------------------------------------------------------------------------

  /** B8.1: the no-spawn decisions of 2.1-T4, or the captured reference to recheck at. */
  function referenceDecision(m: Member): { readonly decided: RecheckOutcome } | { readonly reference: DispatchReference } {
    const state = m.request.reference;
    // QA-2.2-2: 2.1's direct hook, `ref.kind === "disabled" || !failureRecheck` -> disabled.
    if (!m.failureRecheck) return { decided: { kind: "disabled" } };
    switch (state.kind) {
      case "disabled":
        return { decided: { kind: "disabled" } };
      case "none":
        return { decided: { kind: "unusable", cause: "no-reference", reason: state.reason } };
      case "captured":
        return { reference: state.reference };
    }
  }

  /** The recheck of a member whose deadline already ended: its reference decision, else skipped-deadline. */
  function lateRecheck(m: Member): RecheckOutcome {
    const decision = referenceDecision(m);
    return "decided" in decision ? decision.decided : { kind: "skipped-deadline", remainingMs: m.request.deadline.remaining() };
  }

  /** B8.3: below the threshold a member gets skipped-deadline and nothing is spawned for it. */
  function skippedForDeadline(b: Batch, m: Member, scoped: RanOutcome): boolean {
    const remainingMs = m.request.deadline.remaining();
    if (remainingMs >= b.runtime.recheckMinRemainingMs) return false;
    settle(m, { scoped, recheck: { kind: "skipped-deadline", remainingMs } });
    return true;
  }

  async function rechecks(b: Batch, scope: VerificationScope): Promise<void> {
    // B8.2: one group per distinct reference.
    const groups = new Map<string, Candidate[]>();
    for (const m of live(b)) {
      const scoped = m.scoped;
      if (scoped === undefined) {
        settle(m, errorRun("verification batch produced no outcome"));
        continue;
      }
      if (!needsRecheck(scoped)) {
        settle(m, { scoped, recheck: undefined });
        continue;
      }
      const decision = referenceDecision(m);
      if ("decided" in decision) {
        settle(m, { scoped, recheck: decision.decided });
        continue;
      }
      m.phase = "recheck";
      m.recheckBoundMs = m.request.deadline.remaining();
      const key = referenceKey(decision.reference);
      const group = groups.get(key) ?? [];
      group.push({ m, scoped, reference: decision.reference });
      groups.set(key, group);
    }
    // B8.3: one group at a time, the earliest deadline first.
    const ordered = [...groups.values()].map((g) => g.sort(byCandidateDeadline)).sort((x, y) => byCandidateDeadline(x[0], y[0]));
    for (const group of ordered) await recheckGroup(b, scope, group);
  }

  async function recheckGroup(b: Batch, scope: VerificationScope, group: readonly Candidate[]): Promise<void> {
    // B8.3: a member below the threshold leaves its group, as it would alone.
    const members = group.filter((c) => !c.m.settled && !skippedForDeadline(b, c.m, c.scoped));
    if (members.length === 0) return;
    // B8.4.
    if (members.length === 1) {
      await recheckOne(b, scope, members[0]);
      return;
    }
    // B8.5: one recheck over the union of the group's failing files, bounded by Rg.
    const seen = new Set<string>();
    const files: string[] = [];
    for (const c of members) {
      for (const f of c.scoped.result.failingFiles) {
        const k = fold(f, platform);
        if (seen.has(k)) continue;
        seen.add(k);
        files.push(f);
      }
    }
    const first = members[0];
    const rg = createBatchDeadline(members.map((c) => c.m.request.deadline));
    b.group = rg;
    for (const c of members) c.m.recheckBoundMs = c.m.request.deadline.remaining();
    counters.rechecks++;
    const shared = await recheck(scope, first.m.request, first.reference, files, rg);
    b.group = undefined;
    rg.dispose();
    const counts = shared.kind === "exact" ? shared.result?.testsByFile : undefined;
    const split: Candidate[] = [];
    for (const c of members) {
      if (c.m.settled) continue;
      const derived = deriveSharedRecheck(shared, counts, c.scoped.result.failingFiles, c.m.spec.cwd, platform);
      if (derived === "split") split.push(c);
      else settle(c.m, { scoped: c.scoped, recheck: derived });
    }
    if (split.length === 0) return;
    warn("verify batch: a shared recheck split into own rechecks", { members: split.length, shared: shared.kind });
    for (const c of split.sort(byCandidateDeadline)) await recheckOne(b, scope, c);
  }

  /** B8.4: the direct path, under the member's own deadline. */
  async function recheckOne(b: Batch, scope: VerificationScope, c: Candidate): Promise<void> {
    const { m, scoped, reference } = c;
    if (m.settled || skippedForDeadline(b, m, scoped)) return;
    m.recheckBoundMs = m.request.deadline.remaining();
    counters.rechecks++;
    const link = linkDeadline(m.request.deadline, b.deadline.signal);
    const out = await recheck(scope, m.request, reference, scoped.result.failingFiles, link.deadline);
    link.unlink();
    settle(m, { scoped, recheck: out });
  }

  // -- seams (B-G5: a throwing seam becomes a fail-closed outcome) ------------------------------

  async function execute(scope: VerificationScope, spec: ScopedSpec, deadline: Deadline): Promise<ScopedOutcome> {
    try {
      return await scope.execute(spec, deadline);
    } catch (e) {
      return { kind: "error", reason: `scoped run failed: ${message(e)}` };
    }
  }

  async function recheck(
    scope: VerificationScope,
    request: TestsPassRequest,
    reference: DispatchReference,
    files: readonly string[],
    deadline: Deadline,
  ): Promise<RecheckOutcome> {
    try {
      return await scope.rechecker(request.command, request.cwd)(reference, files, deadline);
    } catch (e) {
      return { kind: "unusable", cause: "error", reason: `recheck failed: ${message(e)}` };
    }
  }

  /** B5.9: close once; requesters never wait for it, dispose() does. */
  function closeScope(b: Batch): Promise<void> {
    if (b.closing === undefined) {
      const scope = b.scope;
      const p =
        scope === undefined
          ? Promise.resolve()
          : Promise.resolve()
              .then(() => scope.close())
              .catch((e: unknown) => warn("verify batch: scope close failed", { error: message(e) }));
      b.closing = p;
      closing.add(p);
      void p.then(() => closing.delete(p));
    }
    return b.closing;
  }

  // -- arrival (B2) ----------------------------------------------------------------------------

  async function submit(runtime: BatchRuntime, request: TestsPassRequest): Promise<TestsPassRun> {
    if (disposed) return abortedRun(BATCH_REASONS.disposed);
    if (request.testScope === "full" || !(runtime.batchWindowMs > 0)) return await runtime.direct(request);
    if (request.deadline.signal.aborted) return abortedRun(BATCH_REASONS.beforeRun);
    let plan: ScopingPlan;
    try {
      plan = await runtime.plan({ command: request.command, cwd: request.cwd, changedFiles: request.changedFiles }, request.deadline);
    } catch (e) {
      return errorRun(`scoped run planning failed: ${message(e)}`);
    }
    if ("noAffected" in plan) return { scoped: { kind: "no-affected", note: plan.note }, recheck: undefined };
    if ("unverifiable" in plan) return { scoped: { kind: "unverifiable", code: plan.code, reason: plan.reason }, recheck: undefined };
    if (disposed) return abortedRun(BATCH_REASONS.disposed);
    if (request.deadline.signal.aborted) return abortedRun(BATCH_REASONS.beforeRun);
    return join(runtime, request, plan);
  }

  return {
    hook(runtime: BatchRuntime): TestsPassHook {
      return async (request) => {
        try {
          return await submit(runtime, request);
        } catch (e) {
          return errorRun(`verification coordinator failed: ${message(e)}`);
        }
      };
    },

    sweep(): number {
      let evicted = 0;
      for (const [key, w] of windows) {
        if (w.members.some((m) => !m.settled)) continue;
        w.closed = true;
        timers.clearTimeout(w.timer);
        windows.delete(key);
        evicted++;
        warn("verify batch: evicted a window with no live member", { key });
      }
      const t = now();
      for (const b of running) {
        if (b.settledAt === undefined || t - b.settledAt <= BATCH_STALE_GRACE_MS) continue;
        running.delete(b);
        b.group?.dispose();
        b.deadline.dispose();
        void closeScope(b);
        evicted++;
        warn("verify batch: evicted a batch whose seam never returned", { key: b.key, members: b.members.length });
      }
      return evicted;
    },

    stats(): BatchStats {
      return { openWindows: windows.size, runningBatches: running.size, pendingRequests: pending, ...counters };
    },

    async dispose(): Promise<void> {
      if (!disposed) {
        disposed = true;
        for (const w of windows.values()) {
          w.closed = true;
          timers.clearTimeout(w.timer);
          for (const m of [...w.members]) settle(m, abortedRun(BATCH_REASONS.disposed));
        }
        windows.clear();
        for (const b of running) {
          for (const m of b.members) settle(m, abortedRun(BATCH_REASONS.disposed));
          b.group?.dispose();
          b.deadline.dispose();
          void closeScope(b);
        }
      }
      await Promise.all([...closing]);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for table tests)
// ---------------------------------------------------------------------------------------------

function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/** Path-key folding: case-insensitive on win32 (B3, B6). */
function fold(p: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? p.toLowerCase() : p;
}

/** Code-unit order, independent of the locale. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** B3: key-sorted JSON of a spec's env. */
export function envSignature(env: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.keys(env)
      .sort(byCodeUnit)
      .map((k) => [k, env[k]]),
  );
}

/** B3: spec.args without the elements equal to an input, with spec.reportPath replaced by "<report>". */
export function argvTemplate(spec: ScopedSpec): readonly string[] {
  const inputs = new Set(spec.inputs);
  const report = spec.reportPath;
  return spec.args.filter((a) => !inputs.has(a)).map((a) => (report === "" ? a : a.split(report).join("<report>")));
}

/** B3: [gitRoot, runner, entry, file, cwd, envSignature, argvTemplate] as JSON, with paths case-folded on win32. */
export function batchKey(spec: ScopedSpec, platform: NodeJS.Platform): string {
  return JSON.stringify([
    fold(spec.gitRoot, platform),
    spec.runner,
    fold(spec.entry, platform),
    fold(spec.file, platform),
    fold(spec.cwd, platform),
    envSignature(spec.env),
    argvTemplate(spec),
  ]);
}

/** B8.2: root, commit, and the sorted untracked, tracked and captureReasons entries; capturedAt is excluded. */
export function referenceKey(reference: DispatchReference): string {
  const entries = (m: ReadonlyMap<string, string>) => [...m.entries()].sort((a, b) => byCodeUnit(a[0], b[0]) || byCodeUnit(a[1], b[1]));
  const reasons = reference.captureReasons.map((r) => JSON.stringify([r.cause, r.path])).sort(byCodeUnit);
  return JSON.stringify([reference.root, reference.commit, entries(reference.untracked), entries(reference.tracked), reasons]);
}

/** One member's change set, as unionChangedFiles reads it. */
export interface BatchMemberChanges {
  /** The request's check cwd: relative ChangedPath paths resolve against it. */
  readonly cwd: string;
  readonly changedFiles: readonly ChangedPath[];
}

/**
 * B6: every member's entries, with path and previousPath made absolute against the member's cwd,
 * deduplicated by the platform key of (path, previousPath) in first-seen order.
 */
export function unionChangedFiles(members: readonly BatchMemberChanges[], platform: NodeJS.Platform): ChangedPath[] {
  const P = pathApi(platform);
  const seen = new Set<string>();
  const out: ChangedPath[] = [];
  for (const m of members) {
    for (const c of m.changedFiles) {
      const path = P.resolve(m.cwd, c.path);
      const previousPath = c.previousPath === undefined ? undefined : P.resolve(m.cwd, c.previousPath);
      const key = JSON.stringify([fold(path, platform), previousPath === undefined ? null : fold(previousPath, platform)]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        path,
        ...(c.status !== undefined ? { status: c.status } : {}),
        ...(previousPath !== undefined ? { previousPath } : {}),
      });
    }
  }
  return out;
}

/** runner.ts JS_TEST_RE: the G.8 test-file suffix rule. */
const JS_TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** runner.ts isJsTestPath (G.8): a .test/.spec file or a file under __tests__. Either separator. */
function isJsTestPath(p: string): boolean {
  const segs = p.split(/[\\/]/);
  return JS_TEST_RE.test(segs[segs.length - 1] ?? "") || segs.includes("__tests__");
}

/**
 * B7.2: true when readResult's zero-test guard (runner.ts I step 2a) could fire for this spec alone:
 * lexicalPaths, inputsAreTests, or a JS test file among its inputs (runner.ts G.8 rule).
 */
export function isGuardSensitive(spec: ScopedSpec, platform: NodeJS.Platform): boolean {
  // The G.8 rule reads both separators and is case-sensitive on every platform, as in runner.ts.
  void platform;
  return spec.lexicalPaths === true || spec.inputsAreTests || spec.inputs.some(isJsTestPath);
}

/** The id-space file key: the path of `absolutePath` relative to `cwd`, with "/" separators (runner.ts I). */
export function fileKeyOf(cwd: string, absolutePath: string, platform: NodeJS.Platform): string {
  return pathApi(platform).relative(cwd, absolutePath).replace(/\\/g, "/");
}

/**
 * 2.1-T5's fileKeyOfId, private until 2.2.3 can import it: the part of an id before " > ", else
 * before "::", else the whole id.
 */
function idFileKey(id: string): string {
  const gt = id.indexOf(" > ");
  if (gt >= 0) return id.slice(0, gt);
  const cc = id.indexOf("::");
  return cc >= 0 ? id.slice(0, cc) : id;
}

/** The sum of `counts` over `keys`, matched with the platform's folding. */
function countOver(counts: TestCounts, keys: Iterable<string>, platform: NodeJS.Platform): number {
  const folded = new Map<string, number>();
  for (const [k, n] of Object.entries(counts)) folded.set(fold(k, platform), (folded.get(fold(k, platform)) ?? 0) + n);
  let n = 0;
  for (const k of new Set([...keys].map((x) => fold(x, platform)))) n += folded.get(k) ?? 0;
  return n;
}

function greenResult(total: number | undefined): RunResult {
  return { failingIds: [], failingFiles: [], collectionError: false, total, complete: true, source: "report" };
}

/** Per-file test counts of one run (P1): id-space file key -> the number of tests listed. */
export type TestCounts = Readonly<Record<string, number>>;

/** Why a member runs its own spec (B7). */
export type OwnRunCause =
  /** 7.1: the union's result is incomplete, has a collection error, or comes from text. */
  | "not-comparable"
  /** 7.2b/7.3a: the member's own run could have tripped the zero-test guard, and counts cannot tell. */
  | "zero-test-ambiguous"
  /** 7.3b: a failing vitest/jest union. */
  | "mode-b";

/** attributeUnion's decision for one member. */
export type UnionAttribution =
  | { readonly kind: "derived"; readonly result: RunResult; readonly exitCode: number }
  | { readonly kind: "own-run"; readonly cause: OwnRunCause };

/**
 * B7.1-7.3 for one member, given the union run's result, its per-file counts (P1; undefined
 * without them) and the member's own spec. Pure.
 */
export function attributeUnion(
  union: RunResult,
  counts: TestCounts | undefined,
  member: ScopedSpec,
  platform: NodeJS.Platform,
): UnionAttribution {
  // 7.1
  if (!union.complete || union.collectionError || union.source !== "report") return { kind: "own-run", cause: "not-comparable" };
  const inputKeys = member.inputs.map((f) => fileKeyOf(member.cwd, f, platform));

  // 7.2b for pytest (and 7.3a when none of the union's failures is the member's): its own run is
  // green with n tests, or trips the zero-test guard with n = 0.
  const staticGreen = (): UnionAttribution => {
    if (counts === undefined) return { kind: "own-run", cause: "zero-test-ambiguous" };
    const n = countOver(counts, inputKeys, platform);
    if (n > 0) return { kind: "derived", result: greenResult(n), exitCode: 0 };
    return {
      kind: "derived",
      result: { ...greenResult(0), complete: false, note: `${member.runner} ran no tests although a test file was passed` },
      exitCode: member.runner === "pytest" ? 5 : 0,
    };
  };

  if (union.failingIds.length === 0) {
    // 7.2a
    if (!isGuardSensitive(member, platform)) return { kind: "derived", result: greenResult(union.total), exitCode: 0 };
    // 7.2b
    if (member.inputsAreTests) return staticGreen();
    if (counts === undefined) return { kind: "own-run", cause: "zero-test-ambiguous" };
    const n = countOver(
      counts,
      member.inputs.flatMap((f, i) => (isJsTestPath(f) ? [inputKeys[i]] : [])),
      platform,
    );
    return n > 0 ? { kind: "derived", result: greenResult(n), exitCode: 0 } : { kind: "own-run", cause: "zero-test-ambiguous" };
  }

  // 7.3b
  if (!member.inputsAreTests) return { kind: "own-run", cause: "mode-b" };
  // 7.3a: static attribution by input file key.
  const own = new Set(inputKeys.map((k) => fold(k, platform)));
  const ids = union.failingIds.filter((id) => own.has(fold(idFileKey(id), platform)));
  if (ids.length === 0) return staticGreen();
  const files = union.failingFiles.filter((f) => own.has(fold(fileKeyOf(member.cwd, f, platform), platform)));
  const total = counts === undefined ? union.total : countOver(counts, inputKeys, platform);
  return {
    kind: "derived",
    result: { failingIds: ids, failingFiles: files, collectionError: false, total, complete: true, source: "report" },
    exitCode: 1,
  };
}

/**
 * B7.5: the member's result with complete = false and the note "batched run failure not
 * reproduced by any request's own run: <ids>". Its failing ids and files are kept.
 */
export function taintUnreproduced(result: RunResult, unreproduced: readonly string[]): RunResult {
  if (unreproduced.length === 0) return result;
  return {
    ...result,
    complete: false,
    note: `batched run failure not reproduced by any request's own run: ${[...new Set(unreproduced)].sort(byCodeUnit).join(", ")}`,
  };
}

/** B8.5: unusable causes that describe the reference, the same for every member of its group. */
const REFERENCE_LEVEL_CAUSES: ReadonlySet<string> = new Set([
  "no-reference",
  "materialize-failed",
  "reference-vanished",
  "unreproduced-inputs",
  "runner-unsupported",
  "error",
]);

/**
 * B8.5: one member's RecheckOutcome, derived from a recheck shared by its reference group, or
 * "split" when only the member's own recheck can answer. `failingFiles` are the member's absolute
 * live paths and `cwd` its spec.cwd (the id key space).
 */
export function deriveSharedRecheck(
  shared: RecheckOutcome,
  counts: TestCounts | undefined,
  failingFiles: readonly string[],
  cwd: string,
  platform: NodeJS.Platform,
): RecheckOutcome | "split" {
  switch (shared.kind) {
    case "approximate":
    case "disabled":
    case "timed-out":
    case "skipped-deadline":
      return shared;
    case "unusable":
      return REFERENCE_LEVEL_CAUSES.has(shared.cause) ? shared : "split";
    case "exact":
      break;
  }
  const mine = new Set(failingFiles.map((f) => fold(fileKeyOf(cwd, f, platform), platform)));
  const ranFiles = shared.ranFiles.filter((k) => mine.has(fold(k, platform)));
  const absentFiles = shared.absentFiles.filter((k) => mine.has(fold(k, platform)));
  // Every file of the member must be accounted for, and ran files need a result: otherwise only
  // the member's own recheck can answer.
  const covered = new Set([...ranFiles, ...absentFiles].map((k) => fold(k, platform)));
  if ([...mine].some((k) => !covered.has(k))) return "split";
  if (ranFiles.length === 0) return { kind: "exact", result: undefined, ranFiles, absentFiles, notes: shared.notes };
  const full = shared.result;
  if (full === undefined) return "split";

  const ranSet = new Set(ranFiles.map((k) => fold(k, platform)));
  const failingIds = full.failingIds.filter((id) => ranSet.has(fold(idFileKey(id), platform)));
  // The rerun's failingFiles are absolute paths in the reference worktree, whose cwd this module
  // does not know: each is keyed by the longest shared ran-file key it ends with.
  const allKeys = [...new Set(shared.ranFiles.map((k) => fold(k, platform)))].sort((a, b) => b.length - a.length);
  const keyOfRerunFile = (f: string): string | undefined => {
    const slashed = fold(f.replace(/\\/g, "/"), platform);
    return allKeys.find((k) => slashed === k || slashed.endsWith(`/${k}`));
  };
  const failingFilesAtRef = full.failingFiles.filter((f) => {
    const k = keyOfRerunFile(f);
    return k !== undefined && ranSet.has(k);
  });

  let total: number | undefined;
  if (counts !== undefined) {
    total = countOver(counts, ranFiles, platform);
    if (total === 0) {
      return { kind: "unusable", cause: "incomplete", reason: "rerun ran no tests although every input is a test file" };
    }
  } else {
    if (failingIds.length === 0) return "split";
    total = full.total;
  }
  return {
    kind: "exact",
    result: { failingIds, failingFiles: failingFilesAtRef, collectionError: false, total, complete: true, source: "report" },
    ranFiles,
    absentFiles,
    notes: shared.notes,
  };
}

/** B9: the deadline of a batch or of a recheck group, over the members still attached. */
export interface BatchDeadline extends Deadline {
  /** Detaches a settled member: it no longer counts toward remaining() or the all-aborted rule. */
  release(member: Deadline): void;
  /** Aborts the signal if it has not aborted yet, and removes every listener. Idempotent. */
  dispose(): void;
}

/** B9. It has no timer of its own: it aborts when every attached member has aborted, or at dispose. */
export function createBatchDeadline(members: readonly Deadline[]): BatchDeadline {
  const controller = new AbortController();
  const attached = new Map<Deadline, () => void>();
  const budgetMs = members.reduce((m, d) => Math.max(m, d.budgetMs), 0);

  const detachAll = () => {
    for (const [d, listener] of attached) d.signal.removeEventListener("abort", listener);
    attached.clear();
  };
  const abort = () => {
    detachAll();
    if (!controller.signal.aborted) controller.abort();
  };
  const check = () => {
    for (const d of attached.keys()) if (!d.signal.aborted) return;
    abort();
  };

  for (const d of members) {
    if (attached.has(d)) continue;
    const listener = () => check();
    attached.set(d, listener);
    d.signal.addEventListener("abort", listener, { once: true });
  }
  check();

  const remaining = () => {
    if (controller.signal.aborted) return 0;
    let r = 0;
    for (const d of attached.keys()) r = Math.max(r, d.remaining());
    return r;
  };

  return {
    budgetMs,
    remaining,
    bound: (ownBudgetMs: number) => Math.min(ownBudgetMs, remaining()),
    signal: controller.signal,
    release(member: Deadline) {
      const listener = attached.get(member);
      if (listener === undefined) return;
      member.signal.removeEventListener("abort", listener);
      attached.delete(member);
      check();
    },
    dispose: abort,
  };
}

