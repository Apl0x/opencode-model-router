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
- Unknown `VERIFY:` value: superseded by QA-1.6-2 — the first VALID occurrence wins; unknown values
  are logged once per key only when no valid occurrence exists.
- Deviation (QA-1.6-6): the result carries `modeSource` and `waitSource` instead of the plan's single `source`.
- Extension of §1.5-17 config list (QA-1.6-11): `vite.config.*`, `vitest.workspace.*`, `*setup*.{js,ts}`,
  `pytest.ini`, `tox.ini`, `setup.cfg`, `setup.py`, `.gitlab-ci.yml`, `Makefile`, `CMakeLists.txt`,
  `requirements*.txt`/`constraints*.txt`; snapshots (`__snapshots__/**`, `*.snap`) count as test files.
- `assessRisk` takes an optional `root` (git root); absolute paths are made repo-relative before classification.
- Deviation (QA-1.6-18): a non-upper-case `VERIFY`/`VERIFY_WAIT` key counts only when its value ends the line, is followed by closing marks/punctuation/a table pipe up to the end of the line, or by another directive key with a valid value on the same line (QA-1.6-27, QA-1.6-35). Upper-case keys are unchanged.

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
- Resolution: 35669c0 — value grammar `([a-z]+)\b` / `(\d+)(ms|s)\b`, one leading quote/markdown mark accepted (`VERIFY:"required"` → required); bold/backtick/period/quote tests and CAP parity tests.

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
- Resolution: 35669c0 — first VALID occurrence wins; unknown logged once per key only when no valid one exists.

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
- Resolution: 35669c0 — `[ \t]*` around the colon; line-break tests.

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
- Resolution: 35669c0 — router-example contract documented in the directives.ts header (2.3/2.4 must follow it).

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
- Resolution: 35669c0 — test renamed "is deterministic and stateless"; header documents prompt-only parsing and the quoting risk. Enforcement test stays deferred (2.4).

**QA-1.6-6 — Low — `source` mixes up where the mode and the wait came from**
- Where: directives.ts:74, :81, :94, :100.
- Evidence (probe): `VERIFY_WAIT:2s` → `{"mode":"deferred","waitMs":2000,"source":"directive"}`.
  The mode came from `defaultVerify`, yet `source` says `directive`.
  The same happens with `VERIFY:maybe VERIFY_WAIT:1s`.
  If 2.4 uses `source` to mean "the orchestrator chose the mode", it is wrong.
- Fix: document `source` as "any directive applied". Better: return `modeSource` and
  `waitSource`. The plan signature has a single `source`, so if it is split, record that as a
  deviation.
- Resolution: 35669c0 — split into `modeSource`/`waitSource` (deviation recorded under Result).

**QA-1.6-7 — Low — unknown values are logged verbatim: unbounded length and raw control characters**
- Where: directives.ts:83, :96.
- Evidence (probe):
  - `verify:` followed by 200 × `A` → the full 200-character value is logged.
  - `verify:\u001b[31mred` → the ESC byte reaches the log unescaped.

  The value comes from dispatch text and is excluded only from whitespace and `,;)]}`.
- Fix: truncate to about 32 characters and escape control characters (e.g. `JSON.stringify(v.slice(0, 32))`).
  Together with QA-1.6-2, this limits logging to one bounded line per key per dispatch.
- Resolution: 35669c0 — logged values truncated to 32 chars via JSON.stringify, C1/DEL escaped; test.

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
- Resolution: 3ddd994 — `RiskInput.root` added; paths made repo-relative (case-folded for drive-letter roots); unresolvable absolute paths never count as docs; POSIX/Windows tests with `docs`/`test` ancestors.

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
- Resolution: 3ddd994 — docs exclude test/config paths; `.md/.mdx/.rst/.adoc` anywhere, `LICENSE.txt`/`CHANGELOG.txt`, doc/image types only under `docs/`; bare `*.txt` dropped.

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
- Resolution: 3ddd994 — snapshots → test (medium); config list extended (recorded under Result as §1.5-17 extension).

**QA-1.6-12 — Medium — a deletion in the porcelain Y (worktree) column is missed**
- Where: risk.ts:115-117 (`/^d/i` on the trimmed status) and :119-121 (`/^r/i`).
- Evidence: tree.ts:27 emits two-character porcelain XY codes. A file with staged changes that
  the producer then deletes is `MD` (also `AD`, `RD`). Probe:
  - `{path:"test/a.test.ts", status:"MD"}` → medium, "a test file was modified", instead of high;
  - `{path:"src/a.ts", status:"AD"}` → low, with no deletion reason.

  ` D` and `D ` work.
- Fix: for a two-character code, D (or R) in either column counts as deleted (or renamed).
  Keep the word forms (`deleted`) and name-status forms (`R100`). Add `MD`/`AD` cases.
- Resolution: 3ddd994 — two-char porcelain: D/R in either column counts; `MD`/`AD`/`RM` tests.

**QA-1.6-13 — Low — moving a test file out of test collection counts as a modification, not a deletion**
- Where: risk.ts:143-147.
- Evidence (probe): `src/a.test.ts` → `src/a.ts` or → `src/a.test.ts.bak` (`status:"R "`) → medium
  ("a test file was modified"). The test stops running, which is effectively a deletion.
  Separately, tree.ts:28 skips the rename source, so `previousPath` is never filled today.
  runner.ts:302 already says "2.1 should pass previousPath".
- Fix: when `previousPath` is a test path and `path` is not, add `testDeleted` (high), with a test.
  Filling `previousPath` is deferred by plan (2.1).
- Resolution: 3ddd994 — test `previousPath` renamed to non-test path → `testDeleted` (high). Filling `previousPath` stays deferred (2.1).

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
- Resolution: 3ddd994 — count deduplicated by normalised path (case-folded for drive-letter paths).

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
- Resolution: 35669c0, 3ddd994 — directives.ts purity test; `require(`/`import(`/`process.` guards in both; formatted parity inputs.

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

## QA re-review (round 2)

Reviewer: @heavy, adversarial re-review of `3338d75..f16b56c` (35669c0, 3ddd994, f16b56c):
`src/verify/directives.ts`, `src/verify/risk.ts`, both test files and this report, against plan
§1.5-15, §1.5-17, "Phase 1.6" (plan L857-915) and the 2.4 tasks (plan L1158-1218).

Method:
- `npx vitest run --maxWorkers=2 test/unit/directives.test.ts test/unit/risk.test.ts` → 2 files, 41 passed.
- Throwaway scripts in `%TEMP%\omr-qa16r2` (deleted afterwards), run with `node --experimental-strip-types`.
  They import both modules and a verbatim copy of `parseCapDirective` (sessions.ts:59-66). The
  labels in brackets below (`[1a]`, `[e20]`, ...) are probe cases; the quoted results are their
  actual output.
- Real porcelain: a temp git repo (git 2.51.0.windows.1) put into `MD`, `RD`, `R `, `RM`, `UU`,
  `D `, ` D`, ` M`, `??` and intent-to-add states. Its changed files were read with the real
  `snapshotTree` (tree.ts) and passed to `assessRisk`. tree.ts:21/27 passes `status --porcelain=v1 -z`
  records as `{ path: resolve(root, record.slice(3)), status: record.slice(0, 2) }`, where `root` is
  the `rev-parse --show-toplevel` output. The rename source is skipped (tree.ts:28).

### Resolved findings — verification

| Finding | Status | Evidence |
|---|---|---|
| QA-1.6-1 | Verified | [1a] `**VERIFY:required**` → required (`**CAP:3**` → 3); [1b] `` `VERIFY:required` `` → required; [1c] `VERIFY:required.` → required; [1d] `VERIFY:"required"` → required; [1e] `**VERIFY_WAIT:2s**` → 2000. |
| QA-1.6-2 | Verified (whitespace-separated occurrences) | [2a] `Verify: run npm test and report.\n\nVERIFY:required` → required, no log; `CAP:abc CAP:3` → 3. Residual in the same whitespace-free token: QA-1.6-19. |
| QA-1.6-3 | Verified for the mandatory part (no line straddle); same-line residual | [3a] `Steps to verify:\nrequired fields present` → default; [3d] `VERIFY:\ndeferred` (default required) → required/default. The round-1 same-line examples still parse: [3b] `Verify: required fields are validated` → required; [3c] `Things to verify: deferred loading works` → deferred, `modeSource:"directive"`. The round-1 fix called the terminator part optional, so this is tracked as QA-1.6-18. |
| QA-1.6-4 | Verified (doc contract) | Contract in directives.ts:21-27. Behaviour unchanged by design: [4a] literal example + `VERIFY:deferred` → required; [4b] `\|VERIFY:required\|` → default, no log (documented); [4d] `VERIFY:required\|deferred`/`VERIFY_WAIT:<n>s` → defaults, no log. |
| QA-1.6-5 | Verified | Test renamed "is deterministic and stateless"; directives.ts:29-35 names the prompt-only rule and the quoting risk. Two consecutive calls return equal results. |
| QA-1.6-6 | Verified | [6a] `VERIFY_WAIT:2s` → `modeSource:"default"`, `waitSource:"directive"`; [6b] `VERIFY:maybe VERIFY_WAIT:1s` → `modeSource:"default"` + one log line. |
| QA-1.6-7 | Verified (length, C0, C1/DEL) | [7a] 200 × `A` → the log holds exactly 32 `A`s; [7b] ESC and U+009B → `\u001b` / `\u009b` escaped. Residual for Unicode format characters: QA-1.6-24. |
| QA-1.6-9 | Verified | With `root`: [9a] `/home/u/docs/app/test/a.test.ts` ` D` → high; [9b] `D:\work\docs\app\src\core.ts` ` D` → medium; [9c] `/home/u/docs/app/package.json`, no reference → high; [9d] `/tmp/test/app/src/a.ts` → low `["1-5 files changed"]`. Absolute paths without a usable root never count as docs (tested). Edge cases: QA-1.6-22. |
| QA-1.6-10 | Verified | `requirements.txt`, `CMakeLists.txt`, `docs/package.json` (no reference) → high, config reason; [10d] `docs/conf.py` + `docs/vite.config.ts` → medium. Residual: QA-1.6-23. |
| QA-1.6-11 | Verified | `src/__snapshots__/a.test.ts.snap` → medium "a test file was modified"; `vite.config.ts`, `vitest.workspace.ts`, `vitest.setup.ts`, `pytest.ini`, `tox.ini`, `setup.cfg`, `.gitlab-ci.yml` → medium config. Breadth of the setup rule: QA-1.6-21. |
| QA-1.6-12 | Verified, including real porcelain | Synthetic: `MD` test → high; `AD`/`RD` → deleted-or-renamed. Real `snapshotTree` output: `MD test/a.test.ts` → high; `RD`, `R `, `RM`, `D `, and a worktree-column ` R` → medium. See "Real porcelain" below. |
| QA-1.6-13 | Verified with an explicit `previousPath`; not reachable from tree.ts yet | [13a] `src/a.test.ts` → `src/a.ts` and [13b] → `src/a.test.ts.bak` → high "a test file was deleted". Real output: raw `R  test/r.ts\0test/r.test.ts\0`, yet `snapshotTree` lists only `test/r.ts`, so `previousPath` stays empty. Without it, [13c] `R ` → medium only. Deferred (2.1). |
| QA-1.6-15 | Verified | [15a] 6 × `src/a.ts` → low; [15b] `./src/a.ts`, `src\a.ts`, `src/a.ts`, `D:\r\src\a.ts`, `d:/R/src/A.ts` + `src/b.ts` with root `D:\r` → 2 keys, low. [15c] POSIX case-distinct paths stay distinct (correct). |
| QA-1.6-16 | Verified | directives.ts purity test added; both guards reject `require(`/`import(`/`process.`; the parity inputs include bold, backtick and punctuation wrappers. Residual guard gaps: QA-1.6-25. |

