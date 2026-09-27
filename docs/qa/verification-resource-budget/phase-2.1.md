# Phase 2.1 — testsPass pipeline, gate abort, dispatch reference: QA report

## Pre-flight

- **Worktree:** `D:\git\omr-p21`, branch `vrb/p21`, based on `vrb/wave-2` at `5a79c0b`. That tip
  holds the merges of 1.1, 1.2, 1.4, 1.3, 1.5 and 1.6, plus the follow-up
  `refactor(verify): import the process seam types in reference.ts from types.ts`. `git status` was
  clean before task 2.1.1.
- **Baseline suite at `5a79c0b`:** 81 files, 2600 passed, 3 skipped. The orchestrator ran it (the
  serialized full-suite run, §0.6.7). The design task did not run it again.
- **Wave-1 QA reports** (`docs/qa/verification-resource-budget/phase-1.*.md`): the orchestrator
  reports all six clean at merge. Every last-round finding has a recorded resolution commit. Some
  reports still read as open because their final status line predates the last fix:

  | Report | Last round | Final status line |
  |---|---|---|
  | 1.4 | round 7 | "CLEAN" |
  | 1.5 | last round | "clean" |
  | 1.6 | last round | "clean" |
  | 1.1 | QA-1.1-7 resolved in `25c5a79` | none after the resolution |
  | 1.3 | QA-1.3-48 and -49 (`85068c0`), -50 (`36c9a0b`), -51 (`9a04eb5`) | none after the resolutions |
  | 1.2 | QA-1.2-30 resolved in `e59297c` | line 1480 still reads "NOT CLEAN"; it predates `e59297c` |

  None of this blocks 2.1. The 1.2 status line should be amended by its owner; this phase does not
  write that file.
- **Typecheck:** `npm run typecheck` is clean after the types commit (`5be8c85`) and after the
  design commit.
- **Inbound handoffs:** each item in the dispatch list was checked against the Wave-1 reports:
  - 1.1: `phase-1.1.md` lines 10-23 and 209-218.
  - 1.2: QA-1.2-13, lines 465-470.
  - 1.3: QA-1.3-16/17 (lines 454-455 and 588), plus the stat/readdir notes (lines 658 and 1137).
  - 1.4: QA-1.4-18 (lines 787-794), QA-1.4-19/31, and the QA-1.4-21 residual (lines 116-122).
  - 1.5: QA-1.5-4 (line 282), QA-1.5-7 (lines 340-348), QA-1.5-10 (lines 394-408), QA-1.5-25
    (line 859), and the `reference.ts` OPEN RISKS: pytest, and "2.1 must classify reference
    vanished".
  - 1.6: QA-1.6-13 and QA-1.6-22, and the "deferred by plan" table (lines 600-610).

  Each one is placed in `src/verify/deterministic.ts`, section T9 of the testsPass header.

## Design notes / deviations

Task 2.1.1 produced two things:

- the contract types, in the "testsPass pipeline contract" block of `src/verify/types.ts`
  (commit `5be8c85`, to be cherry-picked onto `vrb/p22` and `vrb/p24`);
- the design header of the testsPass section of `src/verify/deterministic.ts`, sections T1-T11:
  guarantees, pipeline steps, deadline, recheck, verdict algebra, truth table, wording, the other
  command checks, handoffs, the task breakdown and residual risks.

The design takes these deliberate decisions beyond the plan text:

1. **The recheck returns facts; judgeScoped classifies.** `RecheckOutcome` "exact" carries:
   - the rerun's `RunResult`;
   - the id-space keys of the files that ran at the reference, and of those absent there.

   The per-id pre-existing/introduced split (`FailureClassification`) is computed by
   `judgeScoped`, so one recheck can serve several batch requests (2.2 shares one recheck per
   reference). The table's "exact-and-all-preexisting" and "exact-and-some-introduced" columns are
   outcomes of that classification, and the added "X?" column (exact, but some ids unproven) is
   too.
2. **Contract types beyond the plan's list:**
   - `ReferenceState`: the gate's view of the capture. 2.4 stores it as a promise.
   - `VerificationScope` / `OpenVerificationScope`: QA-1.4-18 requires one slot hold per gate or
     batch, held across the recheck, and never nested. A `ScopedExecutor` that acquired the slot on
     every call could not give 2.2's mode B "all under one slot hold".
   - `TestsPassRequest` / `TestsPassRun` / `TestsPassHook`: the "same function signature" that
     2.2.3 swaps the coordinator in behind.
   - `TestsPassJudgement`, structurally a `CheckResult`.
   - `FailureClassification`.
   - `RecheckUnusableCause`.
3. **Extra truth-table rows:**
   - no-affected;
   - failures with an incomplete scoped inventory;
   - incomplete result without failure ids;
   - executor error.

   The plan's rows cannot express these states, and every state needs exactly one verdict.
