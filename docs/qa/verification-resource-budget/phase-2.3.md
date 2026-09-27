# Phase 2.3 — Protocol text, docs, ADR, CHANGELOG, goldens

Branch `vrb/p23`, diff base `65567dc` (merge of phase 2.4). Reviewed diff: `git diff 65567dc..HEAD`
(commits `58ecf65` … `12f0cb6`).

## Pre-flight

- Scope of the diff (13 files): `CHANGELOG.md` (`[Unreleased]`), `README.md` (two prompt-size
  sentences), `docs/COMMAND_REFERENCE_INDEX.md` (new *Router tools* table),
  `docs/CONFIG_REFERENCE.md` (verify table, *Affected-test verification*, *Deferred verification*,
  validation rows, shipped-defaults table), `docs/FLOW_DIAGRAMS.md` (§9–§11),
  `docs/VERIFICATION.md` (allowlist, invariants, *`testsPass`: affected tests* section),
  `docs/adr/0003-affected-test-verification.md` (new), `docs/plans/README.md`, `src/index.ts`
  (`delegate` description :503, annotate-plan guidance :1673), `src/router/protocol.ts` (DoD section
  :278, :290–291), the assembled-prompt golden, `test/unit/config-verify-budget.test.ts` (docs table
  check) and `test/unit/protocol-directives.test.ts` (new).
- Deferred by plan and not reported as findings: 3.1 (live Spike F checks, benchmarks, including the
  "0.4–0.5 s" measurement), 3.2 (plan-text amendments), 3.3 (CHANGELOG version header).

## Implementation notes

- The implementer placed the new `VERIFY:` sentence in `buildDoDProtocolSection`
  (enforcement-on only), not next to the `CAP:` sentence. Their rationale was that deferral cannot
  happen when enforcement is off. The QA judgement is in QA-2.3-16.
- The implementer measured the prompt-size numbers as follows: Claude path 5,229 → 5,992 characters
  with enforcement on, and a 1,982-character DoD section. QA re-measured them (QA-2.3-17).

## QA findings — round 1

Reviewer: adversarial senior-engineer QA. Method: every factual claim in the changed docs was
cross-read against the merged code in `src/`, the directive parser was run over the model-facing
text, prompt sizes were re-measured with a script, and the scoped tests and typecheck were run.

### Runs

- `npx vitest run --maxWorkers=2 test/golden test/unit/protocol-directives.test.ts test/unit/config-verify-budget.test.ts test/unit/packaging.test.ts test/unit/docs-drift.test.ts`
  gives **11 files / 141 tests passed** (2.0 s).
- `npm run typecheck` (`tsc --noEmit`) is **clean** (exit 0).
- Measurement script (bun, over `tiers.json`):
  - `buildDoDProtocolSection` is 1,975 characters;
  - the Claude path is 4,010 characters with enforcement off and 5,992 with it on, a difference of **1,982**;
  - the non-Claude path is 3,238 characters.
- Directive probe (`parseVerifyDirectives`, `parseCapDirective`):
  - The DoD section, the full Claude enforcement-on prompt and the `delegate` description
    (`src/index.ts:503`) all return the defaults (`deferred`, `captureWaitMs`, source `default`).
  - The DoD section yields CAP `null`, and the full prompt yields the base protocol's own CAP (8),
    which is unchanged.
  - A dispatch that contains the literal `VERIFY:required|deferred`, with or without backticks,
    also returns the **default** (`deferred`), silently. See QA-2.3-3.
- Acceptance grep `rg -n "warm|baseline capture|full suite" docs README.md`: every hit was reviewed.
  - `README.md:421` and `CONFIG_REFERENCE.md:540` are about the prompt cache and are unrelated.
  - The ADR 0003 hits describe the 1.14.0 behaviour or rejected alternatives.
  - The `docs/plans/` and `docs/qa/` hits are records.
  - No doc claims that a dispatch warms a test cache or that `testsPass` runs the suite. **Pass.**

### Findings

