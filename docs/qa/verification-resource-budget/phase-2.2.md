# Phase 2.2 — Batching coordinator (S5): QA report

## Pre-flight

- **Worktree:** `D:\git\omr-p22`, branch `vrb/p22`, based on `vrb/wave-2` at `5a79c0b` (the same
  base as `vrb/p21`). `git status` was clean before task 2.2.1.
- **2.1.1 contract types:** `5be8c85` (`feat(verify): add the testsPass pipeline contract types`)
  was fetched from `origin/vrb/p21` and cherry-picked cleanly as `f6776d5`. It touches only the
  "testsPass pipeline contract" block of `src/verify/types.ts`. Phase 2.2 never edits that block:
  a different copy on each branch would conflict at merge.
- **Typecheck:** `npm run typecheck` is clean after the cherry-pick and after the design commit.
- **Full suite:** not run. The orchestrator owns the serialized full-suite run (§0.6.7). The design
  commit changes no behaviour: `src/verify/batch.ts` is new, and nothing imports it yet.
- **Inputs read:**
  - plan §1.3 (S5), §1.4 (`batchWindowMs`), §1.5-13/18/19, §1.6, Phase 2.2 and Phase 2.4
    (`router_verify` and background mode run through this coordinator);
  - `src/verify/types.ts`, the 2.1.1 block;
  - the testsPass header in `origin/vrb/p21:src/verify/deterministic.ts` (`7cd793d`), T1-T11;
  - `src/verify/runner.ts` sections G, H, I, J and Q, and the `ScopedSpec`, `RunResult`,
    `planScopedRun`, `planRerun`, `readResult` and `detectRunner` contracts;
  - `DispatchReference` in `src/verify/reference.ts`.

### Spike C result: attribution mode B

Recorded from `docs/qa/verification-resource-budget/phase-1.3.md`, section "vitest 4.1.11 — `list`
(S5 decision)", lines 83-124. `runner.ts` section J restates the decision.

- **vitest 4.1.11 has no non-executing listing of the tests related to a given set of files.**
  - `vitest list --related src/math.js` fails with an unknown-option error (exit 1).
  - `vitest list src/math.js` and `vitest list related src/math.js` treat their arguments as
    test-file name filters and print nothing.
  - `list --changed` is git-based, so it cannot take the caller's file set.
  - Default `list` imports test modules. Only `--filesOnly` and `--staticParse` avoid that.
- **jest 30.5.2 has one** (`--findRelatedTests … --listTests`, lines 126-164). A jest-only mode A
  was still rejected (runner.ts J):
  - mode B must exist for vitest anyway, and a second attribution path would double 2.2's test
    matrix for a saving that only appears on the failure path;
  - `--listTests` is still one process per request (a haste-map build).
- **Decision: attribution mode B.** When a vitest/jest union run fails and the batch has more than
  one request, each request's own `planScopedRun` spec runs again, all under the batch's single
  slot hold. `related` cannot be intersected with a file filter, so "re-run the failing files
  scoped to the request" means the request's own spec. Each request is charged the failures its
  own run reproduces. A union failure that no per-request run reproduces (a flaky test) must not
  become a pass for anyone.
- **pytest: `inputsAreTests` attribution, with no process.** `planScopedRun` computes the pytest
  affected set itself, so `ScopedSpec.inputs` are the test files (`inputsAreTests: true`). A
  failing pytest file is charged to every request whose own plan's inputs contain it, with no
  process started (runner.ts J; phase-1.3.md records the pytest affected-set mapping under G.8).

## Design notes / deviations

Task 2.2.1 produced the design header of the new file `src/verify/batch.ts` (sections B1-B16) and
its exported contract. The bodies throw `not implemented: batch.<name> (Task 2.2.2)`. The header
is the specification. This list records the decisions that go beyond the plan text, and why.

1. **Equivalence is the design rule (B-G1).** Each request receives one of two outcomes. Either it
   is its own run's outcome, verbatim, or it is a result derived from the union run that is proven
   to judge the same way. Every case the coordinator cannot prove falls back to the request's own
   run under the same slot hold. That fallback is never a guess, and it is never a wider run.
2. **Batch key (D1).** The key is `(gitRoot, runner, entry, env signature)` plus `file`, `cwd` and
   the argv template (the args without the inputs, with the report path masked). Two commands can
   resolve to the same entry and still differ in kept arguments (`-t`, `--project`, `-k`), in the
   worker cap, or in pytest's pinned `-c`/`--rootdir`. Merging such requests would run one
   request's options for both.
3. **The union is planned by `planScopedRun`** (runner.ts Q 2.2), then checked against the
   members: the same key, and inputs equal to the union of the members' inputs. On any mismatch
   the batch splits into per-request runs. Mismatches include a union-only S6 (`argv-too-long`,
   `too-many-searches`, `config-too-large`), a pytest pin taken from a different common ancestor,
   and a search that answered differently. Merging the members' specs by hand was rejected: it
   would duplicate runner.ts H (argv construction, the length cap, pinning) outside runner.ts.
4. **The zero-test guard on green unions (D5, prerequisite P1).** `readResult` makes a run
   incomplete when it reports 0 tests and a test file was among its inputs (runner.ts I step 2a,
   QA-1.3-19). A green union cannot show that one member's own run would have reported 0 tests.
   Passing that member would be a false green that the member would not get alone (for example,
   an e2e spec excluded by the runner config, QA-1.3-37).
   - The design needs per-file test counts. P1 adds `RunResult.testsByFile` to `readResult`, an
     additive runner.ts change (task 2.2.2.a).
   - runner.ts has no Wave-2 owner in the §2 map, and neither 2.1 nor 2.4 writes it, so the
     addition cannot conflict. It still needs the orchestrator's approval as a write-set addition.
   - Without P1 the coordinator stays correct. Each such member gets a confirmation run instead,
     at the cost of most of the saving on implementation delegations.
5. **Mode B's cost (D2).** A failing vitest/jest union spends 1 + n runs. The plan's acceptance
   criterion, "≤ 1 scoped run + ≤ 1 recheck per window", holds on the green path, on the pytest
   path and with a shared reference. The 2.2.3 wiring test asserts it there, and asserts 1 + n on
   the vitest failing path. That is the cost of mode B, which the plan's pre-flight selects.
6. **Flaky taint (B7.5).** Suppose a union failure id is reproduced by no member's own run. Then
   every member's result is marked `complete: false`, with a note naming the ids. Under 2.1-T6
   that result never passes, while a proven introduced failure still rejects.
7. **One shared recheck per distinct reference (D3).** A recheck at one dispatch reference proves
   nothing about another. Requests are grouped by a structural reference key: root, commit, and
   the untracked, tracked and captureReasons entries, with `capturedAt` excluded. One recheck runs
   per group, over the union of the group's failing files, and each member's outcome is derived
   from it. When a group's shared rerun fails for a run-level cause (`incomplete`,
   `collection-error`, `no-tests`, `rerun-unplannable`), the cause may lie in another member's
   files, so each member is rechecked alone. The plan's "single shared recheck" holds when the
   requests share a reference: the members of one dispatch, or captures of the same clean HEAD.
   Distinct stash commits never share.
8. **Deadlines (B9).** Each requester keeps its own deadline. The batch deadline has no timer of
   its own:
   - its remaining time is the largest among the members not yet settled;
   - it aborts only when every attached member has aborted.

   A requester whose deadline passes is settled at once. The result depends on its phase: aborted
   in the window, during the union run, or while queued for attribution; or a recheck "timed-out".
   The batch continues for the others. A member's own run and a single-member recheck use the
   member's own deadline, exactly as the direct path does.
9. **Maximum window size (D4)** is a coordinator option, `BATCH_MAX_REQUESTS = 8`, not a config
   key. `config.ts` is outside 2.2's write set, and the value only bounds the worst-case slot hold
   of mode B (1 + 8 runs).
