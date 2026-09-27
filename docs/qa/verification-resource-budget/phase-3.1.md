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