| ID | Severity | Finding | Evidence (doc vs code) | Fix |
|---|---|---|---|---|
| QA-2.3-1 | **major** | **The README still promises verification of every delegation.** The diff edits the `README.md:876` sentence, but only its numbers. It still says "every non-trivial delegation is verified and any genuine failure surfaces a forcing-note". `README.md:881` (Layer 2) says the DoD "is checked … before the result is trusted" and that "An explicit `[acceptance]` block is always verified". Under the new default, any DoD with `testsPass` returns **unverified**, with no gate and no forcing note. This is the class of QA-2.4-7 (major), left in the README. | `README.md:876`, `README.md:881` vs `src/verify/wiring.ts:1782-1790` (`isDeferred`: mode `deferred` and `hasTestsPass`), `src/index.ts:1290-1307` (native path returns with the footer, no gate), `src/index.ts:671-686` (`delegate`, no ladder). | Rewrite both sentences. For example: "every non-trivial delegation is verified **unless it is deferred**; by default a DoD with `testsPass` returns unverified with a `vrf_` handle (see Deferred verification)". Drop "always verified" from :881, or qualify it as "always verified when required or verified on demand". |
| QA-2.3-2 | **major** | **`failureRecheck: false` is documented as stricter, but the code is laxer.** The table says "`false` = no reference; a failing scoped run then counts as a failure without a recheck." The code makes **every** scoped failure `unverifiable` (u5), which is **accepted with a caveat** by default. A user who disables the recheck to get fail-closed behaviour gets the opposite. `VERIFICATION.md` (Unverifiable, "`failureRecheck` is off") and `FLOW_DIAGRAMS.md` §10 ("failureRecheck off ──► unverifiable") are correct, so the docs contradict each other. | `docs/CONFIG_REFERENCE.md:202` vs `src/verify/types.ts:253` ("`failureRecheck: false`: no reference, no recheck; any scoped failure is unverifiable"), `src/verify/baseline.ts:171` (u5), `src/verify/deterministic.ts:457-465` (column D = `V u5`), `:1290`. | Row text: "`false` = no reference and no recheck; any scoped failure is then `unverifiable` (accepted with a caveat unless `strictUnverifiable`), never a fail." |
| QA-2.3-3 | **major** | **The only directive syntax the model sees for required mode is a placeholder, and the parser silently ignores it.** The `delegate` description says "dispatch in required mode (`VERIFY:required\|deferred`)". The protocol says "you may add `VERIFY:required\|deferred`". By the router-example contract, a value followed by `\|` is a placeholder and is skipped **silently** (no log). An orchestrator that copies the text it was given gets the default `deferred`, not the synchronous gate it asked for. Probe result: `"VERIFY:required\|deferred\nImplement X"` → `{mode:"deferred", modeSource:"default"}`. The model-facing text never shows the concrete form `VERIFY:required`. (The tool description is not dispatch text, so the placeholder contract does not even apply to it.) | `src/index.ts:503`, `src/router/protocol.ts:291` (golden `.snap` :59, :193) vs `src/verify/directives.ts:38-44`, `:158` (placeholder `continue`, no `firstInvalid`). | In the `delegate` description (not parsed as dispatch text), write the literal form: "…or put `VERIFY:required` in `task` for a synchronous gate". In the protocol line, keep the placeholder-safe form but say how to fill it in, for example "add `VERIFY:` followed by `required` or `deferred` (one word)". A pinned-example pattern would also work. Add a probe test asserting that the protocol text never presents a pipe placeholder as the thing to paste. |
| QA-2.3-4 | minor | **The stated synchronous cost of a deferred delegation leaves out the dispatch wait.** The ADR says the deferred return costs up to 2 s and "That is the whole synchronous price of a deferred delegation". The CHANGELOG says "The synchronous cost is the git-only reference snapshot: at most 2 s". Both paths also **await the reference capture at dispatch for up to `VERIFY_WAIT`** (default `captureWaitMs` = 5 s, at most `baselineTimeoutMs`) before the producer starts, whatever the mode. The worst case is ≈ 5 s + 2 s. The ADR contradicts its own :108-109. | `docs/adr/0003-affected-test-verification.md:133-134`, `CHANGELOG.md:64-66` vs `src/verify/wiring.ts:1191-1200` (`awaitBounded(begun, waitMs)`), `:1771`, `src/index.ts:619` (awaited `startDispatch`). `CONFIG_REFERENCE.md:323` ("the deferred **return** adds up to 2 s") is correct. | "A deferred delegation costs at most `VERIFY_WAIT` (default 5 s, typically the capture's ~0.5 s) before the producer starts, plus at most 2 s at return." |
| QA-2.3-5 | minor | **The CHANGELOG lists two pre-existing keys as "Added", and a behaviour change is missing.** Both `baselineTimeoutMs` and `gateBudgetMs` existed in 1.14.0: they are typed and validated at `60c2de3`, and released CHANGELOG entries document them. `baselineTimeoutMs` changed its **default (60 s → 15 s)** and its **meaning** (it bounded a test run; now it bounds a git-only capture), but *Changed* does not say so. "The `gateBudgetMs` key is removed from `tiers.json`" is listed under *Deprecations*, although the key is not deprecated. | `CHANGELOG.md:21-28`, `:75-77` vs `git show 60c2de3:src/router/config.ts` (:134 `baselineTimeoutMs?`, :138 `gateBudgetMs?`, :745-746 validation), `CHANGELOG.md:339-340` ("`baselineTimeoutMs`, default 60s"), `:635` (`gateBudgetMs` 90000), `src/router/config.ts:1350` (15_000). | Move both keys out of *Added*. Under *Changed*, add: "`baselineTimeoutMs` now bounds the git-only reference capture; default 60 s → 15 s". Move the `tiers.json` note out of *Deprecations*, for example to *Changed*: "the bundled `tiers.json` no longer sets `gateBudgetMs` (the in-code 90 s default applies)". |
| QA-2.3-6 | minor | **The deferral conditions are presented as complete, but they are not.** CONFIG_REFERENCE lists three conditions ("All of these must hold. Everything else runs the required gate"). It leaves out: <br>• the mode is `deferred` (a directive or `defaultVerify`); <br>• `verify.require` ≠ `"never"`, and with `"never"` nothing runs the required gate, so "everything else" is false; <br>• `router_verify` is registered (start-time mode ≠ `off`, or the `delegate` tool is enabled); <br>• not a trivial dispatch with an inferred DoD; <br>• on the `delegate` path, the producer did not error. <br>"The producer changed files" is also imprecise: an **unattributed** change set still defers, at risk `high`; only an attributed empty set falls back. | `docs/CONFIG_REFERENCE.md:315-319` vs `src/index.ts:461`, `:470`, `:671-672`, `src/verify/wiring.ts:1783-1787`, `:1281` (`no-change`), `src/verify/pending.ts:250-252` (`unattributedRisk`). | List every condition. Replace "Everything else runs the required gate" with "otherwise the dispatch is handled as before 2.4 (the required gate, or no gate when `require` is `never`)". Say that an unattributed change set defers with risk `high`. |
| QA-2.3-7 | minor | **A DoD that mixes `testsPass` with other checks is deferred as a whole.** `isDeferred` tests only for the presence of `testsPass`, so `buildPasses`, `lintClean`, `run` and `criteria` lines in the same DoD are **not** checked before return either. The model-facing text says "Required-mode delegations and non-testsPass DoDs are gated before return", which a reader can take to mean that the non-`testsPass` checks of a mixed DoD still gate. | `src/index.ts:503`, `src/router/protocol.ts:278`, `docs/VERIFICATION.md` ("Deferral applies to delegations whose DoD has a `testsPass` check") vs `src/verify/wiring.ts:1783`, `src/index.ts:1290-1307` (early return, no gate). | Add to the protocol, the description and CONFIG_REFERENCE: "a DoD that contains `testsPass` defers **all** of its checks, including build, lint, `run` and criteria; use `VERIFY:required` when any of them must gate." |
| QA-2.3-8 | minor | **The 8.3 short-path limit names the wrong directory and understates the effect.** The docs say "plugin directory", "path to the plugin" or "plugin or runner path", and that the rerun "can" be unplannable. QA-2.4-23 observed that when the directory opencode passes to the plugin (`ctx.directory`, the project directory) is an 8.3 short path, **every** reference rerun is `rerun-unplannable`. On such a setup no scoped failure can ever be rejected: every introduced failure is accepted with an `unverifiable` caveat unless `strictUnverifiable`. `VERIFICATION.md` also opens the bullet with a reassurance about change sets. If 3.1 shows that the host really passes short paths, raise this to major. | `docs/CONFIG_REFERENCE.md:264-266`, `docs/VERIFICATION.md:234`, `docs/adr/0003-…:138-139` vs `docs/qa/verification-resource-budget/phase-2.4.md:1199` (QA-2.4-23), `src/verify/deterministic.ts:1078`, `:1133` (`rerun-unplannable`). | "When the project directory opencode hands the plugin (`ctx.directory`) is an 8.3 short path, every reference rerun is unplannable: scoped failures are then always `unverifiable` (accepted unless `strictUnverifiable`), so `testsPass` cannot reject. Open a project through its long path." Cross-reference 3.1. |
| QA-2.3-9 | minor | **The Windows limits list omits limits that `exec.ts` records.** The docs say "Abort kills the whole process tree", with the orphaned-grandchild case as the only exception. The code also records these limits: <br>• the orphan sweeper needs Windows PowerShell in **FullLanguage** mode, and under AppLocker or WDAC Constrained Language Mode it exits at once and kills nothing (`[orphan sweep unavailable: …]`); <br>• `taskkill` slowed by CPU saturation can leave part of a tree (a G4 known limit); <br>• death by an unhandled signal skips the exit hook; <br>• `lowPriority` on Windows is applied after spawn, so a descendant spawned before `setPriority` runs at normal priority ("not a guarantee"). | `docs/VERIFICATION.md:235`, `docs/adr/0003-…:140-141` vs `src/verify/exec.ts:31-37`, `:90-96`, `:201-215`, `:564-580`. | Add the four bullets to *Windows limits*, with one line each in the ADR consequences. |
| QA-2.3-10 | minor | **The protocol implies that unverified delegations stay visible until they are verified.** "unverified delegations stay listed in the prompt until verified." An entry leaves the list, **without** being verified, after `pendingTtlMs` (1 h) or an opencode restart. An orchestrator can read an empty list as "everything was verified", which is the automatic-check misreading this phase was meant to prevent. CONFIG_REFERENCE is correct. | `src/router/protocol.ts:291` (golden `.snap` :59, :193) vs `src/verify/pending.ts:340-341` (R13, restart), `:419` (`EXPIRED_HANDLE_TEXT`); `docs/CONFIG_REFERENCE.md` §`router_verify` (TTL, restart). | "…stay listed until verified or expired (1 h; lost on restart). A missing entry does not mean verified." |
| QA-2.3-11 | nit | **The model-facing allowlist omits pytest.** The protocol line still lists 12 tools. The code allowlists `pytest` and the exact form `uv run pytest …`, and `VERIFICATION.md:77` and the CHANGELOG say so. The model is therefore told that a `run command="pytest …"` check is not allowed. | `src/router/protocol.ts:292` vs `src/verify/deterministic.ts:85` (`DEFAULT_ALLOWLIST`), `:109-112` (`uv run pytest` only when `pytest` is allowlisted); `docs/VERIFICATION.md:77`. | Append "pytest, and `uv run pytest` only" to the protocol line, and update the golden and the README numbers. |
| QA-2.3-12 | nit | **VERIFICATION.md understates the drift effect.** It says drift "lets it add a **drift** notice". In fact drift never lets a pass stand: the pass becomes `unverifiable`, as CONFIG_REFERENCE says correctly. | `docs/VERIFICATION.md:199` vs `src/verify/wiring.ts:646-647` (DRIFT_NOTICE, "never lets a pass stand"); `docs/CONFIG_REFERENCE.md:385`. | Change it to "…a pass becomes `unverifiable` with a drift notice". |
| QA-2.3-13 | nit | **Directives are also read from the `description` field.** CONFIG_REFERENCE says directives are parsed "only from the orchestrator's own dispatch prompt (the `task`/`delegate` prompt argument)". The native path passes both `prompt` and `description` to `dispatchDirectiveText`. Both fields are orchestrator-authored, so security is unaffected, but the doc is imprecise. (I did not read the body of `dispatchDirectiveText`; this rests on its call signature.) | `docs/CONFIG_REFERENCE.md` §Directives vs `src/index.ts:1092`, `:1284`. | Change it to "from the orchestrator's `task` arguments (`prompt` and `description`) or the `delegate` `task` argument". |
| QA-2.3-14 | nit | **A stale ADR 0002 line still puts `testsPass` behind the per-workspace mutex.** ADR 0003 says it supersedes only ADR 0002 D6 (the dispatch baseline). The ADR 0002 concurrency bullet still says `testsPass` serializes behind the mutex, which is no longer true. | `docs/adr/0002-acceptance-gate.md:78` vs `src/verify/deterministic.ts:307-308`, `docs/VERIFICATION.md:149`. | Add "Superseded in part by ADR 0003 (testsPass no longer takes the mutex)" to ADR 0002, or extend ADR 0003's *Supersedes* line. |
| QA-2.3-15 | nit | **The `router_verify` registration condition is vague.** The index says "Verification is enabled (`routerVerifyEnabled` in `src/index.ts`)". The real condition, fixed at plugin start, is `verify.require` ≠ `"never"` **and** (the start-time mode ≠ `off` **or** the `delegate` tool is enabled). | `docs/COMMAND_REFERENCE_INDEX.md:275` vs `src/index.ts:458-461`. | State the condition, and that it is evaluated once at plugin start. |
| QA-2.3-16 | info | **Implementer deviation: the `VERIFY` sentence is only in the enforcement-on DoD section.** **Acceptable.** The stated rationale is not exact, though. With the start-time mode `off` and `experimental.verifiedDelegateTool` on, `router_verify` is registered and the `delegate` path defers (no mode check at :671), while the system prompt has no DoD section. In that configuration the `delegate` description is the only teaching, which makes QA-2.3-3 the relevant fix. The native `task` path cannot defer with enforcement off. | `src/index.ts:461`, `:671-672`, `:503`; `src/router/protocol.ts:271-296`. | No change beyond QA-2.3-3. Correct the rationale if it is repeated in 3.2. |
| QA-2.3-17 | info | **Verified correct, recorded for the audit trail.** <br>• The footer text matches `buildDeferredFooter` verbatim. <br>• The late-notice text, both headers, matches `buildLateNoticeBlock`. <br>• The pending list is limited to 5, newest first, with `... and N more`. <br>• pytest failures are always unverifiable: `runner-unsupported` is decided before classification, so a new pytest test file cannot be proven introduced either. <br>• `RECHECK_MIN_REMAINING_MS` is 10 s and `KILL_GRACE_MS` is 2 s. <br>• `VERIFY_WAIT` accepts `ms`, allows `0` and is capped at `baselineTimeoutMs`; upper-case keys have no prose guard. <br>• `captureWaitMs` is clamped to `baselineTimeoutMs`. <br>• `testsPass` runs outside the mutex; `buildPasses` and `run` keep it. <br>• The prompt-size numbers are exact: +1,982, 5,992, 4,010 and 3,238, with the token ranges 496–551 and 810–1,665 consistent at 3.6–4.0 characters per token. <br>• The golden diff holds only the intended text (one line reworded and two bullets added, in both snapshots). <br>• No model-facing text parses as a live directive. <br>• The verify table defaults are pinned by the new docs test. | `src/verify/pending.ts:1716-1766`, `:414`; `src/verify/deterministic.ts:307-308`, `:387`, `:653`, `:1135`; `src/verify/exec.ts:76`; `src/verify/directives.ts:179-207`; `src/router/config.ts:1350-1351`. | None. |