10. **The runtime arrives per gate (D6).** The coordinator is created once per plugin instance.
    Each gate calls `hook(runtime)` with its own direct hook, planner, scope opener, window length
    and recheck threshold, so a config reload reaches the next window with no new coordinator.
    `recheckMinRemainingMs` is injected (2.1's `RECHECK_MIN_REMAINING_MS`), so 2.2.2 has no
    runtime dependency on 2.1's unmerged `deterministic.ts`.
11. **Starvation (W2).** A window's close time is fixed when it opens. Arrivals never push it back,
    and a full window closes at once. Requests that arrive while a batch plans, waits or runs go to
    the next window. No request waits in a window longer than `batchWindowMs`. A joining request
    whose budget would run out before the close closes the window at once (W3).
12. **Bypasses (B2).** The following requests never enter a window:
    - `testScope: "full"`;
    - `batchWindowMs <= 0`, which goes to 2.1's direct hook;
    - planning outcomes (S6 unverifiable, including "unavailable" attribution; NoAffected; a
      planner error);
    - an already-aborted deadline.

    None of them takes the slot.

### Exported contract (`src/verify/batch.ts`)

```ts
export const BATCH_MAX_REQUESTS = 8;
export const BATCH_STALE_GRACE_MS = 60_000;
export const BATCH_REASONS = {
  disposed: "verification coordinator disposed",
  beforeRun: "gate budget exhausted before the scoped run",
  window: "gate budget exhausted waiting for the batch window",
  run: "gate budget exhausted during the scoped run",
  attribution: "gate budget exhausted during batch attribution",
} as const;
export type BatchPlanInput = Pick<TestsPassRequest, "command" | "cwd" | "changedFiles">;
export type BatchPlanner = (input: BatchPlanInput, deadline: Deadline) => Promise<ScopingPlan>;
export interface BatchRuntime {
  readonly direct: TestsPassHook;
  readonly plan: BatchPlanner;
  readonly openScope: OpenVerificationScope;
  readonly batchWindowMs: number;
  readonly recheckMinRemainingMs: number;
  readonly failureRecheck: boolean; // QA-2.2-2: the gate-time setting, read per request
}
export interface BatchTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface BatchCoordinatorOptions {
  readonly maxBatchSize?: number;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  readonly timers?: BatchTimers;
  readonly logger?: Pick<PluginLogger, "warn">;
}
export interface BatchStats {
  readonly openWindows: number;
  readonly runningBatches: number;
  readonly pendingRequests: number;
  readonly unionRuns: number;
  readonly ownRuns: number;
  readonly rechecks: number;
  readonly splits: number;
  readonly taints: number;
}
export interface BatchCoordinator {
  hook(runtime: BatchRuntime): TestsPassHook;
  sweep(): number;
  stats(): BatchStats;
  dispose(): Promise<void>;
}
export function createBatchCoordinator(options?: BatchCoordinatorOptions): BatchCoordinator;
export function envSignature(env: Readonly<Record<string, string>>): string;
export function argvTemplate(spec: ScopedSpec): readonly string[];
export function batchKey(spec: ScopedSpec, platform: NodeJS.Platform): string;
export function referenceKey(reference: DispatchReference): string;
export interface BatchMemberChanges { readonly cwd: string; readonly changedFiles: readonly ChangedPath[] }
export function unionChangedFiles(members: readonly BatchMemberChanges[], platform: NodeJS.Platform): ChangedPath[];
export function isGuardSensitive(spec: ScopedSpec, platform: NodeJS.Platform): boolean;
export function fileKeyOf(cwd: string, absolutePath: string, platform: NodeJS.Platform): string;
export type TestCounts = Readonly<Record<string, number>>;
export type OwnRunCause = "not-comparable" | "zero-test-ambiguous" | "mode-b";
export type UnionAttribution =
  | { readonly kind: "derived"; readonly result: RunResult; readonly exitCode: number }
  | { readonly kind: "own-run"; readonly cause: OwnRunCause };
export function attributeUnion(union: RunResult, counts: TestCounts | undefined, member: ScopedSpec, platform: NodeJS.Platform): UnionAttribution;
export function taintUnreproduced(result: RunResult, unreproduced: readonly string[]): RunResult;
export function deriveSharedRecheck(shared: RecheckOutcome, counts: TestCounts | undefined, failingFiles: readonly string[], cwd: string, platform: NodeJS.Platform): RecheckOutcome | "split";
export interface BatchDeadline extends Deadline { release(member: Deadline): void; dispose(): void }
export function createBatchDeadline(members: readonly Deadline[]): BatchDeadline;
```

### Task breakdown

The full breakdown is in `batch.ts` B16. In brief:

- **2.2.2** runs on `vrb/p22`, in parallel with 2.1.2-2.1.6. It never touches `wiring.ts`,
  `index.ts` or `deterministic.ts`.
  - **a** runner.ts P1 (`RunResult.testsByFile`), only with approval.
  - **b** the pure helpers, with table tests.
  - **c** the coordinator core: windows, bypasses, union run, deadlines and disposal, tested
    under fake timers.
  - **d** attribution (mode B, pytest static attribution, confirmation runs, flaky taint) and the
    shared recheck.
  - **e** the equivalence property test (seeded PRNG, ≥ 300 cases, fake runner seam, a
    2.1-T5/T6 oracle), with coverage ≥ 90%.
- **2.2.3** starts after 2.1 is merged.
  - **a** `wiring.ts`: one coordinator per plugin instance. `coordinator.hook(runtime)` replaces
    the direct hook in `buildGateDeps`, the TTL sweep calls `sweep()`, and `batch.ts` switches to
    2.1's `fileKeyOfId`.
  - **b** `test/unit/batch-wiring.test.ts`: 5 concurrent gates and the spawn counts of B13; the
    verdicts equal those with `batchWindowMs: 0`; the property with 2.1's `judgeScoped`; one slot
    acquisition per batch.

### Open questions for the orchestrator

1. Approve P1 (runner.ts `RunResult.testsByFile` + `test/unit/runner.test.ts` cases) as a 2.2
   write-set addition? Without it 2.2.2 skips task a, and green batches with test-file changes pay
   confirmation runs.
   **Decided: approved** by the orchestrator. P1 landed as `e4ab59b`. The QA-2.2-1 root fix in
   runner.ts (`3fd26e4`) was approved under the same write-set addition.
2. Is the acceptance reading in note 5 accepted? The criterion "≤ 1 scoped run + ≤ 1 recheck per
   window" would hold on the green path, on the pytest path and with a shared reference. On the
   vitest/jest failing path, 1 + n runs are expected under mode B.
   **Decided: accepted** by the orchestrator (deviation D2). QA round 1 treats it as an approved
   deviation.

## Task 2.2.2 record (QA-2.2-7)

- **Commits (2.2.2):** `e4ab59b` (a, runner.ts P1 `testsByFile`), `3745902` (b, pure helpers),
  `19058fa` (c, coordinator core), `95fc4f4` (d, attribution and shared recheck), `0791c91` (e,
  the B12 property). **Round-1 fixes:** `3fd26e4`, `5827256`, `94dec74`, `00129c3`, `ae69340`,
  `c041ad6` and `7f3d0a8` (see Resolutions below).
- **Tests:** `npx vitest run --maxWorkers=2 --coverage --coverage.include=src/verify/batch.ts
  test/unit/batch.test.ts test/unit/runner.test.ts` → Test Files 2 passed (2), Tests 866 passed
  (866): `batch.test.ts` 149, `runner.test.ts` 717. The B12 property runs 300 seeded cases (6
  chunks of 50). `npm run typecheck` is clean. The full suite was not run (§0.6.7).
- **Coverage of `src/verify/batch.ts`** (v8, same run): statements 96.93%, **branches 92.85%**,
  functions 99.2%, **lines 98.35%**. That meets the ≥ 90% lines and branches of B16 2.2.2.e and the
  plan's DoD. Uncovered: L1199-1200 (a defensive `settleLate` branch for a member with no outcome,
  unreachable because held and ready members always have one) and L1439-1444 (sweep's eviction of
  a window with no live member, which `leaveWindow` already deletes).
- **Mutation check, re-run on the final state** (in-place mutants of `batch.ts` and `runner.ts`,
  each restored from a copy afterwards; "B12" = `batch.test.ts -t B12`, "file" = all of
  `batch.test.ts`):

  | mutant | result |
  | --- | --- |
  | M7 `deriveSharedRecheck` ignores `total === 0` | killed by B12, 1 chunk (survived in round 1) |
  | M9 `batchKey` without `argvTemplate` | killed by B12, 1 chunk (survived in round 1) |
  | runner.ts: a key shared by two inputs goes to the first input (the QA-2.2-1 bug) | killed by B12, 2 |
  | runner.ts: the classname walk stops at the first hit | killed by B12, 3 |
  | runner.ts: the pinned rootdir is ignored (suffix map only) | survives B12: it only makes more unions ambiguous, hence incomplete and run per member, which costs runs, not verdicts; killed by 6 unit tests (`runner.test.ts` and the `batch.test.ts` QA-2.2-1 cases) |
  | `referenceDecision` ignores `failureRecheck` (QA-2.2-2) | killed by B12, 6 |
  | `attributeUnion` always derived for vitest/jest (M1) | killed by B12, 8 |
  | flaky taint disabled | killed by B12, 6 |
  | the taint counts unmapped pytest ids (see QA-2.2-6 below) | killed by file, 1 |
  | derived ids of settled pytest members not counted (QA-2.2-3 c) | killed by file, 1 (a unit test: B12 has no deadline expiry, by design) |
  | held members wait for every own run (the round-1 schedule) | killed by file, 13 |

## QA findings (round 1)

Adversarial senior review of `git diff 5a79c0b..HEAD` on `vrb/p22` (f6776d5, 5921f6e, e4ab59b,
3745902, 19058fa, 95fc4f4, 0791c91). Wiring (2.2.3) is out of scope. Checked against the frozen
contract block of `src/verify/types.ts` (5be8c85, unchanged on `origin/vrb/p21`), plan Phase 2.2
and the S5 row / 1.5-13, and the 2.1 truth table (`origin/vrb/p21:src/verify/deterministic.ts`
T2-T7) plus 2.1's actual direct hook (`createDirectTestsPassHook`, e4b512e). Approved deviations
(extended key, mode B 1 + n, size cap option 8, per-reference shared recheck) are not reported.

**Test run** (once, as dispatched): `npx vitest run --maxWorkers=2 test/unit/batch.test.ts
test/unit/runner.test.ts` → Test Files 2 passed (2), Tests 837 passed (837), 1.88 s.

**Mutation check of the property test** (B12, "batched verdicts equal solo verdicts"). Each mutant
was a scratch copy of `batch.ts` in `%TEMP%` run against a copy of `batch.test.ts` (129 tests;
the unmutated control passes 129/129). Scratch files were deleted afterwards.

| mutant | change | batch.test.ts result | killed by B12? |
| --- | --- | --- | --- |
| M1 | `attributeUnion` always returns `derived` with the union's result | 34 failed | yes |
| M2 | 7.3b mode-b → derived green | 22 failed | yes |
| M3 | 7.2b JS zero-test-ambiguous → derived green | 5 failed | yes ("false pass", seed 11070) |
| M4 | 7.2a ignores `isGuardSensitive` | 14 failed | yes ("false pass", seed 11051) |
| M5 | flaky taint disabled | 7 failed | yes ("a member of the flaky batch judged ok") |
| M6 | `referenceKey` ignores `commit` | 7 failed | yes |
| M7 | `deriveSharedRecheck` ignores the zero-test count (`total === 0`) | 1 failed | **no** (table test only) |
| M8 | pytest 7.3a static ids dropped | 11 failed | yes |
| M9 | `batchKey` without `argvTemplate` | 5 failed | **no** (table tests only) |
| M10 | pytest n = 0 → derived green | 7 failed | yes ("false pass", seed 11034) |

The property test does catch the dispatched mutation (M1) and most attribution mutants. Its blind
spots are listed in QA-2.2-6.

### Findings