Not changed by design (unchanged from round 1):
- QA-1.6-8: deferred to the §1.4 config-resolver phase.
- QA-1.6-14: the header note is now present (risk.ts:16-17); the unknown case is deferred (2.4).
- QA-1.6-17: Info, no change.

### Real porcelain (tree.ts → assessRisk, root = `rev-parse --show-toplevel`)

| status (tree.ts) | path | level, reasons |
|---|---|---|
| ` D` | `docs/guide.md` | low, documentation-only |
| ` M` | `docs/my guide.md`, `docs/ünï.md` | low, documentation-only (`-z` means no quoting; spaces and Unicode survive) |
| `R ` / `RM` / `RD` | `src/b2.ts` / `src/c2.ts` / `src/renamed.ts` | medium, deleted-or-renamed |
| ` R` | `src/ita.ts` | medium. Git paired the intent-to-add file with a deleted staged file as a worktree rename, so a planned `AD` came out as ` R` + `A `: R in the Y column. |
| `D ` | `src/gone.ts` | medium |
| `A ` | `src/new.ts` | low |
| `UU` | `src/conflict.ts` | low (see QA-1.6-26) |
| `MD` | `test/a.test.ts` | high, "a test file was deleted" |
| `R ` | `test/r.ts` (from `test/r.test.ts`) | medium, test modified (still under `test/`) |
| `??` | `notes.md` | low, documentation-only |

All 13 records together → high `["6-15 files changed","a test file was deleted","files were deleted or renamed"]`,
with every root spelling and with no root.

### New findings

| ID | Severity | Summary |
|---|---|---|
| QA-1.6-18 | Low | Same-line prose is still a directive; the leading-quote acceptance widens it |
| QA-1.6-19 | Low | A second occurrence in the same whitespace-free token is swallowed (`CAP:` finds it) |
| QA-1.6-20 | Low | NBSP/Unicode spaces around the colon no longer parse, silently (parity regression) |
| QA-1.6-21 | Low | The `*setup*` config rule over-rates application code and is the only super-linear regex |
| QA-1.6-22 | Low | The `root` contract: a subdirectory root can under-rate; `TreeSnapshot` does not expose the toplevel |
| QA-1.6-23 | Low | `requirements/*.txt` directories are not treated as dependency manifests |
| QA-1.6-24 | Info | Log escaping leaves Unicode format characters (bidi overrides) raw |
| QA-1.6-25 | Info | The purity guards miss global network APIs and non-listed re-exports |
| QA-1.6-26 | Info | The first-letter status heuristic for word forms; `UU` rated as an ordinary change |

**QA-1.6-18 — Low — same-line prose is still a directive; the leading-quote acceptance widens it**
- Where: directives.ts:70 (`i` flag on the key), :72 (`LEAD`), :73.
- Evidence (probe):
  - [3b] `Verify: required fields are validated` → required;
  - [3c] `Things to verify: deferred loading works`, `defaultVerify:"required"` → deferred, `modeSource:"directive"`;
  - [q1] `Please verify: "deferred" state is rendered correctly.` → deferred;
  - [q3] ``Things to verify: `deferred` imports still resolve`` → deferred;
  - [q2] `Also verify: *required* fields show an error.` → required;
  - [q4] `verify: 'required' props are passed` → required.

  q1-q4 are new with 35669c0. The round-1 grammar kept the quote/backtick in the value, so those
  inputs fell back to the default. Downgrades only matter with the opt-in `defaultVerify:"required"`.
  Upgrades spend a synchronous gate, which is the resource this plan budgets.
- Fix: keep upper-case `VERIFY:` as it is. When the key is not written in upper case, accept the
  value only if nothing except closing markup or punctuation follows it before the end of the line
  or the next directive. The plan's `verify:Required` test still passes, and 3b/3c/q1-q4 are
  rejected. Add these six strings as tests.

**QA-1.6-19 — Low — a second occurrence in the same whitespace-free token is swallowed**
- Where: directives.ts:70-71 (`(\S*)` inside the scan regex) and :92 (`matchAll` resumes after the capture).
- Evidence (probe):
  - [s1] `VERIFY:maybe,VERIFY:required` → default, log `"maybe,VERIFY:required"`; `CAP:abc,CAP:3` → 3;
  - [s2] the same with `;`;
  - [s3] `(VERIFY:tbd)/VERIFY:required` → default;
  - [s4] `VERIFY_WAIT:soon,VERIFY_WAIT:2s` → 5000 (default);
  - [s5] with different keys (`VERIFY:required,VERIFY_WAIT:2s`) both parse.

  The drop is logged, not silent, and the trigger is narrow. It still breaks the "same rules as
  `CAP:`" parity.
- Fix: match only key + colon in `VERIFY_RE`/`WAIT_RE`. Read the token with a sticky `/\S*/y` at
  the end of the match, so scanning resumes right after the colon. Add s1/s4 as parity tests.

**QA-1.6-20 — Low — NBSP/Unicode spaces around the colon no longer parse (silent parity regression)**
- Where: directives.ts:70-71 (`[ \t]*`, introduced for QA-1.6-3).
- Evidence (probe):
  - [n1] `VERIFY:\u00a0required` → default, **no log**; `CAP:\u00a03` → 3;
  - [n3] U+3000 → the same;
  - `VERIFY\u00a0:required` → default.

  The round-1 "Verified OK" list had "a no-break space after the colon parse(s)". The failure is
  silent because `(\S*)` captures `""`, and an empty value is skipped without a log line. An
  explicit `required` becomes the default `deferred`: the failure class named in the 2.4 QA focus.
- Fix: replace `[ \t]*` with `[^\S\r\n\u2028\u2029]*` on both sides of the colon. That allows any
  horizontal whitespace and still never straddles a line. Add NBSP/U+3000 parity tests next to
  the existing line-break tests.

**QA-1.6-21 — Low — the `*setup*` config rule over-rates application code and is the only super-linear regex**
- Where: risk.ts:157 (`/setup[^/]*\.[cm]?[jt]sx?$/i`).
- Evidence:
  - Over-rating (probe): `src/setup.ts`, `src/ui/SetupWizard.tsx`, `src/hooks/useSetup.ts`,
    `src/server/setupRoutes.js` and `lib/teardownAndSetup.mjs` → medium "config, lock or CI files
    changed". `src/setup.ts` with no reference → high. (This repo has no such file:
    `git ls-files | rg -i setup` is empty, so these are synthetic paths.)
  - Setup files under test directories already hit the test row: `test/setup.ts` and
    `tests/auth.setup.ts` → "a test file was modified". Outside test directories the broad pattern
    adds mostly false positives.
  - Cost (probe, basename of repeated `setup`): 10k chars → 12 ms, 20k → 56 ms, 40k → 206 ms,
    80k → 840 ms, which is quadratic. At 100k, `isConfigPath` takes 1.3 s and `assessRisk` 2.6 s
    per file (it runs the rule twice). Real file names are at most 255 characters (255 → 0.0 ms).
    But tool-observed paths (`extractChangedFile`, dispatch.ts:54-67) are model-supplied arguments
    that are never checked against the filesystem.
  - All other directive and risk regexes are linear. 100k-character adversarial inputs took
    ≤ 4.1 ms; 1M characters took 24.6 ms, a 10× input giving about a 7.7× time.
- Answer: not acceptable as is. Restrict the rule to test-setup naming conventions.
- Fix: replace line 157 with `/\.setup\.[cm]?[jt]sx?$/i.test(b)` (covers `vitest.setup.*`,
  `jest.setup.*`, `auth.setup.*`) or
  `/^(setupTests|setup-tests|test-setup|global-setup|globalSetup)\.[cm]?[jt]sx?$/i.test(b)`. Both
  are linear. Tests: keep `vitest.setup.ts`, `src/setupTests.js`, `e2e/global-setup.ts` and
  `jest.setup.js` as config; assert `src/setup.ts` and `src/ui/SetupWizard.tsx` are not config.
  Record the change as an adjustment to the §1.5-17 extension.

