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