| id | severity | evidence | fix |
| --- | --- | --- | --- |
| QA-2.2-1 | critical | **pytest static attribution trusts a classname→file map that depends on the input set, so a union can move a failure from one member to another and excuse its producer.** runner.ts `parseJunit` (L4759-4775) keys "each dotted suffix of each input … once (the first input wins a shared suffix)" and resolves a classname by walking its own prefixes. With union inputs `/r/sub/tests/test_x.py` (member B) and `/r/tests/test_x.py`, `/r/tests/test_y.py` (member A), pytest's classname `tests.test_x` for A's failing test hits B's suffix first. Scratch repro through the real `readResult` + `attributeUnion`: union `failingIds: ["sub/tests/test_x.py::test_1"]`, `testsByFile: {"sub/tests/test_x.py":2,"tests/test_y.py":1}`; solo A `failingIds: ["tests/test_x.py::test_1"]`; `attributeUnion(A)` = `{"kind":"derived", failingIds: [], total: 1, complete: true}`; `attributeUnion(B)` = derived failing with A's test. The flaky taint (batch.ts L1016-1022) does not fire, because B's derived ids "reproduce" the moved id. Verdicts (2.1-T6): batched A = R1 **P e1**; solo A = R2 with a pytest recheck (`runner-unsupported`, or D/none) = **V u4/u5**. Batched B = V where solo B = P. Preconditions: the same batch key (same pin), and one member's test path is a dotted suffix of another member's path, with the longer path sorting first (e.g. `app/tests/test_x.py` vs `tests/test_x.py`), which is common in monorepos and with `--import-mode=importlib`. 1.3 alone only misnames a failing file inside one request (still failing); 2.2's static attribution turns it into a cross-request pass. | Fix before 2.2.3. Either (a) batch.ts: when a pytest union's inputs are suffix-ambiguous (some input's gitRoot-relative dotted path is a proper dotted suffix of another input's), treat the union as not comparable (own runs, cause `not-comparable`) or split; or (b) runner.ts (needs a write-set approval): resolve a classname to the input whose full rootdir-relative dotted path matches, and treat an ambiguous classname as unmapped (forced incomplete). Add a table test with colliding suffixes that runs through the real `readResult`. |
| QA-2.2-2 | major | **The batch does not mirror the direct hook's `failureRecheck` check, so a batched request can pass where it would be unverifiable alone.** 2.1's direct hook (origin/vrb/p21 deterministic.ts L1221): `if (ref.kind === "disabled" \|\| !deps.budget.failureRecheck) return { kind: "disabled" };`. batch.ts `referenceDecision` (L1054-1064) reads only `request.reference`. p21 wiring.ts L349 maps `failureRecheck` off → `disabled` only when the reference is prepared (dispatch time). When the setting turns off between capture and gate (config reload, or a later `router_verify` under 2.4), the direct hook answers D → **V u5**, while the batch runs a shared or own recheck → X+ → **P n2**. The property oracle `directOver` (batch.test.ts L1774-1776) copies the batch's rule instead of the real hook's, so B12 cannot see this. | Carry the gate's `failureRecheck` in `BatchRuntime` and normalize each request in `hook(runtime)` before it joins a window (`captured` → `{ kind: "disabled" }` when it is off). The value must be per request, not the window opener's. Mirror the real hook in `directOver`, and add a case with a captured reference and `failureRecheck: false`. The wiring side is deferred by plan (2.2.3). |
| QA-2.2-3 | major | **Gate-budget interaction: a member that already has its outcome waits for every other member, and is then aborted.** Own runs go earliest-deadline-first (L937). Every member then holds its outcome until the taint (L942), and rechecks start only after all own runs (L945). `onAbort` in phase `queued` settles `aborted BATCH_REASONS.attribution` (L779-781) even when `m.scoped` is already set (`runOwn` L1040-1047, derived members L1007). So the member with the least time left runs first and waits longest. A failing member can also fall below `recheckMinRemainingMs` because of other members' runs (S → V u7), where alone it would reach X- (F r1) or X+ (P n2). With the defaults (gateBudgetMs 90 s, up to 1 + 8 sequential runs under one hold), the plan's own case "a pre-existing failure related to all requests → one shared recheck, all pass with the note" becomes V u13/u7 for most members once 5 members' vitest runs take ~15 s each (an estimate: 1 + 5 runs at ~15 s each is ≈ 90 s, before the recheck). Related: a member aborted during the union run (no `scoped`) leaves its union ids unreproduced (L1018-1022), which taints every other member, including pytest members whose attribution is exact. B-G1 excludes deadline expiry, so this lowers verdict quality and is not a false pass. It is still the plan's named adversarial focus. | (a) Settle a member as soon as its outcome can no longer be tainted: every union failing id is already reproduced by finished own runs or static derivations, or the union is green. Recheck such members immediately instead of after all own runs. (b) On an abort in `queued` with `m.scoped` known, settle with `taintUnreproduced(m.scoped, ids not yet reproduced)` plus `lateRecheck(m)` instead of a bare abort: still never a pass while anything is outstanding. (c) pytest: do not count ids whose file key belongs to a settled member's inputs as unreproduced (attribution is exact there). Add fake-timer tests with staggered deadlines. |
| QA-2.2-4 | minor | **`dispose()` and `sweep()` close a batch's scope while its seam may still be in flight.** `dispose` (L1270-1275) and `sweep` (L1245-1251) call `closeScope(b)` right after aborting D. The contract's `VerificationScope.close()` "waits for pending reference disposals, then releases the hold", not for an in-flight `execute`, so the slot can be released while the killed tree is still exiting. `dispose()` resolves before `runBatch` returns (L1277 awaits only `closing`), so B-G6 "nothing outlives dispose()" holds for timers and listeners but not for the in-flight seam. | Keep each batch's `runBatch` promise. `dispose()` aborts D, then awaits those promises (with a bounded grace), and lets `runBatch`'s `finally` close the scope. Keep the forced close in `sweep()` only for seams that are really hung, and log that the slot was released early. |
| QA-2.2-5 | minor | **An early-settled member's gate competes with its own batch for the slot.** A derived-green member settles right after the union (L1006), and every member settles before `void closeScope(b)` (L887). The batch keeps the hold for the other members' own runs and rechecks (up to 1 + 8 runs). 2.1's direct hook awaits `scope.close()` in its `finally` before returning, and 2.1-T2 P4/T8 assume a check's close is awaited before the gate's next S3 check. Under `maxConcurrentVerifications: 1`, the member's next command check (lintClean, run) waits for the whole batch and can end as slot-busy (V u14). There is no deadlock, since the batch never waits on that check, so this is not a QA-1.4-18 violation. | Record this in B10 as an accepted cost, or release members only when the hold ends for gates that still have S3 checks queued. Assert the behaviour in the wiring test: deferred by plan (2.2.3). |
| QA-2.2-6 | minor | **The property test has blind spots**, per the mutation table: M7 (the shared-recheck zero-test rule) and M9 (the argv template in the key) survive B12. By construction: `execute` returns the model's RunResult and never goes through `readResult`/`parseJunit` (so QA-2.2-1 cannot appear); one cwd per runner (`ROOT`, `PY`: L1846/L1852), linux only, no `lexicalPaths`, no split path; test counts are not per reference (B12 promised "a test count … both now and at each reference"); the fake runner ignores `-t`. `judgeStandIn` (L1747) maps every incomplete or collection-error result to V, while 2.1-T6 R2i/R3 × X- is F r1. B12's promised per-case assertions "exactly one scope per batch" and "spawns within the cost model (B13)" are missing: only `closes === opens` (L1937) and the timer count (L1938) are asserted. | Synthesize junit/json reports in the fake executor and parse them with the real `readResult`. Add suffix-colliding pytest paths, per-reference counts, `-t` filtering in the model, several request cwds and win32 keys. Assert `opens === number of batches` and the B13 spawn bounds for each case. The `judgeScoped` oracle is deferred by plan (2.2.3). |
| QA-2.2-7 | minor | **2.2.2.e deliverables are not recorded.** This report has no 2.2.2 section: the file was last changed by 5921f6e (design). No coverage figure is recorded for `batch.ts`, although B16 2.2.2.e and the plan's DoD require ≥ 90% of lines and branches. "Open questions for the orchestrator" still reads as open, although P1 and the D2 acceptance reading were approved. | Add the 2.2.2 record: commits, test counts, and the coverage of `src/verify/batch.ts` from a scoped `--coverage` run. Mark both questions as resolved, with the approval. |
| QA-2.2-8 | info | **Contract drift for 2.2.3.** 2.1's `CheckScope.rechecker(command, cwd, currentTree?)` (p21 deterministic.ts L782, direct hook L1223) forwards the gate's tree to `materialize`. batch.ts calls the frozen two-argument `VerificationScope.rechecker`, and `TestsPassRequest` carries no tree, so batched rechecks skip `materialize`'s same-repository guard. That guard is "never used to decide exactness" (reference.ts section 4 step 0), and `referenceKey` includes `root`, so no verdict changes. | Deferred by plan (2.2.3): either bind the opener's tree in the runtime's `openScope`, or accept the gap in B15. |
| QA-2.2-9 | nit | **Abort wording differs from the direct path.** A member aborted while the union waits for the slot gets `BATCH_REASONS.run` "gate budget exhausted during the scoped run" (L776-777), where alone it would get slot-busy with `deadlineCut` (u14 "…waiting for the verification slot"). B2.4 (L1209) answers `aborted` before planning, where 2.1's direct hook plans first (a NoAffected or S6 plan gives P n0 / V u15). Both differences are V, or more cautious than alone. | Document both in B9, or record the member's phase as `slot` until the first execute returns. |
| QA-2.2-10 | nit | **`void runBatch(b)` (L870) and the `void p.then(...)` in `closeScope` (L1199) have no rejection handler.** If the injected `logger.warn` throws inside `runBatch`'s `catch` or in `closeScope`'s `.catch`, the rejection is unhandled, and `dispose()`'s `Promise.all([...closing])` can reject, contrary to "never rejects". Unverified whether `PluginLogger.warn` can throw. | Wrap `warn` in try/catch, and end `runBatch`/`closeScope` chains with a terminal `.catch(() => {})`. |

### Resolutions (round 1)

