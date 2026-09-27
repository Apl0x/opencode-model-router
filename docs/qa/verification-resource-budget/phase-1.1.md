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
  - `src/verify/wiring.ts:258` — `verify?.testBaseline === false || verify?.require === "never" ? [] : commands`
    (decides whether a capture runs); switch to `resolveVerifyBudget(cfg).failureRecheck`.
  - `src/verify/wiring.ts:276` — `getConfig().enforcement?.verify?.testBaseline === false` (decides
    whether the baseline is used); switch to `resolveVerifyBudget(cfg).failureRecheck`.
  - `src/index.ts:82` — the `DEFAULT_GATE_BUDGET_MS` import goes once the read at `:593-596` moves.
  - `tiers.json:21` — `"gateBudgetMs": 90000` makes the `?? 90_000` default in `resolveVerifyBudget`
    dead for every real `loadConfig()`. **Removing this key is Phase 2.1's job** (not edited in 1.1).
  - `src/index.ts` must call `warnDeprecatedVerifyKeys(cfg, logger)` with the plugin logger after
    every `loadConfig()` — **deferred by plan (2.1)**. `resolveVerifyBudget` no longer logs.

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

Review 1: adversarial `[tier:heavy]` review of `754296c..d54778d` (`src/router/config.ts`,
`test/unit/config-verify-budget.test.ts`, this file) against plan §1.4, §1.5 and Phase 1.1.
Result: **6 open findings** (0 critical, 0 major, 4 minor, 2 nit) and 3 items deferred by plan.
Proofs were run with `bun` 1.3.14 (the runtime opencode loads the plugin in) and `node`, using a
scratch script that imports `src/router/config.ts`. The script is outside the repo.

1. **QA-1.1-1 — minor — a non-object `enforcement.verify` bypasses validation, and an override
   `verify: null` deletes the whole bundled block.** `src/router/config.ts:722-726`.
   - Evidence: the guard only validates when `typeof verify === "object" && verify !== null`, so
     anything else is skipped silently. Proof output:
     `ACCEPTED verify: "x"`, `ACCEPTED verify: 5`, `ACCEPTED verify: []`, `ACCEPTED verify: null`,
     but `REJECTED enforcement: null (for contrast): tiers.json: enforcement must be an object`.
   - Through the real merge path, `deepMerge(base, { enforcement: { verify: null } })` yields
     `merged verify after {verify:null} override: null`. The config then validates, so one override
     line erases every bundled `verify` value (`tiers.json:15-22`: `delegateTimeoutMs`,
     `graderTimeoutMs`, `gateBudgetMs`, `requireExplicitDoD`, …) and any base budget key
     (`testScope: "full"` became `"affected"` and `maxWorkers: 4` became `2` in the proof). So an
     override **can** delete defaults, one level up from the keys this phase added. By contrast, a
     leaf `null` is rejected (`REJECTED override leaf maxWorkers: null`), so leaf deletion is closed.
   - `test/unit/config-verify-budget.test.ts:200` ("a null verify block resolves to defaults")
     locks the bypass in as intended behaviour.
   - Fix: in `validateEnforcement`, when `enforcement.verify !== undefined`, require
     `isPlainObject(enforcement.verify)` and otherwise throw
     `tiers.json: enforcement.verify must be an object` (same form as `enforcement`). Change the
     test at :200 to expect that error for `null`, `"x"`, `5` and `[]`. Add a merge-path test:
     `validateConfig(deepMerge(validRaw({ maxWorkers: 4 }), { enforcement: { verify: null } }))`
     throws. No existing test passes a non-object `verify` (`rg "verify: null" test` only matches
     this file).

   - Resolution: OPEN (blocked) — the fix needs `test/unit/config.validate.test.ts:196-201` ("permissive skip", which pins `verify: "x"` as accepted) to be flipped, and that file is outside this dispatch's edit scope. Attempted and reverted; not committed.

