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

## Risk implementation notes

- `assessRisk({ changedFiles, reference, producerTier, scopingPlan })` in `src/verify/risk.ts`;
  `changedFiles: readonly ChangedPath[]`, `reference: boolean` (presence only),
  `producerTier: string`, `scopingPlan: StaticScoping` (type-only import from `./runner`).
- §1.5-17 lists the inputs but not the roll-up; the table in the file header is our interpretation:
  level = max of matching rows, then "no reference" raises one step (capped at high).
- Thresholds: 1-5 files low, 6-15 medium, 16+ high.
- Short-circuits: empty set → low ("no changes attributed"); docs-only (`docs/**`, `*.md`,
  `*.mdx`, `*.rst`, `*.txt`, including rename sources) → low, even without a reference.
- Deleted test → high; modified/renamed test → medium; other deletion or any rename → medium;
  config/lock/CI (incl. `.github/**`) → medium; `Unverifiable` → medium; fast tier → medium.
  `NoAffected` only adds an informational reason.
- Deletion/rename detection: `status` starting with `D`/`R` (case-insensitive, so porcelain
  `D`/`R100` and words both work) or `previousPath` present.
- Guards are inlined (`"unverifiable" in plan`) to keep the import type-only; semantics match
  `isUnverifiable`/`isNoAffected`.
- Tests: `npx vitest run --maxWorkers=2 test/unit/risk.test.ts test/unit/directives.test.ts` → 27 passed (14 risk); typecheck clean.
