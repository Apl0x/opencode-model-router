# Phase 1.1 — Configuration surface: QA report

## Pre-flight

- **deepMerge keeps sibling keys: confirmed.** `deepMerge` (`src/router/config.ts`) merges plain
  objects key by key, skips `undefined` override values, and skips `__proto__`/`constructor`. An
  override that sets only `enforcement.verify.maxWorkers` keeps every other base `verify` key; unset
  keys are then defaulted by `resolveVerifyBudget`. Covered by the tests "deep-merged overrides keep
  sibling keys and defaults" and "an undefined override value does not delete a base value".
- **Existing default reads for Phase 2.1 to switch to `resolveVerifyBudget` (not edited here):**
  - `src/verify/wiring.ts:257` — `verify?.baselineTimeoutMs ?? 60000` (old default 60000; the new
    default is 15000).
  - `src/index.ts:593-596` — `timeoutMs(activeCfg.enforcement?.verify?.gateBudgetMs, DEFAULT_GATE_BUDGET_MS)`.
  - `src/verify/timeout.ts:37` — `DEFAULT_GATE_BUDGET_MS = 90_000` (the constant `src/index.ts:82` imports).

## Implementation notes

- `EnforcementConfig.verify` gains every §1.4 key, each with a JSDoc line that gives its default.
  The `testBaseline` and `baselineTimeoutMs` docs are updated (deprecated; 15000).
- Validation in `validateConfig` uses the existing message form:
  - `>= 1` ms keys: `pendingTtlMs` and `recheckTimeoutMs` join the existing time-box loop.
  - `>= 0` keys: `captureWaitMs`, `slotWaitMs`, `batchWindowMs`.
  - Counts `>= 1`: `maxWorkers`, `maxConcurrentVerifications`.
  - Booleans: `lowPriority`, `background`, `failureRecheck`.
  - Literals, case-sensitive: `testScope`, `defaultVerify`.
  - `null` is rejected for all new keys.
- `resolveVerifyBudget(cfg, { cores?, logger? })` is exported with the `VerifyBudget` type. It is
  synchronous and the only place defaults are applied.
  - `maxConcurrentVerifications` defaults to `max(1, floor(cores / 8))`, which gives 1→1, 8→1,
    16→2 and 64→8. `cores` defaults to `os.availableParallelism()`, and a non-finite or `< 1` value
    counts as 1.
  - It reads own properties only, so a prototype-inherited value is never applied. `validateConfig`
    reads through `[]`, so inherited bad values are still rejected.
- **Deviation (logger seam):** `config.ts` had no logger seam; it only uses `console.warn`. Following
  the `warnAgentOptionsEffortOnce` pattern in `agent-options.ts`, the deprecation warning goes through
  an optional `PluginLogger` passed in `opts.logger`, with no console fallback (the dispatch forbids
  console).
  - A resolve without a logger does not consume the once-per-process flag.
  - `resetVerifyBudgetWarnings()` is the test-only reset hook.
  - Phase 2.1 callers should pass the plugin logger.
- Coverage (`--coverage.include=src/router/config.ts`, the new test file only): no uncovered
  statements or branches in the new validation block or in `resolveVerifyBudget`/`VerifyBudget`.
  The whole file is at 92.41% statements and 90.64% branches when run with the existing config
  tests.

## QA findings
