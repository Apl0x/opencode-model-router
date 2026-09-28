# ADR 0003 — Affected-Test Verification and Deferred Verdicts

> **Status:** Accepted **Date:** 2026-09-27 **Wave/Phase:** Verification Resource Budget, Phase 2.3
> **Supersedes:** the dispatch-time test baseline described in ADR 0002 D6 and shipped through 1.14.0 **Depends on:** ADR 0002 (acceptance gate)
> **Deciders:** owner (Marco Jardim) + implementer + Senior-QA (adversarial review per phase)
> **Plan:** [`../plans/verification-resource-budget-plan.md`](../plans/verification-resource-budget-plan.md)

## Context

### The incident

Two opencode sessions with many subagents drove a 16-core Windows machine to 80–100% CPU. A
process monitor traced the load to `cmd.exe /d /s /c "npm test"` → `vitest run` → 8–16 workers.
The router's dispatch-time test baseline launched them **one second after each `task` dispatch**,
including read-only ones.

`1.14.0` fixed three defects: the process tree is killed on timeout and abort
(`src/verify/exec.ts`), read-only dispatches no longer capture a baseline, and at most one capture
runs per directory and command per process. **It still ran the full suite up to twice for every
delegation whose DoD carried `testsPass`**: once as the dispatch-time baseline and once as the
`testsPass` check after the producer returned. The injected protocol tells orchestrators to prefer
`testsPass` in acceptance blocks, so that meant most implementation delegations. The native `task`
path also had no gate budget at all (`accept(…)` was not wrapped in `withTimeout` there).

### The owner's constraints (plan §1.1)

1. **The router must not run a test suite per delegation.**
2. **Verification must never slow implementation down.** The owner runs many sessions and
   subagents in parallel on one machine and prefers speed to absolute safety. The fast tier is
   already a mid-tier model.
3. **No CPU is spent on verification nobody asked for.** Verification runs only when the
   orchestrator marks a delegation as fundamental or explicitly asks for a verdict. There is no
   background verification by default.
4. **The orchestrator decides the risk.** Per dispatch, it sets how long to wait for the reference
   and whether the verification is fundamental. The router supplies a deterministic risk signal and
   a way to get the verdict on demand. It never forces the wait.

### Guardrail semantics that must survive

Whenever a verification does run, `testsPass` must still reject a delegation that introduces a
failing test, must not blame the producer for failures that existed at dispatch, and must say
`unverifiable` rather than give a false pass when it cannot tell those two apart. A delegation that
was not verified is never reported as verified.

## Decision

Seven mechanisms, all implemented. Defaults are resolved in one place,
`resolveVerifyBudget` (`src/router/config.ts`).

### S1 — Affected-test scoping

`testsPass` runs only the tests related to the producer's changed files: `vitest related`,
`jest --findRelatedTests`, or a pytest module mapping. A runner adapter builds the command, which is
spawned **without a shell**. `pytest` and `uv run pytest` are allowlisted.

### S2 — Failure-only recheck at a dispatch reference

At dispatch, only a git reference is captured (`git stash create` or `HEAD`, plus hashes of
untracked files). No tests run. When scoped tests fail, only **those failing test files** are rerun
in an ephemeral worktree at the reference, which separates pre-existing failures (excused with a
note) from introduced ones (rejected). Controlled by `failureRecheck` (default `true`) and
`recheckTimeoutMs` (default 60 s). The capture is bounded by `baselineTimeoutMs` (default 15 s).
`testBaseline` is deprecated in favour of `failureRecheck`, and `testBaseline: false` still maps to
`failureRecheck: false`.

### S3 — Machine-wide verification slot

A cross-process semaphore (lock files in the OS temp directory) caps concurrent verification
commands across every opencode process on the machine. The cap is `maxConcurrentVerifications`,
default **`max(1, floor(cores / 8))`**: 2 on a 16-core machine. A request that waits longer than
`slotWaitMs` (default 60 s) is `unverifiable` ("verification slot busy").

> **Plan contradiction, resolved in favour of the code.** The S3 row of plan §1.3 gives the
> default as 1. Plan §1.4 and `resolveVerifyBudget` both use `max(1, floor(cores / 8))`. This ADR
> records the code value.

### S4 — Per-run resource caps

The adapter passes the runner's worker cap (`--maxWorkers=N`, `maxWorkers` default 2). Every
verification command runs at below-normal OS priority (`lowPriority`, default `true`). The gate
budget's abort signal reaches the process tree. The native `task` path's required gate is now
bounded by `gateBudgetMs` (default 90 s) like the `delegate` path.

### S5 — Batching

Verification requests for the same runner root that arrive within `batchWindowMs` (default 2 s;
`0` disables) are merged into one scoped run over the union of changed files. The requests can come
from `VERIFY:required` gates, `router_verify` calls or, when enabled, background runs. Failures are
attributed back to each request.

### S6 — The full suite is CI's job

The router never falls back to a full suite. When scoping is impossible (an unknown runner, a
composite script, a changed config file), the result is `unverifiable` with a caveat. A full suite
runs only with an explicit `testScope: "full"`, and it still goes through S2–S5.

### S7 — Verification on the orchestrator's terms

Each dispatch carries `VERIFY:required` or `VERIFY:deferred` (default: `defaultVerify`, which is
`"deferred"`), and optionally `VERIFY_WAIT:<n>s` (default `captureWaitMs`, 5 s, never more than
`baselineTimeoutMs`).