### Not verified in this round

- `CHANGELOG.md` *Fixed*, second bullet: that the native `task` required gate is now wrapped in `gateBudgetMs`. The source was not read.
- `CONFIG_REFERENCE.md` §`background`, "foreground test runs preempt them". The code read so far shows only that background runs never wait for a slot (`src/verify/wiring.ts:1051-1053`). Actual preemption was not confirmed.
- `VERIFICATION.md:148`, that `buildPasses`, `lintClean` and `run` each take the machine-wide slot. Also whether `lintClean` keeps the mutex: the `deterministic.ts:308` comment names only `buildPasses` and `run`.

### Summary

- Counts: **3 major** (QA-2.3-1, -2, -3), 7 minor, 5 nit and 2 info. No critical findings.
- **Must fix:** all three majors.
  - QA-2.3-1 and QA-2.3-2 are docs that promise a stronger safety guarantee than the code gives.
  - QA-2.3-3 is model-facing text whose only example of required mode silently gives deferred mode.
- **Fix now:** each minor is a one- or two-sentence doc change. This is round 1, so they can be fixed before the owner's round-2 rule applies.
- **Tests and typecheck:** green.

## Round-1 resolutions

- QA-2.3-1 — Resolution: `2e4ed81` — README no longer promises that every delegation is verified; deferral is stated.
- QA-2.3-2 — Resolution: `c34df3e` — `failureRecheck: false` documented as making every scoped failure `unverifiable`, never a fail.
- QA-2.3-3 — Resolution: `2e4ed81` — the delegate description (now the exported `DELEGATE_TOOL_DESCRIPTION` in `protocol.ts`) shows the literal `VERIFY:required`, and the protocol line explains how to fill it in.
- QA-2.3-4 — Resolution: `c34df3e` — the deferred synchronous cost now includes the `VERIFY_WAIT` dispatch wait plus up to 2 s at return.
- QA-2.3-5 — Resolution: `c34df3e` — CHANGELOG moves both keys out of *Added*, records the `baselineTimeoutMs` change and moves the `gateBudgetMs` note out of *Deprecations*.
- QA-2.3-6 — Resolution: `c34df3e` — every deferral condition is listed, including the unattributed change set at risk `high`.
- QA-2.3-7 — Resolution: `2e4ed81` — model-facing text says a DoD with `testsPass` defers all of its checks.
- QA-2.3-8 — Resolution: `c34df3e` — the 8.3 limit names `ctx.directory` and states that every reference rerun is unplannable.
- QA-2.3-9 — Resolution: `c34df3e` — the four missing Windows limits are added to VERIFICATION.md and the ADR.
- QA-2.3-10 — Resolution: `2e4ed81` — the protocol says entries stay listed until verified or expired, and that a missing entry does not mean verified.
- QA-2.3-11 — Resolution: `2e4ed81` — the allowlist line includes pytest and `uv run pytest`; prompt sizes are now 6,189 characters enforcement-on with a 2,179-character DoD section.
- QA-2.3-12 — Resolution: `c34df3e` — drift is documented as turning a pass into `unverifiable`.
- QA-2.3-13 — Resolution: `c34df3e` — directives are documented as read from `prompt`, falling back to `description` only when `prompt` is blank (`dispatchDirectiveText`).
- QA-2.3-14 — Resolution: `c34df3e` — the ADR 0002 mutex line is marked as superseded in part by ADR 0003.
- QA-2.3-15 — Resolution: `c34df3e` — the `router_verify` registration condition is stated and evaluated at plugin start.
- QA-2.3-16 — info, no action.
- QA-2.3-17 — info, no action.
- Follow-up (QA-2.3-5 leftover) — Resolution: `92eca0e` — CONFIG_REFERENCE and ADR 0003 no longer list the `gateBudgetMs` `tiers.json` change under *Deprecations*.