2. **QA-1.1-2 — minor — no upper bound on millisecond and count keys: a huge budget becomes an
   immediately-expiring one.** `src/router/config.ts:767-798`.
   - Evidence: `Number.isInteger(1e300)` is `true`. Proof output:
     `ACCEPTED gateBudgetMs: 2**31`, `ACCEPTED pendingTtlMs: 30 days (2592000000)`,
     `ACCEPTED recheckTimeoutMs: 1e300`, `ACCEPTED maxWorkers: 1e21`.
   - Timers clamp any delay above 2147483647 ms to 1 ms, in both runtimes:
     `setTimeout(2**31) fired after 10 ms` with `TimeoutOverflowWarning: 2147483648 does not fit into
     a 32-bit signed integer. Timeout duration was set to 1.` (bun), and `fired after 7 ms` (node).
     `withTimeout` (`src/verify/timeout.ts:92`) passes the budget straight to `setTimeout`, and
     `timeoutMs()` (`src/verify/timeout.ts:67-71`) only rejects non-finite or ≤ 0 values. So
     `gateBudgetMs: 3000000000`, the natural way to write "effectively no deadline", fails every
     required gate at once with "timed out after 3000000000ms". That is the exact failure the
     comment at `config.ts:763-766` says this validation exists to prevent. Among the new keys,
     `pendingTtlMs` (a 30-day TTL is plausible), `recheckTimeoutMs`, `slotWaitMs`, `captureWaitMs`
     and `batchWindowMs` inherit the same hole.
   - For counts, `maxWorkers: 1e21` resolves to argv `--maxWorkers=1e+21` (proof output), which no
     runner parses as an integer.
   - Fix: add `const MAX_TIMER_MS = 2_147_483_647` and reject millisecond values above it in both the
     `>= 1` loop and the `>= 0` loop, for example
     `…must be an integer between 1 and 2147483647 (milliseconds)`. The shared loop fixes the four
     pre-existing keys too. For `maxWorkers` and `maxConcurrentVerifications`, require
     `Number.isSafeInteger` (or an explicit ceiling such as 1024). Add `2 ** 31` and `1e21` to the
     test's bad-value lists.

   - Resolution: 277a200 — `MAX_TIMER_MS = 2_147_483_647` upper bound on all nine millisecond keys (message `… >= 1 and <= 2147483647 (milliseconds)`); `Number.isSafeInteger` for `maxWorkers`/`maxConcurrentVerifications`; tests add `2 ** 31` and `1e21`.