**QA-2.2-1** (critical)
Resolution: `3fd26e4` — root fix in runner.ts I step 3, as approved. `parseJunit` maps a
classname by the exact rootdir-relative path. The rootdir is the last `--rootdir` of the spec's
argv (D.4's pin or the user's kept value, resolved against `spec.cwd`; a value pytest would expand
is not trusted). Every dot prefix of the classname is walked, so classes nested in the module stay
in the id. Without a trusted rootdir (an explicit `-c`, a `--rootdir` in `PYTEST_ADDOPTS`, the
unpinned QA-1.3-49 spawn), the gitRoot-relative suffixes are kept as candidates. In both modes, a
classname that more than one input answers is ambiguous: it is charged to no file, it is left out
of `testsByFile`, and the result is `complete: false` with the note `pytest classname maps to more
than one test file: <classname>`. This holds for failing and passing cases alike, so a batch with
such a union runs every member's own spec (7.1). "First input wins" is gone. The runner test that
pinned it now asserts the ambiguity. Regression through the real `readResult` + `attributeUnion`
(QA's scenario, `batch.test.ts` "QA-2.2-1"): with the pin, the owner of `tests/test_x.py` is
charged its failure, exactly as alone, and `sub/tests/test_x.py`'s owner derives green with its
own count. Without the pin, the union is not comparable. Both tests fail on the old runner.ts. B7.3a
records the dependency.

**QA-2.2-2** (major)
Resolution: `5827256` — `BatchRuntime.failureRecheck` carries the gate-time setting. Each member
keeps the value of the hook that submitted it, never the window opener's. `referenceDecision`
applies 2.1's rule first: `!failureRecheck` gives `disabled` for any reference. The property
oracle `directOver` now applies the direct hook's rule, not the batch's own, and draws the setting
per request. Unit test: a captured reference with the setting off gives `disabled`, per request,
whichever gate opened the window. The unit test and the property fail on the old batch.ts.

**QA-2.2-3** (major)
Resolution: `94dec74` (with `7f3d0a8`) — B5 steps 5-8 are one queue under the single hold,
earliest deadline first across own runs and rechecks. Scopes are never nested.
- A member's outcome is final once every union failing id is reproduced, or once no own run is
  left, in which case the taint is applied once.
- A final member settles at once, or rechecks at its turn. A later member at the same reference
  reuses a recorded recheck that covers its files (B8.6). Only outcomes that hold for any member
  are reused: exact, approximate, and unusable `reference-vanished`, `unreproduced-inputs` or
  `runner-unsupported`. Never a deadline-bound one, nor `materialize-failed` or `error`.
- A member that aborts after its outcome is known settles with that outcome, not a bare abort.
  While a union failure is unexplained the outcome is made incomplete with those ids (never a
  pass), and its recheck becomes its reference decision, else `skipped-deadline` (B9 table).
- QA's (c): pytest derivations of members that left during the union still count as reproduced.
- The recheck threshold is unchanged: a member below `recheckMinRemainingMs` gets
  `skipped-deadline`.
- Plan-case test (5 requests with a shared pre-existing failure, 90 s budgets, a 10 s threshold,
  15 s per run): the first three members pass with the note (pre-existing at the exact reference)
  at 45.1 s, 60.1 s and 75.1 s, with one recheck. The other two cannot fit their own runs in 90 s
  and are unverifiable, never a false pass. A request alone passes. On the old schedule every
  member held its outcome until all 1 + 5 runs had ended (90.1 s), so each was aborted at its
  90 s deadline.
- More tests cover the EDF interleaving, an abort while held, an abort while waiting for a recheck
  turn, a pytest member leaving mid-union, and reuse hits and misses.

**QA-2.2-4** (minor)
Resolution: `00129c3` — `dispose()` no longer closes a scope right after aborting D. It awaits
each running batch's promise, and `runBatch`'s `finally` closes the scope only after the in-flight
seam has returned, that is once the killed tree has exited. The wait is bounded by
`BATCH_STALE_GRACE_MS`, with one injected timer that is cleared afterwards. A batch still running
after that goes through the same `evict` path as `sweep()`, which logs that its slot is released
before the seam exits. Tests: the slot is released only after the tree exits; a hung seam is
evicted after the grace, with no timer left; a seam that returns after eviction does not close the
scope a second time (`7f3d0a8`).

**QA-2.2-5** (minor)
Resolution: `00129c3` — documented in B10 as an accepted cost, the minimal fix. An early-settled
member's next S3 check may wait for its own batch's hold, and can end slot-busy (u14). It cannot
deadlock: the batch never waits on a gate or another scope, a settled member is released from D,
and every batch step is bounded by a remaining member's deadline. The wiring assertion is deferred
by plan (2.2.3).

**QA-2.2-6** (minor)
Resolution: `c041ad6` (with `5827256`) — B12 was rebuilt.
- The fake executor writes real vitest JSON and pytest junit reports and parses them with the real
  `readResult`. The pytest reports use a pinned `--rootdir` or an explicit `-c`, suffix-colliding
  paths (`tests/test_x.py`, `sub/tests/test_x.py`, `app/tests/test_x.py`), a module next to a
  package of the same name, and nested classes.
- Requests come from several cwds. About a third of the cases use win32 paths, some spelled in
  another case. `-t smoke` filters the tests now and at the reference. Test counts differ per
  reference, including zero.
- Each case asserts one scope per batch and the B13 spawn bounds: a batch of one is the direct
  path; a not comparable union or mode B runs 1 + n; pytest runs 1; a green union runs
  1 + ambiguous members, with no recheck; rechecks ≤ n + distinct references.
- `judgeStandIn` ports 2.1's `judgeScoped` rules (T5/T6), so R2i/R3 × X- is a rejection.
- Tallies require more than 10 hits each for win32 batches, multi-cwd batches, suffix-colliding
  unions (pinned and unpinned), `-t` batches, recheck reuse and flaky members.
- M7 and M9 are now killed, and so is a revert of the QA-2.2-1 mapping (see the 2.2.2 record).
- The stronger property found one more divergence, toward caution. An unpinned pytest union whose
  classname is ambiguous keeps a raw id (`tests.test_x::t1`) that no own run can reproduce, so the
  flaky taint made every member unverifiable. Such ids name no input and only occur in an
  incomplete union, whose members all run their own specs, so the taint now leaves them out (B7.5).
  There is a deterministic test for it.
- The real `judgeScoped` oracle stays deferred by plan (2.2.3).

**QA-2.2-7** (minor)
Resolution: `735e110` — see "Task 2.2.2 record" above: commits, test counts, `batch.ts`
coverage (lines 98.35%, branches 92.85%), and the mutation re-run. Both open questions are marked
as decided, with the approval.

**QA-2.2-8** (info)
Resolution: deferred by plan (2.2.3); unchanged in this round.

**QA-2.2-9** (nit)
Resolution: `ae69340` — a request whose deadline is already aborted is planned first, as in 2.1's
direct hook. A NoAffected or S6 plan therefore gives the same outcome as alone, and only a spec
gets `ABORTED_BEFORE_RUN` (B2.4-5). `BATCH_REASONS.beforeRun` and `.run` are asserted to equal
2.1's `ABORTED_BEFORE_RUN` and `ABORTED_DURING_RUN` verbatim. B9 records why a member cut while
the union waits for the slot reports `ABORTED_DURING_RUN` rather than slot-busy
(`SLOT_DEADLINE_REASON`): the scope does not expose when its first execute took the hold. Both
are unverifiable.

**QA-2.2-10** (nit)
Resolution: `ae69340` — the coordinator's `warn` wraps the logger. A logger whose `warn` throws
is dropped for the coordinator's life, so neither `runBatch`, a scope close nor `dispose()` can
reject. Test: a throwing logger during an internal failure, a split and a failing close gives no
unhandled rejection, and `dispose()` resolves. On the old batch.ts, vitest reports an unhandled
rejection.

### Verified without a finding

- **Starvation:** `closeAt` is fixed at opening (L831), and the key is deleted before any async
  step (L850, W4). Arrivals never extend a window, and a full window or a W3 joiner closes it
  at once (L841).
- **Memory:** windows leave the map on close or when empty (L805-809). `running` is cleared in
  `finally` (L884). Member abort listeners are removed in `settle` (L753). Batch-deadline and
  group listeners are removed on release/dispose (L1626-1633, L1593-1596). `linkDeadline`
  unlinks after each seam call, and on its own abort (L695-702).
- **One slot hold per batch (QA-1.4-18):** exactly one `openScope` per batch (L914), after
  union planning. The union run, own runs and rechecks are awaited one at a time on that scope.
  Nothing in a batch waits on another batch or another scope.
- **Never a rejection:** `hook` wraps `submit` in try/catch (L1225-1230). A `join` promise
  resolves only through `settle`, and `runBatch`'s `finally` settles every member (L883).
- **Union spec:** the union is planned by `planScopedRun`, then checked for key equality and set
  equality of inputs (L973-976). `lexicalPaths` is not in the key, which is safe: a
  lexical member is guard-sensitive, and a lexical union can only be less complete.
- **Early exit cannot truncate a pytest union:** `-x`/`--maxfail` are dropped and
  `--maxfail=0` is appended (runner.ts L4394). vitest/jest `bail` only matters on the
  failing path, which runs mode B's verbatim own runs.
- **testsByFile keys:** vitest/jest use `relSlash(spec.cwd, s.name)`, the same prefix as the
  ids (runner.ts L4673-4679). pytest uses `relOf(hit.file)`, as its ids do (L4805, L4843).
  Collection pseudo-cases are excluded (L4819-4822). Unmapped cases are excluded, and they
  force the run incomplete, so a union with them is not comparable.
- **Shared recheck derivation vs 2.1-T4/T5:** keys are matched in the live spec's cwd space.
  An uncovered file splits, and so does a ran file with no shared result. All-absent → `exact`
  with `result: undefined` (T4.h). The zero-test rule with counts gives `incomplete` (T4.k).
- **Deferred by plan (2.2.3):** coordinator wiring, sweep hook-up, `fileKeyOfId` import,
  `judgeScoped` oracle, batch-wiring spawn counts. **Deferred by plan (2.4):** `router_verify`
  and background mode through the coordinator.

## QA re-review (round 2)

Adversarial review of `git diff 577522f..HEAD` on `vrb/p22` (3fd26e4, 5827256, 94dec74, 00129c3,
ae69340, c041ad6, 7f3d0a8, 735e110, f99e93c). Code cleared in round 1 was only re-read where the
diff touched it or where a new path reaches it. This is the second round: under the owner's rule,
only major, critical and blocking findings get fixed after it. Each severity below is justified,
and the critical one has a reproduction.

**Test run** (once, as dispatched): `npx vitest run --maxWorkers=2 test/unit/batch.test.ts
test/unit/runner.test.ts` → Test Files 2 passed (2), Tests 866 passed (866), 1.81 s.

**Method.** All scratch work ran in a `%TEMP%` copy of `src/` and the two test files, with a
junction to `node_modules`. The worktree was not edited. The copy was deleted afterwards.

- **Real pytest reports.** Scratch tests pass synthesized junit through the real `readResult` and
  the real `createBatchCoordinator`. A pytest 9.0.2 run confirmed the one report shape that
  matters to the finding: `parametrize('expr', ['1 > 0'])` writes
  `<testcase classname="tests.test_x" name="test_cmp[1 &gt; 0]">`.
- **Comparison with 577522f.** `runner.ts` at `577522f` was loaded next to HEAD's.
- **Mutation runs.** Each mutant was an in-place change in the copy, restored after its run. "B12"
  means `batch.test.ts -t B12` (9 tests). "files" means both test files (866 tests).

### Round-1 findings: verdicts

| id | verdict | evidence |
| --- | --- | --- |
| QA-2.2-1 (critical) | **fixed** | **Pinned mode** keys each input once, by its exact rootdir-relative path (`parseJunit`, L4793-4809). A key two inputs share is ambiguous, and ambiguous or unmapped makes the run `complete: false`. **Reporting shapes checked through the real `readResult`:** nested classes (`tests.v1.2.test_x.TestA.TestB` → `tests/v1.2/test_x.py::TestA::TestB::test_m[1.5-a.b]`), a parameter id containing `::`, `/` and `.` (`test_p[x::y/z.py]`), a rootdir with spaces and Unicode below gitRoot with the cwd under the rootdir, win32 with the rootdir in another case (`c:\r` vs `C:\R\Tests\…` → `Tests/test_x.py::t1`), a relative `--rootdir=..`, and an input outside the rootdir, which fails closed for failing cases. All ids are correct. **Mutants:** "a shared key goes to the first input" is killed by B12 (2). "Pinned rootdir ignored" survives B12 and is killed by files (6), as recorded. Residual issues in the new mapping are QA-2.2-12 and QA-2.2-13. |
| QA-2.2-2 (major) | **fixed** | `Member.failureRecheck` comes from the submitting hook (L930), and `referenceDecision` applies 2.1's rule first (L1230). Mutant "failureRecheck ignored" is killed by B12 (6). |
| QA-2.2-3 (major) | **fixed** | **Code:** no member settles with a derived or own "ran" outcome before `b.final`. `release` is only reached from `advance` once the batch is final (L1152). Held and recheck-wait aborts go through `settleLate`, which taints with `outstanding(b)` while not final (L1202). `settle` is guarded (L862), so no member resolves twice. Reuse keeps only `exact`, `approximate` and `REUSABLE_CAUSES` (L1259-1268). `deriveSharedRecheck` splits whenever the recorded run does not cover the member's files (L1763). There is one `openScope` per batch (L1032), and nothing awaits another scope. The queue cannot spin: every step changes a phase or settles. **Mutants:** "final without waiting" is killed by B12 (6). "settleLate never taints" is killed by files (2). "Deadline order replaced by arrival order", "remember keeps deadline-bound outcomes" and "reuse ignores file coverage" each survive B12 and are killed by 1 unit test from 7f3d0a8; see QA-2.2-15. Two deadline-only nits are in QA-2.2-14. |
| QA-2.2-4 (minor) | **fixed** | `dispose()` aborts D and the in-flight Rg, then awaits each `b.run` (L1470-1491). The scope is closed only in `runBatch`'s `finally`, after the last seam returned (L1006). Own runs and single rechecks are linked to D (`linkDeadline`), so they are killed too. `evict` runs only after `BATCH_STALE_GRACE_MS`. A batch that sweep already evicted is not awaited again, and its scope is not closed twice (`closing` memo). |
| QA-2.2-5 (minor) | **accepted** | Documented in B10. No new nesting: a later request from a settled member's gate opens window N+1, and batch N never waits on it. |
| QA-2.2-6 (minor) | **fixed, with gaps** | B12 kills M1 (7), M5 (6), M7 (1), M9 (1), the QA-2.2-1 revert (2), the QA-2.2-2 mutant (6) and "final without waiting" (6). The gaps are QA-2.2-15: the pytest taint path is unreachable, names containing `" > "` are never drawn, and the reuse-coverage mutant survives. They let QA-2.2-11 through. |
| QA-2.2-7 (minor) | **fixed** | The record, coverage and test count (866) match this run. One discrepancy: the row "the classname walk stops at the first hit, killed by B12, 3" did not reproduce with the form "break at the longest hit", which survives B12 (9/9) and is killed by 1 runner unit test. The record does not state its mutant's form. Info only. |
| QA-2.2-8 (info) | deferred | Unchanged, by plan (2.2.3). |
| QA-2.2-9 (nit) | **fixed** | `submit` plans before the aborted check (L1412-1421). The reasons equal 2.1's phrases. |
| QA-2.2-10 (nit) | **fixed** | `warn` drops a throwing logger (L848-856). `runBatch`'s catch and finally, and `closeScope`'s chain, call only non-throwing code. `dispose()` awaits promises that never reject. |

### New findings (round 2)

| id | severity | evidence | fix |
| --- | --- | --- | --- |
| QA-2.2-11 | **critical** | **The B7.5 exclusion added in c041ad6 turns a pytest failure whose name contains `" > "` into a batched pass. Alone, the same request is unverifiable.** `taintable` (L1126-1131) keeps a pytest union id only when `idFileKey(id)` names an input. `idFileKey` (L1611-1616) cuts at `" > "` before `"::"`, so `tests/test_x.py::test_cmp[1 > 0]` is keyed `tests/test_x.py::test_cmp[1`. The same key drops the id from the owner's 7.3a derivation (L1693). The owner therefore derives `staticGreen` with n > 0, and the taint, the only net that caught this before c041ad6, no longer sees the id. **Reproduction** (real coordinator, real `readResult`, pinned `--rootdir=/r`, `parametrize('expr', ['1 > 0'])`, report shape confirmed with pytest 9.0.2). A owns `tests/test_x.py`: 1 failing, 1 passing. B owns `tests/test_y.py`: green. **Solo A:** `failingIds ["tests/test_x.py::test_cmp[1 > 0]"]`, recheck `unusable runner-unsupported`, so V (2.1 decision 5). **Batched A:** `{kind:"ran", failingIds:[], total:2, complete:true}` with recheck `undefined`, so **P e1**. Stats: `unionRuns 1, ownRuns 0, taints 0`. **With `taintable` returning every id** (the pre-c041ad6 behaviour), A and B are both `complete:false` with the note "batched run failure not reproduced … `tests/test_x.py::test_cmp[1 > 0]`", so never a pass. **Why the exclusion's premise is wrong:** B7.5 says such ids "only occur in an incomplete union". Here the union is complete, and the id does name an input. **Preconditions:** a pytest batch of ≥ 2 members, where every failing case of one member has `" > "` in its node id. This happens with any parametrized string such as a comparison expression, or with explicit `ids=`. | **Fix before 2.2.3.** (a) `taintable`: exclude an id only when `!union.result.complete`, which is the stated premise, so a complete union keeps every id. That alone restores B-G2. (b) Key pytest ids with the `"::"` rule. For `inputsAreTests`, the file part is before the first `"::"`; `" > "` is vitest/jest's separator. Apply this in 7.3a and `taintable`, or attribute by `failingFiles`. Otherwise a member with a mixed failure set is still charged only part of its ids. (c) Add a `" > "` name to the B12 pytest name pool. Note for the 2.1 owner: 2.1-T5's `fileKeyOfId`, which 2.2.3 will import, has the same rule. Its effect on 2.1's pytest judgments was not checked in this round. They are V anyway under 2.1 decision 5. |
| QA-2.2-12 | minor | **Unpinned mapping calls a single input "ambiguous" when it answers two prefixes of its own classname.** `map` (L4811-4826) marks `ambiguous` on a second hit without checking that the hit is a different input. Unpinned keys are every suffix of the gitRoot path, so `test_api/test_api.py` has the keys `test_api.test_api` and `test_api`, and its classname hits both. **Real `readResult`, input `/r/test_api/test_api.py` alone, no `--rootdir`, 2 passing cases:** HEAD gives `complete:false` with "pytest classname maps to more than one test file: test_api.test_api" (one input) and `testsByFile {}`. `577522f` gave `complete:true` with `{"test_api/test_api.py":2}`. HEAD with the pin also gives `complete:true`. So a green solo run becomes V (u12) instead of P, but only unpinned (explicit `-c`, or the QA-1.3-49 (a) spawn). This errs toward caution and is never a false verdict, hence minor. | In `map`, treat a second hit as ambiguous only when `file !== hit.file`, and keep the first (longest) hit. |
| QA-2.2-13 | minor | **Solo-path behaviour change, as designed: an unpinned solo run with nested duplicate paths is now incomplete.** Real `readResult`: a green run whose inputs are `sub/tests/test_x.py` and `tests/test_x.py`, unpinned. HEAD gives `complete:false` ("maps to more than one test file: tests.test_x"). `577522f` gave `complete:true`, with its count charged to the wrong file. So 2.1's direct path also moves from P to V (u12) for this layout when there is no pin. The change is fail-closed and intended by 3fd26e4. It is minor because it costs verdicts and never excuses. The rootdir is often knowable where the pin is absent. With `-c` and no `--rootdir`, pytest's `determine_setup` uses the ini file's directory; this was not re-verified in this round. `pytestPin`'s QA-1.3-49 (a) path already holds `run.setups[i].rootdir` (L3002-3005). | Accept (record in runner.ts I step 3), or give `parseJunit` the rootdir that planning already knows: the `-c` directory, or QA-1.3-49 (a)'s agreed rootdir. |
| QA-2.2-14 | nit | **Split rechecks step outside the queue.** In `recheckGroup`, members that wait for their turn in the split loop (L1332) stay in phase `recheck`. An abort there reports `timed-out` with the shared recheck's `boundMs` (L902-903), where the B9 table gives "reference decision, else skipped-deadline" to a member that waits for its turn. The loop also finishes every split recheck before the EDF queue resumes. So an own run with less time left waits for them. Both outcomes are V, and only deadline behaviour changes. | Set the waiting split members back to `recheck-wait` and let the queue order them, or document this in B9. |
| QA-2.2-15 | minor | **Blind spots of the rebuilt B12**, which let QA-2.2-11 through. (1) The pytest taint path is unreachable: every input-naming id is reproduced by some member's derivation (L1112), and the rest are excluded. The mutant "`taintable` returns `[]` for pytest" survives all 866 tests. (2) No pytest name contains `" > "`. (3) The mutant "reuse ignores file coverage" (`reuse` returns the recorded outcome on `"split"`) survives B12 and is killed by 1 unit test. So B12's reuse tally (> 10 hits) never draws a later member whose files the record does not cover. | Add `" > "` names and a flaky pytest id to B12, and draw reuse cases where a later member's files exceed the recorded run's. Test-only. |
| QA-2.2-16 | info | **Pre-existing, not introduced. Passing cases in a file outside the pinned rootdir count toward `total` but toward no file.** pytest writes `classname=""` for such a case (runner.ts L4871). `countCase` counts it in `total` and in no file, and a passing unmapped case does not set `unmapped`. Real `readResult`: input `/r/other/test_z.py`, `--rootdir=/r/sub`, 1 passing case gives `complete:true, total:1, testsByFile:{}`. Alone this is P. A batched member that owns only such files derives n = 0, which gives "ran no tests" (`complete:false`, V). This is toward caution and has been the case since P1 (e4ab59b). Round 1's "Verified" bullet ("unmapped cases … force the run incomplete") holds for failing cases only. | Optional: make a passing unmapped case force `complete:false` too, which gives an own run instead of a derived V. Or record the behaviour. |

**Mutation summary (round 2).** Killed by B12: M1 (7), M5 (6), "final without waiting" (6), the
QA-2.2-2 mutant (6), M7 (1), M9 (1), and the QA-2.2-1 "first input" revert (2). Survive B12 but
killed by unit tests: "settleLate never taints" (2), "deadline order → arrival order" (1),
"remember keeps deadline-bound outcomes" (1), "reuse ignores file coverage" (1), "walk stops at
the longest hit" (1), and "pinned rootdir ignored" (6). Survives everything: "pytest ids never
taint" (QA-2.2-15). Control: B12 9/9.

**Round-2 verdict.** All round-1 findings are fixed or accepted as recorded. One new
**critical** remains, QA-2.2-11, a false pass introduced by c041ad6's B7.5 exclusion. It must be
fixed before 2.2.3. The rest are minor, nit or info, and under the owner's rule they are not
fixed.

### Resolutions (round 2)

**QA-2.2-11** (critical)
Resolution: `0e89ef1` — fixes (a) and (b), and the test part of (c). (a) `taintable` keeps every
failing id of a complete union. It drops an id that names no input only when the union is
incomplete, which is B7.5's premise. (b) `idFileKey` cuts an id at the earliest `" > "` or `"::"`,
so `tests/test_x.py::test_cmp[1 > 0]` is keyed `tests/test_x.py`. It is batch.ts's only rule for
getting a file from an id, used by 7.3a, `taintable` and B8.5. The judge stand-in in the test
follows it too (2.1-T5 now states the same rule). (c) Three new tests. An `attributeUnion` row. A
complete pytest union with an id that names no input taints both members. A regression through the
real coordinator and the real `readResult` with `classname="tests.test_x" name="test_cmp[1 &gt; 0]"`.
Solo and batched A are both `failingIds ["tests/test_x.py::test_cmp[1 > 0]"]` with
`runner-unsupported`, so both are unverifiable. B passes. Stats are `unionRuns 1, ownRuns 0,
taints 0`. B12's pytest name pool adds `test_cmp[1 > 0]` and `TestK::test_gt[a > b]`, and the
report escapes them as pytest does. New tallies require > 10 cases with a failing `" > "` name and
> 10 multi-member pytest unions with such an id. **Checked against the old batch.ts** (only
`src/verify/batch.ts` stashed): 7 tests fail. They are the regression test, the (a) test, the new
row, and 4 of 6 B12 chunks, each with "false pass" (e.g. seed 11158, `pytest -q`,
`tests/test_x.py`, solo unverifiable). With the fix, `batch.test.ts` + `runner.test.ts` pass
869/869, and `tsc --noEmit` is clean.

**QA-2.2-12, QA-2.2-13, QA-2.2-14, QA-2.2-15, QA-2.2-16**: accepted per owner rule (post-round-2:
only major/critical are fixed). QA-2.2-15 (2) is covered anyway by the `" > "` names above.

## Task 2.2.3 record (wiring)

- **Merge:** `7b62cae` merges `origin/vrb/wave-2` (`fbcf456`, Phase 2.1) into `vrb/p22`. It had no
  conflicts. `src/verify/types.ts` auto-merged: the 2.1.1 contract block is the same on both sides,
  and wave-2 adds only 2.1's later fields (`Verdict.failures`, the `DeterministicDeps` testsPass
  seams). Phase 2.1 did not touch `runner.ts`, so p22's `testsByFile` and the pytest rootdir
  mapping carried over unchanged. After the merge, `npm run typecheck` was clean, and `batch.test.ts`
  + `runner.test.ts` + `tests-pass-pipeline.test.ts` passed 984/984.