## QA re-review (round 2)

Final round. Reviewed diff: `git diff f626a9c..HEAD` (commits `2e4ed81`, `c34df3e`, `92eca0e`,
`4c33edc`; 12 files). Text cleared in round 1 was not re-audited. Owner rule: only critical, major
or blocking findings are fixed after this round.

### Runs

- `npx vitest run --maxWorkers=2 test/golden test/unit/protocol-directives.test.ts test/unit/config-verify-budget.test.ts test/unit/packaging.test.ts test/unit/docs-drift.test.ts`
  gives **11 files / 142 tests passed** (2.0 s). The extra test is the new `DELEGATE_TOOL_DESCRIPTION` probe.
- `npm run typecheck` (`tsc --noEmit`) is **clean** (exit 0).
- Measurement (tsx script over `tiers.json`, `anthropic` / `normal`):
  - Claude path: 4,010 characters with enforcement off and **6,189** with it on, a difference of **2,179**.
  - `buildDoDProtocolSection` alone is 2,172 characters. The 2,179 includes the 7-character
    `\n\n---\n\n` separator. Round 1 used the same convention (1,982 vs 1,975).
  - Non-Claude path: 3,238 characters.
  - Tokens: 2,179 → **545–606**, and 3,238 / 6,189 → **810–1,720**. Both use the ceiling at 4.0 / 3.6
    characters per token, the same rounding as round 1. The README figures match.