4. **Rejecting needs one proof; excusing needs completeness.** A fail needs at least one id proven
   introduced against an exact, comparable rerun. The scoped inventory need not be complete, since
   one real introduced failure is enough. An excuse needs completeness on both sides. QA-1.3-17
   ("complete false or collectionError are not comparable") is read as "cannot excuse". The
   reference rerun must always be comparable.
5. **pytest rechecks are not run** (`runner-unsupported`). The `reference.ts` OPEN RISKS says a
   pytest reference run must count as approximate, because editable installs import the live tree.
   Such a run can neither excuse nor prove, so it would only spend CPU (§1.1 constraint 3). pytest
   failures are therefore unverifiable, and pytest greens still pass.
6. **Approximate references and non-inert `unreproduced` skip the rerun**, for the same reason.
   The inert allowlist (T4.f) is deliberately small. Env files and build output are never on it.
7. **`DeterministicDeps` changes differ from 2.1.2.a:**
   - `signal` becomes `deadline: Deadline`, which carries the signal and the remaining-time bound;
   - `slot` becomes `openScope`;
   - `testsPass: TestsPassHook` is added.

   With no hook, testsPass is unverifiable and never falls back to a command run (G5).
8. **Write-set additions** (no other Wave-2 phase writes these files):
   - `src/verify/tree.ts`: QA-1.6-13 `previousPath` and QA-1.6-22 `root`. The file is not in the
     §2 map.
   - `tiers.json`: the 1.1 QA assigned the `gateBudgetMs` key removal to 2.1.
   - `src/router/config.ts`: the `captureWaitMs` clamp and the `slotWaitMs` residual doc. It is
     unowned in Wave 2, per the orchestrator.
   - The clamp's test goes in `test/unit/baseline-wiring.test.ts` (2.1-owned), not in
     `config-verify-budget.test.ts`, whose Wave-2 owner is 2.3.
   - `src/verify/timeout.ts` is not written. `DEFAULT_GATE_BUDGET_MS` loses its last importer and
     stays until 3.2.
9. **The 2.1.1 types block is frozen for the rest of 2.1.** It is cherry-picked. 2.1-internal types
   (the `CheckScope` shell/lint runners, the new `DeterministicDeps` members) go outside it.
10. **testsPass leaves the per-cwd mutex.** The mutex would serialize the concurrent gates that 2.2
    batches. buildPasses and run keep it.
11. **The deadline starts before `prepareVerification`,** so the snapshot and a still-pending
    capture are bounded by the gate budget.
12. **The last `close()` of a gate is not awaited** by the verdict path. A slow reference dispose
    (EBUSY retries) holds the slot a little longer but never costs a verdict. Earlier checks'
    closes are awaited, so there is no nesting.
13. **testScope "full" identities come from text.** The full command runs as written through the
    shell. Its `RunResult` is synthesized from `observeTests` (source "text"). It can be rejected
    through file-level proof, and excused only with a complete text inventory.

Open question for QA and the orchestrator: T11 describes the native `task` re-dispatch after a
rejection. The new dispatch's reference already contains the failed attempt's changes, as with the
1.14 baseline. The candidate mitigation lives in 2.4's registry, which knows the orchestrator
session.

## QA findings (round 1)

Scope: `git diff 5a79c0b..HEAD` on `vrb/p21` (tip `5dd3c35`). Reviewer: adversarial senior-engineer
review, CAP:none.

**Runs:**
- The nine scoped test files named in the dispatch: 9 files, 388 passed.
- `npm run typecheck`: clean.

**Real-process repro:** `%TEMP%\opencode\qa21\repro-retry.ts`, run under Bun 1.3.14. It uses:
- a real git repository in `%TEMP%`, with vitest through a `node_modules` junction;
- the real `createChangedFileStore`, `createVerificationWiring` (snapshot, capture, planner, scope
  opener, argv/shell seams) and `runDeterministic`.

The scratch directory and the junction were removed afterwards. No `omr-ref-*` or `omr-verify-*`
entries were left in `%TEMP%`.

**Mutation check:** run in a scratch copy of the worktree, never in the worktree itself. Each mutant
was run against the same nine test files. Result: 19 killed, 0 survived; one mutant was skipped
because its pattern was ambiguous. The killed mutants were:
- G1 excuse without a complete inventory;
- an un-rerun file treated as preexisting;
- an id-level report id treated as preexisting;
- non-inert `unreproduced` inputs ignored;
- a rerun with `total === 0`, one with `complete === false`, and one with a `collectionError`,
  each accepted;