- **Commits:** `ae92325` (a, wiring), `83dedaf` (b, tests).

### 2.2.3a: wiring (`src/verify/wiring.ts`, `src/verify/batch.ts`, `src/index.ts`)

- **One coordinator per plugin instance:** `createVerificationWiring` creates it once, with the
  wiring's logger. A `batch` option passes the test seams (clock, timers, platform, maximum
  window size); the logger is always the wiring's.
- **Per gate (`buildGateDeps`, deviation D6):**
  - 2.1's direct hook is built as before and becomes `runtime.direct`.
  - With `budget.batchWindowMs > 0`, `testsPass` is `coordinator.hook(runtime)`. The runtime
    shares the direct hook's scope opener, PlannerFs and budget:
    - `plan` is `planScopedRun` with the same inputs as the direct hook, and with its git
      searches bound to the deadline it is given (the member's deadline, or the batch deadline D
      for the union, B6);
    - `failureRecheck` is the gate-time `budget.failureRecheck` (QA-2.2-2);
    - `recheckMinRemainingMs` is 2.1's `RECHECK_MIN_REMAINING_MS`.
  - With `batchWindowMs <= 0`, the direct hook is used as is: no coordinator is involved.
- **QA-2.2-8 (resolved):** `BatchRuntime.currentTree` is new, and additive. Each member keeps
  its own gate's snapshot, and `recheck` forwards it: `scope.rechecker(command, cwd, tree)`.
  `BatchRuntime.openScope` is now `OpenBatchScope`, whose scope's rechecker takes the optional
  tree, as 2.1's `CheckScope` does. Any `OpenVerificationScope` still fits, because a
  two-argument rechecker is assignable to it; `batch.test.ts` compiles unchanged.
  - A single-member recheck gets that member's tree, exactly as alone.
  - A shared recheck gets its first member's tree, with that member's command and cwd. Every
    member of a group shares the reference and therefore its root (B8.2). The tree only feeds
    materialize's same-repository guard (reference.ts section 4 step 0), so no verdict depends on
    which member's tree is used.
  - The frozen types block is untouched.
