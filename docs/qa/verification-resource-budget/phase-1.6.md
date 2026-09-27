# Phase 1.6 — Dispatch directives (QA notes)

## Pre-flight

- `parseCapDirective` lives in `src/router/sessions.ts` (line 59). Regex
  `/\bCAP\s*:\s*(none|\d+)\b/i`, first match wins; `CAP:0`, `CAP:-1`, `CAP:abc` → `null`.
  It has **no explicit filter** for router-injected examples. The rule is structural:
  - `src/router/dispatch-header.ts` (`buildDispatchHeader`) pins the resolved value
    `CAP:${input.cap}` **before** the instructional sentence
    "To change the budget, put CAP:N or CAP:none accompanied by a reason: line in the dispatch.",
    so first-occurrence-wins keeps the real value;
  - the placeholder `CAP:N` does not match the value grammar, so it is skipped.
- Test files from `rg -l parseCapDirective test`:
  - `test/unit/guard-style-independence.test.ts`
  - `test/unit/sessions.test.ts`
- Shared helper: **none exists**. `src/verify/directives.ts` implements the same rule itself
  (`sessions.ts` untouched): first occurrence wins, and placeholder values (containing `|`, `<`
  or `>`, e.g. `VERIFY:required|deferred`, `VERIFY_WAIT:<n>s`) are treated as instructional
  examples and skipped silently, so a later real directive still applies.

## Result

- `parseVerifyDirectives(text, defaults, log?)` in `src/verify/directives.ts`; pure, logger seam.
- Tests: `npx vitest run --maxWorkers=2 test/unit/directives.test.ts` → 13 passed; `npm run typecheck` clean.
- Deviation: signature adds an optional third `log` parameter (the injected logger seam);
  `defaults` carries `defaultVerify`, `captureWaitMs`, `baselineTimeoutMs`.
- Unknown `VERIFY:` value: the first occurrence decides; an unknown value falls back to the default
  (with a log line) rather than searching for a later valid value.