- Directive probe (`parseVerifyDirectives` with sentinel defaults, and `parseCapDirective`):
  - The DoD section, and the full Claude and non-Claude prompts with enforcement off and on, all
    return the **defaults** (`deferred`, sentinel wait, both sources `default`).
  - The same holds for the assembled enforcement-on prompt of every preset and mode, on both paths:
    22 prompts, 0 non-default.
  - CAP is `null` for the DoD section and 8 for the full prompts. Both are unchanged.
  - Change from round 1: the new wording ``add `VERIFY:` followed by `required` …`` is no longer a
    silent placeholder. It records `firstInvalid` = `` ` `` and would log
    `ignoring unknown VERIFY value`. This has no runtime effect, because the system prompt is never
    parsed as dispatch text (see below). It does matter for QA-2.3-18.
- `DELEGATE_TOOL_DESCRIPTION` parses as `{mode:"required", modeSource:"directive"}`, as intended
  and as pinned by the new test.
  - Could it make a real dispatch accidentally required? **No.** The constant is referenced only at
    `src/router/protocol.ts:271` (definition) and `src/index.ts:52`/`:503` (the `tool({ description })`
    field). It is not part of `assembleSystemPrompt`.
  - The only inputs to `parseVerifyDirectives` are `resolveDirectives(text)` (`src/verify/wiring.ts:1208-1215`),
    which is reached from `startDispatch` / `takeDispatch`. Those receive:
    - `args.task` on the `delegate` path (`src/index.ts:619`);
    - `dispatchDirectiveText(prompt, description)` of the `task` call's own args on the native path
      (`src/index.ts:1084-1092`, `:1284`).
  - The dispatch header is prepended to `args.prompt` only after that parse (`:1148-1150`), and the
    after hook reuses the stored start.
  - `parseCapDirective` reads `args.prompt` (`:1143`) and the session dispatch text (`src/router/sessions.ts:493`).
  - The tool description is never concatenated into any of these. Even if it were, `required` is the
    fail-safe direction: a stronger gate that costs only latency.
- Golden diff: exactly three lines change in each of the two snapshots. They are the QA-2.3-7 reword,
  the QA-2.3-3/-10 `VERIFY` line and the QA-2.3-11 allowlist line. There are no other changes.
- Acceptance grep `rg -n "warm|baseline capture|full suite" docs README.md`: the hits are the same set
  as in round 1.
  - `CONFIG_REFERENCE.md:540` is now `:562` because of the added lines. It is about the prompt cache.
  - The fix diff adds no hit. **Pass.**

### Verdicts on round-1 findings

| ID | Verdict | Evidence |
|---|---|---|
| QA-2.3-1 | **Resolved** | `README.md:876` now makes an exception for a DoD with `testsPass` ("deferred by default and returns unverified with a `vrf_` handle"). `:881` replaces "always verified" with "verified, but one with `testsPass` is deferred by default". This matches `wiring.ts:1782-1790` and `index.ts:1290`, `:671`. There is a link nit in QA-2.3-20. |
| QA-2.3-2 | **Resolved** | The `CONFIG_REFERENCE.md:202` row now says "any scoped failure is then `unverifiable` … never a fail". This matches `deterministic.ts:464` (row R2, column D = `V u5`). |
| QA-2.3-3 | **Resolved** | `DELEGATE_TOOL_DESCRIPTION` shows the literal `` `VERIFY:required` `` "in the task", and `args.task` is the parsed text (`index.ts:619`). The probe gives `required`. The protocol line has no pipe placeholder, which the test pins (`not.toMatch(/VERIFY:[a-z]+\|/i)`). QA-2.3-18 records a residual. |
| QA-2.3-4 | **Resolved** | CHANGELOG, the ADR 0003 consequences and CONFIG_REFERENCE now all state `VERIFY_WAIT` at dispatch plus up to 2 s at return. The dispatch wait is awaited before the producer starts (`index.ts:619` then `:644`; native `:1089`) and applies in either mode (`wiring.ts:1771`, `:1200`). |
| QA-2.3-5 | **Resolved** | *Added* no longer lists `baselineTimeoutMs` or `gateBudgetMs`. *Changed* now has the `baselineTimeoutMs` bullet and the `tiers.json` bullet. *Deprecations* keeps only `testBaseline`. `git show v1.14.0:tiers.json` has `"gateBudgetMs": 90000` (:21), and HEAD's `tiers.json` has no such key. The in-code default is `?? 90_000` (`config.ts:1368`). The 15 s default is pinned by the docs-table test, which is green. |
| QA-2.3-6 | **Resolved** | The listed conditions match the code: mode (`wiring.ts:1783`), `require` (`:1787`), registration (`index.ts:462`, `:471`), proven root (`:672`, `:1290`), trivial/inferred (`wiring.ts:1785`; the `delegate` path never passes `trivial`, and its gate uses `trivial: false`, `index.ts:753`), producer error (`:671`), and attributed empty set → `no-change` / unattributed → `unattributedRisk` (`wiring.ts:1274`, `:1281`). There is an omission nit in QA-2.3-21. |
| QA-2.3-7 | **Resolved in the model-facing text; the docs part was not done** | The protocol line and `DELEGATE_TOOL_DESCRIPTION` now say a DoD containing testsPass defers "as a whole (its build, lint, run and criteria checks too)". This matches `wiring.ts:1783` (`hasTestsPass` only). Round 1 also asked for this in CONFIG_REFERENCE, but `rg "as a whole\|all of its checks" docs/CONFIG_REFERENCE.md docs/VERIFICATION.md README.md` finds nothing. See QA-2.3-23. |
| QA-2.3-8 | **Resolved** | CONFIG_REFERENCE, VERIFICATION.md and the ADR name `ctx.directory`, "every reference rerun is unplannable" and the 3.1 cross-reference, as QA-2.4-23 (`phase-2.4.md:1199`) observed. A possible overstatement is recorded in QA-2.3-19. |
| QA-2.3-9 | **Resolved** | All four bullets match `exec.ts`: FullLanguage and exit 3 (`:574-587`), `[orphan sweep unavailable: …]` only while the run is unsettled (`:262`), taskkill under saturation (`:90-96`), unhandled signal skipping the exit hook (`:28-37`), and priority applied after spawn, "not a guarantee" (`:201-215`). "Windows PowerShell 5.1" matches `:568`. There is a scope nit in QA-2.3-22. |
| QA-2.3-10 | **Resolved** | "until verified or expired (1 h, or a restart); absent from the list does not mean verified". This matches `config.ts` `pendingTtlMs ?? 3_600_000` and `pending.ts:341`, `:419`. |
| QA-2.3-11 | **Resolved** | The allowlist line adds "pytest (plus exactly `uv run pytest`)". The golden is updated, and the README numbers were re-measured and match (see *Runs*). |
| QA-2.3-12 | **Resolved** | The text now reads "a pass becomes `unverifiable` with a drift notice naming the drifted paths (a fail stays a fail)". This matches `wiring.ts:1557-1571` ("A fail stays a fail") and `:458-459` (paths in the notice). |
| QA-2.3-13 | **Resolved, and more precise than the round-1 fix text** | "from `prompt`, or from `description` when `prompt` is missing or blank (never both)" is exactly `dispatchDirectiveText` (`wiring.ts:254-256`). The round-1 suggestion ("`prompt` and `description`") was imprecise, and the implementer read the body correctly. |
| QA-2.3-14 | **Resolved** | ADR 0002 now has the "Superseded in part by ADR 0003" sub-bullet. It matches `deterministic.ts:307-308` ("buildPasses and run keep the mutex"). |
| QA-2.3-15 | **Resolved** | The `COMMAND_REFERENCE_INDEX.md:275` condition is exactly `index.ts:461-462`, evaluated once at plugin start. |
| QA-2.3-16 | info, unchanged | Still accurate. `DELEGATE_TOOL_DESCRIPTION` now carries the literal form, which covers the mode-`off` + `delegate` configuration. |
| QA-2.3-17 | info, amended | One bullet no longer holds as written: "No model-facing text parses as a live directive". `DELEGATE_TOOL_DESCRIPTION` now parses as `required` by design. It is a tool description, not dispatch text, and it never reaches the parser (see *Runs*). Every other bullet stands. |
| Follow-up (`92eca0e`) | **Resolved** | Neither CONFIG_REFERENCE nor ADR 0003 *Deprecations* mentions `gateBudgetMs` now. Both have a *Bundled defaults* note that says "still supported, not deprecated". |

### New findings

| ID | Severity | Finding | Evidence | Fix |
|---|---|---|---|---|
| QA-2.3-18 | minor | **The fill-in instruction admits a rendering that silently gives `deferred`.** The protocol line now says "add `` `VERIFY:` `` followed by `` `required` `` or `` `deferred` ``". The natural fill-ins parse: `VERIFY:required`, `VERIFY: required`, `` VERIFY:`required` ``, and lower-case `verify: required` on its own line all give `required`. A model that copies the two code spans as they are rendered does not: `` `VERIFY:` `required` `` parses as **`deferred`** (`modeSource: default`), with only a log line. That is the QA-2.3-3 failure class, but much less likely. The round-1 fix text had "(one word)", and it was dropped. It is not major, because the result still carries the `[router] unverified · vrf_…` footer and stays in the pending list. The orchestrator is told that it was not gated and is never told it was verified. This path matters most on the native `task` path, where the protocol line is the only teaching. | Probe: `` "`VERIFY:` `required`\nImplement X" `` → `{mode:"deferred",modeSource:"default"}`. `src/verify/directives.ts:153-158`, `:175`: the closing backtick ends the token, so `v` is null → `firstInvalid`. `src/router/protocol.ts` DoD line (golden `.snap` :59, :193). | Optional under the owner rule. Write it as one token with a `<…>` placeholder, which is skipped silently and keeps the no-live-directive test green. For example: "add `VERIFY:<mode>` (one token; mode `required` or `deferred`)". Then update the golden, the README numbers and the test's `toContain`. |
| QA-2.3-19 | nit (unverified) | **"Scoped failures are then always `unverifiable` … `testsPass` cannot reject" may overstate the 8.3 effect.** This wording is QA's own round-1 fix text. In the recheck order, failing files absent at the reference (new test files) are classified at step g. When the rerun list is empty, step h returns `exact` without planning. The unplannable rerun that QA-2.4-23 observed ("runner not installed: vitest", from `resolveEntry`) is at step i. So a failure confined to a new test file may still be rejected. Whether `toRefPath(f)` also fails for the failing files under a short path, which would leave them unknown, was not checked. The error is in the pessimistic direction and has no safety impact. | `src/verify/deterministic.ts:405-410` (steps g–i), `:435` (absent → introduced), `:1076` (`rerun-unplannable` from `resolveEntry`); `phase-2.4.md:1199`. | Leave it for 3.1. The live check should also try a new-test-file failure under a short path, and soften the wording to "generally" if it fails there. |
| QA-2.3-20 | nit | **The README Layer-2 link is imprecise.** `[Deferred verification](docs/VERIFICATION.md)` has no anchor. Its label names the CONFIG_REFERENCE section, and the sentence then repeats "See docs/VERIFICATION.md". | `README.md:881`; the VERIFICATION.md heading is "Deferred path (the default)" (`:183`). | `docs/CONFIG_REFERENCE.md#deferred-verification` or `docs/VERIFICATION.md#deferred-path-the-default`. |
| QA-2.3-21 | nit | **The deferral list and its "Otherwise" sentence omit the live enforcement mode.** The native `task` path runs neither `startDispatch` nor any gate when the enforcement mode at dispatch time is `off` (for example after `/router enforce off`). So "Otherwise … the required (synchronous) gate, or no gate when `require` is `"never"`" leaves out a second no-gate case. Registration is a start-time condition only. | `docs/CONFIG_REFERENCE.md` §Which delegations defer vs `src/index.ts:1082-1083`, `:1265-1266` (`shouldVerifyTask(…, mode, …)`). | Add "on the native `task` path, the enforcement mode at dispatch is not `off`", and "or no gate when the mode is `off`". |
| QA-2.3-22 | nit | **The unhandled-signal limit is not Windows-specific.** It is listed under *Windows limits*, but `exec.ts` states it for the exit hook on every platform (POSIX process groups included). | `docs/VERIFICATION.md` *Windows limits* ("Unhandled signals"), ADR 0003 consequences vs `src/verify/exec.ts:28-37`. | Move it to a general limits line, or add "(all platforms)". |
| QA-2.3-23 | nit | **The QA-2.3-7 leftover: the user docs do not say a `testsPass` DoD defers all of its checks.** The model-facing text does. CONFIG_REFERENCE ("the DoD carries a `testsPass` check"), VERIFICATION.md ("Deferral applies to delegations whose DoD has a `testsPass` check") and the README do not say that build, lint, `run` and criteria checks are deferred too. | The `rg` above (no hits); `src/verify/wiring.ts:1783`. | Add one sentence to CONFIG_REFERENCE §Which delegations defer, the same as the protocol wording. |

### Not verified in this round

- QA-2.3-19: whether `toRefPath` maps failing test files under an 8.3 `ctx.directory`. This needs the
  3.1 live check.
- The three items under *Not verified in this round* in round 1 are outside the fix diff and were not
  revisited.

### Summary

- **Every round-1 finding is resolved.** QA-2.3-7 is resolved in the model-facing text, which is where
  it affects behaviour. Its docs half is QA-2.3-23 (nit).
- The fix diff introduced **no critical, major or blocking defect**. The new findings are 1 minor
  (QA-2.3-18) and 5 nits (QA-2.3-19 to -23). Under the owner's final-round rule none of them has to
  be fixed. QA-2.3-18 is the one worth taking if the protocol text is touched again, for example in 3.2.
- The golden diff contains only the intended text. The README figures (6,189 / 2,179, 545–606,
  810–1,720) match the re-measurement. `DELEGATE_TOOL_DESCRIPTION` parsing as `required` cannot leak
  into dispatch text. Scoped tests and typecheck are green.

**Status: CLEAN.** There are no critical, major or blocking findings. 1 minor and 5 nits are recorded
and not fixed, per the owner's rule.
