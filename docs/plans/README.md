# Plans index

This directory holds design/implementation plans for `opencode-model-router`.

## Active plans

- [`model-router-enforcement-and-verification-plan.md`](./model-router-enforcement-and-verification-plan.md)
  — Enforced Delegation Architecture (three-layer enforcement-and-verification:
  hard-block guard → independent acceptance gate → quality escalation ladder)
  on top of the existing prompt-based router. Covers both usage modes:
  on-the-fly orchestrator delegation and `[tier:X]`-annotated plan execution.
- [`verification-resource-budget-plan.md`](./verification-resource-budget-plan.md)
  — Verification Resource Budget (target `1.15.0`): the acceptance gate stops
  running a test suite per delegation. Affected-test scoping, a failure-only
  recheck at a git dispatch reference, a machine-wide verification slot,
  low-priority capped runs, batching, and deferred verification on the
  orchestrator's terms (`VERIFY:`, `router_verify`). Decision record:
  [`../adr/0003-affected-test-verification.md`](../adr/0003-affected-test-verification.md).
  - Handover: [`verification-resource-budget-handover.md`](./verification-resource-budget-handover.md)
    — execution state, operating rules and troubleshooting notes for the
    orchestrator running the plan.

## Related records

- Architecture decision records: [`../adr/`](../adr/)
  - `0000-spike-results.md` — Phase 0.0 enforcement-primitives capability spike.
- QA reports: `../qa/` (added during Wave 5).