- **`fileKeyOfId`:** batch.ts imports 2.1's exported `fileKeyOfId` from `baseline.ts`, and the
  private `idFileKey` is gone.
  - The separator rule is the same: the earliest `" > "` or `"::"`.
  - 2.1's function also turns `\` into `/`. Both sides of every comparison are then
    `/`-separated, because `fileKeyOf` already does that on the file side. readResult's ids are
    `/`-separated anyway.
  - `baseline.ts`'s only runtime import is `../guard/scrub`, so the new import creates no cycle.
- **Sweep and dispose (`index.ts`, minimal):**
  - `VerificationWiring` gains `sweepVerification()` (the coordinator's `sweep`) and
    `disposeVerification()` (its `dispose`).
  - The existing idle-TTL sweeper list gains `() => { sweepVerification(); }`. It is throttled
    to once every 5 minutes, and each sweeper runs inside its own try/catch.
  - Plugin `dispose` awaits `disposeVerification()` after `stopReferenceGc()` and before
    `logger.flush()`. The coordinator's dispose never rejects. It waits at most
    `BATCH_STALE_GRACE_MS` for a seam that ignores its abort signal, and nothing else is ever
    that slow.
- **Default behaviour change:** `batchWindowMs` defaults to 2000 (config.ts). A testsPass gate
  with a spec now waits up to 2 s in a window before its run, unless the window fills up (8
  requests) or the W3 rule closes it earlier.
  - `baseline-wiring.test.ts`'s QA-2.1-14 case tests attribution through the direct path and ran
    near its 5 s timeout. Its `wiringAt` config now sets `batchWindowMs: 0`. No assertion changed.

### 2.2.3b: tests

- **`test/integration/batch-wiring.test.ts` (new, 7 tests):**
  - Setup: 5 concurrent gates through `createVerificationWiring` → `buildGateDeps` → `accept`,
    over a real vitest-shaped project in a temp dir. The planner, scope opener, `readResult` and
    judge are real. The fake seams are:
    - `runArgv`: writes the JSON report the spec names;
    - `runShell`;
    - `acquireSlot`: counts holds and their nesting;
    - `materialize` and `gcStaleReferences`: materialize records the tree it receives, then fails.
  - Each scenario runs batched (window 60 s, closed by a size cap of 5) and with
    `batchWindowMs: 0`. The acceptance, outcome, failure classification and reasons must be
    equal.
  - Assertions:
    - Green path: 1 scoped run over the 5 sources, 1 acquire, 1 release, never 2 holds at
      once. Alone: 5 runs and 5 acquires.
    - Failing vitest path (mode B, D2): 1 + 5 runs, all under the one hold. Only the producer of
      the failing test is unverifiable (its reference is none), as alone.
    - QA-2.2-5 (B10): a gate settles while its batch still holds the slot; the hold is released
      once, at the end.
    - QA-2.2-8: with two distinct references, each batched recheck's materialize receives its
      own gate's tree.
    - Shared reference: exactly one recheck, with the tree of one of the failing members; alone,
      there are two.
    - `testScope: "full"` bypasses the window: the direct hook runs, with one shell run and one
      hold per gate.
    - Dispose: a gate that waits in its window, and a later gate, both get `BATCH_REASONS.disposed`
      (unverifiable). Nothing spawns or acquires, `sweepVerification()` evicts nothing live, and a
      second dispose resolves.
  - Mutants: "the wiring never batches" fails 6 of 7 tests. "batch.ts drops the tree" fails the
    2 tree tests.
- **B12 with 2.1's real `judgeScoped` (`test/unit/batch.test.ts`):**
  - `runCase` takes the judge as a parameter, and 6 more chunks run the same 300 seeds under
    `judgeReal`, which maps `judgeScoped`'s ok/unverifiable/failures to the stand-in's shape.
  - With the real judge, every solo and batched run is also judged by the stand-in, and both
    judges must agree (B12: "both must agree"). They agree on all 300 cases.
  - Mutant "judgeReal never says fail" fails all 6 chunks.
  - Placement: the plan puts this variant under 2.2.3b, but it lives in `batch.test.ts`, next to
    the harness it reuses (`genCase`, `propertySeams`, `directOver`). Moving the harness into a
    shared module would rewrite 400 lines of a QA-reviewed test for no gain in what is checked.
- **Test runs:**
  - `npx vitest run --maxWorkers=2 test/unit/batch.test.ts test/integration/batch-wiring.test.ts
    test/unit/baseline-wiring.test.ts test/unit/tests-pass-pipeline.test.ts
    test/integration/layer2-wiring.test.ts test/integration/delegate-timeout.test.ts
    test/integration/session-lifecycle.test.ts` → Test Files 7 passed (7), Tests 409 passed (409).
    `batch.test.ts` has 158 tests, and `batch-wiring.test.ts` has 7.
  - `npm run typecheck` is clean.
  - The other wiring consumers that mention testsPass also pass, 224/224: `annotate-plan`,
    `deterministic`, `dod`, `wiring`, `enforcement-defaults`, `modeA-e2e`, `modeB-e2e` and
    `reference-gc-start`.
  - The full suite was not run (§0.6.7).
- **Coverage** (v8, the 7-file run with `--coverage.include` of both files):
  - `batch.ts`: lines 98.55%, branches 93.09%. Uncovered: L1237-1238 (the defensive
    `settleLate` branch) and L1478-1482 (sweep's eviction of an empty window), as in the 2.2.2
    record.
  - `wiring.ts`: lines 100%, branches 91.89%. No uncovered branch lies in the changed region
    (L262, L504-545, L658-659); the uncovered arms are all in 2.1 code.

## QA findings (2.2.3 wiring, round 1)

Adversarial review of `git diff 70fe235..HEAD` on `vrb/p22`, restricted to `0e89ef1` (QA-2.2-11
fix), `ae92325` (wiring) and `83dedaf` (tests), and to how the coordinator meets 2.1's gate
pipeline. The wave-2 merge (`7b62cae`) was reviewed in phase 2.1 and is not re-reviewed. This is the
first round on the wiring, so one more round follows the fixes.

**Test run** (once, as dispatched): `npx vitest run --maxWorkers=2 test/unit/batch.test.ts
test/integration/batch-wiring.test.ts test/unit/baseline-wiring.test.ts
test/unit/tests-pass-pipeline.test.ts test/integration/layer2-wiring.test.ts
test/integration/delegate-timeout.test.ts test/integration/session-lifecycle.test.ts` → Test Files 7
passed (7), Tests 409 passed (409), 15.59 s. `npm run typecheck` is clean.

**Method.** All scratch work ran in a `%TEMP%` copy of `src/` and `test/` with a junction to
`node_modules`. The worktree was not edited, and the copy was deleted afterwards.

- **Repros.** Two scratch test files drive the real `createVerificationWiring` → `buildGateDeps` →
  `accept`. The planner, scope opener, `readResult`, judge and gate are real. The `exec`, `slot` and
  `reference` seams are faked, as in `batch-wiring.test.ts`.
- **R5/R6 seams.** R5 and R6 add three things:
  - a FIFO slot with one holder (`maxConcurrentVerifications` defaults to 1 below 16 cores);
  - vitest runs that take 1 s;
  - an exact fake reference (`materialize` returns `exact: true` over a copy of the project), at
    which the failing test passes.
- **Mutants.** Each mutant was an in-place change in the copy, restored after its run.

**Mutation check of the wiring tests:**

| mutant | change | tests run | result |
| --- | --- | --- | --- |
| MW1 | wiring never builds the coordinator (`if (false && …)`) | batch-wiring | **killed**, 6 of 7 |
| MW2 | wiring drops `...currentTree` from the runtime | batch-wiring | **killed**, 2 of 7 |
| MB1 | batch.ts `recheck` passes `undefined` for the tree | batch-wiring + batch.test | **killed**, 2 of 165 |
| MW3 | runtime `failureRecheck: true`, whatever the config | batch-wiring + layer2-wiring + baseline-wiring | **survives**, 58/58 |
| MW4 | runtime `recheckMinRemainingMs: 0` | batch-wiring + layer2-wiring | **survives**, 12/12 |
| MW5 | batch planner's searches ignore `planDeadline` | batch-wiring + layer2-wiring | **survives**, 12/12 |
| MW6 | `sweepVerification: () => 0` | batch-wiring + layer2-wiring + session-lifecycle | **survives**, 75/75 |
| MW7 | `disposeVerification: async () => {}` | same | **killed**, 1 of 75 |
| MW8 | index.ts dispose no longer awaits `disposeVerification()` | batch-wiring + layer2-wiring + delegate-timeout + session-lifecycle | **survives**, 90/90 |
| MW9 | index.ts idle sweeper list without the coordinator entry | same | **survives**, 90/90 |
| MW10 | runtime `batchWindowMs: 1` | batch-wiring | **killed**, 1 of 7 (the dispose test only) |
| MB3 | `referenceDecision` reads the window opener's `failureRecheck` | batch-wiring | survives 7/7 (B12 kills it, round 2) |

Answer to the dispatch's question:
- `batch-wiring.test.ts` fails when the coordinator is bypassed (MW1).
- It fails when the tree is dropped, on either side (MW2, MB1).
- It does **not** fail when the gate-time `failureRecheck` is ignored (MW3).

The wiring is correct today: repro R2 gives batched = alone (see QA-2.2-20). But no test pins it.

### Findings

| id | severity | evidence | fix |
| --- | --- | --- | --- |
| QA-2.2-17 | **major** | **The batch spends gate budget that the direct path spends on the recheck, and the gate accepts the resulting unverifiable verdict by default. A proven introduced failure is therefore accepted when batched and rejected with `batchWindowMs: 0`.** gate.ts L78: `accepted: outcome !== "fail" && !(strictUnverifiable && caveats.length > 0)`. `strictUnverifiable` is off by default (wiring.ts L558 passes the config value). B-G1 excludes deadline expiry, and B-G2, QA-2.2-3 and QA-2.2-5 call V "toward caution". That holds for the verdict, but not for acceptance: F → V turns a rejection into an acceptance. Two things now shift the timeline. `ae92325` puts every testsPass gate behind the window (default 2000 ms), and on the mode-B path (D2) the union run comes before the own runs. **R6** (default config, one gate, no concurrency, 12 s left at testsPass, `c` introduces `test/c.test.ts > t2`, which passes at the reference): the window ends at 2021 ms and the run takes 2021-3036 ms. The recheck is then skipped (under `RECHECK_MIN_REMAINING_MS`, 10 s): **`unverifiable`, `accepted: true`**, "testsPass: gate budget exhausted before recheck; observed failures: test/c.test.ts > t2". With `batchWindowMs: 0` the run takes 5-1008 ms and the reference run 1014-2027 ms: **`fail`, `accepted: false`**, "introduced failures: test/c.test.ts > t2". Same result in 2 of 2 runs. A lone gate never benefits from the wait (B5.1: a batch of one is the direct path). **R5** (5 concurrent gates, one FIFO slot, 15.5 s budgets, `c` arrives 30 ms after the others). Batched: union 54-1064 ms, then a, b, d and e, then c's own run 5095-6105 ms, so c is **`unverifiable`, `accepted: true`**. Alone: a, b, d, e, then c 4053-5055 ms and the reference run 5060-6065 ms, so c is **`fail`, `accepted: false`**. Same in 2 of 2 runs. Exposure: a gate whose slack after its run and recheck is below the window (lone gate) or below one union run (a failing vitest/jest batch). At the default 90 s budget this needs slow suites or earlier checks that used up the budget, but nothing in the default config prevents it. The same premise underlies QA-2.2-5 (accepted in round 1): an early-settled member's next lintClean or buildPasses check can end slot-busy behind its own batch (deterministic.ts L1389, V u14, accepted), where alone it could run and fail. That path was traced in code and not executed. | Fix in 2.2.3. (a) Close a window at once when no other request can join. The wiring counts the gates in flight (index.ts brackets `prepareVerification` … the gate's `finally`, and 2.4 does the same), and the coordinator closes a window whose members cover every gate in flight. This removes R6 and QA-2.2-18. (b) Keep the window out of the recheck reserve: W3 also closes the window at once when `remaining − (closeAt − now) < recheckMinRemainingMs + the last run duration measured for the key`. (c) R5 (the mode-B union run) needs the orchestrator's decision. Either record in B-G1/B-G2 and B9 that a deadline-induced V is an acceptance under the default policy, or split to own runs when the least member's remaining is under `(n + 1) ×` the measured run duration plus `recheckMinRemainingMs`. Revisit the QA-2.2-5 acceptance with the same premise. Add R5 and R6 as wiring tests (see QA-2.2-20). |
| QA-2.2-18 | minor | **Every lone testsPass gate now waits the full window.** R1 (real wiring, fake 0 ms runs): one gate under the default config takes 2032 ms, and 6 ms with `batchWindowMs: 0`. The verdicts are equal. B4 (W1-W6) has no early close; a window closes only at `closeAt`, at `maxBatchSize`, or by W3. The default of 2000 matches plan §1.4 (the `batchWindowMs` row: `2000`, "`0` disables batching"), and Phase 2.2's window rule ("closes at `batchWindowMs`, or earlier when a configured maximum size is reached"). So the implementation follows the plan, but the plan never priced sequential delegation. There, the window can never merge anything, and every gate of every attempt pays 2 s. Parallel producers also finish within 2 s of each other only rarely (not measured), so at this default the window mostly adds latency. | QA-2.2-17 (a), which also answers the dispatch's question: yes, a window should close early when no other request can join. Otherwise record the cost in B4 and in the plan's §1.4 row. |
| QA-2.2-19 | minor | **With 2.1's real scope, `dispose()` is not bounded by `BATCH_STALE_GRACE_MS`, and eviction does not release the slot, contrary to the log.** `evict` → `closeScope` → 2.1's `close()`, which waits for every tracked execute (deterministic.ts L1172-1176: `while (inflight.size > 0) await Promise.allSettled([...inflight])`). `dispose()` bounds only the batch promises, then awaits `Promise.all([...closing])` with no bound (batch.ts L1518-1530). **R3** (real wiring, the union seam ignores its abort, grace shortened to 20 ms through the `timers` seam): both gates return unverifiable at 1.5 s. The warning "evicted a batch whose seam never returned; its slot is released before the seam exits" is logged. Yet `disposeVerification()` is still pending after 3000 ms, with acquires 1 and releases 0. **R4** (sweep with the clock advanced 61 s): 1 evicted, the same warning, releases 0, holds 1. index.ts L445-448 awaits `disposeVerification()` before `logger.flush()`, so plugin dispose hangs as long as the seam does. Mitigation: exec.ts force-closes the pipes `KILL_GRACE_MS` (2000 ms) after a kill (`onGrace`), so the real `runArgv` returns. The close also awaits the reference disposal; that disposal's own bound was not checked in this round. The QA-2.2-4 resolution above ("The wait is bounded by `BATCH_STALE_GRACE_MS`") does not hold once the real scope is wired in. | In `dispose()`, race the closes against the rest of the grace too, and log what is left. Correct the `evict` warning and B11: with 2.1's scope the slot stays held until the seam returns. That is the safer behaviour, so keep it. Add a wiring test with a seam that ignores its abort (R3's shape). |
| QA-2.2-20 | minor | **The wiring tests miss the gate-time settings, the plugin hookups, rejections and deadlines.** Survivors from the table above: MW3 (`failureRecheck` ignored), MW4, MW5, MW6 (sweep a no-op), MW8 (dispose not awaited) and MW9 (sweeper entry removed). `batch-wiring.test.ts`'s `materialize` always fails, so "verdicts equal `batchWindowMs: 0`" is only ever checked on P and V: a rejection (F) and a pass with the pre-existing note are never compared through the wiring. No wiring test puts a gate under deadline pressure; R5 and R6 would have caught QA-2.2-17. **R2** shows the current wiring is right: with a captured reference and `failureRecheck: false` at the gate, batched = alone for all 3 gates. The failing gate's reason is "cannot attribute failures: failureRecheck is off … observed failures: test/b.test.ts > t1". | Add these wiring tests: R2 (gate-time `failureRecheck: false` with a captured reference), plus a config flip between two gates of one window; an exact fake reference (R5's `materialize`), so that F and P with the note are compared; the R5/R6 deadline cases; and a plugin-level check that dispose awaits the coordinator and that the idle sweeper calls `sweepVerification`. |
| QA-2.2-21 | nit | **`batchWindowMs` is not bounded by the gate budget.** config.ts L809-818 accepts 0 to `MAX_TIMER_MS`, and `resolveVerifyBudget` (L1364) applies no clamp. `captureWaitMs` has one: it is capped at `baselineTimeoutMs` (QA-1.6-8). W3 closes a window only when a request's `remaining()` is at most the time left, so with `batchWindowMs: 60000` and `gateBudgetMs: 90000` a lone gate spends 60 s of its 90 s waiting. This takes a configuration change. | In the wiring, cap the effective window (for example at a fraction of the deadline's remaining time), or rely on QA-2.2-17 (b). Alternatively, reject `batchWindowMs >= gateBudgetMs` at load. |
| QA-2.2-22 | nit | **The QA-2.2-5 wiring assertion depends on timing.** `holdsAtSettle.some(h => h === 1)` needs a gate's continuation to run before the batch finishes its instant fake runs and releases the hold. It failed once in 13 loaded runs, under the MB1 mutant, which cannot reach it: that test has NONE references, so no recheck runs, and MB1 passed that test in 2 more runs. The unmutated file passed 6 of 6 runs alone and 4 of 4 with `batch.test.ts` in parallel. | Hold the batch's later runs on a promise the test releases after the first gate settles, so the ordering is forced. |

### Verified without a finding

- **The tree (QA-2.2-8).** Each member keeps its own gate's tree (batch.ts L966), and `recheck`
  forwards it (L1404). A shared recheck uses the first member's tree. `materialize` uses the tree
  only for the same-repository guard, which accepts the root or its realpath (reference.ts
  L1597-1601). Members of a group share the reference's root, and each tree's cwd is its dispatch
  cwd, inside that root. So no verdict depends on which member's tree is used. MW2 and MB1 are
  killed.
- **`failureRecheck` at gate time.** The runtime takes it from `resolveVerifyBudget(getConfig())`
  inside `buildGateDeps` (wiring.ts L496, L532), per member (batch.ts L965). The direct hook reads
  the same budget object. R2 gives batched = alone. The test gap is QA-2.2-20.
- **`fileKeyOfId` (from `0e89ef1` and `ae92325`).**
  - baseline.ts L75-79 cuts at the earliest `" > "` or `"::"`, then maps `\` to `/`. That is the
    private copy's rule plus the separator mapping.
  - `fileKeyOf` also maps `\` to `/`, so both sides of every comparison are `/`-separated.
  - 2.1's judge uses the same function.
  - The QA-2.2-11 `taintable` change keeps every id of a complete union (batch.ts L1164-1168), as
    that resolution states.
- **The attempt-union change set and the HEAD-moved diff.** Each member's `changedFiles` comes
  from its own `prepareVerification`. An `unavailable` change set makes the planner return
  attribution-unavailable, which bypasses the window (B2.4), as it does on the direct path. The
  union is planned again and checked for an equal key and an equal input set; any mismatch splits
  into own runs.
- **Retries.** The delegate ladder starts a retry only after the previous gate returned: its
  `withTimeout` rejects and index.ts aborts the gate deadline. A member aborted in a window
  leaves it (W5). So no two attempts of one dispatch can share a window.
- **Different references.** Grouping by `referenceKey` is unchanged, and the QA-2.2-8 wiring test
  covers two references.
- **`testScope: "full"`.** `submit` sends it to `runtime.direct` before planning (batch.ts L1447).
  The wiring test covers it.
- **Planner and opener.**
  - The direct planner and the batch planner share the same `PlannerFs` and `maxWorkers`, and
    their searches are bound to the same gate deadline: `withCheckDeadline` passes
    `deps.deadline` as `request.deadline`.
  - The union uses the window opener's runtime (D6). Its budget is used only for timeouts,
    priority and slot waits. A different worker cap or argv template changes the batch key.
- **CLOSE_MARGIN_MS (QA-2.1-13).**
  - Batched members never wait for a scope close: `closeScope` is `void` in `runBatch`'s
    `finally`.
  - A member settles on its own deadline's abort, the same instant at which the gate's
    `withTimeout` fires (index.ts L644-660, L1171-1186). Both paths give V there.
  - Batching adds no race here.
- **One slot hold per batch next to the gate's other checks.**
  - There is one `openScope` per batch (batch.ts L1068).
  - A gate's command checks close their scope before the next check (deterministic.ts L1426), and
    a gate waiting on its batch holds nothing.
  - So there is no nesting and no wait cycle. QA-2.2-5's cost stands; its acceptance is
    questioned in QA-2.2-17.
- **The sweeper.** `() => { sweepVerification(); }` refers to a `const` declared later (index.ts
  L340, L351-354). The idle sweeper runs only from `chat.message`, and each sweeper runs inside
  its own `try`/`catch` (idle-sweep.ts). So there is no TDZ in practice.
- **Timers and listeners.**
  - Window timers are unref'd (batch.ts L851-854) and cleared on close, on leave and in
    `dispose()`.
  - The dispose grace timer is cleared.
  - Member abort listeners are removed in `settle`.
  - The coordinator is one per plugin instance, and a gate's runtime lives only as long as its
    batch.
  - No leak was found in the wiring, apart from the `closing` wait of QA-2.2-19.
- **Plan §1.4.** `batchWindowMs` defaults to 2000, and `0` disables batching. This matches
  config.ts L1364 and B2.3.

**Round verdict (2.2.3 wiring, round 1).** One **major** finding, QA-2.2-17: a batched gate can
accept an introduced failure that `batchWindowMs: 0` rejects. It reproduces on the default config
with a single gate (R6). There are three minor findings (QA-2.2-18, QA-2.2-19, QA-2.2-20) and two
nits (QA-2.2-21, QA-2.2-22). No false pass was found in the tree, `failureRecheck`, `fileKeyOfId`,
reference, retry or full-scope routing. This is the first wiring round: all of these may be fixed,
and one more round follows.

### Resolutions (2.2.3 wiring, round 1)

Owner decision for QA-2.2-17: a batched gate must never end weaker than the same gate would with
`batchWindowMs: 0` under the same budget, as far as can be ensured cheaply. The decision set three
parts: (a) early close, (b) the recheck reserve, and (c) the mode-B union under deadline pressure.
All three are implemented; nothing was deferred to a residual except the estimate's own limits
(below). The B-sections of `batch.ts` changed: B-G7 (new), B4 W1-W3 and W7 (new), B5 steps 1, 2a
(new) and 6, B7.5, B9, B10, B11, B13, B15 and B16.

- **QA-2.2-17 (major).** Resolution: fixed in `9ed2abb`.
  - (a) **W7, idle close.** A window closes at once when no request is planning and no batch is
    running. At that point nothing can join it, and the slot is free.
    - The signal is the coordinator's own: requests between arrival and their window, plus the
      running set. A gate-level count would need index.ts and 2.4 to bracket every gate, and this
      signal needs neither.
    - A lone gate's window closes as it joins, so it runs as the direct path (B5.1) with no window
      latency: R6's batched gate now ends well inside the 2 s window (the test bounds it at 1.5 s).
    - Requests that arrive while a batch runs gather in the next window (group commit). That
      window closes when the batch ends, at its timer, or by W2/W3.
  - (b) **W3, the reserve.** A member's floor is its recheck threshold (only when it can recheck:
    `failureRecheck` on and a captured reference) plus `BATCH_RESERVE_MARGIN_MS` (1 s).
    - The window closes no later than the moment any member would be left with less than floor +
      e, where e is the key's last measured run duration.
    - The close time moves earlier (the timer is re-armed) when a member joins and when a run of
      the key is measured. It never moves later, so W2's starvation bound stands.
  - (c) **B5.2a, the deadline check before a union.** A member is solo when its remaining time is
    below floor + 2e × (solo members) + e × (1 + p + i). That sum is the union, every pooled own run
    (a member can be held until the last, B5.7), the pooled rechecks ahead of it, and the solo
    members' runs and rechecks.
    - Solo members run their own spec and recheck first, in deadline order, under the batch's one
      hold, outside the union.
    - Fewer than two pooled members splits the batch.
    - A solo run never counts as reproducing a union failure, so B-G2 stands.
    - Two alternatives were rejected:
      - Serving a solo member through `runtime.direct`: its own scope would race the batch for the
        slot, and could wait behind the whole batch.
      - Splitting the first window of every key: that gives up the saving of every first fan-out.
  - **Residuals** (B15):
    - Before the first measured run of a key in a plugin instance, e is 0, so a first concurrent
      window pools any member that has its floor. A lone gate, or any earlier batch of the key,
      measures e first.
    - A run or recheck slower than the last measured run by more than the margin.
    - Serial own runs under one hold when `maxConcurrentVerifications` > 1.
    - QA-2.2-5's early-settled member's next check.
  - **Tests.**
    - Unit (`batch.test.ts`, +5):
      - W3 moves the close time earlier and keeps one timer;
      - W7 for a lone request and for arrivals during a running batch;
      - W7 with a request still planning;
      - B5.2a with a measured estimate, and with a cold one;
      - B5.2a/B-G2: a solo run does not explain a union failure.
    - Changed unit tests:
      - The W3 case now expects the 60 ms joiner to split and run first.
      - Two B9/B8.3 cases give the short member enough budget for its floor. Their assertions on
        the phase labels and on skipped-deadline are unchanged.
      - The pre-existing tests of the W1-W6 mechanics and the B12 property use
        `idleClose: false` through a local `createBatchCoordinator`.
    - Wiring (`batch-wiring.test.ts`, +4):
      - R6 (one gate, 11 s);
      - W3 with another gate in flight (11.5 s);
      - R5 as reported (c arrives 30 ms late behind a running batch);
      - R5 in one window after a measured run. The members split, and c rechecks and is rejected,
        as alone.
      - Each compares with `batchWindowMs: 0`, and all four fail on `798735f`.
      - A mutant that keeps every member pooled (no B5.2a) fails the one-window R5 and three unit
        tests (the W2/W3 case, B5.2a and B-G2).
      - A mutant that counts solo runs as reproducing fails the B-G2 unit test.
    - The concurrent wiring tests hold every gate's `planScopedRun` at a barrier until all are
      planning, so W7 cannot split them by timing.
- **QA-2.2-18 (minor).** Resolution: fixed by QA-2.2-17 (a) in `9ed2abb`. The R6 wiring test
  asserts a lone batched gate spends under 1.5 s, with 2 runs (the scoped run and the reference
  run).
- **QA-2.2-19 (minor).** Resolution: fixed in `8f0f936`.
  - `dispose()` bounds both waits, for the in-flight seams and then for the scope closes, by one
    `BATCH_STALE_GRACE_MS`. It logs a close still pending after the grace.
  - The eviction warning and B11 now say what happens. The scope closes, and releases the slot, once
    the seam exits. That is kept, as the safer behaviour.
  - Tests:
    - a unit case whose close waits for its hung execute, as 2.1's does: dispose returns after one
      grace, and the slot is released only when the seam returns;
    - the R3/R4 wiring case: the union seam ignores its abort, sweep evicts it after the clock
      moves 61 s, and dispose returns after a 20 ms grace. It asserts 1 acquire and 0 releases
      until the seam exits, then 1 release.
- **QA-2.2-20 (minor).** Resolution: fixed in `36b471f`. The R5/R6 deadline cases landed in
  `9ed2abb`, and the R3/R4 sweep case in `8f0f936`.
  - New wiring cases:
    - an exact reference compared batched against alone: c's introduced failure is rejected, d's
      pre-existing one passes, and there is one shared recheck;
    - R2: `failureRecheck: false` at the gate with a captured, exact reference;
    - a config flip between two gates of one window.
  - `test/integration/batch-plugin-hookup.test.ts` (new) checks that the idle sweeper calls
    `sweepVerification`, and that plugin dispose awaits `disposeVerification`.
  - Mutation check on the final state (in-place, each restored after its run):

    | mutant | result |
    | --- | --- |
    | MW3 runtime `failureRecheck: true` | killed: R2 and the config flip |
    | MB3 `referenceDecision` reads the window opener's `failureRecheck` | killed: the config flip |
    | MW6 `sweepVerification: () => 0` | killed: the R3/R4 case |
    | MW7 `disposeVerification: async () => {}` | killed: the dispose case and the R3/R4 case |
    | MW8 index.ts dispose does not await `disposeVerification()` | killed: the plugin hookup test |
    | MW9 index.ts idle sweeper list without the coordinator entry | killed: the plugin hookup test |

- **QA-2.2-21 (nit).** Resolution: fixed in `0b6e61e`. The wiring hands the coordinator
  `effectiveBatchWindowMs(budget)`, which is min(`batchWindowMs`, ⌊`gateBudgetMs` / 10⌋). That is
  2000 ms at the defaults, unchanged. W3 still keeps each member's reserve inside it. Test: with
  `batchWindowMs` 60000 and `gateBudgetMs` 20000, the window timer is armed for 2000 ms.
- **QA-2.2-22 (nit).** Resolution: fixed in `2cb8bd5`.
  - The failing producer (a) has the least time left, so its own run comes first after the union
    and makes it final.
  - Every later run waits on a promise that the first settled gate resolves.
  - The test asserts that the first verdict is a's, with one hold live, and that the hold is
    released once.

**Test runs (final state).**

- `npx vitest run --maxWorkers=2 test/unit/batch.test.ts test/integration/batch-wiring.test.ts
  test/unit/baseline-wiring.test.ts test/unit/tests-pass-pipeline.test.ts
  test/integration/layer2-wiring.test.ts test/integration/delegate-timeout.test.ts
  test/integration/session-lifecycle.test.ts` → Test Files 7 passed (7), Tests 424 passed (424).
  `batch.test.ts` has 164 tests and `batch-wiring.test.ts` has 16.
- `batch-wiring.test.ts` alone, 3 runs: 16/16 each time, about 29 s each.
- `batch-plugin-hookup.test.ts`: 1/1.
- The other wiring consumers pass 224/224: `annotate-plan`, `deterministic`, `dod`, `wiring`,
  `enforcement-defaults`, `modeA-e2e`, `modeB-e2e` and `reference-gc-start`.
- `npm run typecheck` is clean. The full suite was not run (§0.6.7).