- the vanished-dir check removed;
- the recheck threshold set to 0;
- `readResult` skipped after a spawn throw;
- a retry that recaptures;
- contamination ignored;
- the native `task` gate left without `withTimeout`;
- `failureRecheck: false` still rechecking;
- full-mode keys not filtered to existing files;
- `lowPriority` dropped;
- the full-mode `collectionError` dropped;
- a capture made while `failureRecheck` is off;
- the per-run abort after a timeout dropped.

The tests are strong on the verdict algebra and the recheck. The two critical findings below are
not in any test, because every test gives the store a complete change set.

| id | severity | evidence | fix |
|---|---|---|---|
| QA-2.1-1 | critical | **False pass on a delegate retry.** `delta` (`dispatch.ts:222`) reads only `bySession.get(childID)`, the *current* attempt's tool edits. The snapshot part (`dispatch.ts:230-234`) adds only paths that were *not* listed at dispatch. `index.ts:594` passes the retry's `producerSid` as `childID`, while the reference stays the first dispatch's. So an attempt-1 edit to a file already dirty at dispatch drops out of the retry's change set, and the scoped run never selects its tests. Repro, scenario A: `src/a.js` is dirty at dispatch. Attempt 1 breaks it through the edit tool. Attempt 2 touches only `src/b.js`. Result: `A attempt2 {"changed":["\src\b.js",…],"ref":"captured","pass":true,"outcome":"pass"}`, while `full-suite truth: RED`. The pre-2.1 full-suite baseline caught this; S1 scoping made the change set safety-critical. | Attribute the *cumulative* change since the reference: `delta` unions the tool-observed files of every producer session of the dispatch (record each attempt's session against the dispatch id, or pass `producerSessions`). Add a wiring test: a retry after a rejection re-runs the tests of attempt 1's files. |
| QA-2.1-2 | critical | **False pass on shell edits to already-dirty files.** `record()` gets nothing from `bash`/`shell` (`extractChangedFile` returns null). `delta` adds only snapshot paths absent at dispatch (`dispatch.ts:232-233`). So `sed -i`, codemods, formatters, `git checkout -- f` or `git rm` on a file that was dirty at dispatch are invisible, and an empty set is a pass (§1.5-6). Repro, scenario B: `src/a.js` is dirty (and green) at dispatch; the producer breaks it without a tool record. Result: `B bash-edit {"changed":[],"ref":"captured","pass":true,"outcome":"pass","notes":["no changed files, no affected tests"]}`, while `full-suite truth: RED`. The whole-tree `fingerprint` changed but is never consulted. | Give `TreeSnapshot` a per-path content identity for listed paths (e.g. `git hash-object` of each dirty or untracked file, or a per-path hash of `git diff HEAD -- <p>`). `delta` then adds every path whose identity changed or that left the list. Minimum fail-closed fallback: if `current.fingerprint !== snapshot.fingerprint` and a listed-at-both-times path cannot be proven unchanged, return `changeBaseline: "unavailable"` (the §1.5-6 S6 path). Add a real-git test of both cases. |
| QA-2.1-3 | major | **The verdict waits for reference disposal, contrary to the design.** T2 P9 (`deterministic.ts:338-340`) and design note 12 say the last `close()` of a gate is `void`ed. The hook instead runs `await scope.close()` in its `finally` (`deterministic.ts:1278`), and `close()` waits for every tracked `ref.dispose()`: git worktree removal plus up to 5 EBUSY retries with 100-1600 ms backoff (`reference.ts:866-867, 1025`). No gate deadline covers dispose (`reference.ts:1191`, "Unset for dispose"). The rerun may use all remaining time (`rd.bound`), so dispose can run past `gateBudgetMs`. The gate's `withTimeout` then rejects *before* `runDeterministic` calls `onFailure`. `completedFailures` is empty, and a proven introduced failure (r1) becomes "verification gate timed out" (unverifiable), which is accepted with a caveat unless `strictUnverifiable`. | Implement P9 as designed: return the `TestsPassRun` and let `close()` settle in the background (the hold stays until disposal ends; T8 sequencing still needs the earlier checks' closes awaited). Or bound the awaited close by `deadline.remaining()`. Add a test: a scope whose `close()` never resolves still yields the r1 verdict. |
| QA-2.1-4 | minor | **The deadline starts after `prepareVerification`.** Design note 11 and T2 P0 put the deadline before `prepareVerification`. Both call sites call `prepareVerification(…)` with no deadline (`index.ts:594`, `index.ts:1102`), then `createDeadline` (`index.ts:611`, `:1138`). So the grade snapshot (≤ 10 s, `GRADE_SNAPSHOT_TIMEOUT_MS`) and the wait for a still-pending capture (≤ `baselineTimeoutMs`) run outside `gateBudgetMs`. `REFERENCE_NONE.gateBudget` (`dispatch.ts:207-209`) is unreachable in production. The wait is bounded, so this is not a hang. | Create the deadline before `prepareVerification` and pass it in both sites; or record the deviation and the extra ≤ 25 s worst case in the design notes. |
| QA-2.1-5 | minor | **QA-1.2-13 is incomplete on the recheck side.** `buildGateDeps` calls `createScopeOpener({ argv: argvSeam, … })` with no `reference` (`wiring.ts:403`), so `refDeps.argv` is the raw seam (`deterministic.ts:887-892`). `reference.ts` `runGit` sets no `lowPriority` (`reference.ts:1137`). So GC, materialize and dispose git processes inside the hold run at normal priority. The capture (`wiring.ts:388`) and the start-up GC (`wiring.ts:478`) do wrap the seam. | Pass `reference: { argv: <lowPriority-wrapped argvSeam> }` in `buildGateDeps`, or have `createScopeOpener` wrap `refDeps.argv` with `budget.lowPriority`. Assert this through the argv seam in a recheck test. |
| QA-2.1-6 | info | **Native `task` re-dispatch after a rejection** (T11 residual, the open question above). The new dispatch captures a reference that contains the rejected attempt, so that attempt's introduced failures read as preexisting (pass, n2 note "suite is NOT green"). This is the same class as the 1.14 baseline. The delegate ladder is not affected: it keeps its first reference (mutant "retry recaptures" killed). QA-2.1-1 is the separate change-set gap. | Orchestrator decision. The mitigation (link the re-dispatch to the rejected dispatch's reference through 2.4's registry) is not in the plan text for 2.4. Schedule it explicitly, or accept it in the plan as a residual. |
| QA-2.1-7 | nit | **The acceptance grep is not literally met.** `rg "testBaseline\|baselines\.\|compareTests" src` also returns three comments outside `config.ts`: `deterministic.ts:526`, `deterministic.ts:624` and `types.ts:152`. | Reword the two `deterministic.ts` comments. `types.ts:152` is in the frozen 2.1.1 block: record it as an accepted exception. |
| QA-2.1-8 | info | **Duplicate change-set entries under a Windows 8.3 short-name directory.** `pathKey` does not canonicalise short names. A tool-observed path under `C:\Users\MARQUI~1\…` and the realpath'd snapshot path of the same file are two entries; the repro printed `\src\b.js` and `C:\Users\Marquinho\…\src\b.js` for one file. The snapshot's status and `previousPath` then do not override the tool entry (`dispatch.ts:221-228`). This fails safe (wider scope), but a deletion seen through the short spelling keeps status `modified`. | Key by the realpath of the dispatch cwd (or a root-relative path), or canonicalise tool paths through native `realpath` of their parent. |
| QA-2.1-9 | info | **A live `node_modules` that is itself a junction is not usable at the reference.** Repro scenario A, attempt 1: the recheck returned `reference unusable (rerun-unplannable): runner not installed: vitest` (unverifiable; fails closed). The cause was not isolated; most likely materialize does not link a `node_modules` that is itself a link. | None required unless linked-`node_modules` layouts are supported; if so, follow the link when materialize links `node_modules`. |
| QA-2.1-10 | nit | **`INERT_UNREPRODUCED` matches the last path segment anywhere** (`deterministic.ts:752-774`). An ignored `test/fixtures/logs/` directory, or an ignored `*.log` fixture that a test reads, therefore counts as inert. T4.f asks for evidence that tests cannot read an inert entry. | Anchor the directory patterns (e.g. `coverage/` and `.nyc_output/` at a package root), or exclude paths under test directories. Low priority. |

