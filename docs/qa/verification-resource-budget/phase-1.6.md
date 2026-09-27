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
