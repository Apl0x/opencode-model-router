# Phase 3.1 — end-to-end fixtures, benchmark and CI

## Pre-flight: how the Windows and Linux coverage are merged (task 3.1.3)

### Question

The per-file gate (≥ 90 % lines and branches for `src/verify/{exec,runner,slot,reference,batch,directives,risk,pending}.ts`)
must be evaluated on one combined view of the Windows and Linux runs, because each OS leaves the other's
platform branches uncovered. vitest 4.1.11 offers `--reporter=blob` + `--merge-reports --coverage`.

### Experiment (Windows, vitest 4.1.11, @vitest/coverage-v8 4.1.11)

```
npx vitest run --reporter=blob --coverage --coverage.include=src/verify/directives.ts \
  --outputFile=.vitest-reports/win.json test/unit/directives.test.ts
```

The blob (43 KB) stores the source files by **absolute path of the producing machine**, in both spellings:
`D:\\git\\omr-p31\\src\\verify\\directives.ts` and `D:/git/omr-p31/src/verify/directives.ts` (8 occurrences of the
checkout root). A Linux blob would carry `/home/runner/work/<repo>/<repo>/src/...`. `--merge-reports` keys coverage by
those paths, so the same source file from two OSes stays two unrelated entries (and the foreign-root one cannot even be
remapped to a local source file). Cross-OS `--merge-reports` is therefore **not viable** without rewriting the blob's
internal (serialized, raw-v8) format — too fragile.

### Decision

Each CI run writes istanbul `coverage-final.json` (`--coverage.reporter=json`) with thresholds off
(`OMR_COVERAGE_ARTIFACT=1`), and uploads it. The `coverage-merge` job runs `scripts/coverage-merge.mjs`, which:

1. rewrites every key to its repo-relative `src/...` path (first `/src/` segment after normalising `\` to `/`) and
   resolves it against the merge job's checkout;
2. merges all inputs with `istanbul-lib-coverage` (now a direct devDependency, `^3.2.2` — it was already in the tree
   transitively, same version), whose `FileCoverage.merge` matches statements/branches by source location;
3. reads the gated file list and minimums from `vitest.config.ts` (`MERGED_PER_FILE_GATED`, `MERGED_PER_FILE_MIN`;
   the script sets `OMR_COVERAGE_MERGED=1` before importing it) and fails when any file is below 90 % lines or
   branches, or is missing. It also warns when the merged branch map is larger than any single input's (a sign the two
   OSes mapped the same source to different locations).

Why this: it is the smallest thing that works (one ~90-line script, one existing dependency), the thresholds stay
declared in `vitest.config.ts`, and it does not depend on vitest's internal blob format.

`vitest.config.ts` also installs the same per-file entries (`perFile: true`) when `OMR_COVERAGE_MERGED=1`. Only the
merge script sets that variable; a normal single-OS `npm run test:coverage` never sees the per-file gates (on Windows,
the 8 unit test files alone leave exec.ts at 66.5 % branches), so they cannot fail local runs.

Validation: the script was run locally on the Windows coverage-final.json plus a copy with every path rewritten to
`/home/runner/work/omr/omr/...`. Both collapsed to the same 8 files, the merged numbers equal vitest's own table
exactly (no branch-map drift), and the gate exited 1 as expected on the single-OS data.

### CI inputs to the merge (4 files)

| artifact           | run                                                                 |
| ------------------ | ------------------------------------------------------------------- |
| `win-unit`         | `e2e` job, windows-latest: default suite with coverage              |
| `win-e2e`          | `e2e` job, windows-latest: e2e files, `RUN_VERIFY_E2E=1`, 1 worker  |
| `linux-unit`       | `coverage` job: default suite with coverage                         |
| `linux-e2e`        | `coverage` job: e2e files, `RUN_VERIFY_E2E=1`, 1 worker             |

### Local per-file numbers (Windows, the 8 unit test files only)

`npx vitest run --coverage --maxWorkers=2 test/unit/{exec,runner,slot,reference,batch,directives,risk,pending}.test.ts`
with `--coverage.include` on the 8 files (1182 passed, 2 skipped, 109.9 s):

| file          | lines   | branches |
| ------------- | ------- | -------- |
| batch.ts      | 98.23 % | 91.83 %  |
| directives.ts | 100 %   | 89.55 %  |
| exec.ts       | 84.04 % | 66.5 %   |
| pending.ts    | 99.62 % | 93.7 %   |
| reference.ts  | 89.76 % | 77.04 %  |
| risk.ts       | 100 %   | 98.36 %  |
| runner.ts     | 99.88 % | 97.8 %   |
| slot.ts       | 89.84 % | 77.62 %  |

`directives.ts` 89.55 % branches is not a platform gap (the module has no platform branches); it needs tests.

### Platform-specific branches (not refactored here)

Bound to the real `process.platform` (one OS cannot reach both sides):

- `src/verify/exec.ts:104` — `isWin` module constant; used at `:119`, `:146`, `:148`, `:193`, `:201`, `:239`, `:314`,
  `:334`, `:335`, `:339`, `:382`, `:425`, `:484` (nice vs low-priority, batch-file refusal, detached groups, taskkill vs
  process-group kill, exit-hook tree kill).
- `src/verify/exec.ts:110-111` — `SYSTEM32 ?` (taskkill / powershell path; Windows env only).
- `src/verify/slot.ts:471` — `process.platform === "linux"` branch.
- `src/verify/reference.ts:1367` — `const platform = process.platform` (not injectable in that function; feeds
  `pathFor(platform)` and the win32/posix rules below it).

Injectable (`options.platform` / `deps.platform` / `host.platform`, default `process.platform`) — both sides are
unit-testable on one OS, gaps there are test gaps, not platform gaps:

- `src/verify/batch.ts:1014`, `:1881`, `:1886`, `:2142`
- `src/verify/pending.ts:1329`
- `src/verify/reference.ts:901`, `:906`, `:929`, `:946`, `:1036`, `:1496`, `:1567`, `:1640`, `:1778`, `:1821`, `:1946`
- `src/verify/runner.ts:1504`
- `src/verify/risk.ts`, `src/verify/directives.ts`: none.

## Product findings

### E2E-1 — critical — pytest: an introduced failure passed as "no affected tests"

**Found by** the guardrail matrix (`test/integration/verify-resource-budget.test.ts`). The
`pytest-app` fixture was materialised by `test/integration/e2e/fixture-repo.ts`, and `app/mod02.py` was
broken (`return x - 2` became `return x - 200`). The verdict was:

```
[router ✓ accepted: deterministic]
Verification notes:
- no affected tests: no test files map to the changed modules
```

`tests/test_mod02_1.py` does `from app.mod02 import value02, ...`, and `uv run pytest` fails. The six
pytest source-edit scenarios were skipped until this fix. The pytest green control passed vacuously:
it ran no test at all.

**Root cause** (`src/verify/runner.ts` at cf3f7f2). The planner looked up an existing changed module
only by test file name. `classify` (`:4301-4307`) called `findByName(gitRoot, ["test_mod02.py",
"mod02_test.py"])`. With no hits it only added the note `no tests named for app/mod02.py`, and the
empty input set became NoAffected (`:4322`, note chosen at `:4249`). The search itself worked. A probe
with the wiring's exact argv on a materialised copy showed this:

- `git ls-files -z ... -- :(glob)**/test_mod02.py :(glob)**/mod02_test.py` → empty, exit 0.
- `git grep -l -z -F -w --untracked -e mod02 -- :(glob)**/test_*.py ...` → `tests/test_mod02_1.py`.

The fixture names its tests `test_modNN_K.py`, so no module was ever mapped. The same fail-open shape
had already surfaced three times, each patched on its own: QA-1.3-23, QA-1.3-33 and QA-1.3-39 all
ended in `no test files map to the changed modules`.

**Resolution** (6ded626, `fix(verify): map a changed pytest module to the tests that import it, fail
closed`; the e2e un-skip is 84d1e48).

- Mapping (`runner.ts:4411-4426`). A changed module maps to the tests that import it: a whole-word
  content search for its stem (`git grep -F -w`, new `TestSearchSeam.findByContent(..., {word})`,
  `wiring.ts:922`) over the python_files globs. These hits are re-checked against python_files and
  joined with the by-name hits. Every import spelling contains the stem as a whole word: `import
  app.mod02`, `from app.mod02 import x`, `from app import mod02`, `from .mod02 import x` and `from .
  import mod02`. A longer name such as `mod020` does not match.
- Fail closed. A search that fails is S6 `search-failed`. A module with no in-scope test is S6
  `unmapped-module` (`:4424`). A module that a `conftest.py` names is also S6 `unmapped-module`
  (`:4419`), because its fixtures reach tests that never name it. One unmapped module makes the whole
  change S6. The pytest-only NoAffected note is gone. The final NoAffected (`:4443`) is now reached
  only when no changed file is a module.
- testpaths (G.8b; `testpathScopes` `:2930`, wired at `:3475`, used at `:4328`). Content mapping first
  pulled in `extra/test_preexisting.py`, which imports `app.mod01`. That file lies outside `testpaths =
  ["tests"]`, and the user's run never collects it, so the green control became a false failure. Test
  inputs are now limited to the testpaths when those decide the collection. That requires no path
  argument, pytest started in its rootdir, every release line's config setting testpaths, no `-o
  testpaths=`, no `--pyargs`, no `--rootdir`, and plain entries only. Any other case keeps every test
  under runnerCwd, because an extra input can only add a failure, never hide one. An unreadable
  testpaths value is dropped, never S6.

**Evidence.**

- Unit tests: `test/unit/runner.test.ts` has two new blocks. "E2E-1: pytest maps a changed module..."
  uses the fixture's real file contents. "G.8b: testpaths decide...". `test/unit/baseline-wiring.test.ts`
  adds a test for `-w`. Against the cf3f7f2 product in a separate worktree, 9 new tests fail. The
  mapping test fails with exactly `{"noAffected":true,"note":"no affected tests: no test files map to
  the changed modules"}`. At 6ded626 they all pass: runner, deterministic, baseline-wiring and
  tests-pass-pipeline give 961/961, `tsc --noEmit` passes, and runner.ts branch coverage is 97.84%.
- A real-git planner probe on a materialised fixture: `app/mod02.py` gives `tests/test_mod02_1.py`, and
  `app/mod01.py` gives `tests/test_mod01_{1,2,3}.py` (without `extra/`).
- e2e, pytest part: 8 of 12 fail at cf3f7f2, 12 of 12 pass at 6ded626. The whole matrix passes 36/36.
  The introduced, pre-existing and pre-existing + introduced scenarios are unverifiable, because pytest
  has no reference recheck (approved deviation 5). The caveat reads `reference unusable
  (runner-unsupported) ... observed failures: tests/test_mod02_1.py::test_value_subtracts, ...`, and
  the e2e now asserts that the id is listed. The green control runs `tests/test_mod01_*` and passes.

**Other NoAffected paths in the pytest planner** (line numbers at 6ded626; none of them yields NoAffected
for a changed importable module):

| Where | Path | Verdict |
| --- | --- | --- |
| `runner.ts:4173` | no changed files | correct (section 1.5-6) |
| `runner.ts:4334` | non-`.py` files and non-inputs (docs, `.github/**`, licences) are skipped | residual: a data file that a module reads (`app/data.json`), `.pyi`, `.pyx`, or a binary `.pyd`/`.so` alone gives NoAffected. None of these is an importable source module in the tree. Not fixed. |
| `runner.ts:4342` | an existing test file outside runnerCwd, the path scopes or the testpaths is dropped | correct: the user's run does not collect it |
| `runner.ts:4344` | a deleted test file becomes a note | correct: nothing to run; the risk signal covers it |
| `runner.ts:4363` | static planner, `inputs = 0` and `pending = 0` | reached only without modules |
| `runner.ts:4443` | empty inputs after the searches | reached only without modules (every module adds an input or is S6) |

**Residual risk (documented in runner.ts G.8, not fixed).** A test that reaches the changed module
only indirectly does not run. The indirect routes are another source module (`app/mod02.py` imports
`app/mod01.py`) and a dynamic import. The direct importers still run. A full reverse-import closure
would multiply the git processes, bounded by SEARCH_LIMIT. Making every non-leaf module S6 would have
turned the green control unverifiable.

### E2E-2 — major — an 8.3 short path disabled every reference recheck

**Found by** both e2e files, which worked around it by creating their root under
`realpathSync.native(os.tmpdir())`. On this host `os.tmpdir()` is `C:\Users\MARQUI~1\AppData\Local\Temp`.
With the raw spelling, the plugin directory, TEMP and the reference worktrees are all short. The
required gate on an introduced failure then said:

```
[router ✓ accepted: deterministic]
Verification caveats — NOT verified (acceptance is not a passing check):
- testsPass: cannot attribute failures: reference unusable (rerun-unplannable): runner not installed: vitest; observed failures: test/m20-1.test.js > m20 (1) > double doubles the value, ...
```

Introduced failures were accepted with a caveat, and pre-existing ones were never excused. This is
QA-2.4-23 (`ctx.directory` in 8.3 form), now confirmed on a real host setup.

**Root cause** (line numbers at 84d1e48).

- The implementer's note blamed the `node_modules` link check in materialize
  (`reference.ts:1766-1772`). A probe refuted that. With an 8.3 tmpdir and an 8.3 repository path,
  materialize linked `node_modules` (`links` held the entry and `unreproduced` was empty). The reason
  is that the reference dir is built under `fs.promises.realpath(tmpdir)` (`:1611`), which is the
  native realpath (long form), so `realpath(parent)` and `dir` agree. Measured on this host:
  `fs.realpathSync` keeps `MARQUI~1`, while `realpathSync.native` and `fs.promises.realpath` give
  `Marquinho`.
- The message came from `resolveEntry` (`runner.ts:3458`), called by the recheck at
  `deterministic.ts:1075` with the raw request cwd (the plugin directory, short). `detectRunner`
  returns `gitRoot` realpath'd (long). `ancestors(ctx, cwd, req.gitRoot)` (`runner.ts:1625-1626`)
  returns nothing when cwd is not lexically inside gitRoot, so `node_modules/vitest/package.json` was
  never found. Every internal caller of `resolveEntryImpl` canonicalises its cwd first
  (`canonicalCwd`); the exported `resolveEntry` was the only one that did not. Probe:
  `resolveEntry(runner, <8.3 repo>)` gave `{"code":"runner-not-installed","reason":"runner not
  installed: vitest"}`, and `resolveEntry(runner, runner.runnerCwd)` gave the entry.
- A second, latent gap: `toRefPath` mapped only paths lexically under `ref.root`, which is git's
  spelling. The planner's paths (runner cwd, failing files) are realpath'd, so a root that git spells
  through an 8.3 name, a junction or a subst drive mapped nothing ("the runner cwd is outside the
  reference root"). It did not fire here: git printed the long root (`C:/Users/Marquinho/...`) from an
  8.3 cwd.

**Resolution** (29760a6, `fix(verify): canonicalise 8.3 short paths in the reference recheck`; the
deferred e2e workaround removal is 4892535, the matrix one went in with 84d1e48).

- `runner.ts:4576-4586`: the exported `resolveEntry` canonicalises cwd and gitRoot with the native
  realpath (`canonicalCwd`). Its fs parameter is now `PlannerFs` (an `FsSeam` still fits).
- `deterministic.ts:1079`: the recheck resolves the entry from `runner.runnerCwd`, the canonical start
  the scoped plan used (`planScopedRun`), instead of the raw liveCwd. The T4.i design note says so.
- `reference.ts:1894-1905`: `toRefPath` maps paths under the root or under its native realpath.
  `ReferenceFs.realpath` is documented as the native realpath.
- Checked and unchanged. materialize creates the dir directly under `realpath(tmpdir)` (`:1623`).
  `assertSafeRefDir` takes both `resolve(tmpdir)` and `realpath(tmpdir)` as tmp roots (`tmpRootsFor`),
  so both spellings pass R3; the existing R3 tests cover both. GC scans both tmp roots and matches
  ACTIVE, RELEASED and registered entries by the realpath key. R1–R4 are untouched: no removal path
  changed, dispose still unlinks the junction first, and the new tests check that the store behind
  the junction survives.

**Evidence.**

- Unit tests (real git, a real `node_modules` junction, real 8.3 spellings from `cmd.exe /d /s /c "for
  %I in ("<long>") do @echo %~sI"` spawned with an argv; skipped with a console message only when the
  volume has 8.3 names disabled):
  - `test/unit/reference.test.ts` "8.3 short paths (E2E-2)": capture from the 8.3 cwd, materialize
    with an 8.3 tmpdir, and both root spellings.
  - `test/unit/tests-pass-pipeline.test.ts` "scope.rechecker under 8.3 short paths (E2E-2)": the real
    opener with the real detectRunner, resolveEntry, planRerun, materialize and GC; only the rerun
    spawn and its report are stubbed. Also a direct resolveEntry test.
- Against the unfixed product in a separate worktree, all three fail. The recheck returns `unusable`,
  resolveEntry returns `runner not installed: vitest`, and toRefPath returns undefined for the long
  path under an 8.3 root. With only the runner.ts hunk, the two runner tests pass and the toRefPath
  test still fails. With the whole fix, all pass.
- The affected unit suites (reference, tests-pass-pipeline, baseline-wiring, baseline, dispatch,
  runner, deterministic) at 84d1e48 plus the fixes: 1148/1148. `tsc --noEmit` passes.
- reference.ts coverage, from reference.test.ts alone: statements 83.41 → 83.56, branches
  77.04 → 77.38, functions 95.5 → 95.5, lines 89.76 → 89.77.
- e2e. Before the fix, with the raw `os.tmpdir()`, "VERIFY:required blocks until a verdict" failed
  with the caveat quoted above. After it, both e2e files under the raw `os.tmpdir()` pass 42/42
  (168 s), the pytest scenarios included.

### E2E-3 — major — an edit by a tool the plugin did not know could seed the dispatch baseline

**Found by** 3.1.2.g. With `VERIFY_WAIT:0s`, the harness producer edited files at once by direct fs
writes, with no tool events. The dispatch snapshot settled after the edit, so the baseline already
held it. The gate said `[router ✓ accepted: deterministic] … no changed files, no affected tests`,
with no handle. The e2e producer now waits 1.5 s before editing.

**Assessment: reachable in real use.**

- Not reachable through the tools the plugin already knew. `beginDispatch` runs synchronously before
  the before hook's first await (`wiring.ts:1148` in `beginVerification`, reached from
  `startDispatch`). So the record with `snapshotPending` exists before the producer starts, even at
  `VERIFY_WAIT:0s`. `tool.execute.before` calls `observeEdit` for every tool (`index.ts:1079`). An
  observed write while the snapshot is pending sets `snapshotContaminated` (`dispatch.ts:191`), the
  snapshot is dropped (`:257`), and the delta is `changeBaseline: "unavailable"` (`:334`), so the
  verdict is unverifiable. A contaminated capture gives no reference.
- Reachable through every other tool. `observeEdit` acted only on a fixed list of writers (write,
  edit, patch, multiedit, apply_patch, bash, shell, powershell, exec). opencode fires
  `tool.execute.before` for MCP tools too, named `<server>_<tool>`
  (`packages/opencode/src/session/tools.ts:390-421`, dev branch, read on 2026-09-27), and the
  registry fires it for plugin and custom tools. An MCP `write_file`, a custom editor or `batch` was
  ignored. If such an edit lands before the snapshot settles (`VERIFY_WAIT:0s`, or a snapshot slower
  than the wait on a large repository), the baseline contains it. Probe at 84d1e48: `beginDispatch`
  with a held snapshot, `observeEdit("filesystem_write_file")`, then the snapshot resolves with the
  edited tree. The delta was `{"changeBaseline":"available","changedFiles":[]}`, which is the "no
  changed files" pass. The same race on the capture makes the failure that the edit causes look
  pre-existing at the reference, so it is excused.
- Other paths considered, not false passes of the producer's own edit. A background process started
  by the producer goes through a shell call, whose before hook contaminates a pending snapshot; its
  later writes land after the baseline and the delta sees them. A process started before the dispatch
  is not the producer's edit. The user's own `!` shell has no tool hook, and its edits are the user's.

**Resolution** (495529a, `fix(verify): count unknown tools as writes while a dispatch capture runs`):
fail closed. Only a tool in `NON_WRITING_TOOLS` (`dispatch.ts:100-117`, checked at `:185`) leaves an
in-flight snapshot or capture alone. That set is read, glob, grep, list, ls, codesearch, webfetch,
websearch, lsp, todoread, todowrite, question, skill, plan_enter, plan_exit, invalid, task, the three
MCP resource readers, delegate and router_verify. Any other tool name contaminates: the change set is
unavailable, the reference is none, and the verdict is unverifiable, never a pass. `task` and
`delegate` start sessions whose own tool calls are observed, so parallel dispatches still do not
contaminate each other (3.1.2.f passes). Tool-observed file attribution (`WRITE_TOOLS`, `record`) is
unchanged. Cost: an unknown tool inside the capture window makes that dispatch unverifiable. Outside
the window nothing changes.

**Evidence.** `test/unit/baseline.test.ts` has four E2E-3 cases (filesystem_write_file, morph_edit,
batch, Serena_replace_symbol_body). All four fail at 84d1e48, because the capture is not aborted,
and pass after the fix. Ten non-writing tools keep both the baseline and the reference. The suites and
the e2e run are the ones listed under E2E-2.

**Residual risk (not fixed).** A tool that writes under a non-writing name (for example a custom tool
called `lsp`) is not caught. A write with no tool event at all (an MCP server that writes after its
tool returned, an external editor) cannot be seen by any hook.

## CI round 1 (PR #54, head fa01168, Test run 36355282226)

Four e2e failures, in the `e2e (node 22, ubuntu-latest)`, `coverage (node 22, ubuntu-latest)` (step
"Linux e2e coverage") and `e2e (node 22, windows-latest)` jobs. A fifth (CI1-e) surfaced on the
re-run of the first fixes. The same run's unit-job failures
(baseline-wiring, exec, batch-wiring) are handled separately and are not covered here. Log excerpts
are from `gh run view 36355282226 --job <id> --log` (ubuntu e2e 108721679255, coverage 108721679116,
windows e2e 108721679488).

| # | Test | Jobs | Verdict | Fix |
|---|------|------|---------|-----|
| CI1-a | bound 3.1.2.c: non-vacuity of a verified pass | ubuntu e2e, ubuntu coverage | test | 88d4e2d |
| CI1-b | fixtures self-check: vitest-app pre-existing failure | ubuntu e2e, ubuntu coverage, windows e2e | test | 4c894db |
| CI1-c | bound 3.1.2.d: no orphan 3 s after the gate | windows e2e | test | 1e26ca2 |
| CI1-d | deferred 3.1.2.f: before hook within VERIFY_WAIT | windows e2e | product (in part) and test | ab81633, 4a2e4b8 |
| CI1-e | bound 3.1.2.c: worker bound (on the re-run of d5c268b) | windows e2e | test | 99aac7f |

### CI1-a — 3.1.2.c: a duration floor is no proof that verification ran

`AssertionError: c2 src/m20.js: <task_result> DONE </task_result>: expected 686.17 to be greater than or
equal to 1000` (ubuntu e2e; 587.15 in the coverage job), at `bound.test.ts:461`. A clean required pass
adds no router text, so the test used an after-hook floor of 1000 ms as a proxy for "the gate ran
tests".

**Verification did run on Linux.** The same log: `[3.1.2.c] c2 src/m20.js: after=686ms runner mains
naming it=1 3673` and `c2 src/m13.js: after=684ms runner mains naming it=1 3673` (coverage job: m20
mains 7313,7449). The POSIX `ps` sampler works (this was its first CI run): it saw c2's runner main,
in c2's repo, naming m20. The two neutral dispatches reached the gate together and ran as one batched
scoped run, which on the Linux runner took well under a second.

**Verdict: test defect.** The floor is replaced by the direct evidence: a runner main of that child,
in its repo, naming the dispatch's module, seen in a snapshot within that dispatch's own gate window
(`returnedAt - afterMs` to `returnedAt`, widened by `SNAPSHOT_SKEW_MS` = 250 ms for the snapshot
timestamp skew). This is stronger than before: the old `mains.length >= 1` accepted a main seen at
any time.

### CI1-b — fixtures self-check: the summary parser did not strip colours

`expected undefined to be 1` at `fixtures.e2e-check.test.ts:79`, although the output carried
`Tests  1 failed | 126 passed (127)`. The raw log line is
`\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m...` (14 ESC bytes; checked on the downloaded
log: the old regex does not match it and matches once the escapes are stripped). vitest colours its
output whenever `CI` is set, even into a pipe; locally, without `CI`, the output is plain, so the
self-check passed. The `::error` annotation GitHub shows is uncoloured, which hid this in the job
summary.

**Verdict: test defect.** `countFailed` strips CSI sequences and CRLF and matches the summary per line
(vitest, jest and pytest forms). Always-on parser cases use the CI bytes verbatim. The fixture's test
command still runs with the inherited environment, as the product runs it.

### CI1-c — 3.1.2.d: the "orphans" were the test process's own ancestors

`expected [ …(57) ] to deeply equal []` at `bound.test.ts:573` (`lateMachine`). The log lists them:
19 late snapshots (+3058 ms to +4959 ms) x 3 processes, always the same three:

```
alive at +3058ms 5448 ppid=2620 "C:\hostedtoolcache\windows\node\22.23.2\x64\node.exe" ...\npx-cli.js vitest run --maxWorkers=1 --coverage ...
alive at +3058ms 5288 ppid=5448 C:\Windows\system32\cmd.exe /d /s /c vitest run --maxWorkers=1 --coverage ...
alive at +3058ms 5336 ppid=5288 "node"   "D:\a\opencode-model-router\...\node_modules\.bin\\..\vitest\vitest.mjs" run --maxWorkers=1 --coverage ...
```

and `descendants=0 machine-wide=57 direct kill(0) at +5111ms=3 [5448,5288,5336]`. These are the CI
step's `npx vitest ...`, its `cmd.exe` shim and the vitest main: the chain that launched the test
process, alive because the test run was. None of the timed-out gate's processes (main 4440 and
workers 7940, 5960, 4004, 3044, 4212, 6716, 736) was alive in any late snapshot.

They were counted because Windows never reparents. npx's parent (2620) had exited; during the run a
short-lived child of the test process got pid 2620, and the ppid walk (`descendantsOf`) followed
npx's stale ppid to it. That put npx, cmd and the vitest main among the test process's
"descendants", and the `/vitest/` attribution rule tracked them by pid and creation time.

**Verdict: test defect (case iii of the dispatch: the test's own processes). No G4 violation.**

- `sampler.ts`: `descendantsOf` drops a child created before the process holding its ppid (a process
  cannot predate its parent), and `ancestorsOf` lists the test process's own ancestors. Without
  creation times (POSIX `ps`, where orphans are reparented) the ppid is used as is.
- 3.1.2.d counts only processes created since the dispatch (where the creation time is known), never
  an ancestor, and prints pid, ppid, creation time and args for any late match.
- Always-on pure cases in `harness.e2e-check.test.ts` rebuild the CI shape: without the check the
  walk returns 5448, 5288 and 5336 as descendants; with it, only the reused-pid child.

### CI1-d — 3.1.2.f: before hooks up to 104 ms past VERIFY_WAIT

`expected 5018.3856 to be less than or equal to 5000` at `deferred.test.ts:201`, with
`capture wait (beforeMs) p50=5032ms p95=5090ms max=5104ms` for the 20 parallel deferred dispatches
(windows-latest, 4 cores, `--coverage`). Every capture outlived the 5 s wait, so every hook waited the
full VERIFY_WAIT and then some.

**Product part.** `beginVerificationBounded` armed its timer only after `beginVerification`'s
synchronous start-up had returned (the directive read, `captureDepsFor`, `store.beginDispatch`, the
snapshot's first git spawn). So the wait was VERIFY_WAIT after that start-up, not VERIFY_WAIT from the
dispatch's start. Fix (ab81633): `startDispatch` takes the time on entry and waits only for what is
left (`boundedCaptureWait`). `beginVerificationBounded` counts from its own entry. It uses `Date.now`,
so fake clocks drive it with the timer, and a clock stepped backwards never lengthens the wait past
`waitMs`. Regression test: `deferred-verification.test.ts` "counts the wait from the dispatch's
start". A 300 ms synchronous start-up must release the dispatch at 4700 ms of timer time. It fails
on fa01168's wiring.ts (checked by swapping the file) and passes with the fix.

**Test part.** What remains is outside any timer's control: the timer firing late on a busy event
loop, and the rest of the hook after the wait, serialised over 20 releases that fall due together.
3.1.2.f now allows `HOOK_LATENCY_SLACK_MS` = 250 ms past VERIFY_WAIT (4a2e4b8). The worst case
measured before the product fix was 104 ms.

### CI1-e — 3.1.2.c on the re-run: finished forks still exiting counted as workers

The first push of the fixes above (d5c268b, Test run 36357474278) passed every job except
`e2e (node 22, windows-latest)`. There, 3.1.2.c failed with `expected 3 to be less than or equal
to 2`, from `peak workers (both children)=3 per child=2,3` against a bound of 2 (maxWorkers 2 x one
slot on 4 cores). Round 1 had passed the same test on Windows with `per child=2,2`. The other three
Windows failures were fixed on that run: 3.1.2.d reported `created since the dispatch=8 ... alive >=
3 s after return: descendants=0 machine-wide=0`, 3.1.2.f reported `beforeMs p50=5007ms p95=5036ms
max=5044ms` (before the product fix: p50 5032, p95 5090, max 5104), and the fixtures self-check
passed.

**Mechanism.** vitest 4 does not await a finished fork's exit before it forks the next file's
worker. `vitest/dist/chunks/cli-api.*.js` (pool `schedule`) says so: "Runner terminations are started
but not awaited until the end of full run". With per-file forks (isolate), a sampler can see a
run's `maxWorkers` running forks plus finished ones that are still exiting.

**Reproduced locally.** 3.1.2.b and c ran on the 16-core host (bound 4) with 16
`node -e "require('os').setPriority(10); for(;;){}"` burners. They run at the runner tree's own
below-normal priority, so the host's normal-priority work is not starved. Two runs gave peak workers
5 against the bound of 4. The new composition report showed the same thing in every snapshot over
the bound: at most two runner mains (the slot count), and under one of them a third fork. That fork
was in its last sighting and older than a sibling forked after it. Example:
`worker 55044 ppid=6952 created=...300548 seen -2175..+0ms` beside `52960 created=...302222` and
`59456 created=...302403`, both seen again for another second.

**Verdict: test defect.** The bound is about workers running test files. The product's part of it is
the slot (how many runs at once) and `--maxWorkers` on every run, and both held. A fork that vitest
has finished with and is reaping is not a running worker. The fix is 99aac7f. `workerCensus`
(`sampler.ts`) excuses only that excess. Under one main with more than maxWorkers forks alive, it
excuses up to the excess, oldest first, and only forks that are in their last sighting (never the
final snapshot's) and have a newer sibling. A main never counts fewer than min(alive, maxWorkers)
running, so two runs at once still add up. Sightings are keyed by pid and creation time (pid reuse).
3.1.2.b and c now assert the running peak, report the raw peak, and print every snapshot over the
bound with each worker's parent, creation time, sightings and "retiring" mark. Pure cases cover the
measured shape, a fork seen again later, the final snapshot, two concurrent runs (not excused) and
pid reuse.

### Local verification

- `tsc --noEmit` passes. `deferred-verification.test.ts` and `router-verify-tool.test.ts` pass
  108/108; `baseline-wiring.test.ts` (read-only here) passes 47/47. The always-on parser and
  sampler-helper cases pass (12).
- e2e with `RUN_VERIFY_E2E=1`: the fixtures self-check passes 9/9 with `CI=true` (the colour
  condition of CI1-b), and the deferred file passes 6/6.
- The bound file on an idle host passes 4/4 (53 s): `3.1.2.b peak workers=3 (running 3)`,
  `3.1.2.c peak workers=4 (running 4)`, and 3.1.2.d reports `alive >= 3 s after return:
  descendants=0 machine-wide=0`.
- Under the below-normal CPU load above, c and d pass. b's worker bound passes
  (`peak workers=5 (running 4)`, bound 4).
- Earlier in this round, a concurrent task had 14 normal-priority `node -e "for(;;){}"` processes
  running (host at 100% CPU). Bound runs taken then are not evidence either way: captures timed out,
  gates took up to 90 s, and 3.1.2.d had no runner before its 6 s budget ran out.
- **Open observation (not a CI failure, local, CPU-loaded host only).** Under the below-normal load,
  3.1.2.b failed twice on its run-count heuristic, `expected 15 to be less than or equal to 14`
  (runner-main invocations at most 5 + 5 + 2 x failing). The outputs show neutral dispatches judged
  against references that already held a sibling's broken m12 ("no worse than before; pre-existing
  failures: test/m12-1.test.js ..."). The captures were slow enough under that load for a sibling's
  edit to land first. The worker bound, priority and scoping assertions held. Not investigated
  further. The heuristic's slack assumes an unloaded host.

## CI round 2 (heads 7d59d46 and b4d001d)

### Run 36359394958 (head 7d59d46)

Two failures:

| # | Failure | Verdict | Fix |
|---|---------|---------|-----|
| CI2-a | `exec.test.ts`, the deadline-after-exit test (QA-1.2-1): the holder not dead 3 s after the deadline on a loaded runner | test (G4's documented load limit) | a325320 |
| CI2-b | coverage gate: branches below 90% for `exec.ts` (82.54%), `slot.ts` (78.01%) and `reference.ts` (79.42%) | test coverage, with one product bug found on the way | e8ee28f, bcd6639, b4d001d |

- **CI2-a.** a325320 tolerates only G4's documented sweep load limit (QA-1.2-14), and only with its
  signature: when the holder is not dead 3 s after the deadline, the test still requires it killed
  within 18 s of its start and logs `[G4 load limit, QA-1.2-14]` with the measured delay and stderr.
  Any other shape still fails.
- **CI2-b, product bug (e8ee28f).** An abort in the tick between a failed spawn and its error event
  reached `killTree` with no PID. There, `child.kill` threw `kill EINVAL` (Windows) out of the abort
  listener. The kill is now wrapped. The same commit runs the orphan sweeper's stand-ins in-process so
  `exec.ts`'s sweep and kill branches count toward coverage.
- **CI2-b, coverage.** bcd6639 covers `slot.ts`'s error and edge branches through its seams (merged
  branches 401/514 -> 505/514). b4d001d covers `reference.ts`'s error, abort and cleanup branches
  through fake git and fs seams.

### Run 36360864743 (head b4d001d)

Every job passed except `test (node 20, windows-latest)`, where one test failed:

```
test/unit/slot.test.ts > slot: waiting > backoff jitter never goes below the floor nor above the cap (QA-1.4-16)
AssertionError: expected 1 to be greater than or equal to 2
```

at `slot.test.ts:1115`, the `stamps.length` after
`acquireSlot({ max: 1, waitMs: 300, meta }, { dir, backoffMinMs: 100, backoffMaxMs: 800, ... })`.
With a 300 ms wait and a 100 ms floor, a loaded runner got only one attempt in.

**Verdict: test defect.** The wait is now 20 s, ended by an abort signal once 3 attempts are stamped,
so the test no longer depends on how many attempts fit in a time window. It still asserts that each
wall-clock gap is at least its backoff step (100 ms, then 200 ms, 5 ms timer slack; load only
lengthens a gap). It now also asserts the sleeps the loop asks for between the first and the third
attempt, via a pass-through `setTimeout` spy: exactly `[100, 200]`, each within [floor, cap]. Locally:
5 runs pass, 3 more pass with 14 normal-priority `node -e "for(;;){}"` processes running, and the
whole `slot.test.ts` passes 62/62.

The coverage gate on this run:

```
per-file gate: lines >= 90%, branches >= 90%
src/verify/exec.ts           lines  96.12% (248/258)  branches  96.22% (204/212)  ok
src/verify/runner.ts         lines  99.88% (1778/1780)  branches  97.94% (2003/2045)  ok
src/verify/slot.ts           lines  98.46% (640/650)  branches  98.24% (505/514)  ok
src/verify/reference.ts      lines  98.11% (624/636)  branches   98.8% (581/588)  ok
src/verify/batch.ts          lines   98.4% (557/566)  branches  92.34% (362/392)  ok
src/verify/directives.ts     lines    100% (59/59)  branches  91.04% (61/67)  ok
src/verify/risk.ts           lines    100% (75/75)  branches  98.36% (120/122)  ok
src/verify/pending.ts        lines  99.62% (532/534)  branches  93.94% (388/413)  ok
coverage gate passed
```

### Bun smoke

b246ab2 adds `test/smoke/bun-runtime.smoke.ts`, a plain Bun script that runs the real `src/verify`
modules under Bun (opencode loads the plugin in Bun; every other test runs under Node). f5ff0c8 runs
it in CI as the `bun-smoke` job on ubuntu and windows, with `oven-sh/setup-bun@0c5077e` (v2.2.0),
Bun 1.3.14.

Local runs:

- **Windows: 12/12 pass.** The deadline kill left the tree dead 366 ms after the deadline;
  lowPriority gave priority 6; a `.cmd` was refused and its marker file is absent; JS runners run
  under node, not bun; the slot had one holder across 2 Bun processes; disposing a reference with a
  junctioned `node_modules` was safe; the exit hook left the tree dead in 1 ms.
- **WSL Linux: 11 pass, 1 skipped (Windows only).** lowPriority gave niceness 10; disposing a
  reference with a symlinked `node_modules` was safe.

### Code scanning AI findings

The "Code scanning AI findings" check fails on every sha with a GitHub infrastructure error,
`CAPIError: 400 The requested model is not supported`. It is not caused by the code: the repository
has no `codeql.yml`, and the check is not part of the Test workflow.

## CI round 3 (head 8821de7, Test run 36362100353)

Every job passed except `e2e (node 22, windows-latest)`, step "Windows unit coverage" (the full
default suite with `--coverage` on a 4-core runner). Two tests of `exec.test.ts` failed there:

```
[G4 load limit, QA-1.2-14] holder not dead 3 s after the deadline; still alive; stderr: [output streams force-closed 2000 ms after the kill: a descendant still held them]
FAIL test/unit/exec.test.ts > process lifecycle around the direct child's exit > a deadline after the direct child exited kills what it left running within 3 s (QA-1.2-1, G4)
AssertionError: expected false to be true
 ❯ test/unit/exec.test.ts:453:24
FAIL test/unit/exec.test.ts > process lifecycle around the direct child's exit > an abort between the child's exit and the pipes closing kills the leftovers, not the exited PID (QA-1.2-1, QA-1.2-10)
AssertionError: expected false to be true
 ❯ test/unit/exec.test.ts:478:85
```

The first test failed after 18491 ms, the second after 3919 ms. The holder was still alive 18 s after
it started, and the second test's holder was still alive 3 s after the abort.

### What the logs already showed

The same run's `test` jobs (no coverage) passed, but the first of these two tests was slow in all of
them: 4038 ms (node 20), 7235 ms (node 22) and 3691 ms (node 24). On node 22 it went through the
a325320 tolerance: `holder not dead 3 s after the deadline; killed 4229 ms after it`. The abort test,
which runs next, took 1.0 to 1.1 s in every job. In run 36359394958 (CI2-a) it was also the first test
that failed. The slow one is the job's first orphan sweep.

### Diagnostic run (Test run 36362968435, throwaway branch `vrb/p31-diag`, deleted)

An env-gated trace in `exec.ts` logged the run and sweeper events. The sweeper script printed its own
timestamps: script start, CIM query returned, candidates with their creation times, pinned, kill.
The branch ran the same coverage step 3 times, a plain `vitest run` once, and an idle cold
`powershell.exe` job. Times are ms after the sweeper's spawn:

| Job | Script start | CIM query back | `pinned 1` | Kill requested | Holder |
|-----|-------------:|---------------:|-----------:|---------------:|--------|
| cov 1 | 2200 | 3012 | 3078 | 2423 | test passed in 3817 ms |
| cov 2 | **6584** | **30286** | 31016 | 2430 | killed at +31106, **28751 ms after the deadline** |
| cov 3 | 1965 | 2622 | 2678 | 2408 | test passed in 3404 ms |
| plain | 2479 | 3390 | 3451 | 2423 | test passed in 4202 ms |

- **Later sweeps in the same jobs are fast.** Every later real sweeper reached its script within 182 to
  932 ms, and its query was back by +1195 ms.
- **Idle, a cold `powershell.exe` is fast too.** Script start took 181, 155, 155 and 155 ms, and the
  CIM query 362, 277, 261 and 244 ms.
- **So the cost is the first sweeper's PowerShell start and its first CIM query under the suite's
  load:** 3 vitest workers with V8 coverage, plus their git and node children, on 4 cores. In cov 2
  the sweep was still correct, only late. It killed 28.7 s after the kill request, **1.3 s inside the
  30 s `SWEEP_TIMEOUT_MS`** that exists to bound only a hung sweeper.

The three hypotheses:

- **(i) Slow sweeper under load: confirmed**, as above.
- **(ii) Creation window missed: rejected.** Each first sweep found its holder inside the window, for
  example cov 2: `cand 8856 created 1790556039487` in `from 1790556039364 to 1790556039845`. The V8
  clock (`Date.now()`) minus a fresh file's mtime (system time) was −8.0 to +12.0 ms in 278
  measurements. That is within file-time granularity and well inside `SWEEP_CLOCK_SLACK_MS` (50 ms).
  The one outlier, +59993 ms, was a `git worktree list` run under another test's fake clock, not a
  sweep.
- **(iii) Different parent: rejected.** `tree.cjs` spawns the holder from node directly, with no
  shell. Every first query returned `n 1`, the holder, by `ParentProcessId` = the exited child.

**Verdict: test defect, plus product hardening.** The failures are G4's documented load limit
(QA-1.2-14). The deadline test's tolerance ended 18 s after the holder started, which is below the
sweep's own bound. The abort test had no tolerance at all. In the original failure, the abort test
started while the first sweep was probably still in its query. Its own sweep was then slow too; that
part is inferred, because that run has no trace.

The product finding: a working sweep used 96% of the limit that should only stop a hung one.

### Changes

- **99c7bf9 (product).** `SWEEP_TIMEOUT_MS` goes from 30 s to 60 s, still counted from the kill request.
  It is exported for tests. A hung sweeper still never outlives opencode: it is unref'd, and it is a
  direct child in libuv's kill-on-close job (QA-1.2-19). The only cost is that a hung PowerShell may
  now live 30 s longer inside a running opencode.
- **6730f0e (tests).**
  - Both lifecycle tests now share `expectLateSweep`. The 3 s check comes first and is unchanged. The
    tolerance applies only on Windows, and only when all of these hold:
    - the grace settled the run (`output streams force-closed … a descendant still held them`);
    - there is no `[orphan sweep unavailable: …]` note, so a sweep that could not run fails at once;
    - the holder is dead within `SWEEP_TIMEOUT_MS` + 2 s of the kill.
  - A `[G4 load limit, QA-1.2-14]` warning records the delay.
  - The holder now self-exits after 90 s (it was 20 s), which is later than any wait. It writes
    `holder.exit` (`released` or `timeout`) when it ends on its own. Both tests assert that the file
    is absent, so a pass means the holder was killed.
  - `exec-branches.test.ts` adds a stand-in sweeper that pins and never reports. It asserts that the
    kill arms a `SWEEP_TIMEOUT_MS` limit of at least twice the 28.7 s CI sweep.

### Local verification (Windows, 16 cores)

- `exec.test.ts` + `exec-branches.test.ts`: 50 passed, 2 skipped, in each of 4 runs. They also passed
  twice with 14 normal-priority `node -e "for(;;){}"` loops running (all killed afterwards), and once
  with `--coverage`. `tsc --noEmit` is clean.
- **Forced late sweep** (a local-only `Start-Sleep -Seconds 8` at the top of the sweeper script): both
  tests pass through the tolerance, `dead 6828 ms after it` and `dead 8999 ms after it`.
- **Forced sweep that never kills** (a local-only `exit 0`, so no marker): both tests fail at once on
  `[orphan sweep unavailable: no marker]`. Before that check was added, the abort test failed at
  `expect(dead)` after 62 982 ms.

### Also seen in the diagnostic run

In cov 2, `reference.test.ts > materialize / dispose > QA-1.5-12` failed with
`Error: Hook timed out in 10000ms` in its `beforeEach` (`reference.test.ts:185`). That is the same
load, on a different file. It is not addressed here.

## Known follow-ups (non-blocking CI)

**Owner decision:** Windows CI gates that are too hard to stabilise now are **non-blocking for now, to be
fixed later**. Since the commit `ci(verify): make the windows e2e leg non-blocking and keep the coverage gate running`:

- The **Windows leg of the `e2e` job** is `continue-on-error`. Its Ubuntu leg, the whole `test` matrix
  (Windows included), `bun-smoke` (both OSes) and `coverage` stay blocking.
- The Windows leg still produces coverage when a test fails. Both Windows coverage commands pass
  `--coverage.reportOnFailure`, because vitest 4.1.11 defaults it to `false` and
  `OMR_COVERAGE_ARTIFACT=1` only turns thresholds off. The `e2e` step also runs after a failed
  "Windows unit coverage" step. The `coverage-windows` upload runs `always()`, with
  `if-no-files-found: warn`.
- `coverage-merge` runs whenever `coverage` succeeded, whatever the Windows e2e leg did. It requires
  `linux-unit` and `linux-e2e` and accepts 2–4 inputs. The per-file ≥ 90 % gate **blocks only when all
  4 inputs are present**. With Windows inputs missing, it prints
  `::warning::Windows coverage inputs missing; merged gate is Linux-only for this run` and still prints
  the table, but a gate failure is only a warning. The data requires this. On run 36364312868's Linux
  artifacts alone, `src/verify/exec.ts` is at 65.11 % lines (168/258) and 57.54 % branches (122/212),
  because its win32 branches are uncovered. The other seven gated files pass (slot 98.46/98.05,
  reference 97.79/97.27, runner 99.88/97.94).

Open items to fix later:

1. **`harness.e2e-check.test.ts:214` sampler snapshots:** `expected 3 to be ≥ 5`. Seen in Windows e2e
   run 36364312868, attempts 1 and 2. The e2e step took 591–629 s there, against 466 s earlier, and
   fixture prep doubled.
2. **`reference.test.ts` QA-1.5-12:** `Hook timed out in 10000ms` in `beforeEach` (`:185`). Seen once, in
   the diagnostic job (see above).
3. **G4 late-sweep tolerance:** the first PowerShell sweep under coverage load took 6.6 s to start and
   23.7 s to query. The tolerance added in 6730f0e covers it, but the load limit (QA-1.2-14) remains.
4. **The merged coverage gate depends on Windows.** The gate is only fully enforced when the
   non-blocking Windows leg delivers both of its inputs. Make the Windows e2e leg blocking again once
   items 1–3 are fixed.

## QA findings (round 1)

Adversarial review of `git diff f79dc15..bb3e4bb` (HEAD = origin/vrb/p31 = bb3e4bb): the e2e suite,
the CI jobs, the smoke extensions and the product fixes 6ded626, 29760a6, 495529a, ab81633, 9053dd8,
e8ee28f and 99c7bf9. Reviewer: heavy tier. No code, test or workflow was changed. Mutations were
applied in place to `src/` one at a time, then reverted with `git checkout`. `git status` was clean
after each batch.

### Local runs (Windows 11, 16 cores, idle host, node v24.21.0)

| Command | Result (verbatim) |
| --- | --- |
| `$env:RUN_VERIFY_E2E='1'; npx vitest run --maxWorkers=1 test/integration/e2e test/integration/verify-resource-budget` | `Test Files  5 passed (5)`, `Tests  65 passed (65)`, `Duration  281.21s`, exit 0 |
| same, `--reporter=verbose --silent=false test/integration/verify-resource-budget.deferred.test.ts` (to see the 3.1.2.f–h numbers) | `Tests  6 passed (6)`, exit 0 |
| `npx vitest run --maxWorkers=2` over runner, baseline-wiring, baseline, reference, reference-branches, tests-pass-pipeline, exec, exec-branches, slot, slot-branches (unit) and deferred-verification (integration) | `Test Files  11 passed (11)`, `Tests  1318 passed \| 2 skipped (1320)`, 132 s |

Measured locally (`OMR_E2E_REPORT` plus the verbose deferred run):

- 3.1.2.b: bound 4 (2 × 2); `peak workers=4 (running 4)`; `distinct runner-main invocations=6`;
  sampler `interval median=310ms max=516ms`; `git/cmd descendants seen at normal priority=4`
  (`git --no-pager diff --cached --binary …`, `git --no-pager diff HEAD --binary …`).
- 3.1.2.c: `peak workers (both children)=4 (running 4) per child=2,2`; sampler median 350 ms.
- 3.1.2.d: `afterMs(gate)=6015`, `deadline->gate return=15ms`, `alive >= 3 s after return: descendants=0 machine-wide=0`.
- 3.1.2.e: `omr-ref worktrees=0 omr-ref dirs in tmp=0`.
- 3.1.2.f: `capture wait (beforeMs) p50=2891ms p95=3155ms max=3296ms | after-hook (afterMs) p50=1526ms p95=1655ms max=1670ms`;
  sampler `interval p50=429ms p95=751ms`; `slot dir exists=false`.
- 3.1.2.g: `beforeMs default=401ms VERIFY_WAIT:0s=10ms; afterMs default=373ms 0s=400ms`; required gate `afterMs=3311ms`.
- 3.1.2.h (background on): `late notice after 5671ms; runners seen (repo predicate)=0 broad=7`.

CI (Test run 36366712022, head bb3e4bb): all 12 jobs green. The merge job listed 4 inputs
(`linux-e2e`, `linux-unit`, `win-e2e`, `win-unit`) and printed `coverage gate passed`. Sampler
intervals there were 107–112 ms. On the ubuntu e2e leg, 3.1.2.b printed `peak workers=3 (running 2)`
and `snapshots over the worker bound=1`. On the Windows leg, the neutral 3.1.2.c gates waited
9.4–17.7 s for the slot.

### Mutation checks on the product fixes

| # | Fix | Mutation | Result |
| --- | --- | --- | --- |
| M1 | 495529a | `observeEdit` back to the fixed writer list | killed: baseline.test.ts, 4 failed (the four E2E-3 cases) |
| M1b | 495529a | `batch` added to `NON_WRITING_TOOLS` | killed: 1 failed (the `batch` case) |
| M2 | ab81633 | `awaitBounded(begun, waitMs)` instead of `remaining` | killed: deferred-verification.test.ts, "counts the wait from the dispatch's start" |
| M3 | 9053dd8 | `deadlineCut: deadline.remaining() === 0` (the fix reverted) | **survived**: deterministic, tests-pass-pipeline, batch, slot, slot-branches and router-verify-tool, `507 passed`, exit 0 |
| M4 | e8ee28f | `child.kill("SIGKILL")` moved out of the try | killed: exit 1, vitest `Unhandled Errors`: `Error: kill EINVAL … killTree src/verify/exec.ts:429` |
| M5 | 99c7bf9 | `SWEEP_TIMEOUT_MS = 30_000` | killed: exec-branches.test.ts, 1 failed |
| M6a | 29760a6 | `toRefPath` tries only `[root]` | killed: reference.test.ts "8.3 short paths (E2E-2)" |
| M6b | 29760a6 | `resolveEntry` without `canonicalCwd` | killed: tests-pass-pipeline.test.ts "resolveEntry walks from an 8.3 cwd …" |
| M6c | 29760a6 | recheck resolves the entry from the raw `liveCwd` again | survived, 191/191 (equivalent while resolveEntry canonicalises) |
| M7a | 6ded626 | no `-w` in the wiring's `git grep` | killed: baseline-wiring.test.ts, 1 failed |
| M7b | 6ded626 | an unmapped module is skipped (`continue`) instead of S6 | killed: runner.test.ts, 8 failed |
| M7c | 6ded626 | the conftest reference is ignored | killed: 1 failed |
| M7d | 6ded626 | the content search without `word` | killed: 3 failed |
| M7e | 6ded626 | testpaths applied even when overridden | killed: 1 failed |
| M7f | 6ded626 | testpaths entries with glob characters accepted | **survived**: runner.test.ts 725/725, exit 0 |
| M7g | 6ded626 | content hits not re-checked with `isPyTestFile` | survived, 725/725 (near-equivalent: conftest hits have returned S6 earlier) |

### G1–G8: where the e2e suite proves each criterion

| G | e2e proof (file, test) | Holds on | Gaps |
| --- | --- | --- | --- |
| G1 | bound.test.ts 3.1.2.b: every runner main is `related` or explicit files, fewer than 42; no runner inside a before hook. deferred.test.ts 3.1.2.f and h: zero runners for 20 deferred dispatches. | vitest only | jest and pytest: no argv proof (QA-3.1-9); the before-window check is narrow (QA-3.1-9 c) |
| G2 | verify-resource-budget.test.ts: the 36-cell matrix (3 runners × 6 scenarios × 2 entry points); deferred 3.1.2.g (required → NOT ACCEPTED, drift → not a pass) | vitest, jest; pytest failures are unverifiable (deviation 5) | the required green cell is vacuous (QA-3.1-9 a); pytest maps direct importers only (QA-3.1-20); "✓ accepted" wording on unverifiable verdicts (QA-3.1-21) |
| G3 | 3.1.2.b (bound and priority), 3.1.2.c (two processes) | meaningful on 4-core CI; on ≥ 16 cores c cannot show the slot (QA-3.1-7) | priority asserted for the runner tree only (QA-3.1-8); sampler rate (QA-3.1-5); uncapped reaping excuse (QA-3.1-17) |
| G4 | 3.1.2.d (the gate budget cuts a 120 s test; 0 alive 3 s later); exec unit tests | both OSes | Windows sweep path: tolerance up to 62 s (QA-3.1-19) |
| G5 | 3.1.2.e (no omr-ref worktree or dir; vitest sentinels intact); the matrix `afterEach` (no omr-ref worktree) | vitest | jest's materialize/dispose sentinel is never checked; no pnpm or monorepo layout (QA-3.1-15) |
| G6 | the `test` matrix (ubuntu/windows × node 20/22/24), smoke-keyless, bun-smoke | CI | CodeQL: no workflow (QA-3.1-23) |
| G7 | 3.1.2.f (0 runners, no lock files, beforeMs ≤ VERIFY_WAIT + 250 ms, afterMs ≤ 2.5 s); 3.1.2.h with background off | both OSes | capture wait 3–5 s where the plan expects < 1 s (QA-3.1-3); after-hook bound above the cap (QA-3.1-10); slot residue only (QA-3.1-11) |
| G8 | 3.1.2.g (VERIFY_WAIT:0s, required blocks, drift); 3.1.2.h (5 handles listed plus "… and 15 more"; one late notice); the risk level in the footer regex | both OSes | a required pass tells the orchestrator nothing (QA-3.1-18) |

### Findings

| id | severity | finding | evidence | fix |
| --- | --- | --- | --- | --- |
| QA-3.1-1 | major | **The non-blocking Windows decision leaks into the whole coverage gate.** With fewer than 4 inputs, the per-file ≥ 90 % gate becomes a warning for all 8 files. Only `exec.ts` needs Windows data. With 3 inputs (win-unit present, win-e2e missing), the gate is a warning too, although win-unit alone runs the unit tests that cover the win32 branches. Because the Windows leg is flaky (follow-ups 1–3), any coverage regression in runner, slot, reference, batch, directives, risk or pending passes whenever that leg fails to upload. | `.github/workflows/test.yml:169-177` (`-eq 4` → blocking, else `rc=1` → `::warning::`). This report, "Known follow-ups": on Linux-only data "the other seven gated files pass", and only exec.ts drops (65.11 / 57.54). | Linux-only case: still fail on the 7 platform-neutral files, and warn only for `exec.ts`, or hold exec.ts to a measured Linux floor. Also: whenever `win-unit` is present, gate `exec.ts` at 90/90. |
| QA-3.1-2 | major | **Concurrent dispatches on one working tree blame each other, and the e2e hides it.** A dispatch's change set is the union of its tool-observed files and every tree change since its own snapshot. A sibling's edit therefore counts as this dispatch's change. A correct `VERIFY:required` dispatch is rejected with the sibling's failures listed as "introduced failures", and told to re-run at heavy. This is fail-closed, not a false pass. But it hits the plugin's main pattern (parallel implementation dispatches), and no doc mentions it. 3.1.2.b and c avoid it by starting the neutral dispatches 3.5 s later, and only check that a rejection is present, not what it names. The plan asks for "5 concurrent" gates. Under load, the stagger stops working (the recorded 15 > 14 run count, with neutral dispatches judged against references that held a sibling's broken m12). | `src/verify/dispatch.ts:334-364` (tree delta joined to the observed files). Local 3.1.2.b, outputs #2 and #4: the m12 dispatch and the m14 dispatch each list all 8 failures (m12-1, m14-1..3) as introduced. `bound.test.ts:275-282` ("measured: m11 rejected over m12/m14 failures") and `:105` (`NEUTRAL_START_DELAY_MS = 3500`). `rg -i "parallel\|concurrent\|sibling" docs/VERIFICATION.md docs/adr/0003-*` has no hit on this. | Owner decision, to take into 3.2. At minimum: document the limitation (VERIFICATION.md, ADR 0003), and word the rejection as "failures in files changed since this dispatch (may include concurrent delegations' edits)". Better: narrow a dispatch's change set when a concurrent live dispatch's lineage has tool-observed the file. The e2e should keep one fully concurrent pair and assert the documented outcome, rather than stagger it away. |
| QA-3.1-3 | major | **The dispatch-time capture does not scale to parallel dispatches, and the test hides it.** The plan's 3.1.2.f expects "< 1 s". Measured: p50 2.9 s locally (single dispatch 0.4 s). On 4-core CI, all 20 hit VERIFY_WAIT. The assertion (≤ VERIFY_WAIT + 250 ms) passes even when every dispatch waits the full 5 s. It is not recorded as a deviation. Consequence (inferred, not reproduced e2e): when captures outlive VERIFY_WAIT, the producers start with the snapshot or capture still in flight. Since 495529a, any tool outside `NON_WRITING_TOOLS`, from any session, contaminates every pending capture when it has no `cwd` argument: edit, bash, and any MCP tool, even a read-only one. That leaves the change set unavailable, so the dispatch is unverifiable. The capture's git processes also run at normal priority, outside the slot. | Local 3.1.2.f: `beforeMs p50=2891ms p95=3155ms max=3296ms`. 3.1.2.g: single dispatch `beforeMs default=401ms`. This report, CI1-d/CI1-e: `p50=5032ms` before ab81633, `p50=5007ms` after. `src/index.ts:1079-1080` (`observeEdit(tool, output.args.cwd)`, undefined for most tools). `src/verify/dispatch.ts:185-197`. | Profile the capture (which git calls, how many per dispatch). Share one tree snapshot among dispatches that start within the same short window (their baselines are identical), or bound concurrent captures. In 3.1.2.f, assert p50 < 1 s (or record an approved deviation), and verify the 20 handles afterwards to count unverifiable outcomes. Name the contaminating tool in the caveat. |
| QA-3.1-4 | minor | **The deferred file's "mandated" runner predicate never matches under an 8.3 temp dir.** `isRunner` compares against `r().dir` in its raw spelling. The runner argv carries the long form, so on this host (and on GitHub's Windows runners, `C:\Users\RUNNER~1\…`) it matched nothing. The zero-runner assertions of 3.1.2.f and h rest only on the `broad` regex. | Local 3.1.2.h (background on): `runners seen (repo predicate)=0 broad=7`, and the 7 are this repo's vitest main and forks (`C:\Users\Marquinho\…\vitest-app-511617f3\…`), while the dir is `C:\Users\MARQUI~1\…`. `deferred.test.ts:100`. | Use `pathSpellings` as bound.test.ts does. Add a positive control in the background-on test (`runners.length >= 1`). Search machine-wide by path spelling too, as 3.1.2.d does, so an orphaned runner whose parent exited is not missed. |
| QA-3.1-5 | minor | **The sampler's rate is not asserted.** The plan says it polls every 100 ms. On a busy Windows host, one CIM query of every process takes ~300 ms. A worker shorter than the interval can be missed, so the peak is only a lower bound. The non-vacuity checks are "≥ 5 snapshots" and "peak ≥ 1". | Local: b `median=310ms max=516ms`, c `median=350ms`, d `median=291ms`, f `p50=429ms p95=751ms`. CI: 107–112 ms. | Assert a median interval ≤ 150 ms (fail in CI, warn locally). On Windows, compute the peak from lifetimes (`[createdMs, lastSeen]`) rather than per-snapshot counts. Filter the CIM query (`Name='node.exe'`, or `CreationDate` after the start) to cut its cost. |
| QA-3.1-6 | minor | **3.1.2.b's run-count check is not the plan's rule.** It is too loose where batching matters: the 5 deferred handles verified by one `router_verify` could run 5 times and still pass. It also has no headroom under load (15 > 14 recorded). Observed: 3 invocations with identical argv `related src/m12.js src/m14.js` (distinct outputFile) for one window, which is the union run plus the per-member attribution runs (batch.ts B7). | `bound.test.ts:393` (`5 + 5 + 2 * FAILING.size`). Local `distinct runner-main invocations=6`: 3 × `related m12 m14`, 1 recheck (`run …omr-ref…/m12-1 m14-1..3`), 1 × `related m11 m13 m15`, 1 × `related m06 … m14` (the pending batch). "Open observation" above: `expected 15 to be less than or equal to 14`. | Derive the bound per window from the design: 1 union run, ≤ 1 attribution run per failing member, ≤ 1 recheck per member. For the `router_verify({pending:true})` window, assert exactly 1 run, by creation time or first sighting inside that call. |
| QA-3.1-7 | minor | **3.1.2.c can only show the joint slot on small hosts.** The default `maxConcurrentVerifications = max(1, floor(cores/8))` gives bound 4 on 16 cores, which is 2 children × maxWorkers 2. The slot then never has to hold anyone back, so a broken cross-process slot would pass locally. There is also no assertion that the two children's gates overlapped, or that one of them waited. | Local: `bound 4`, `per child=2,2`, peak 4. Windows CI (bound 2): neutral gates took 9.4–17.7 s, which shows that the slot works there. | Give the children `verify.maxConcurrentVerifications: 1` (the plan's "with the defaults" applies to b). Assert overlapping gate windows, and at least one gate that waited. |
| QA-3.1-8 | minor | **The priority check is narrower than the plan's bullet.** 3.1.2.b says "no descendant runs above below-normal priority". The test asserts this only for the runner tree, and it only logs the capture's git processes seen at normal priority. There is also no non-vacuity check that any runner process was sampled after the 250 ms grace with `lowPriority === true`. (G3's own text, "all at below-normal priority", is about runner workers.) | `bound.test.ts:340-341, 383`. Local: `git/cmd descendants seen at normal priority=4` (`git --no-pager diff --cached --binary …`, `git --no-pager diff HEAD --binary …`). The dispatch saw 12 in another run. | Either spawn the capture's git at low priority (the same `lowPriority` path) and assert every descendant, or record the deviation (the bullet narrowed to the runner tree). Add "≥ 1 runner process sampled at low priority after the grace". |
| QA-3.1-9 | minor | **Weak cells in the matrix and in G1.** (a) The required "accepted" cell asserts only that markers are absent, so it passes if the gate never ran. (b) The "not the full suite" check `/(\d+) tests? (?:ran\|run)/` matches no text the product emits, so it never asserts, and jest and pytest have no e2e argv proof of G1. (c) The "nothing at dispatch" check in 3.1.2.b looks only at snapshots inside before-hook windows, so a runner the before hook started in the background, alive during `produce`, is not flagged. The full-set argv check is what really guards against it. | `verify-resource-budget.test.ts:224-230, 336-337`. `rg "tests? (ran\|run)" src/verify` only finds "no affected tests ran". `bound.test.ts:342-350`. | Add an argv probe to each fixture (vitest/jest `globalSetup`, a pytest `pytest_configure` hook writing `sys.argv`; the smoke already does this for vitest). Assert per cell that a scoped run happened and never the full set. In b, require every runner main's creation time or first sighting to fall inside an after-hook or `router_verify` window. |
| QA-3.1-10 | minor | **3.1.2.f's after-hook bound (2.5 s) is above `DEFERRED_FINISH_MS` (2 s).** So every deferred finish could run into its cap, where static scoping is "counted as impossible (conservative)", and the test would still pass. The measured cost also contradicts G7's "0 ms" wording. This is known deviation QA-2.4-11 (plan: 50 ms). | `deferred.test.ts:29, 212`. `src/verify/wiring.ts:172, 177`. Local: 20 in parallel `afterMs p50=1526ms p95=1655ms max=1670ms`, single 373–400 ms. | Assert max < `DEFERRED_FINISH_MS`, and that no footer carries the cap's conservative reason. Make sure no doc repeats "0 ms" (check in 3.2). |
| QA-3.1-11 | minor | **3.1.2.f checks the slot only for lock files left at the end.** A slot taken and released during the dispatches passes. | `deferred.test.ts:124-127, 208`. Local: `slot dir exists=false`, which is stronger, but it is not asserted. | 3.1.2.f runs first in its file: assert `!existsSync(slotDir)`. |
| QA-3.1-12 | minor | **9053dd8 has no regression test.** Reverting it passes every related suite. It only changes a label: slot-busy vs deadline cut, both non-pass. | M3: `Tests  507 passed (507)`, exit 0. `git show --stat 9053dd8`: deterministic.ts only. | Add a unit test: a deadline leaving less than `slotWaitMs`, and a busy answer whose timer fires just before `remaining()` reads 0. Expect `deadlineCut: true`. |
| QA-3.1-13 | minor | **6ded626's testpaths glob guard is untested.** With a mixed `testpaths = ["tests", "pkg*/tests"]`, dropping the guard narrows the inputs to `tests`. An importer under `pkgA/tests` is then never run, which can hide a failure. | M7f: runner.test.ts `725 passed`, exit 0. `src/verify/runner.ts` (`testpathScopes`, `if (/[*?[]/.test(t)) return undefined;`). | Add the mixed-entry case, expecting no collect scopes. |
| QA-3.1-14 | minor | **The user-facing docs miss the 3.1 behaviour changes.** E2E-1: a pytest module now maps to its importers by content search plus the by-name hits. It is S6 `unmapped-module` when no test maps or a `conftest.py` names it, testpaths bound the inputs, and only direct importers are mapped. E2E-3: any tool outside `NON_WRITING_TOOLS`, MCP tools included, during an in-flight capture makes the dispatch unverifiable. | `git log f79dc15..HEAD -- docs/VERIFICATION.md docs/adr CHANGELOG.md docs/CONFIG_REFERENCE.md` → only 3a8ccd2 (8.3). ADR 0003:53 says only "a pytest module mapping". | Document both in VERIFICATION.md, ADR 0003 and CHANGELOG `[Unreleased]`. |
| QA-3.1-15 | minor | **The fixtures miss the realism the plan's QA focus names.** (a) No pnpm layout and no monorepo (runner cwd below the git root), the same path-spelling surface as E2E-2. (b) jest-app has `setupFilesAfterEnv: jest.setup.js`, but no scenario edits it. (c) vitest-app's `dynamic.test.js` (plan §5: "to document the behaviour") has no scenario. (d) The harness producer writes with `fs` and fires no child-session tool events. So the tool-observed attribution and E2E-3's primary defence never run e2e, and 3.1.2.g's 1.5 s producer delay hides the `VERIFY_WAIT:0s` race. | `test/fixtures/projects/*`. `harness.ts:139-157`. `deferred.test.ts:253-267`. `fixtures.e2e-check.test.ts` checks counts and the pre-existing failure only. | Add a monorepo variant of vitest-app, a `jest.setup.js` edit scenario (expect unverifiable) and an m07 break asserting the documented blind spot. Have the harness wrap its writes in `tool.execute.before/after("edit", <child session>)`. |
| QA-3.1-16 | minor | **The 3.1.4/3.1.5 evidence is not in the report.** The keyed 3.1.4 smokes soft-pass on non-compliance (4 early `return`s) and are not in `smoke:keyless`. No run that reached their hard assertions is recorded. The full unit suite run (3.1.5 and the pre-flight) and a local keyless lane run are not recorded either. The keyless lane does hard-assert that `router_verify` is registered. | `test/smoke/layer2-gate.smoke.test.ts:587-595, 631-639, 680-681`. `package.json` `smoke:keyless` lists registration, subagent-tiers and deferred-catalog. This report has no smoke or full-suite section. | Record one keyed run's evidence file that shows the hard path (scoped argv, a deferred footer with no verifier argv, a completed `router_verify`), plus the full-suite and keyless results. |
| QA-3.1-17 | minor | **The census's "retiring" excuse has no cap, and the blocking Linux leg relies on it.** Any number of excess forks in one snapshot can be excused (in their last sighting, with a newer sibling). On POSIX, "newer" is first-sighting order. It could mask a per-run cap regression on short files. | CI ubuntu e2e 3.1.2.b: `peak workers=3 (running 2)`, `snapshots over the worker bound=1`. `sampler.ts:414-423`. | Excuse at most 1 fork per main per snapshot (the vitest reaping shape). Report the excused count, and fail when excused snapshots exceed a small share. |
| QA-3.1-18 | minor | **A clean `VERIFY:required` pass adds no router text.** The orchestrator cannot tell "verified" from "gate did not run", and the e2e needs sampler evidence to prove that a gate ran (CI1-a). This touches protocol text and goldens. | `bound.test.ts:522-529`. `verify-resource-budget.test.ts:225-226`. | Decide in 3.2: a short positive line for required passes (for example `[router ✓ verified] testsPass: N files`), which also lets the matrix assert positively. |
| QA-3.1-19 | info | **G4 on the Windows sweep path.** The exec tests accept a holder's death up to `SWEEP_TIMEOUT_MS` + 2 s (62 s) after the kill, when the grace signature is present. A regression that makes every sweep slow but under 60 s would pass on Windows. CI measured 28.7 s. Known load limit QA-1.2-14. | This report, CI round 3. 6730f0e `expectLateSweep`. | Deferred by plan (3.2 "leave an orphan process"). Suggest tolerating only a process's first, cold sweep, or requiring the sweeper's own timestamps to show the slow query. |
| QA-3.1-20 | info | **pytest maps direct importers only.** A test that reaches the changed module through another source module is not run. The fixture has that shape: `app/mod02.py` imports `app.mod01`. A pass is still labelled `✓ accepted: deterministic`. Unlike `vitest related` and `jest --findRelatedTests`, there is no transitive step at all. | `runner.ts` G.8 residual. E2E-1 "Residual risk". `test/fixtures/projects/pytest-app/app/mod02.py:1`. | Deferred by plan: §5 accepts missed dependencies, and 3.2 must "construct a false pass". Suggest a bounded reverse-import closure through source modules (within SEARCH_LIMIT), or a caveat note on pytest passes. |
| QA-3.1-21 | info | **An unverifiable verdict renders as `[router ✓ accepted: …]` plus the NOT-verified caveat.** G2 says an unverified delegation is "never labelled accepted". This is by design (`strictUnverifiable: false`, QA-2.2-17). | Local 3.1.2.g drift: `· unverifiable` then `[router ✓ accepted: deterministic]`. 3.1.2.d: `[router ✓ accepted: none]`. | Deferred by plan (3.2: G2 wording vs the shipped label). |
| QA-3.1-22 | nit | Two surviving mutants are equivalent or nearly so: M6c (deterministic.ts passes `runner.runnerCwd`, masked by resolveEntry's own canonicalisation) and M7g (the `isPyTestFile` re-check of content hits). | Mutation table, M6c and M7g. | None needed. Optionally, a seam-level test that the recheck passes `runner.runnerCwd`. |
| QA-3.1-23 | info | **CI hygiene checked, clean.** All 7 action pins match their tags (`gh api repos/<a>/commits/<tag>`: checkout v6.1.0, setup-node v6.5.0, setup-uv v10.2.0, cache v6.1.0, upload-artifact v7.0.1, download-artifact v8.0.1, setup-bun v2.2.0). The workflow has `permissions: contents: read` and runs on `pull_request`, not `_target`. No secrets are used. `continue-on-error` applies to the Windows `e2e` leg only (`test.yml:37`). The `test` matrix, bun-smoke and coverage stay blocking. The artifacts hold coverage JSON only, kept 7 days. Two nits: checkout keeps its default `persist-credentials: true`, and the DoD names CodeQL, but no CodeQL workflow exists (the failing "Code scanning AI findings" check is the infra `CAPIError 400`). | `.github/workflows/test.yml`. Merge log of 36366712022. | Optional: `persist-credentials: false` on the new jobs. Owner: confirm the DoD's CodeQL item or add the workflow. |

### Verdict

**Not clean.** 3 major and 15 minor findings are open. No critical finding: no false pass introduced
in this phase was found. The product fixes are correct as far as checked, and their tests kill the
mutations, except 9053dd8 (QA-3.1-12) and the testpaths glob guard (QA-3.1-13). The e2e suite
passes locally (65/65) and in CI. The main gaps:

- the coverage gate turns into a warning for all 8 files whenever the non-blocking Windows leg drops
  an input (QA-3.1-1);
- concurrent dispatches blame each other, and the e2e hides it with a stagger (QA-3.1-2);
- the capture wait under parallel dispatch is 3–5×, not the plan's < 1 s, which is not recorded
  (QA-3.1-3);
- several assertions that can pass vacuously or are looser than the plan's (QA-3.1-4 to -11).

QA-3.1-19 to -21 are deferred by plan to 3.2. QA-3.1-22 and -23 need no action.

### 3.1.5 evidence

Recorded for QA-3.1-16. Local host: Windows 11, 16 cores, node v24.21.0, bun 1.3.14, at 15e9218.

**Keyless smoke lane** (`npm run smoke:keyless`: registration, subagent-tiers and deferred-catalog),
exit 1:

```
 ❯ test/smoke/registration.smoke.test.ts (2 tests | 1 failed) 19066ms
     × loads the plugin, resolves overrides and registers agents with no API key 12102ms
 FAIL  test/smoke/registration.smoke.test.ts > keyless registration smoke > loads the plugin, resolves overrides and registers agents with no API key
AssertionError: expected { providerID: 'anthropic', …(1) } to deeply equal { providerID: 'openai', …(1) }
-   "modelID": "gpt-5.6-luna-fast",
-   "providerID": "openai",
+   "modelID": "claude-sonnet-5",
+   "providerID": "anthropic",
 ❯ test/smoke/registration.smoke.test.ts:161:27
 Test Files  1 failed | 2 passed (3)
      Tests  1 failed | 8 passed (9)
   Duration  80.91s
```

The one failure is the known local-only one: `expect(agent.model).toEqual(OPENAI_MODEL)` at
`registration.smoke.test.ts:161`. On this host the agent resolves to the local user's anthropic model
instead of the test's openai override, so the providerID differs (cause not re-investigated here). It
does not touch verification. The other 8 tests pass: the second registration test and both the
subagent-tiers and deferred-catalog files.

**Bun smoke** (`bun test/smoke/bun-runtime.smoke.ts`), exit 0:

```
bun 1.3.14 on win32-x64, execPath C:\Users\Marquinho\.bun\bin\bun.exe
PASS exec: runArgv keeps exit codes 0 and 3 (724 ms)
PASS exec: runArgv passes argv byte for byte (372 ms)
PASS exec: the deadline kills the whole tree (2333 ms): child and grandchild dead 332 ms after the deadline
PASS exec: lowPriority lowers the child (1426 ms): base priority 6
PASS exec: runArgv refuses a .cmd target and it does not run (510 ms)
PASS runner: resolveEntry picks node, not bun (60 ms): C:\Users\Marquinho\scoop\apps\nodejs-lts\current\node.exe
PASS runner: planScopedRun's spec runs node, not bun (137 ms): C:\Users\Marquinho\scoop\apps\nodejs-lts\current\node.exe
PASS slot: max 1 in one Bun process (20 ms)
PASS slot: the machine clock under Bun reads the OS uptime (65 ms): hrtime 6105 ms, mono 143337111 ms, uptime 143337109 ms
PASS slot: max 1 across two Bun processes (191 ms)
PASS reference: dispose keeps the real node_modules and leaves no omr-ref dir (1652 ms): junction links removed, exact=true
PASS exec: the exit hook kills a runShell tree when a Bun host exits (868 ms): child and grandchild dead 0 ms after the host exited
OK: 12 passed, 0 failed, 0 skipped
```

**CI, Test run 36366712022 (head bb3e4bb), conclusion `success`.** All 12 jobs green (`gh run view
36366712022 --json jobs`): test × 6 (ubuntu/windows × node 20/22/24), e2e × 2 (ubuntu, windows),
bun smoke × 2, coverage, and the coverage gate. Merged per-file table, reproduced locally from the
run's `coverage-linux` and `coverage-windows` artifacts with `scripts/coverage-merge.mjs` (4 inputs,
`coverage gate passed`, exit 0):

| file | lines | branches |
| --- | --- | --- |
| src/verify/exec.ts | 96.12 % (248/258) | 96.22 % (204/212) |
| src/verify/runner.ts | 99.88 % (1778/1780) | 97.94 % (2003/2045) |
| src/verify/slot.ts | 98.46 % (640/650) | 98.24 % (505/514) |
| src/verify/reference.ts | 98.11 % (624/636) | 98.8 % (581/588) |
| src/verify/batch.ts | 98.4 % (557/566) | 92.34 % (362/392) |
| src/verify/directives.ts | 100 % (59/59) | 91.04 % (61/67) |
| src/verify/risk.ts | 100 % (75/75) | 98.36 % (120/122) |
| src/verify/pending.ts | 99.62 % (532/534) | 93.94 % (388/413) |

**Local e2e run** (QA round 1, above): `Test Files  5 passed (5)`, `Tests  65 passed (65)`,
`Duration  281.21s`, exit 0.

**Keyed 3.1.4 smokes** (`test/smoke/layer2-gate.smoke.test.ts`) are not in `smoke:keyless`. They
soft-pass when the live model does not follow the dispatch protocol (the early `return`s at
`:587-595`, `:631-639`, `:680-681`), so a green keyed run alone does not prove the hard path. The one
live keyed run that reached the hard assertions (as reported by the 3.1.4 implementer; its evidence
file was not re-run in this round) showed: `router_verify` completed with a pass; on the required
path, exactly one verifier run, scoped (`related …m01.js`); the deferred dispatch returned the
`[router] unverified · vrf_… · risk …` footer with 0 verifier runs.

Not recorded here: a full unit-suite run (this dispatch was limited to targeted suites).

### Round-1 resolutions

- **QA-3.1-1** (e116182): `scripts/coverage-merge.mjs` gains `--warn-only <file>` (repeatable; the
  file must be one of `MERGED_PER_FILE_GATED`, else exit 2). A warn-only file is still measured and
  printed, and a miss prints `::warning::` instead of failing. `test.yml` passes
  `--warn-only src/verify/exec.ts` only when `win-unit` is missing; every other gated file always
  blocks, and exec.ts is gated at 90/90 whenever `win-unit` is present (3 or 4 inputs). Checked
  locally on run 36366712022's artifacts, with the workflow's own bash step (extracted from the YAML
  and run with Git bash): Linux-only → exec.ts `WARN (warn-only)` 65.11/57.54, the other 7 `ok`,
  `coverage gate passed`, exit 0; Linux + win-e2e → exec.ts warn-only (68.21/64.15), exit 0;
  Linux + win-unit → exec.ts 96.12/96.22 `ok`, blocking, exit 0; all 4 → all gated, exit 0;
  Linux-only with slot.ts's counters zeroed → slot.ts `0% FAIL`, exec.ts still only a warning,
  `coverage gate FAILED on the merged report (2 inputs)`, exit 1. Without the flag, Linux-only
  exits 1 on exec.ts. `npx --yes js-yaml .github/workflows/test.yml` exit 0.
- **QA-3.1-14** (15e9218): E2E-1 (whole-word content mapping plus name matches, S6
  `unmapped-module` for no mapped test or a naming `conftest.py`, testpaths-bounded inputs; residual:
  direct importers only, non-`.py` files alone give "no affected tests") and E2E-3 (only
  `NON_WRITING_TOOLS` leave an in-flight snapshot or capture alone; any other tool, MCP and custom
  included, makes that dispatch's change set unavailable and reference none → unverifiable; residual:
  writes with no tool event, writers under a non-writing name) documented in `docs/VERIFICATION.md`
  (two new sections, linked from Unverifiable), `docs/CONFIG_REFERENCE.md` (pytest paragraph of
  Affected-test verification; Deferred verification), ADR 0003 Consequences and CHANGELOG
  `[Unreleased]` → Fixed. `npx vitest run --maxWorkers=2 test/unit/config-verify-budget.test.ts
  test/unit/docs-drift.test.ts`: `Tests  71 passed (71)`.
- **QA-3.1-16**: evidence recorded in "3.1.5 evidence" above (keyless lane 8/9 with the known
  local-only providerID failure, Bun smoke 12/12, CI run 36366712022 12/12 jobs green with the merged
  table, local e2e 65/65, the keyed smokes' soft-pass caveat and the one hard-path keyed run). The
  keyed run's evidence file is cited as reported, not reproduced; no full unit-suite run is recorded.

