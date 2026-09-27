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

## QA findings

Reviewer: @heavy, adversarial review of `754296c..8116966` (`src/verify/directives.ts`,
`src/verify/risk.ts`, both test files, this report) against plan §1.5-15, §1.5-17, §1.4 and
"Phase 1.6". `runner.ts` (merged from 1.3 in `64979a3`) is not under review.

Method: read the code and plan, then
`npx vitest run --maxWorkers=2 test/unit/directives.test.ts test/unit/risk.test.ts` → 2 files,
27 passed. Behaviour was then probed with a throwaway script, not committed, run via
`node --experimental-strip-types`. It imported both modules and a verbatim copy of
`parseCapDirective` (sessions.ts:59-66). The "Probe" lines below are its actual output.
Input facts used by the risk findings:
- `ChangedPath.path` is "Absolute, or relative to the planner's cwd" (runner.ts:745).
- The existing producer, `snapshotTree`, emits `{ path: resolve(root, record.slice(3)), status: record.slice(0, 2) }`
  (tree.ts:27). That means absolute paths with two-character porcelain XY status codes. It also
  drops the rename source (tree.ts:28).

Severity: High = the phase's core safety property is violated in realistic input; Medium = a
destructive/explicit intent is mis-rated in a plausible case; Low = hygiene, contract clarity or
narrow edge; Info = no change required.

### Directives