**Handoffs checked with no finding:**
- QA-1.3-16 and -17 (mutants killed).
- QA-1.5-7 (except QA-2.1-10) and QA-1.5-4 (mutants killed).
- QA-1.5-10: GC, then materialize, both inside the hold (`deterministic.ts:1099-1116`).
- PlannerFs: native `realpath`, `stat` with bigint, `readdir` (`wiring.ts:236-241`).
- TestSearchSeam: `git ls-files` / `git grep` through argv, low priority, deadline-bound (`wiring.ts:253-281`).
- `previousPath` and `TreeSnapshot.root` (`tree.ts`).
- `warnDeprecatedVerifyKeys` after every plugin-path `loadConfig` (`index.ts:115` and `:131` are the persistence helpers).
- The `captureWaitMs` clamp (`config.ts`).
- `tiers.json` `gateBudgetMs` removed.
- QA-1.5-25: no per-call `maxBuffer` (`wiring.ts:204-220`).
- No test command at dispatch: `captureDepsFor` only calls `captureReference`.
- Native `task` gate: `withTimeout`, abort and `unverifiableGateResult` (mutant killed).
- Every deadline, timer and listener is disposed or removed on each path read.

**Status: NOT CLEAN.** QA-2.1-1 and -2 are critical false passes on the default config.