**QA-1.6-22 — Low — the `root` contract: a subdirectory root can under-rate; `TreeSnapshot` does not expose the toplevel**
- Where: risk.ts:7-11, :56-57, :102-111; dispatch.ts:18-24; tree.ts:16, :47.
- Evidence:
  - [e20] root `D:\repo\tests`, deleted `D:\repo\tests\helpers\db.ts` → medium ("files were deleted
    or renamed"). With the toplevel root [e19] → high ("a test file was deleted"). A root that is
    a subdirectory strips the inner `tests/` segment and under-rates a test deletion.
  - Real run under `%TEMP%` (`C:\Users\MARQUI~1\...`): `show-toplevel` =
    `C:/Users/Marquinho/...`, and the tree.ts paths are `C:\Users\Marquinho\...`. For the
    docs-only subset:
    - root = the 8.3 spelling → medium `["1-5 files changed","files were deleted or renamed"]`
      (conservative);
    - root = `show-toplevel` or `snapshot.cwd` → low.
    - `realpathSync(repo)` returned the 8.3 form; `realpath` from `fs/promises`, as used by
      tree.ts, returned the long form.
  - `TreeSnapshot` carries `cwd: realpath(cwd)` but not the git root. `cwd` is a subdirectory
    whenever the delegation's cwd is one. So the 2.4 caller has no toplevel to hand unless it runs
    git again.
  - UNC roots are not case-folded. [e9] `\\SERVER\share\repo\docs\a.md` under root
    `\\server\share\repo` → not docs. [e10] a `tests` ancestor makes a `src` deletion "a test file
    was deleted". Both are conservative.
  - Correct edge cases:
    - trailing separators [e1-e4] and mixed separators [e5];
    - drive-letter case [e6] and POSIX case sensitivity [e7];
    - `D:\` [e16] and `/` [e17] as roots;
    - the root itself as a path [e11] and paths outside the root [e12, e13, e18] fall back
      conservatively;
    - `D:\repo2` is not taken to be under `D:\repo` [e13].
  - `..` segments are not normalised: [e15] `D:\repo\..\evil\README.md` → docs. tree.ts resolves
    paths, so only raw tool-observed paths could contain `..` (Info).
- Fix now (doc): in the risk.ts header, state that `root` must be the toplevel the paths were
  resolved against (`git rev-parse --show-toplevel`, as tree.ts uses), never the delegation cwd,
  because a subdirectory root can under-rate. Optionally fold case for `//host/share` roots, as is
  done for drive letters.
- Deferred by plan (2.1/2.4): expose the toplevel on `TreeSnapshot` (or emit repo-relative paths),
  and pass it through in the 2.4 wiring.

**QA-1.6-23 — Low — `requirements/*.txt` directories are not dependency manifests**
- Where: risk.ts:167 (basename-only `^(requirements|constraints).*\.txt$`).
- Evidence (probe): `requirements/base.txt`, no reference → medium `["1-5 files changed","no reference…"]`
  with no config reason. `requirements.txt` → high with the config reason. The pip layout
  `-r requirements/base.txt` is common.
- Fix: also match `(^|/)requirements/[^/]*\.txt$`, with a test.

**QA-1.6-24 — Info — log escaping leaves Unicode format characters raw**
- Where: directives.ts:78-83.
- Evidence: [7d] `verify:\u202eevil` → the log line contains a raw U+202E (right-to-left
  override). `JSON.stringify` escapes C0; `safe` adds U+007F-U+009F only. Bidi controls, zero-width
  characters and U+2028/2029 inside a longer token pass through. The problem is limited to the log.
- Fix (optional): widen the class to `[\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]`.

**QA-1.6-25 — Info — the purity guards miss global network APIs and non-listed re-exports**
- Where: risk.test.ts (purity test) and directives.test.ts (QA-1.6-16 test).
- Evidence: running the risk guard regex on these strings reports each as NOT caught:
  - `await fetch("http://x")`;
  - `new WebSocket(u)`;
  - `export { cpus } from "node:os"` (the directives guard catches `node:`, but not `fetch`).

  Neither module contains any of them today.
- Fix (optional): add `\bfetch\(|\bWebSocket\b|\bXMLHttpRequest\b|^export .* from` to both guards.

**QA-1.6-26 — Info — the first-letter status heuristic for word forms; `UU` rated as ordinary**
- Where: risk.ts:173-177.
- Evidence (probe):
  - `removed` → R → "renamed". For a test file this gives medium, not high: `testGone` needs
    `deleted` (risk.ts:231-232).
  - `dirty` → D.
  - `UU` (unresolved conflict, real porcelain) → low.

  No producer emits word forms that start with D or R today: tree.ts emits porcelain codes, and
  `extractChangedFile` emits `written`/`modified` (dispatch.ts:66). The header documents the rule.
- Fix: none now. If 2.x introduces word statuses, map them explicitly (`deleted|removed` → D,
  `renamed` → R).

### Other checks (no finding)

- `modeSource`/`waitSource` compared with the plan contract. Plan 1.6.1 (L874-875) specifies one
  `source`. A grep of the plan shows L875 is the only place that mentions it. The 2.4 tasks and
  tests (L1158-1218) consume only `mode` and `waitMs`. The deviation is recorded under "Result".
  What 2.4 consumers must do:
  - use `modeSource` wherever they need "the orchestrator chose the mode" (e.g. a footer or log
    note, or the "`defaultVerify:"required"` with no directive" test → `modeSource:"default"`);
  - never infer it from `waitSource`;
  - destructure `mode`/`waitMs`, not `source`.

  The 1.6.1 signature text in the plan should be amended when the plan is next revised.
- Directives:
  - `VERIFY:**required**`, ``VERIFY:``required`` ``, `VERIFY:_required_`, `_VERIFY:required_` and
    `VERIFY:[required]` → default. The matching `CAP:` forms (`CAP:**3**`, `CAP:_3_`, `_CAP:3_`,
    `CAP:[3]`) → null too, so parity holds.
  - `*VERIFY:required*`, `VERIFY:*required*` → required.
  - Header nit: `_` is listed as an accepted leading mark, but `VERIFY:_required_` fails at the
    closing `_` (a word character).
  - `VERIFY:required/deferred` → required (the `/` form is not a placeholder). The router contract
    requires `|` or `<…>`, so this is not a finding.
  - `CAP:0 CAP:3` → null, while `VERIFY_WAIT:0s VERIFY_WAIT:2s` → 0. Both follow their own grammar.
  - `VERIFY_WAIT:007s` → 7000; `5Ms` → 5; `VERIFY_WAIT : 2s` → 2000; a 400-digit number → capped
    at 15000; `VERIFY_WAIT:2s|5s` → placeholder.
  - U+2028 after the colon → skipped (`\S*` ends at it).
  - The global regexes are used through `matchAll` (it clones them), and the value regexes are
    non-global, so there is no `lastIndex` state across calls.
- Docs set:
  - `README` and `LICENSE` (no extension), `docs/a.pdf`, `docs/index.html`, `docs/api.json` and
    `docs/_static/app.js` → not docs. That errs to medium only when there is no reference.
  - `docs/requirements.txt` and `.github/PULL_REQUEST_TEMPLATE.md` → config. This is plan-mandated
    (`.github/**`) and conservative.
  - `Docs/guide.txt`, `CHANGELOG.TXT`, `notes.MD` → docs. `test/fixtures/x.md` → test.
  - `src/prompts/system.md` → docs. Markdown anywhere is documentation for test-risk purposes.
    Acceptable, because the signal concerns test verdicts.
- Dedupe: counts only; the rows still see every record (correct: a duplicate cannot hide a deletion).

### Deferred by plan

| Item | Phase |
|---|---|
| Golden check that `parseVerifyDirectives` returns defaults over the final header/protocol text (QA-1.6-4) | 2.3 / 2.4 |
| "Subagent cannot self-select" enforcement test; parse only the orchestrator `prompt` (QA-1.6-5) | 2.4 |
| Clamp `captureWaitMs ≤ baselineTimeoutMs` (QA-1.6-8) | §1.4 config resolver phase |
| Fill `previousPath` from the porcelain rename source. tree.ts:28 skips it today; confirmed on real `-z` output (QA-1.6-13) | 2.1 |
| Unknown or failed attribution must not become `[]` → low (QA-1.6-14) | 2.4 |
| Expose the git toplevel on `TreeSnapshot` / pass it as `root` (QA-1.6-22) | 2.1 / 2.4 |
| Tool-observed `ChangedFile` never carries a deletion (`written`/`modified` only, dispatch.ts:66), so `apply_patch` deletes and shell `rm` never reach risk as deletions | 2.1 / 2.4 (changed-file computation) |
| Amend the plan's 1.6.1 signature (`source` → `modeSource`/`waitSource`) | next plan revision |

Outcome: every resolved finding except QA-1.6-3 is verified. QA-1.6-3's mandatory part is
verified, and its residual is QA-1.6-18. Six new Low and three Info findings are open. No High or
Medium finding is open.

### Round-2 resolutions

- QA-1.6-18 — Resolution: fixed in dcbd023. Non-upper-case keys (`verify:`, `Verify_Wait:`) count only when the value ends the line (optionally followed by closing quotes, `*`, `_`, `)`/`]` or punctuation); otherwise the text is prose and skipped silently. Decision: `verify: required` alone on a line → required. Upper-case `VERIFY`/`VERIFY_WAIT` behave as before. Tests cover 3b, 3c, q1–q4.
- QA-1.6-19 — Resolution: fixed in dcbd023. The key regexes match key + colon only, and the value is read with a sticky `/\S*/y`: `VERIFY:maybe,VERIFY:required` → required, `VERIFY_WAIT:soon,VERIFY_WAIT:2s` → 2000 (parity with `CAP:abc,CAP:3` → 3).
- QA-1.6-20 — Resolution: fixed in dcbd023. `[^\S\r\n\u2028\u2029]*` on both sides of the colon; NBSP/U+3000 parse, while newline/U+2028 still do not.
- QA-1.6-21 — Resolution: fixed in 8ce93d5 (an adjustment to the §1.5-17 extension). The setup rule is now `\.setup\.[cm]?[jt]sx?$` plus the basenames setupTests, setup-tests, test-setup, global-setup, globalSetup, vitest.setup and jest.setup (any js/ts extension). `src/setup.ts`, `SetupWizard.tsx` and similar names are no longer config. A timing test checks that a 100k-character path takes < 50 ms.
- QA-1.6-22 — Resolution: documented in 8ce93d5. The risk.ts header states that `root` must be the git top-level (real path, `rev-parse --show-toplevel`), never the delegation cwd. Exposing the top-level on `TreeSnapshot` and wiring it through stays deferred (2.1/2.4).
- QA-1.6-23 — Resolution: fixed in 8ce93d5. `(^|/)requirements/[^/]*\.txt$` counts as a dependency config.
- QA-1.6-24 — Resolution: fixed in dcbd023. Logged values escape C1/DEL, soft hyphen, U+061C, U+180E, U+200B–200F, U+2028–202E, U+2060–206F, U+FEFF and U+FFF9–FFFB.
- QA-1.6-25 — Resolution: fixed in dcbd023 and 8ce93d5. Both purity guards also reject `fetch(`, `WebSocket`, `XMLHttpRequest` and `export … from`; both reject any `from "node:…"`.
- QA-1.6-26 — Resolution: accepted, no change (Info). Word statuses will be mapped explicitly if 2.x introduces them.

## QA re-review (round 3)

Reviewer: @heavy, adversarial re-review of `9ef28ec..225a55b` (dcbd023, 8ce93d5, 225a55b):
`src/verify/directives.ts`, `src/verify/risk.ts`, both test files, the "Round-2 resolutions" above,
and plan "Phase 1.6" (L857-915) plus §1.5-15/§1.5-17.

Method:
- `npx vitest run --maxWorkers=2 test/unit/directives.test.ts test/unit/risk.test.ts` → 2 files, 47 passed.
- Throwaway scripts in `%TEMP%\omr-qa16r3` (deleted afterwards), run with `node --experimental-strip-types`
  (node v24.21.0). They import both modules and a verbatim copy of `parseCapDirective` (sessions.ts:59-66).
  Bracketed labels (`[L1]`, `[24b]`, ...) are probe cases, and the quoted results are their actual output.
- Timing: each adversarial case ran in its own child process with a 30 s kill timeout, after a warm-up call.
- Fix prototypes were patched **copies** of directives.ts inside the temp dir. The repository has no code changes.

### Round-2 findings — verification

| Finding | Status | Evidence |
|---|---|---|
| QA-1.6-18 | Verified; residual QA-1.6-27 | All six round-2 strings are rejected: [18a] `Verify: required fields are validated` → deferred/default; [18b]/[18c]/[18d] with `defaultVerify:"required"` → required/default; [18e]/[18f] → default, no log. [18g] `verify:Required` and [18h] `verify: required` → required/directive (plan test kept). [18i] upper-case `VERIFY: required fields are validated` → required (documented). [18j] CRLF `verify: *required*.` → required. |
| QA-1.6-19 | Verified; residual QA-1.6-28 | [19a] `VERIFY:maybe,VERIFY:required` → required, no log (`CAP:abc,CAP:3` → 3); [19b] `;` form → required; [19c] `(VERIFY:tbd)/VERIFY:required` → required; [19d] `VERIFY_WAIT:soon,VERIFY_WAIT:2s` → 2000; [19e] `VERIFY:VERIFY:required` → required (`CAP:CAP:3` → 3); [19f] mixed keys both parse; [19g] lower-case `verify:maybe,verify:required` → required. |
| QA-1.6-20 | Verified | After and before the colon: NBSP, U+3000, U+2007, U+202F, U+FEFF, TAB, VT, FF and U+1680 → required. `CAP:` with the same character → 3 (parity). LF, CR, U+2028 and U+2029 after the colon → default, no log; `CAP:` straddles → 3. That is the intended QA-1.6-3 deviation. NEL and ZWSP → default + one log line; `CAP:` → null (parity). |
| QA-1.6-21 | Verified; Info residual QA-1.6-31 | `vitest.setup.ts`, `src/setupTests.js`, `e2e/global-setup.ts`, `jest.setup.js`, `tests/auth.setup.mts`, `globalSetup.cjs`, `test-setup.tsx`, `SETUPTESTS.TS`, `src/a.setup.jsx` → config. `src/setup.ts`, `SetupWizard.tsx`, `useSetup.ts`, `setupRoutes.js`, `teardownAndSetup.mjs` → low `["1-5 files changed"]`. Linear: a 1M-character `setup…` path takes 1.8 ms (`isConfigPath`) / 5.9 ms (`assessRisk`); round 2 measured 1.3 s at 100k. The unit timing test allows 50 ms, and 100k measured 0.7 ms (~70× margin under concurrent load). |
| QA-1.6-22 | Verified (doc) | The risk.ts:9-12 header states the top-level contract. [22a] root `D:\repo\tests`, deleted `D:\repo\tests\helpers\db.ts` → medium `["1-5 files changed","files were deleted or renamed"]`; [22b] root `D:/repo` → high "a test file was deleted", so the documented hazard is real. Wiring stays deferred (2.1/2.4). The optional UNC case-fold was not done; that is conservative, and not a finding. |
| QA-1.6-23 | Verified; Info residual QA-1.6-31 | `requirements/base.txt` and `backend/requirements/dev.txt` → config (no reference → high); `requirements/sub/notes.txt` → not config (as tested); `requirements/README.md` → docs. |
| QA-1.6-24 | Verified for the listed classes; residual QA-1.6-29 | [24a] `VERIFY:x\u202eevil\u200b\u2066` → the log holds `\u202e`, `\u200b` and `\u2066` escaped. [24d] A surrogate pair cut at 32 units → `\ud83d` escaped (no lone surrogate). |
| QA-1.6-25 | Verified; residual QA-1.6-30 | Both guards now contain `\bfetch\(`, `\bWebSocket\b`, `\bXMLHttpRequest\b` and `^export .* from` (`m` flag); risk adds `from ["']node:`. Tests pass, so neither module contains these forms. |
| QA-1.6-26 | Accepted (Info), unchanged | `statusHas` (risk.ts:185-189) is unchanged; no producer emits D/R word forms (round-2 evidence stands). |

### New findings

| ID | Severity | Summary |
|---|---|---|
| QA-1.6-27 | Low | A valid lower-case directive followed by another directive (or any other text) on the same line is dropped silently |
| QA-1.6-28 | Low | The directive scan is quadratic on whitespace-free runs of keys (a regression from the QA-1.6-19 fix) |
| QA-1.6-29 | Info | Log escaping still passes 4,173 invisible code points raw, including Unicode tag characters |
| QA-1.6-30 | Info | The purity guards have whitespace/optional-call false negatives, and comment false positives |
| QA-1.6-31 | Info | Test/dependency config conventions left out after the QA-1.6-21/23 changes (within §1.5-17) |
| QA-1.6-32 | Info | Trimming trailing slashes from `root` (`/\/+$/`) is quadratic; the round-2 "all other regexes linear" claim is corrected |
| QA-1.6-33 | Info | The lower-case prose guard deviates from §1.5-15 "same rules as `CAP:`" but is not recorded as a deviation |

**QA-1.6-27 — Low — a valid lower-case directive followed by another directive on the same line is dropped silently**
- Where: directives.ts:90 (`LINE_TAIL`), :127-131.
- Evidence (probe; every case logs nothing):
  - [L1] `verify:required verify_wait:2s` → `deferred/default`, while the wait on the same line applies (2000/directive);
  - [L2] `verify: required, VERIFY_WAIT:2s` → deferred/default;
  - [L3] `verify:required cap:none` → deferred/default, while `parseCapDirective` on the same text → `none`;
  - [L6] `| verify:required |` → default, while `| cap:3 |` → 3;
  - [L4] `verify: required (per QA)`, [L5] `verify: required -- tests must pass`, [L7] `<!-- verify: required -->`,
    [L8] `Verify: required; Verify_Wait: 2s` → mode default.

  The round-2 fix text (QA-1.6-18) accepted the value "before the end of the line **or the next directive**".
  The implementation dropped the second half. This is the 2.4 failure class "a required one silently
  becomes deferred", reachable only with a lower-case key, which the plan sanctions (`verify:Required`).
  Separately, the tail is tested on a 256-character slice. [L9] `verify: required` + 300 spaces +
  `fields are validated` → required, and [L10] the same with 300 dots → required. That is pathological.
- Fix: let the tail also end at another key: after the closing marks and horizontal space, accept
  `(?:VERIFY(?:_WAIT)?|CAP)[^\S\r\n\u2028\u2029]*:` (flag `i`) as well as the end of line. Add `|` to the
  closing marks (table cells). Test the tail with a sticky regex at `end` on `text` itself, instead of a
  256-character slice; it stays linear because its two classes are disjoint. Add L1, L2, L3 and L6 as
  tests. L4, L5 and L7 may stay prose, but record that decision in the header.
- Resolution: 288cb6a — after a non-upper-case key the tail may be closing marks/a table pipe/horizontal space, then end of line or another `VERIFY`/`VERIFY_WAIT`/`CAP` key (any case) + `:`; sticky regex on the text, no 256-char slice. L1/L2/L3/L6 → required; 300 spaces/dots + prose, L4, L5 stay rejected (L7 `<!-- … -->` stays prose, recorded in the header). Tests added.

**QA-1.6-28 — Low — the directive scan is quadratic on whitespace-free runs of keys (a regression from dcbd023)**
- Where: directives.ts:117-123. Each key match re-reads the rest of its whitespace-free token with
  `/\S*/y` and copies it (`raw.replace(LEAD, "")`). Because scanning resumes right after the colon
  (the QA-1.6-19 fix), a run of k keys costs O(k × run length).
- Evidence (timing, one parse per child process):

  | input | 10k | 20k | 40k | 100k | 1M |
  |---|---|---|---|---|---|
  | `"VERIFY:".repeat` | 8 ms | 23.2 ms | 81.9 ms | 539.2 ms | killed > 30 s |
  | `"VERIFY_WAIT:".repeat` | 3.6 ms | 13.8 ms | 52 ms | 330.6 ms | killed > 30 s |
  | `"verify:".repeat` | 10 ms | 25.8 ms | 90.8 ms | 555.8 ms | killed > 30 s |
  | `"VERIFY:a,".repeat` | 5.5 ms | 18 ms | 81.8 ms | 424 ms | killed > 30 s |

  Doubling the input gives about 4× the time. With the round-2 grammar the same inputs took ≤ 4.1 ms at 100k.
  Every other directive shape is linear at 1M ≤ 67.6 ms: spaced keys, long HWS runs, long values,
  prose, and a minified `{verify:function(e){return e}},` blob (26.6 ms). 2.4 runs the parse
  synchronously on the dispatch path, so a pasted whitespace-free blob stalls the event loop.
- Fix (prototyped on a temp copy, not committed): memoise the token end per whitespace-free run
  (recompute only when `start >= tokEnd`). Match the values with sticky versions of
  `MODE_VALUE`/`WAIT_VALUE` on `text` at `start + lead`, and slice only the ≤ 32-character logged value.
  Measured at 1M: 34.6 / 15.5 / 65.2 ms (`VERIFY:` / `VERIFY_WAIT:` / `verify:`). There were **0**
  behaviour differences on 49 inputs, covering every unit-test string plus this round's probes. A bare
  `/\S{0,64}/y` bound is also linear (77-99 ms at 1M), but it changes 2 behaviours. It loses the log line
  for the QA-1.6-7 lower-case 200 × `A` case, which breaks that test, and it turns a 400-digit wait from
  "capped at 15000" into "malformed". So it is not recommended. Add a timing test such as
  `"VERIFY:".repeat(15_000)` < 50 ms (the QA-1.6-21 pattern).
- Resolution: 288cb6a — run end memoised per whitespace-free run, values matched in place with sticky regexes, only the ≤32-char logged value sliced. Probe at 1M: `VERIFY:` 41.7 ms, `VERIFY_WAIT:` 14.5 ms, `verify:` 41.0 ms, `VERIFY:a,` 29.3 ms. Timing test (1M chars < 500 ms per key form); all prior tests unchanged and green.

**QA-1.6-29 — Info — log escaping still passes invisible code points raw**
- Where: directives.ts:93 (`UNSAFE`).
- Evidence: the probe enumerated every non-whitespace code point in `\p{Cc}`, `\p{Cf}`,
  `\p{Default_Ignorable_Code_Point}`, `\p{Zl}` or `\p{Zp}`, placed each one inside a logged value, and
  checked the log line. [24b] 4,173 of them stay raw: U+034F, U+0600-0605, U+06DD, U+070F, U+0890-0891,
  U+08E2, U+115F-1160, U+17B4-17B5, U+180B-180D, U+180F, U+3164, U+FE00-FE0F, U+FFA0, U+FFF0-FFF8,
  U+110BD, U+110CD, U+13430-1343F, U+1BCA0-1BCA3, U+1D173-1D17A and U+E0000-E0FFF. [24c] Tag characters
  (U+E0049 U+E0047 U+E004E), the invisible "ASCII smuggling" carrier, appear raw in the line. The
  exposure is bounded to 32 UTF-16 units and the log only.
- Fix (optional): after `JSON.stringify`, escape everything outside printable ASCII (`/[^\x20-\x7e]/g`).
  That is complete, and simpler than a list; every valid value is ASCII.
- Resolution: 288cb6a — after `JSON.stringify` everything outside `[\x20-\x7e]` is escaped (`\uXXXX`, astral as `\u{…}`). Test covers U+E0049, U+034F, U+202E.

**QA-1.6-30 — Info — purity-guard false negatives and false positives**
- Where: directives.test.ts:155-156; the risk.test.ts purity test.
- Evidence: the guard regexes, copied verbatim, were run on sample lines.
  - Missed by **both** guards:
    - `await import ("fs")`, `import\n("fs")`, `require ("child_process")`;
    - `fetch ("http://x")`, `globalThis.fetch?.(…)`;
    - `process?.env`, `const { env } = process`, `process["env"]`;
    - `import{readFileSync}from"fs"`, `export*from"fs"`;
    - `new Worker(…)`, `new EventSource(…)`, `navigator.sendBeacon(…)`, `Bun.spawn(…)`.
  - Missed by the directives guard only: an indented `  import { readFileSync } from "fs"`
    (the risk guard catches `from "fs"`).
  - False positives (the test fails, so they fail closed):
    - comments mentioning `fetch()`, `import()`, `process.` or `WebSocket`;
    - an `export type … // from the plan` line;
    - in directives only, a string containing `node:`.
  - The installed TypeScript (7.0.2) has no `preProcessFile`, so a comment-aware import scan through
    the TS API is not available.
- Fix (optional): `\bimport\s*\(`, `\brequire\s*\(`, `\bfetch\b`, `\bprocess\b`, `^\s*(import|export)\b.*\bfrom\b`,
  and add `\bWorker\b|\bEventSource\b|sendBeacon|\bBun\.|\bDeno\.`. False positives are acceptable.
- Resolution: 7267b6c — both guards strip comments first and match `\bimport\s*\(`, `\brequire\s*\(`, `\bimport\b`, `\bfetch\b`, `\bprocess\b`, `export\s*\*`, indented `import/export … from`, `Worker`, `EventSource`, `sendBeacon`, `Bun.`, `Deno.`; risk removes its one allowed `import type` line before scanning.

**QA-1.6-31 — Info — test/dependency config conventions outside the rules**
- Where: risk.ts:147-148 (`SETUP_FILE`), :165-179.
- Evidence (probe): each of these → low `["1-5 files changed"]`:
  - test-setup/teardown names:
    - `src/setup-jest.ts` (the jest-preset-angular default);
    - `jest-setup.ts`, `vitest-setup.ts`, `setupVitest.ts`, `src/testSetup.ts`;
    - `global-teardown.ts`, `globalTeardown.js`;
  - runner configs: `playwright.config.ts`, `cypress.config.ts`, `karma.conf.js`, `.mocharc.yml`,
    `babel.config.js`.

  With no reference → medium (no config reason): `requirements.in`, `requirements/base.in` (pip-tools
  sources), `Requirements/base.txt`, `Pipfile` and `environment.yml`.

  None is named in §1.5-17. The plan list is `package.json`, lockfiles, `tsconfig*.json`,
  `vitest|jest.config.*`, `conftest.py`, `pyproject.toml` and `.github/**`, so the implementation
  conforms. These paths are rated at the file-count level, never below it. Setup files under
  `test/`/`tests/` already hit the test row.
- Fix (optional, a further §1.5-17 extension):
  - add `^(setup-jest|jest-setup|vitest-setup|setup-vitest|setupVitest|testSetup|global-teardown|globalTeardown)\.[cm]?[jt]sx?$`;
  - add `^(playwright|cypress)\.config\.`;
  - add `.in` beside `.txt` in both requirements rules;
  - add `Pipfile`.
- Resolution: 7267b6c — added `setup-jest`, `jest-setup`, `vitest-setup`, `global-teardown` (`.[cm]?[jt]sx?`), `playwright.config.*`, `requirements*.in`, `Pipfile`. Tests added. (`cypress`/`karma`/`.mocharc`/`babel`/`environment.yml` not added: outside the dispatch scope.)

**QA-1.6-32 — Info — trimming trailing slashes from `root` is quadratic**
- Where: risk.ts:109 (`norm(root).replace(/\/+$/, "")`).
- Evidence (timing, root = `"/".repeat(n) + "x"`): 10k → 66.9 ms, 20k → 282.3 ms, 40k → 1217.6 ms,
  100k → 6744.2 ms, 1M → killed > 30 s. The round-2 claim "all other directive and risk regexes are
  linear" timed only changed paths, so it is corrected here. Every changed-path regex is linear:
  the probes cover dots, slashes, `./` prefixes, `requirements/` runs, `tsconfig…`, `test_…py`,
  `docs/` runs and `.setup` runs, all ≤ 10.7 ms at 1M.
  Under the QA-1.6-22 contract, `root` is `git rev-parse --show-toplevel` output, not model input.
- Fix (optional): trim with a loop (`while (r.endsWith("/")) r = r.slice(0, -1)`).
- Resolution: 7267b6c — trailing `/` trimmed with an `endsWith` loop; timing test with 1M-slash roots (< 200 ms).

**QA-1.6-33 — Info — the lower-case prose guard is an unrecorded deviation from §1.5-15**
- Where: this report, "Result" (the deviation list) and the round-2 "Deferred by plan" row "Amend the
  plan's 1.6.1 signature".
- Evidence: §1.5-15 says "the same rules as `CAP:`". `CAP:`'s key is case-insensitive with no prose
  guard: `| cap:3 |` → 3 and `verify:required cap:none` → `none`, while [L6]/[L3] leave VERIFY at the
  default. The guard is a deliberate decision (QA-1.6-18), and it is documented in the directives.ts
  header, but it is not listed with the `modeSource`/`waitSource` deviation.
- Fix: add "Deviation (QA-1.6-18): a non-upper-case key counts only when its value ends the line" under
  "Result", and include it in the next plan revision.
- Resolution: 288cb6a — Deviation (QA-1.6-18): a non-upper-case VERIFY key counts only when its value ends the line (or is followed by another directive key / table pipe, QA-1.6-27); `CAP:` has no such guard. Recorded in the directives.ts header and here; plan amendment stays in the next plan revision.

### Other checks (no finding)

- The upper-case test is `m[0].startsWith(upperKey)`, which is case-sensitive: `VERIFY_wait:` gets the
  guard ([L15] `VERIFY_wait: 2s please` → default), and upper-case `VERIFY:required VERIFY_WAIT:2s` →
  both parse ([L14]).
- Accepted by design: [L11] `Steps to verify: deferred.` → deferred/directive (a one-word sentence-final
  value), [L12] `Please verify: required` → required, and [L16] trailing NBSP → required.
- Curly quotes: [L13] `verify: “required”` and `VERIFY: “required”` → default + one log line; `CAP: “3”` → null (parity, not silent).
- Placeholders are checked before the prose guard, so lower-case placeholders are skipped silently, as upper-case ones are.
- Plan contract (L873-908), as amended:
  - 1.6.1: signature plus the log seam, and `modeSource`/`waitSource` (recorded deviations).
  - 1.6.2: `assessRisk` plus optional `root` (recorded); header table; pure and synchronous.
  - Directive edge-case tests present: `verify:Required`; first wins; unknown → default + log; `0s`/`750ms`/`99999s`;
    `-1s`/`abc`/`5`; router example; fenced-block parity; `CAP:`+`VERIFY:` in both orders.
  - Risk edge-case tests: all rows and thresholds are covered (round-2 evidence stands; risk.test.ts
    only gained tests in this range).
  - Acceptance: directives.ts has no imports; risk.ts has only `import type … from "./runner"`, and takes
    the scoping plan as input.
  - The only gaps are QA-1.6-27 (the directive grammar) and QA-1.6-33 (the deviation record).

### Deferred by plan (unchanged; nothing new deferred)

| Item | Phase |
|---|---|
| Golden check that `parseVerifyDirectives` returns defaults over the final header/protocol text (QA-1.6-4) | 2.3 / 2.4 |
| "Subagent cannot self-select" enforcement test; parse only the orchestrator `prompt` (QA-1.6-5) | 2.4 |
| Clamp `captureWaitMs ≤ baselineTimeoutMs` (QA-1.6-8) | §1.4 config resolver phase |
| Fill `previousPath` from the porcelain rename source (QA-1.6-13) | 2.1 |
| Unknown or failed attribution must not become `[]` → low (QA-1.6-14) | 2.4 |
| Expose the git top-level on `TreeSnapshot` and pass it as `root` (QA-1.6-22) | 2.1 / 2.4 |
| Tool-observed `ChangedFile` never carries a deletion (`written`/`modified` only) | 2.1 / 2.4 |
| Amend the plan's 1.6.1 signature (`source` → `modeSource`/`waitSource`) and record the QA-1.6-18 guard (QA-1.6-33) | next plan revision |

### Handoff to 2.4

1. **Result shape:** destructure `mode`, `waitMs`, `modeSource`, `waitSource`; there is no `source`.
   Use `modeSource` for "the orchestrator chose the mode" (the `defaultVerify:"required"` test expects
   `modeSource:"default"`), and never infer it from `waitSource`.
2. **Input:** parse only the orchestrator-authored `task`/`delegate` `prompt` argument. Never parse tool
   results, the subagent's final text or child-session messages.
3. **Router examples:** any VERIFY example injected into dispatch text uses `|`/`<…>` placeholders, or
   the resolved `VERIFY:<mode>`/`VERIFY_WAIT:<n>ms` is pinned first (the `CAP:` pattern). A pinned value
   also defeats quoted subagent text.
4. **Key case:** a lower-case key counts only when its value ends the line (QA-1.6-18, and QA-1.6-27 while
   open). Protocol text (2.3) and any router-authored example should show upper-case
   `VERIFY:`/`VERIFY_WAIT:`.
5. **Logging:** wire the `log` seam to the router logger. The default is a no-op, so unknown values
   would otherwise be invisible.
6. **Wait:** `waitMs` may be `0` (start immediately). `VERIFY_WAIT` is capped at `baselineTimeoutMs`,
   the default `captureWaitMs` is not (QA-1.6-8).
7. **Root:** pass `root` = the git top-level the paths were resolved against (`rev-parse --show-toplevel`,
   as tree.ts). Never the delegation cwd; `TreeSnapshot.cwd` is not the top-level. A subdirectory root
   under-rates a test deletion ([22a] medium vs [22b] high). Without `root`, absolute paths never count
   as docs (conservative).
8. **Tier:** `producerTier` must be the canonical lowercase id. Only exact `"fast"` triggers row 11;
   `"Fast"`, `"FAST"` and `" fast"` → low.
9. **Attribution:** never map failed attribution (`snapshotTree` → `undefined`) to `[]`, which is rated
   low "no changes attributed" (QA-1.6-14).
10. **Renames and deletions:** pass `previousPath` when known (2.1); without it, a test renamed out of
    test naming is medium, not high. Tool-observed changes carry no deletions.
11. **Scoping:** `scopingPlan` is the no-spawn `planStaticScoping` result. `Unverifiable` → medium;
    `NoAffected` is informational only.

Outcome: QA-1.6-18..26 are verified (QA-1.6-26 accepted as Info). Open and not deferred: two Low
(QA-1.6-27, QA-1.6-28) and five Info (QA-1.6-29..33). No High or Medium finding is open. Phase 1.6 QA is
**not** clean until QA-1.6-27 and QA-1.6-28 are resolved, or explicitly accepted.

## QA re-review (round 4)

Reviewer: @heavy, adversarial re-review of `fe7a82b..959b831` (288cb6a, 7267b6c, 959b831):
`src/verify/directives.ts`, `src/verify/risk.ts`, both test files and the QA-1.6-27..33 resolutions above.

Method:
- `npx vitest run --maxWorkers=2 test/unit/directives.test.ts test/unit/risk.test.ts` → 2 files, 52 passed.
- Throwaway scripts in `%TEMP%\omr-qa16r4` (deleted afterwards), run with `node --experimental-strip-types`
  (node v24.21.0). They import both modules, the `fe7a82b` versions of both (for old-vs-new
  differentials), and a verbatim copy of `parseCapDirective` (sessions.ts:59-66). Bracketed labels are
  probe cases; the quoted results are their actual output.
- Timing: one parse per child process, 30 s kill timeout, after a warm-up call. Fix prototypes were
  patched **copies** of directives.ts in the temp dir, timed in-process. The repository has no code changes.

### Round-3 findings — verification

| Finding | Status | Evidence |
|---|---|---|
| QA-1.6-27 | Verified; Info residual QA-1.6-35 | [L1] `verify:required verify_wait:2s` → required/directive + 2000; [L2] `verify: required, VERIFY_WAIT:2s` → required + 2000; [L3] `verify:required cap:none` → required (`parseCapDirective` → `none`); [L6] `\| verify:required \|` → required; [L8] `Verify: required; Verify_Wait: 2s` → required + 2000. [L4] `(per QA)`, [L5] `-- tests must pass`, [L7] `<!-- … -->` → default (documented, directives.ts:20-21). [L9]/[L10] 300 spaces/dots + prose → default, while 300 trailing spaces/dots with nothing after → required, and a 600k-char `" ."` run + CRLF → required: the 256-char slice is gone. Old-vs-new differential (112 inputs × 2 defaults, including the 42 string literals passed directly to `parseVerifyDirectives` in directives.test.ts): 42 differences, all intended (key-terminated tail, table pipe, removed slice, log escaping). |
| QA-1.6-28 | Verified for the round-3 shapes; residual QA-1.6-34 (Low) | 1M chars: `"VERIFY:".repeat` 39.1 ms, `VERIFY_WAIT:` 20.2 ms, `verify:` 44.7 ms, `VERIFY:a,` 40.0 ms (round 3: killed > 30 s); `verify_wait:` 21.0, `verify:a,` 38.2, spaced keys 33.7, key + 1000 spaces without colon 3.0, `verify` + 1M NBSP 4.2, 1M-letter value 4.4, 1M-digit wait 3.7, minified blob 15.7 ms. New tail rule: one key + 1M `" ."` run 15.2 ms, `cap` + 1M spaces without colon 4.4, 100 spaces per key 10.0, punctuation per key 9.5, `verify:a cap:` chain 26.9 ms. |
| QA-1.6-29 | Verified | U+E0049 → `\u{e0049}`, U+034F → `\u034f`, U+202E, curly quotes → `\u201c`/`\u201d`, emoji → `\u{1f600}`. A pair cut at 32 units is escaped by `JSON.stringify` first (`\ud83d`). Old vs new: only the log text differs (5 inputs); results are identical. |
| QA-1.6-30 | Verified | With the tests' stripper and regex copied verbatim, all 16 round-3 misses are caught (`import ("fs")`, `import\n(`, `require (`, `fetch (`, `fetch?.(`, `process?.env`, `= process`, `process["env"]`, `import{…}from"fs"`, `export*from"fs"`, `Worker`, `EventSource`, `sendBeacon`, `Bun.`, indented import, `export {…} from "node:os"`). Comment false positives are gone; `"node:"` inside a string still fails closed (acceptable). See "Other checks" for what stripping cannot see. |
| QA-1.6-31 | Verified as scoped; Info residual QA-1.6-36 | `requirements.in`, `requirements-dev.in`, `Pipfile`, `playwright.config.{ts,mjs}`, `setup-jest`, `jest-setup`, `vitest-setup`, `global-teardown` (any case, `.[cm]?[jt]sx?`) → config; `src/teardown.ts`, `src/Pipfile.md`, `setup-jest.json` → not config. Classifier differential (58 paths × 3 classifiers): 19 differences, all these names turning into config. |
| QA-1.6-32 | Verified | `assessRisk` differential old vs new: 36,652 cases (14 roots incl. `/repo//`, `//`, `/`, `D:/`, `d:/REPO///`, `D:`, a UNC root with a trailing `\`, `""`; 7 statuses; both references; two tiers; three scoping plans; 7 multi-file sets): 4,788 differences, **all** explained by the added config reason on QA-1.6-31 names; 0 from the new trim. 1M chars: trailing slashes 18.9 ms, leading slashes 2.0 ms, 1M backslashes 137.1 ms (100k: 14.6 ms, linear). |
| QA-1.6-33 | Verified in the header; report nit QA-1.6-37 | directives.ts:22-23 records the deviation. The round-3 fix also asked for a line under "Result"; that list (above) was not updated. |

Upper-case `CAP:` parity: 46 wrappers × 22 inner forms = 1,012 pairs each for `VERIFY:required` and
`VERIFY_WAIT:2s` against `CAP:3`. Each key has 313 differences, all in documented classes: one leading
mark accepted (129, QA-1.6-1), no line-break straddle (123, QA-1.6-3), `|` placeholder (61, QA-1.6-4).
**0** unexpected.

Risk rows (no regression): empty → low; docs → low; 1 file → low; 6 → medium; 16 → high; deleted test →
high; test renamed to a non-test path → high; modified test → medium; deleted source → medium; `Pipfile`
→ medium, and high without a reference; Unverifiable → medium; fast tier → medium; no reference → medium.

Line endings: `git ls-files --eol` → `i/lf w/lf`. 862 LF, 0 CRLF: **not mixed**. The file had no final
newline since `fe7a82b` (pre-existing); this append ends with one.

### New findings

| ID | Severity | Summary |
|---|---|---|
| QA-1.6-34 | Low | The prose-guard tail at the run end is re-evaluated for every other key: quadratic, 1M killed > 30 s |
| QA-1.6-35 | Info | The key-terminated tail accepts any following key + colon, so narrow prose passes |
| QA-1.6-36 | Info | QA-1.6-31 was narrower than its fix text, and the omissions are not recorded |
| QA-1.6-37 | Info | Report hygiene: the "Result" deviation list and the round-3 handoff item 4 are stale |

**QA-1.6-34 — Low — the tail at the run end is re-evaluated for every other key (quadratic)**
- Where: directives.ts:135-137 and :152-157 (the single-slot `tailAt`/`tailOk` memo).
- Evidence: a value-less lower-case key (`verify:1`) sets `end = tokEnd`, and a valued one (`verify:a`)
  sets `end` inside the run. When the two alternate in one whitespace-free run, the one-slot memo misses
  every time. The tail at `tokEnd` then walks, and backtracks over, the whole horizontal-space/punctuation
  run after the token. Cost: O(keys in the run × trailing run). Ends inside the run cannot share work,
  because each of their tails stops at the next key's letters, so `tokEnd` is the only repeated position.

  | input (half keys, half trailing run, then `x`) | 10k | 20k | 40k | 100k | 1M |
  |---|---|---|---|---|---|
  | `"verify:1,verify:a,".repeat` + spaces | 5.8 ms | 27.2 ms | 93.9 ms | 603.4 ms | killed > 30 s |
  | same + `" ."` run | 10.1 ms | 45.1 ms | 170.4 ms | 1052.0 ms | killed > 30 s |
  | `verify_wait:x,verify_wait:1s!x,` + spaces | 3.9 ms | 14.7 ms | 64.5 ms | 377.6 ms | – |
  | `verify:1,verify:a!x,` + spaces | 5.6 ms | 26.8 ms | 85.6 ms | 585.0 ms | – |
  | `Verify:1,Verify:a,` + tabs | 6.8 ms | 25.7 ms | 95.7 ms | 616.2 ms | – |

  Controls, 1M: the same run without the trailing spaces → 28.5 ms; upper-case `VERIFY:1,VERIFY:a,` +
  spaces → 15.2 ms (no guard). The QA-1.6-28 unit timing test uses only homogeneous runs, so it cannot
  catch this. Same class and exposure as QA-1.6-28: 2.4 parses synchronously on the dispatch path.
- Fix (prototyped on a temp copy, not committed): cache the tail result for `tokEnd` per run. Add
  `let tokTail: boolean | null = null`, reset it where `tokEnd` is recomputed, and inside
  `if (end !== tailAt)` reuse it when `end === tokEnd` (store it after computing). Measured at 1M
  (in-process): 28.7 / 99.7 / 13.9 ms for rows 1-3. **0** behaviour differences on 77 inputs × 2
  defaults (the 42 direct string-literal inputs of the unit file plus 35 probes from this round). Add
  `"verify:1,verify:a,".repeat(27_778) + " ".repeat(500_000) + "x"` to the timing test.
- Resolution: 33ce7ea — tail result at the run end cached once per run (`tokTail`, reset with `tokEnd`); 1M-char timing test (`"verify:1,verify:a,".repeat(27_778)` + 500k spaces, < 500 ms).

**QA-1.6-35 — Info — the key-terminated tail accepts any following key + colon**
- Where: directives.ts:99-102 (`(?:VERIFY(?:_WAIT)?|CAP)${HWS}:`, no value, no leading `\b`).
- Evidence (default `deferred` unless marked R = `defaultVerify:"required"`; every case is silent, and
  `fe7a82b` returned the default for all of them):
  - [T1] `please verify: required cap: the budget is tight` → required/directive (`parseCapDirective` → null);
  - [T5] `Things to verify: deferred. Cap: the budget matters.` (R) → deferred/directive, a downgrade
    ("Cap: the budget matters." is the round-1 prose example);
  - [T6] `Things to verify: deferred, verify: the rest later` (R) → deferred;
  - [T7] `Steps to verify: required. Verify: also the docs.` → required;
  - [T8] `What to verify: deferred; verify_wait: none given` (R) → deferred;
  - [T29] `Things to verify: deferred cap: see below` (R) → deferred;
  - [T3] `verify:required CAP:` (no value) → required; [T11] `verify: required _cap: 3` → required.

  Rejected correctly: `capacity:`, `recap:`, `verifyx:`, `VERIFY_WAITX:`, a key without a colon, a colon
  on the next line, an em dash before `CAP:`. The leak needs a one-word value followed by
  `verify:`/`verify_wait:`/`cap:` on the same line. `Steps to verify: deferred.` alone is already accepted
  by design ([L11], round 3), so this is narrow.
- Fix (optional): make the tail's key alternative directive-shaped:
  `\b(?:VERIFY${HWS}:${HWS}["'`*_]?(?:required|deferred)\b|VERIFY_WAIT${HWS}:${HWS}["'`*_]?\d+(?:ms|s)\b|CAP${HWS}:${HWS}(?:none|\d+)\b)`.
  Prototype (on top of the QA-1.6-34 memo): 0 differences on the 42 direct unit-test literals and on L1, L2, L3, L6,
  L8, T13; T1, T3, T5-T8, T11, T29 and `verify: required cap:3x` → default; linear (1M ≤ 127 ms
  in-process). Trade-off: `verify:required CAP:` with an empty `CAP:` then falls back silently.
  Otherwise, accept it and record the decision in the header.
- Resolution: 33ce7ea — the tail's key alternative now needs a valid value (`VERIFY: required|deferred`, `VERIFY_WAIT: <n>ms|s`, `CAP: none|<n>`, leading `\b`); T1, T5, T3 → default (tests). Accepted trade-off: `verify:required CAP:` falls back silently.

**QA-1.6-36 — Info — QA-1.6-31 was narrower than its fix text**
- Where: risk.ts:148-149, :181-183; the QA-1.6-31 resolution line.
- Evidence (classifier output identical to `fe7a82b`, i.e. still not config):
  - `requirements/base.in`: the fix text asked for `.in` in **both** requirements rules; only the
    basename rule got it;
  - `setupVitest.ts`, `setup-vitest.ts`, `src/testSetup.ts`, `globalTeardown.js`: in the suggested regex
    but not added, although `globalSetup` and `global-teardown` are config. The resolution names only
    cypress/karma/mocharc/babel/environment.yml as left out;
  - `Requirements/base.txt` (capitalised directory).

  These are rated at the file-count level, never below it. §1.5-17 does not name them.
- Fix (optional): add them, or list them in the QA-1.6-31 resolution as out of scope.
- Resolution: 33ce7ea — `requirements/*.in`, case-insensitive `requirements/` folder, `setupVitest`/`setup-vitest`/`testSetup`/`globalTeardown` (`.[cm]?[jt]sx?`) are config; tests.

**QA-1.6-37 — Info — report hygiene**
- The QA-1.6-33 fix asked for a "Deviation (QA-1.6-18)" line under "Result"; "Result" still lists only the
  `modeSource`/`waitSource` deviation. The record exists in directives.ts:22-23 and the resolution line.
- The QA-1.6-27..33 "Resolution" bullets were inserted before "Where:". Earlier rounds put them last or in
  a "Round-N resolutions" list. Cosmetic.
- Round-3 "Handoff to 2.4" item 4 is stale: it is superseded below.
- Fix: add the "Result" line in the next doc pass.
- Resolution: this commit — "Deviation (QA-1.6-18)" line added under "Result"; round-3 resolution bullets moved after "Where:"/"Fix"; file LF with a final newline.

### Other checks (no finding)

- A lower-case directive in a table cell that is not the last one (`| verify:required | 2s |`,
  `| verify:required | notes |`) → default, silently; `| cap:3 | notes |` → 3. This follows the documented
  rule (a pipe, then the end of the line). Upper-case keys are unaffected.
- The tail now accepts punctuation and spaces in any order (`verify: required . . .`, `) ] ! ?` →
  required; `fe7a82b` rejected them). Harmless.
- U+2028 after the value ends the line → required; NEL does not (not a JS line terminator) → default.
  `VERIFY:\u0085required` and `CAP:\u00853` → both unmatched (parity).
- Purity guards: stripping comments first creates a blind spot for comment markers inside strings or
  regex literals (`const a = "/*"; fetch(u); const b = "*/";`, `const s = "//"; fetch(u)` → missed).
  Computed access (`globalThis["fe" + "tch"]`) and `new Function(…)` → missed. The guards are tripwires
  for accidental imports, not a sandbox, and neither module's code has `/*` or an unescaped `//` outside
  comments. Acceptable.
- The value, key and `LINE_TAIL` regexes run in place on `text` with sticky flags; only the ≤ 32-unit
  logged value is sliced. The 200 × `A` log (QA-1.6-7) is unchanged.
- Plan contract: directives.ts still has no imports; risk.ts has only
  `import type { ChangedPath, StaticScoping } from "./runner"` (unit guard green).

### Deferred by plan (unchanged; nothing new deferred)

| Item | Phase |
|---|---|
| Golden check that `parseVerifyDirectives` returns defaults over the final header/protocol text (QA-1.6-4) | 2.3 / 2.4 |
| "Subagent cannot self-select" enforcement test; parse only the orchestrator `prompt` (QA-1.6-5) | 2.4 |
| Clamp `captureWaitMs ≤ baselineTimeoutMs` (QA-1.6-8) | §1.4 config resolver phase |
| Fill `previousPath` from the porcelain rename source (QA-1.6-13) | 2.1 |
| Unknown or failed attribution must not become `[]` → low (QA-1.6-14) | 2.4 |
| Expose the git top-level on `TreeSnapshot` and pass it as `root` (QA-1.6-22) | 2.1 / 2.4 |
| Tool-observed `ChangedFile` never carries a deletion (`written`/`modified` only) | 2.1 / 2.4 |
| Amend the plan's 1.6.1 signature (`source` → `modeSource`/`waitSource`) and record the QA-1.6-18 guard (QA-1.6-33) | next plan revision |

### Handoff to 2.4 (delta)

Item 4 of the round-3 handoff now reads: **Key case:** a lower-case key counts only when its value ends
the line, is followed by closing marks/punctuation/a table pipe up to the end of the line, or is followed
on the same line by another `VERIFY:`/`VERIFY_WAIT:`/`CAP:` key (QA-1.6-18, QA-1.6-27; see QA-1.6-35).
In a multi-cell table row only the last cell qualifies. Protocol text (2.3) and any router-authored
example should show upper-case `VERIFY:`/`VERIFY_WAIT:`. The other items are unchanged.

Outcome: QA-1.6-27..33 are verified (QA-1.6-27 and QA-1.6-28 with residuals). Open and not deferred:
one Low (QA-1.6-34) and three Info (QA-1.6-35..37). No High or Medium finding is open. Phase 1.6 QA is
**not** clean until QA-1.6-34 is resolved or explicitly accepted.

## QA re-review (round 5)

Reviewer: @heavy, adversarial re-review of `174bdca..ebad545` (33ce7ea, ebad545): `src/verify/directives.ts`,
`src/verify/risk.ts`, both test files and the QA-1.6-34..37 resolutions above. Code cleared in rounds 1-4 and
unchanged in this range was not re-audited.

Method:
- `npx vitest run --maxWorkers=2 test/unit/directives.test.ts test/unit/risk.test.ts` → 2 files, 55 passed.
- Throwaway scripts in `%TEMP%\omr-qa16r5` (deleted afterwards), run with `node --experimental-strip-types`
  (node v24.21.0). They import both modules at HEAD and at `174bdca`, and a verbatim copy of
  `parseCapDirective` (sessions.ts:59-66). Three patched **copies** of HEAD directives.ts isolate each change:
  B = HEAD scan with the `174bdca` tail; C = HEAD with the `tokTail` shortcut disabled; E = HEAD with no tail
  memo at all (the tail is evaluated for every key), used as the reference. The repository has no code changes.
- Main corpus: the 121 quoted string literals of directives.test.ts, 53 probes from rounds 3-5, every sequence
  of 1-3 tokens over a 58-token alphabet (keys in three cases plus `_cap:`, `recap:`, `VERIFY_wait:`, bare
  keys; values including placeholders, `cap:0`, `1x`; separators including NBSP, U+3000, CRLF, U+2028 and every
  closing mark), and 200,000 seeded random sequences of 4-16 tokens: 398,708 inputs, each parsed with
  `defaultVerify` deferred and required. Results **and** log lines are compared.
- Memo corpus: every whitespace-free run of 1-4 items from `verify:1,`, `verify:a,`, `verify:required,`,
  `Verify:deferred`, `VERIFY:x,`, `verify_wait:2s,`, `verify_wait:x,`, `cap:3,`, `verify:`, `verify:*required*`,
  × 3 prefixes × 13 tails (end of text, spaces, prose, newline, U+2028, pipes, dots, valid and invalid
  following keys): 866,580 parses, 19,662 of which take the `tokTail` shortcut.
- Timing: one parse per child process, 30 s kill timeout, after a warm-up call.

### Round-4 findings — verification

| Finding | Status | Evidence |
|---|---|---|
| QA-1.6-34 | Verified | Memo correctness: HEAD vs the no-memo reference E → **0** differences on the main corpus (398,708 × 2 defaults) and on all 866,580 memo-corpus parses, including the 19,662 shortcut hits. C vs E → 0; `174bdca` vs B (the memo under the old tail) → 0. `tokTail` is reset exactly where `tokEnd` is recomputed, and the tail result depends only on the position (sticky regex, `lastIndex` set before every test), so a stale value cannot cross runs. Linear: the five round-4 rows at 1M → 26.2 / 33.3 / 22.1 / 22.6 / 31.8 ms (round 4: rows 1-2 killed > 30 s). Controls on row 1 at 10k/40k/100k: `174bdca` 41.6 / 263.9 / 1257.1 ms; C 11.2 / 315.7 / 1477.7 ms. Without the shortcut the shape is quadratic, so the unit timing test (1M, < 500 ms) guards it. |
| QA-1.6-35 | Verified; Info residual QA-1.6-38 | The tail regex is identical to the round-4 prototype. [T1], [T3] `verify:required CAP:`, [T11] `verify: required _cap: 3` → default; [T5], [T6], [T8], [T29] (R) → required/default; [T7] → deferred/default. Kept: [L1] `verify:required verify_wait:2s` → required + 2000; [L3] `cap:none`, [L6] `\| verify:required \|` → required; [L8] → required + 2000. [L5] stays default. Differential vs `174bdca` (main corpus): 560 inputs differ per default. Per parse: 30 mode directive→default, 2 wait directive→default (`verify_wait: 2s verify: maybe`) and 1,088 log-only (a different value is logged). **0** unexplained: every differing input has a position where the old tail passes and the new one fails, and at no position of any input does the new tail pass where the old one fails. Memo corpus vs `174bdca`: 291,384 directive→default, 8,064 where a later occurrence now wins, 128,216 log-only, **0** new acceptances. |
| QA-1.6-36 | Verified | `requirements/base.in`, `Requirements/base.txt`, `REQUIREMENTS/dev.IN`, `backend/requirements/Base.TXT`, `setupVitest.ts`, `setup-vitest.mts`, `src/testSetup.ts`, `globalTeardown.js`, `globalteardown.mjs`, `GLOBALTEARDOWN.CJS` → config. `setupVitest.json` and `src/requirements/notes.md` → not config (unit test). Classifier differential (14 directories × 27 basenames): 162 differences, all `isConfigPath` false→true. Both changed regexes only add alternatives, `.in` or the `i` flag, so no path can lose config. `isDocPath` goes true→false only for `docs/Requirements/*.txt` (see Other checks). `assessRisk` (3,024 cases: 4 statuses × reference ±, with `root`): 1,296 differences, 0 on paths whose config classification is unchanged. 1M-character paths (`requirements/` runs, long basenames, `/Requirements/.in` runs) → ≤ 34.6 ms. |
| QA-1.6-37 | Verified (ebad545) | "Result" has the Deviation (QA-1.6-18) line, including QA-1.6-27/35. The seven round-3 resolution bullets now follow "Fix". `git ls-files --eol` → `i/lf w/lf`, 0 CRLF, final LF. The resolution names "this commit" instead of the hash (cosmetic). Residual in the code header: QA-1.6-38. |

### Upper-case `CAP:` parity

A matrix of 46 wrappers × 22 inner forms gives 1,012 pairs per key. `VERIFY:required` and `VERIFY_WAIT:2s` are
compared with `CAP:3` by presence through `parseCapDirective`. Result: 288 differences per key at both
`174bdca` and HEAD, **0** changed. Both commits only touch code behind `!m[0].startsWith(upperKey)`, so
upper-case keys cannot change, and the matrix confirms it. This matrix is new this round, so its count is not
comparable with round 4's 313.

Lower-case keys in the same matrix: 144 changes (72 per key), all accept→reject (e.g. `verify:required CAP:`).
That is the only possible direction, since the new tail matches a subset of the old one. The distance from
`CAP:` rises from 308 to 350 per key: the recorded QA-1.6-33 deviation (`CAP:` has no prose guard).

### Linearity (HEAD, one parse per process)

| input | 10k | 100k | 1M |
|---|---|---|---|
| `verify:1,verify:a,` + spaces + `x` (QA-1.6-34 row 1) | 0.8 ms | 6.4 ms | 26.2 ms |
| same + `" ."` run | 0.9 | 6.8 | 33.3 |
| `verify_wait:x,verify_wait:1s!x,` + spaces | 0.8 | 5.3 | 22.1 |
| `verify:1,verify:a!x,` + spaces | 0.5 | 5.1 | 22.6 |
| `Verify:1,Verify:a,` + tabs | 0.7 | 5.4 | 31.8 |
| `verify:1 verify:a ` (alternating across runs) | 2.4 | 6.9 | 36.6 |
| `verify:foo cap:1 ` (valid-value chain that never accepts) | 1.3 | 7.4 | 25.1 |
| `verify:foo verify:required ` | 2.2 | 8.1 | 36.6 |
| `verify:a,cap:1,` (chain inside one run) | 0.8 | 5.5 | 27.6 |
| `verify:x,verify:required,verify:1,` + spaces | 0.8 | 6.2 | 25.1 |
| `verify_wait:x verify_wait:1s ` (wait chain that never accepts) | 1.2 | 5.9 | 25.9 |
| `verify:x VERIFY:required\|deferred ` (placeholder chain) | 0.8 | 6.8 | 26.5 |
| `verify:a verify_wait:` + 100 digits + `s ` | 1.0 | 2.9 | 13.1 |
| `verify:a cap:` + 100 digits + `x ` (digit backtracking) | 0.4 | 2.6 | 8.0 |
| `verify:a cap` + 100 spaces + `: x ` | 0.4 | 2.7 | 8.1 |
| one key, n/4 × `" ."`, then `cap:` + n/2 digits + `x` | 0.4 | 0.8 | 5.1 |
| `verify:1,verify:a,` + spaces + `cap:1` (the shortcut stores `true`) | 1.3 | 5.5 | 26.4 |
| `verify:x,verify_wait:1s,verify:1,` + `" ."` run + `cap:12345678x` | 0.9 | 8.7 | 55.0 |
| `verify:x \u00a0.\u3000cap\u00a0:\u00a0none ` | 2.3 | 6.9 | 58.9 |
| `verify:1,verify:a,` + spaces + `verify:` + 10 NBSP + `requiredx` | 0.8 | 5.5 | 69.0 |
| `VERIFY:1,VERIFY:a,` + spaces (upper-case control) | 1.0 | 4.6 | 25.3 |

The two fixes interact. `verify:x,verify:required,verify:1,` + spaces returned at the first valid key under
`174bdca` (0.4 ms at 100k), because any key + colon ended the tail. With QA-1.6-35, `verify:required` followed by
`,verify:1` is rejected, so the scan runs through the whole run. Without the shortcut this is quadratic
(C: 6.2 / 178.7 / 756.0 ms at 10k/40k/100k); with it, 25.1 ms at 1M. So QA-1.6-35 relies on the QA-1.6-34
memo. The existing timing test already fails if the memo is removed (C, row 1: 1477.7 ms at 100k, against a
500 ms limit at 1M), so no extra test is needed.

### New findings

| ID | Severity | Summary |
|---|---|---|
| QA-1.6-38 | Info | The directives.ts header still describes the pre-QA-1.6-35 terminator; "valid value" means grammar-shaped |

**QA-1.6-38 — Info — the module header still describes the pre-QA-1.6-35 terminator**
- Where: directives.ts:14-17 (module header), :98 (`LINE_TAIL` comment); round-4 "Handoff to 2.4 (delta)" item 4.
- Evidence:
  - The header, which is the contract 2.3/2.4 read, still says a lower-case value counts when it "is followed by
    another directive key (`VERIFY:`/`VERIFY_WAIT:`/`CAP:`, any case; QA-1.6-27)". Since 33ce7ea that key must
    carry a value: `verify:required CAP:` → default (tested), and `please verify: required cap: the budget is
    tight` → default. Only the `LINE_TAIL` comment (:95-97) and "Result" were updated. The accepted trade-off
    (`verify:required CAP:` falls back silently) is recorded only in this report.
  - The `LINE_TAIL` comment still calls the terminator "a fixed alternative". It now contains `\d+` and
    horizontal-space runs. Linearity holds (table above), but the stated reason is out of date.
  - "Valid value" means the value grammar, not a directive the parser would accept. These still end the tail:
    - `verify: required cap:0` and `cap:00` → required, although `parseCapDirective` returns null for `cap:0`;
    - `verify: required VERIFY:required|deferred` and `… VERIFY_WAIT:2s|5s` → required, although the parser
      skips both as placeholders;
    - `Things to verify: required, verify: deferred loading works` → required, although the following
      `verify: deferred loading works` is itself prose.

    In the other direction, `verify: required cap:\n3` → default, while `parseCapDirective` crosses the line
    break → 3 (the QA-1.6-3 no-straddle rule). Each case is unchanged from `174bdca` or narrower than it. Each
    also needs a lower-case `verify:` value followed on the same line by one of these exact shapes.
- Fix (optional, doc only): change the header to "or is followed on the same line by another key with a
  grammar-valid value (`VERIFY:` `required|deferred`, `VERIFY_WAIT:` `<n>ms|s`, `CAP:` `none|<n>`, any case;
  QA-1.6-27, QA-1.6-35); a bare `CAP:` after the value falls back silently". Drop "fixed" from the `LINE_TAIL`
  comment. The report side is handled by the handoff delta below.
- Resolution: 663ebb0 — comment-only. The module header now says that a lower-case value also counts when it is followed
  on the same line by another key with a format-valid value (`VERIFY:` `required|deferred`, `VERIFY_WAIT:`
  `<n>ms|s`, `CAP:` `none|<n>`, any case). "Valid" means the value's format only (`cap:0` counts; a value on the
  next line does not; a bare `CAP:` falls back silently). The `LINE_TAIL` comment no longer calls its ending
  "a fixed alternative". Code is unchanged; directives/risk tests pass (55/55).

### Other checks (no finding)

- The `\b` before the key alternative only matters after a `_` closing mark ([T11] → default). `recap:`,
  `capacity:` and `verifyx:` stay rejected. A value ends at a word boundary, so no key can directly follow a
  value without a closing mark in between.
- `docs/Requirements/guide.txt` (also `.TXT`) is now config instead of docs, because the requirements-folder
  rule is case-insensitive. A docs-only change touching it rises from low to the config row. Lower-case
  `docs/requirements/*.txt` was already config (round 2: "conservative"), so this only extends a conservative
  over-rating. `TestSetup.tsx`/`testsetup.jsx` anywhere and `requirements/Makefile.in` are config too, also
  conservative.
- Unit tests:
  - the QA-1.6-34 timing test is exactly the round-4 shape (1M characters, < 500 ms);
  - the QA-1.6-35 test covers T1, T5 (mode and source), T3, `cap:3`, and upper-case `VERIFY_WAIT: 2s` after a
    lower-case key;
  - the QA-1.6-36 test covers every name from the finding plus two negatives.
- Plan contract: directives.ts still has no imports; the purity guards are green.

### Deferred by plan (unchanged; nothing new deferred)

| Item | Phase |
|---|---|
| Golden check that `parseVerifyDirectives` returns defaults over the final header/protocol text (QA-1.6-4) | 2.3 / 2.4 |
| "Subagent cannot self-select" enforcement test; parse only the orchestrator `prompt` (QA-1.6-5) | 2.4 |
| Clamp `captureWaitMs ≤ baselineTimeoutMs` (QA-1.6-8) | §1.4 config resolver phase |
| Fill `previousPath` from the porcelain rename source (QA-1.6-13) | 2.1 |
| Unknown or failed attribution must not become `[]` → low (QA-1.6-14) | 2.4 |
| Expose the git top-level on `TreeSnapshot` and pass it as `root` (QA-1.6-22) | 2.1 / 2.4 |
| Tool-observed `ChangedFile` never carries a deletion (`written`/`modified` only) | 2.1 / 2.4 |
| Amend the plan's 1.6.1 signature (`source` → `modeSource`/`waitSource`) and record the QA-1.6-18 guard (QA-1.6-33) | next plan revision |

### Handoff to 2.4 (delta)

Item 4 now reads: **Key case:** a lower-case key counts only in three cases:
- its value ends the line;
- it is followed by closing marks, punctuation or a table pipe up to the end of the line;
- it is followed on the same line by another key with a grammar-valid value: `VERIFY:` + `required|deferred`,
  `VERIFY_WAIT:` + `<n>ms|s`, or `CAP:` + `none|<n>` (any case; QA-1.6-18, QA-1.6-27, QA-1.6-35).

A bare `CAP:`, or `cap: the …`, after the value makes the line prose. In a multi-cell table row only the last
cell qualifies. Protocol text (2.3) and router-authored examples should show upper-case `VERIFY:`/`VERIFY_WAIT:`.
The other items are unchanged.

Outcome: QA-1.6-34..37 are verified. No High, Medium or Low finding is open. One optional, doc-only Info
finding is open (QA-1.6-38), and it does not block. Phase 1.6 QA is **clean**.