**QA-1.6-1 — High — a `VERIFY:required` in markdown formatting or before punctuation silently becomes deferred**
- Where: directives.ts:50-51, the value grammar `([^\s,;)\]}]*)`.
- Evidence: the value keeps any trailing markdown or punctuation, so it fails the `required|deferred` check.
  The result is the default (`deferred`), with only a log line the orchestrator never sees. `CAP:` has no
  such problem because its grammar is `(none|\d+)\b`.
  Probe:
  - `**VERIFY:required**` → `{"mode":"deferred","source":"default"}`, log `unknown VERIFY value "required**"`.
    Same input with `CAP:3` → `3`.
  - `` `VERIFY:required` `` → deferred (`"required`"`). Same input with `CAP:3` → `3`.
  - `VERIFY:required.` → deferred. `VERIFY:"required"` → deferred.
  - `**VERIFY_WAIT:2s**` → malformed, default 5000.

  Orchestrators routinely wrap directives in backticks or bold. This is exactly the failure the
  2.4 QA focus names ("a required one silently becomes deferred").
- Fix: end each value like `CAP:` does. Use `\bVERIFY\s*:\s*([a-z]+)\b` and
  `\bVERIFY_WAIT\s*:\s*(\d+)(ms|s)\b` (flag `i`), so `required**`, `` required` `` and `required.`
  resolve. Add tests for bold, backtick, trailing period and quotes, asserting parity with
  `parseCapDirective` on `**CAP:3**` / `` `CAP:3` ``.

**QA-1.6-2 — Medium — the first occurrence decides even when it is not a directive, which diverges from `CAP:`**
- Where: directives.ts:58-65 (`firstRealValue` returns the first non-placeholder match, whatever
  its value) and directives.ts:77-84. The deviation is recorded above in "Result" ("the first
  occurrence decides").
- Evidence: §1.5-15 requires "the same rules as `CAP:`". `parseCapDirective` skips occurrences
  that do not fit the grammar and keeps scanning:
  - `CAP:abc CAP:3` → `3`;
  - `Cap: the budget matters.\n\nCAP:3` → `3`.

  VERIFY instead takes ordinary prose as the first occurrence.
  Probe: `Verify: run npm test and report.\n\nVERIFY:required` → `{"mode":"deferred","source":"default"}`,
  log `unknown VERIFY value "run"`. The real directive is dropped. `Verify:` is common in
  dispatches (task lists, headings).
- Fix: the first **valid** occurrence wins (skip values outside `required|deferred`, as `CAP:`
  skips non-grammar values). Log an unknown value only when no valid occurrence exists, at most one
  line per key per parse. Remove the "first occurrence decides" deviation note.

**QA-1.6-3 — Low — the whitespace after the colon spans newlines, so prose turns into a directive**
- Where: directives.ts:50-51 (`\s*` plus the `i` flag).
- Evidence (probe):
  - `Steps to verify:\nrequired fields present` → required;
  - `Verify: required fields are validated` → required;
  - `Things to verify: deferred loading works` → `{"mode":"deferred","source":"directive"}`. With
    `defaultVerify: "required"` that is a downgrade.

  `CAP:` shares `\s*`/`i`, but its values (`none`, digits) rarely occur in prose. `VERIFY` values
  are ordinary English words. A case-insensitive key is plan-sanctioned (the test list includes
  `verify:Required`).
- Fix: use `[ \t]*` instead of `\s*` on both sides of the colon, so a directive cannot straddle a
  line break. Optionally require the value to be followed by whitespace, punctuation or the end of
  the text (as in QA-1.6-1).

**QA-1.6-4 — Low — the placeholder-skip rule depends on how future router text is worded; that contract is only implied**
- Where:
  - directives.ts:13-18 and :54-56 (skip values containing `|`, `<`, `>`, without logging);
  - dispatch-header.ts:31-32 (the `CAP:` precedent).
- Evidence:
  - `CAP:`'s router sentence contains a *valid* value (`CAP:none`). It is harmless only because
    the resolved `CAP:${input.cap}` is pinned before it (dispatch-header.ts:31).
  - VERIFY has no pinned value. If 2.3/2.4 copy that style into dispatch text, the example wins.
    Probe: `To choose, put VERIFY:required or VERIFY:deferred in the dispatch.\nVERIFY:deferred`
    → required.
  - A table cell without padding, `|VERIFY:required|`, is skipped silently (no log).
    `| VERIFY:required |` works.
- Fix (now, doc only): state the contract in the directives.ts header and in the 2.3/2.4 notes.
  Any VERIFY example the router injects into *dispatch* text must use `|` or `<…>` placeholders,
  or be preceded by a pinned resolved `VERIFY:<mode>` / `VERIFY_WAIT:<n>ms`.
  The golden check that `parseVerifyDirectives` returns defaults over the final header/protocol text
  is deferred by plan (2.3 protocol text / 2.4 wiring).

**QA-1.6-5 — Low — subagent self-selection can only be enforced by the caller; the "security" test proves nothing**
- Where: directives.ts:20-23 (the contract comment) and directives.test.ts:93-98.
- Evidence: the module is pure and cannot know where its text came from, so the guarantee
  depends entirely on the 2.4 caller. The comment states this correctly.
  The test titled "security: only reads the text it is given" only checks that the function is
  deterministic (`f(t) === f(t)`, `f("")` = default). It exercises no subagent source.
  Two points are missing for 2.4:
  - Parse the orchestrator-authored `task`/`delegate` `prompt` argument. Do not parse tool
    results, the subagent's final text, or the child session's messages.
  - Because the first occurrence wins, orchestrator text that *quotes* an earlier subagent's
    output containing `VERIFY:deferred` before its own directive would also win. A pinned resolved
    value (the CAP pattern) removes this.
- Fix: rename the test to "is deterministic" (or delete it), and add the two points above to the
  directives.ts header. The enforcement test ("Subagent cannot self-select", plan 2.4 new tests) is
  deferred by plan (2.4).

**QA-1.6-6 — Low — `source` mixes up where the mode and the wait came from**
- Where: directives.ts:74, :81, :94, :100.
- Evidence (probe): `VERIFY_WAIT:2s` → `{"mode":"deferred","waitMs":2000,"source":"directive"}`.
  The mode came from `defaultVerify`, yet `source` says `directive`.
  The same happens with `VERIFY:maybe VERIFY_WAIT:1s`.
  If 2.4 uses `source` to mean "the orchestrator chose the mode", it is wrong.
- Fix: document `source` as "any directive applied". Better: return `modeSource` and
  `waitSource`. The plan signature has a single `source`, so if it is split, record that as a
  deviation.

**QA-1.6-7 — Low — unknown values are logged verbatim: unbounded length and raw control characters**
- Where: directives.ts:83, :96.
- Evidence (probe):
  - `verify:` followed by 200 × `A` → the full 200-character value is logged.
  - `verify:\u001b[31mred` → the ESC byte reaches the log unescaped.

  The value comes from dispatch text and is excluded only from whitespace and `,;)]}`.
- Fix: truncate to about 32 characters and escape control characters (e.g. `JSON.stringify(v.slice(0, 32))`).
  Together with QA-1.6-2, this limits logging to one bounded line per key per dispatch.

**QA-1.6-8 — Info — the default wait is not capped at `baselineTimeoutMs`**
- Where: directives.ts:73.
- Evidence (probe): `captureWaitMs: 60000`, `baselineTimeoutMs: 15000`, no directive → `waitMs: 60000`.
  This matches §1.5-15 as written: only `VERIFY_WAIT` is capped, and "absent means
  `captureWaitMs`". But waiting past the capture's own bound is pointless.
- Fix: clamp `captureWaitMs ≤ baselineTimeoutMs` in the §1.4 config resolver (`captureWaitMs` is
  not in `src/router/config.ts` yet). Deferred by plan (the §1.4 config resolver phase; which
  phase owns the new key was not checked).

### Risk signal

**QA-1.6-9 — High — absolute paths: any ancestor directory named `docs` makes every change "documentation-only" (low)**
- Where: risk.ts:77-80 (`(^|\/)docs\/`), :82-91 (`(^|\/)(test|tests|__tests__)\/`), :97 (`.github`),
  and the short-circuit at :127-129.
- Evidence: the classifiers match any path segment, including the checkout's ancestors, and the
  real producer supplies absolute paths (tree.ts:27, runner.ts:745). Probe:
  - `{path:"/home/u/docs/app/test/a.test.ts", status:" D"}` → `{"level":"low","reasons":["documentation-only change"]}`.
    A deleted test is rated low.
  - `D:\work\docs\app\src\core.ts` deleted → low.
  - `/home/u/docs/app/package.json`, `reference:false` → low. The short-circuit also bypasses the
    "no reference" raise.
  - In the other direction, `/tmp/test/app/src/a.ts` modified → medium with "a test file was
    modified". Every file is treated as a test.

  This is the plan's named failure mode: a destructive change rated low.
- Fix: classify on repo-relative paths. Either add `root` to `RiskInput` and strip it (after `\`
  → `/` normalisation, case-insensitively on win32), or require the caller to pass relative paths
  and assert that none is absolute. Add tests with absolute paths under `docs`/`test` ancestors.

**QA-1.6-10 — Medium — the "docs" definition is too broad, and the docs-only row wins over the config row**
- Where: risk.ts:77-80 and :127-129.
- Evidence (probe):
  - `requirements.txt` → low "documentation-only change" (a Python dependency manifest);
  - `CMakeLists.txt`, `reference:false` → low;
  - `docs/package.json` → low, although `isConfigPath` matches it;
  - `docs/conf.py` + `docs/vite.config.ts` → low.

  The docs-only row is the implementer's; the plan only says "only docs changed → low" and does
  not define docs.
- Fix:
  - A path is documentation only if neither `isConfigPath` nor `isTestPath` matches it.
  - Restrict `docs/**` to documentation/asset extensions (`md`, `mdx`, `rst`, `txt`, images).
  - Drop bare `*.txt`, or allowlist names such as `LICENSE.txt`/`CHANGELOG.txt`.
  - Classify `requirements*.txt`/`constraints*.txt` as lock/config.

**QA-1.6-11 — Medium — changes to test expectations and test configuration are rated low**
- Where: risk.ts:82-91 (no snapshot patterns) and :93-113.
- Evidence (probe):
  - `src/__snapshots__/a.test.ts.snap` modified → low. Rewriting snapshots is the classic way to
    make a failing test "pass", and it falls under §1.5-17 "whether any test file was modified".
  - `vite.config.ts` → low. Vitest reads its `test` block, so editing it changes what runs.
  - `vitest.workspace.ts`, `vitest.setup.ts`, `pytest.ini`, `tox.ini`, `setup.cfg` → low.
  - `.gitlab-ci.yml` → low.

  The config list does match the §1.5-17 enumeration exactly, plus the lockfiles. That part is a
  gap in the plan.
- Fix:
  - `isTestPath`: add `(^|/)__snapshots__/` and `\.snap$`.
  - `isConfigPath`: add `vite.config.*`, `vitest.workspace.*`, `(vitest|jest).setup.*`,
    `setupTests.*`, `pytest.ini`, `tox.ini`, `setup.cfg` and `.gitlab-ci.yml`. Record it as an
    extension of the §1.5-17 list.

**QA-1.6-12 — Medium — a deletion in the porcelain Y (worktree) column is missed**
- Where: risk.ts:115-117 (`/^d/i` on the trimmed status) and :119-121 (`/^r/i`).
- Evidence: tree.ts:27 emits two-character porcelain XY codes. A file with staged changes that
  the producer then deletes is `MD` (also `AD`, `RD`). Probe:
  - `{path:"test/a.test.ts", status:"MD"}` → medium, "a test file was modified", instead of high;
  - `{path:"src/a.ts", status:"AD"}` → low, with no deletion reason.

  ` D` and `D ` work.
- Fix: for a two-character code, D (or R) in either column counts as deleted (or renamed).
  Keep the word forms (`deleted`) and name-status forms (`R100`). Add `MD`/`AD` cases.

**QA-1.6-13 — Low — moving a test file out of test collection counts as a modification, not a deletion**
- Where: risk.ts:143-147.
- Evidence (probe): `src/a.test.ts` → `src/a.ts` or → `src/a.test.ts.bak` (`status:"R "`) → medium
  ("a test file was modified"). The test stops running, which is effectively a deletion.
  Separately, tree.ts:28 skips the rename source, so `previousPath` is never filled today.
  runner.ts:302 already says "2.1 should pass previousPath".
- Fix: when `previousPath` is a test path and `path` is not, add `testDeleted` (high), with a test.
  Filling `previousPath` is deferred by plan (2.1).

**QA-1.6-14 — Low — an empty change set is rated low, which also hides a failed attribution**
- Where: risk.ts:126.
- Evidence: `snapshotTree` returns `undefined` in several cases, e.g. submodules (tree.ts:35). If
  a 2.4 caller maps "unknown" to `[]`, the result is low with "no changes attributed", although
  nothing was actually attributed. The plan requires the empty → low row. The risk lies in how
  the caller uses it.
- Fix: in the risk.ts header, state that callers must not pass `[]` when attribution failed.
  Handling the unknown case (e.g. medium, "changes could not be attributed") is deferred by plan
  (2.4).

**QA-1.6-15 — Low — duplicate paths inflate the file count**
- Where: risk.ts:138.
- Evidence (probe): six records for the same `src/a.ts` → medium, "6-15 files changed". This errs
  on the safe side, but it is noise.
- Fix: deduplicate by normalised path (case-folded on win32) before counting.

**QA-1.6-16 — Low — gaps in the test guards**
- Where: risk.test.ts:119-123 and directives.test.ts (whole file).
- Evidence:
  - The acceptance criterion covers **both** modules ("Neither module imports `child_process`, `fs`
    or the network"), but only risk.ts has a purity assertion. directives.ts currently has no
    imports at all (verified), so the criterion is met today, with no regression guard.
  - risk.test.ts:121 matches only double-quoted `from "fs"` and misses `require(` or `import(`.
  - The fenced-block parity test (directives.test.ts:64-79) only compares presence. Its inputs
    carry no markdown formatting, so it could not catch QA-1.6-1.
- Fix: add the same import-list assertion for directives.ts, and reject `require(`/`import(`.
  Extend the parity inputs with bold, backticks and trailing punctuation.

**QA-1.6-17 — Info — the implementer's additions and thresholds are consistent with §1.5-17 (no change)**
- Fast tier → medium: the producer tier is a listed input, and §1.5-17 leaves the roll-up to "a
  fixed, documented table". Keep it. The match is exact and case-sensitive (probe: `"Fast"` → low),
  so 2.4 must pass the canonical lowercase tier id.
- Docs-only stays low without a reference: acceptable, because the reference serves test verdicts.
  Keep it, once QA-1.6-9/10 narrow what counts as docs.
- Thresholds `SMALL_CHANGE_MAX=5`, `MEDIUM_CHANGE_MAX=15`: the plan fixes no numbers (it only asks
  for tests at "the exact file-count thresholds"). They are documented in the header and tested at
  both edges (5/6, 15/16).
- `REASONS.small`/`mediumCount` repeat 5 and 15 as literals. The stable-string test pins both,
  so drift would fail CI. Acceptable.
- Row 10 (Unverifiable → medium) and NoAffected being informational only: consistent with the plan.

### Verified OK (no finding)

**Directives**
- Word boundaries: `XVERIFY:required` and `_VERIFY:required` → not a directive.
  `PRE-VERIFY:required` → a directive, the same `\b` behaviour as `CAP:`.
- Key separation: `VERIFY:` does not match `VERIFY_WAIT:`.
- Whitespace: `VERIFY: required`, `VERIFY :required` and a no-break space after the colon parse.
- Unicode: a full-width colon, a Cyrillic `Е` or a zero-width space give "not a directive", which
  falls back to the default, the same as `CAP:`.
- Fenced code blocks are parsed, as the plan requires for parity.
- `VERIFY_WAIT` overflow and units:
  - `1e400s` → malformed + log;
  - a 400-digit number of seconds → `Infinity` → capped at 15000;
  - `-1s`, `1.5s`, `5`, `5 s` → malformed + log;
  - `5S` → accepted.

**Risk**
- Path forms: backslash paths (`src\a.test.ts` deleted → high) and a `./` prefix
  (`./.github/workflows/ci.yml` → medium).
- `.GitHub/` casing: git reports the repository's real casing, and GitHub Actions only reads
  `.github/`, so this is not a finding.
- Purity: risk.ts has a single `import type` from `./runner`; directives.ts has no imports. No
  process, fs or network access.
- Reason strings are stable and pinned by a test.
