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
2. Is the acceptance reading in note 5 accepted? The criterion "≤ 1 scoped run + ≤ 1 recheck per
   window" would hold on the green path, on the pytest path and with a shared reference. On the
   vitest/jest failing path, 1 + n runs are expected under mode B.