3. **QA-1.1-3 — minor — the Phase 2.1 switch-over list in the pre-flight section is incomplete.**
   `docs/qa/verification-resource-budget/phase-1.1.md:10-14` (plan 1.1.1.b: "Any existing reads of
   `baselineTimeoutMs`/`gateBudgetMs` defaults elsewhere … are listed in the QA report for Phase 2.1").
   - Evidence: `rg "baselineTimeoutMs|gateBudgetMs|DEFAULT_GATE_BUDGET_MS|testBaseline" src` finds
     reads the list omits:
     - `src/verify/wiring.ts:258`: `verify?.testBaseline === false || verify?.require === "never" ? [] : commands`
       decides whether a capture runs.
     - `src/verify/wiring.ts:276`: `getConfig().enforcement?.verify?.testBaseline === false`
       decides whether the baseline is used.

     Both apply `testBaseline`'s old implicit default (`true`) and bypass the deprecation mapping.
     If 2.1 switches only the three listed reads, `failureRecheck: false` has no effect and the
     deprecated key stays authoritative.
   - The import at `src/index.ts:82` (`DEFAULT_GATE_BUDGET_MS`) also goes once the read at :593-596
     moves.
   - `tiers.json:21` ships `"gateBudgetMs": 90000`, so the bundled base always sets the key. The
     `?? 90_000` in `resolveVerifyBudget` is therefore dead for every real `loadConfig()`, and a
     future change to the default would be masked silently. This works against "the only place
     defaults are applied". `tiers.json` has no owner in plan §2.
   - Fix: add the two `wiring.ts` lines (switch to `resolveVerifyBudget(cfg).failureRecheck`), the
     `index.ts:82` import and `tiers.json:21` to the Phase 2.1 list. For `tiers.json:21`, either
     drop the key in this phase (it is config surface and no other phase owns the file) or assign
     the removal to 2.1 explicitly.

   - Resolution: 8bc503d — added `wiring.ts:258/276`, the `index.ts:82` import and `tiers.json:21` (removal assigned to Phase 2.1) to the pre-flight Phase 2.1 list.

4. **QA-1.1-4 — minor — `resolveVerifyBudget` is not pure, and the spec'd deprecation warning is
   not guaranteed to fire.** `src/router/config.ts:1264-1294`. Acceptance criterion: "it is pure and
   synchronous". The docstring concedes "Pure apart from the once-per-process deprecation warning".
   - Evidence (a), impurity: the function mutates module state (`warnedTestBaselineDeprecated`)
     and calls `opts.logger.warn`. The result is order-dependent tests: under `--no-isolate`, which
     plan §0.10.6 explicitly allows "for pure unit files", any earlier file that resolves a
     `testBaseline` config with a logger consumes the process-wide flag. A later file that asserts
     the warning (Phase 2.1/2.4 wiring tests) then fails unless it knows to call
     `resetVerifyBudgetWarnings()`.
   - Evidence (b), silent drop: `logger` is optional and has no fallback. Plan §1.4 ("Logs a
     one-time deprecation warning through the plugin logger") and 1.1.1.c are met only if some
     production caller passes a logger. Nothing in 1.1 enforces that, and no 1.1 test can catch a
     2.1 wiring that forgets.
   - Judgement on the implementer's deviation:
     - Rejecting a console fallback is correct. `createPluginLogger` already falls back to the
       console internally (`src/router/logger.ts:99-111`), so the `PluginLogger` is the seam.
     - The plan's premise "the plugin logger seam that config already uses" is false:
       `config.ts:1055-1164` uses bare `console.warn`.
     - Given an optional logger, "a resolve without a logger does not consume the once" is the
       right rule, because otherwise a logger-less call would swallow the only warning.

     The defect is where the warning lives, not the once rule.
   - Fix: keep `resolveVerifyBudget` side-effect free (no flag, no logger). Export
     `warnDeprecatedVerifyKeys(cfg: RouterConfig | undefined, logger: PluginLogger): void` with a
     **required** logger, the once-per-process flag and the reset hook. Record in the Phase 2.1
     list that `src/index.ts` calls it once after every `loadConfig()` with the plugin logger. Move
     the four deprecation-warning tests to the new function. Add a test that
     `resolveVerifyBudget(cfgWith({ testBaseline: false }), { cores: 1 })` performs no warning (it
     no longer takes a logger).

   - Resolution: ca98fdc — `resolveVerifyBudget` is pure (no flag, no logger, `logger` option removed). New export `warnDeprecatedVerifyKeys(cfg, logger)` with a required logger owns the once-per-process flag (`resetVerifyBudgetWarnings()` resets it); warning tests moved. Calling it from `src/index.ts` after each `loadConfig()` is deferred by plan (2.1).

5. **QA-1.1-5 — nit — the `__proto__` test claims more than it proves.**
   `test/unit/config-verify-budget.test.ts:188` ("neither bypasses validation nor pollutes").
   - Evidence: the payload `{"maxWorkers": 99, "testScope": "all"}` is **never validated**:
     `cfgWith(verify)` succeeds although `"all"` is invalid. It is harmless today only because
     `JSON.parse`/`parseJsonc` (`src/router/jsonc.ts:91`) create an own data property named
     `__proto__`, `resolveVerifyBudget` reads own keys, and `deepMerge` skips `__proto__`
     (`config.ts:1030`).
   - A future consumer that copies the block with `Object.assign({}, verify)` would reparent the
     copy through the `__proto__` setter (ECMA-262 `Object.assign` uses `[[Set]]`) and read the
     unvalidated values.
   - Fix: rename the test to "an own `__proto__` key is inert and does not pollute", and assert
     `Object.getPrototypeOf(verify) === Object.prototype`. Optionally reject own
     `__proto__`/`constructor`/`prototype` keys inside `enforcement.verify` in `validateEnforcement`.

   - Resolution: 277a200 — test renamed "an own `__proto__` key is inert and does not pollute" and asserts `Object.getPrototypeOf(verify) === Object.prototype`; `validateEnforcement` now rejects own `__proto__`/`constructor`/`prototype` keys inside `verify` (`tiers.json: enforcement.verify must not contain the key "…"`), tested.

6. **QA-1.1-6 — nit — test gaps against the plan's "New tests" list and the adversarial focus.**
   `test/unit/config-verify-budget.test.ts`.
   - Evidence:
     - :88 ("uses the real core count when none is injected") asserts only
       `Number.isInteger(n) && n >= 1`. It would still pass if the default ignored the core count
       (for example a hard-coded `1`).
     - No test checks that `testBaseline: true` **alone** warns. Plan §1.4 deprecates the key
       whatever its value, and in :220 the `true` resolve only runs after the flag is already
       consumed.
     - No test covers fractional cores (`15.9 → 1`, `16.5 → 2`, the `Math.floor(cores)` path) or
       `Infinity` cores (→ 1).
   - Fix:
     - At :88, assert
       `toBe(Math.max(1, Math.floor(os.availableParallelism() / 8)))`.
     - Add a fresh-flag test where `{ testBaseline: true }` with a logger calls `warn` once.
     - Add `[15.9, 1]`, `[16.5, 2]` and `[Infinity, 1]` to the cores table.
     - The merge-path `null` case is covered by the fix for QA-1.1-1.

   - Resolution: ca98fdc — exact formula test against `os.availableParallelism()`; fresh-flag `testBaseline: true` warns once; cores `15.9→1`, `16.5→2`, `Infinity→1` (the existing non-finite rule already maps `Infinity` to 1; now documented in the docstring).

**Deferred by plan (not open):**

- **deferred by plan (2.1):** switching the old default reads (`src/verify/wiring.ts:257/258/276`,
  `src/index.ts:82` and `:593-596`, `src/verify/timeout.ts:37`) to `resolveVerifyBudget`. Until
  then the runtime still uses `baselineTimeoutMs ?? 60000` and `testBaseline`, and
  `failureRecheck` has no effect.
- **deferred by plan (2.3, owner of `docs/**`):** plan §1.3 row S3 says "`maxConcurrentVerifications`
  (default 1)", which contradicts §1.4 (`max(1, floor(cores / 8))`, 2 on 16 cores). The code follows
  §1.4, the authoritative configuration table. The plan text should be aligned.
- **deferred by plan (1.6 / 2.4):** `captureWaitMs > baselineTimeoutMs` is accepted unclamped.
  Plan §1.5-15 caps `VERIFY_WAIT` at `baselineTimeoutMs` when directives are resolved, which is not
  the job of `resolveVerifyBudget`.

**Verified, no finding:**

- **§1.4 keys and defaults:** every key is present with the type, default and range in the table:
  `testScope` "affected", `maxWorkers` 2, `lowPriority` true, `defaultVerify` "deferred",
  `captureWaitMs` 5000 (≥ 0), `background` false, `pendingTtlMs` 3600000 (≥ 1), `slotWaitMs` 60000
  (≥ 0), `batchWindowMs` 2000 (≥ 0), `failureRecheck` true, `recheckTimeoutMs` 60000 (≥ 1),
  `baselineTimeoutMs` 15000 and `gateBudgetMs` 90000.
- **`maxConcurrentVerifications` formula:** `max(1, floor(cores / 8))` matches §1.4.
- **`availableParallelism`:** it exists in the plugin's real runtime (`bun 1.3.14`:
  `function 16 16`) and in `engines.node >= 20`.
- **Deprecation precedence:** `own("failureRecheck") ?? (testBaseline === false ? false : true)`.
  An explicit `failureRecheck` wins in both directions.
- **Merge and prototype keys:**
  - An `undefined` override is skipped, and a leaf `null` is rejected.
  - `__proto__`/`constructor` are skipped in `deepMerge`, and there is no prototype pollution.
  - Values inherited through a prototype are validated and never applied.
  - The function is synchronous.
- **Existing tests:** the diff adds only the new test file, so existing config tests are unchanged.
- **Coverage:** re-run with `npx vitest run --maxWorkers=2 test/unit/config-verify-budget.test.ts --coverage --coverage.include=src/router/config.ts`
  (40/40 pass). The last uncovered range reported is `1119-1236`, so the new
  `VerifyBudget`/`resolveVerifyBudget` code (1238-1318) has no uncovered line. Branch coverage of
  the validation block could not be confirmed independently because the text reporter truncates the
  earlier ranges.