- A **deferred** delegation returns immediately with an "unverified" disclaimer, a deterministic
  risk signal and a handle (`vrf_…`). It is listed as pending in the prompt until it is verified or
  expires (`pendingTtlMs`, default 1 h). **No verification process runs** unless the orchestrator
  calls the `router_verify` tool with the handle, or `background: true` is configured.
- A **required** delegation is gated synchronously through S1–S6 and keeps the escalation ladder.
- The reference capture waits at most `VERIFY_WAIT` before the producer starts. It never blocks
  beyond that.

## Consequences

- **What `testsPass` no longer proves.** A pass means that the tests related to the changed files
  pass. It does **not** mean the whole suite is green. A change can still break a test that the
  runner's dependency graph does not link to the changed files: dynamic imports, fixtures read from
  disk, cross-package effects, or config and global-setup changes (these last ones are reported as
  `unverifiable`). The full suite is CI's gate, because only CI can afford to run it once per change
  rather than once per delegation, on a machine that is not also running the agents.
- **Deferred by default trades the enforced-verification guarantee for speed.** This was the
  owner's explicit choice (constraints 2 and 3). It re-opens the risk that motivated the router in
  the first place: instructed models false-finish, and a deferred `DONE:` is not checked unless
  someone asks. This is a known, accepted risk. It is mitigated by the deterministic risk signal on
  every deferred return, the pending list in the prompt, `router_verify` on demand, and
  `VERIFY:required` for delegations that later work depends on. `background: true` restores
  automatic checking at a CPU cost.
- **pytest failures are always `unverifiable`.** The reference rerun (S2) is unsupported for pytest,
  because an editable install imports the live tree rather than the reference worktree, so the
  rerun would test the producer's code. A failing pytest scope therefore cannot be split into
  pre-existing and introduced failures. A green pytest scope passes normally.
- **pytest scoping maps direct importers only** (Phase 3.1, E2E-1). A changed module maps to the
  test files that name its stem as a whole word (`git grep -F -w`) plus the name-matched tests,
  limited to `testpaths` when those decide the collection. No mapped test, or a `conftest.py` that
  names the module, is S6 `unmapped-module` (`unverifiable`), never "no affected tests". A test
  that reaches the module only through another source module or a dynamic import is not run, and a
  change to non-`.py` files alone still gives "no affected tests".
- **An unknown tool during the dispatch capture makes that dispatch `unverifiable`** (Phase 3.1,
  E2E-3). Only the tools in `NON_WRITING_TOOLS` (`src/verify/dispatch.ts`) leave an in-flight
  snapshot or capture alone. Any other tool in that window, MCP and custom tools included, leaves
  the change set unavailable and the reference none, which fails closed instead of seeding the
  baseline with the edit. A write with no tool event, or a writing tool under a non-writing name,
  is not seen.
- **`unverifiable` is accepted with a caveat** unless `strictUnverifiable` is set, in which case it
  is rejected. This covers scoping failures, a busy slot, a capture that did not finish, and pytest
  failures.
- **The synchronous price of a deferred delegation** is up to `VERIFY_WAIT` (default
  `captureWaitMs`, 5 s) at dispatch, waiting for the reference capture before the producer starts
  (paid in either mode), plus up to 2 s at return for the git-only snapshot of the producer's
  changes (measured at about 0.4–0.5 s).
- **Windows limits.**
  - `node_modules` is linked into the reference worktree as a directory junction, not copied.
    Cleanup must remove the junction without following it.
  - 8.3 short paths (for example `C:\Users\ABCDEF~1\…`) for the project directory or `%TEMP%`
    are canonicalised with the native realpath before the recheck resolves the runner or maps
    paths. Before Phase 3.1 (QA-2.4-23, E2E-2), every reference rerun on such a setup was
    unplannable, so introduced failures were accepted as `unverifiable`.
  - Tree kill uses `taskkill /T /F`. A descendant that has already been orphaned, because its
    parent exited before the kill, is outside the tree and can survive it.
  - The orphan sweeper needs PowerShell in FullLanguage mode; under Constrained Language Mode
    (AppLocker/WDAC) it exits at once and kills nothing.
  - `taskkill` slowed by CPU saturation can leave part of a tree running.
  - Death of opencode by an unhandled signal skips the exit hook, so in-flight runs are not killed.
  - `lowPriority` is applied just after spawn; a descendant spawned before that call (a narrow
    race) runs at normal priority.
- **Deprecations.** `enforcement.verify.testBaseline` logs a once-per-process warning and maps onto
  `failureRecheck`.
- **Bundled defaults.** The bundled `tiers.json` no longer sets `gateBudgetMs`. The key is still
  supported, not deprecated; its in-code default of 90 s (90000 ms) applies.

## Alternatives rejected

- **Keep the dispatch-time full baseline** (1.14.0 behaviour). This runs the full suite on every
  `testsPass` delegation, often twice. It violates constraint 1 and was the direct cause of the
  incident.
- **Run the full suite, but at low priority only.** Low priority lowers the scheduling pressure on
  interactive work but not the total CPU, RAM or wall time. Many parallel delegations would still
  queue many full suites. It fails constraints 1 and 3, and does not scale with the number of
  sessions.
- **Background verification on by default.** This would restore automatic checking of every
  delegation, but it spends CPU on verdicts nobody asked for (constraint 3) and competes with the
  producers it is meant to protect (constraint 2). It ships as opt-in (`background: true`).
