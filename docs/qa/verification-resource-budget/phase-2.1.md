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
