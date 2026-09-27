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
