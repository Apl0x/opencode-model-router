# Phase 1.3 — pre-flight log (Spike C + Gather)

Date: 2026-09-26. Host: win32, 16 logical CPUs (`[Environment]::ProcessorCount` = 16), node v24.21.0, pwsh 7.
Fixture projects (throwaway): `%TEMP%\omr-spikeC\{vitest-proj,jest-proj,pytest-proj}`. Each has two source
files (`math`, `str`) plus an unrelated `lonely` source (JS) / a test-less dir (py), a passing related test
(`math`), a test file with one passing and one failing test (`str`), and a syntax/collection-error variant
created on demand. All commands below were actually run; output is quoted verbatim (ANSI stripped, tails only).

Versions pinned by this spike:

| runner | version | how |
|---|---|---|
| vitest | 4.1.11 | `D:\git\omr-p13\node_modules` (junctioned into the fixture as `node_modules`) |
| jest | 30.5.2 | `npm i` in the fixture (`devDependencies: {"jest":"^30"}`) |
| pytest | 9.1.1 (+ pytest-xdist 3.8.0) | `uv venv .venv` + `uv pip install pytest pytest-xdist` in the fixture |
| pytest | 9.0.2 | `C:\Users\Marquinho\miniconda3\Scripts\pytest.exe` (no xdist) — cross-checked failing run |

Captured reports (paths replaced by `<ROOT>` = the `%TEMP%\omr-spikeC` dir, `<REPO>` = `D:\git\omr-p13`,
`<PYTHON>` = the base interpreter prefix, `hostname="<HOST>"`) are in `test/fixtures/runner/reports/`.

## Pre-flight / Spike C

### Bin entries (no `.cmd` shim)

```
node -p "JSON.stringify(require('D:/git/omr-p13/node_modules/vitest/package.json').bin)"
{"vitest":"./vitest.mjs"}
node -p "...jest-proj/node_modules/jest/package.json → version+bin"
30.5.2 "./bin/jest.js"
```

- vitest: `bin` is an **object** `{ "vitest": "./vitest.mjs" }` → entry `node_modules/vitest/vitest.mjs`.
- jest: `bin` is a **string** `"./bin/jest.js"` → entry `node_modules/jest/bin/jest.js`.
  `resolveEntry` must accept both shapes (string, or object keyed by the command name).
- Every JS command in this log was run as `node <entry> …` (e.g. `node node_modules\vitest\vitest.mjs related …`,
  `node node_modules\jest\bin\jest.js --findRelatedTests …`) and worked; so
  `{ file: process.execPath, args: [<entry>, …] }` is sufficient on Windows.
- pytest: native `.venv\Scripts\pytest.exe` / `…\miniconda3\Scripts\pytest.exe` executed directly (no shell).

### vitest 4.1.11 — `related`

| case | command (cwd = vitest-proj) | exit |
|---|---|---|
| all passed | `node node_modules\vitest\vitest.mjs related src/math.js --run --passWithNoTests --maxWorkers=2 --reporter=json --outputFile=../vitest-pass.json` | **0** |
| some failed | `… related src/math.js src/str.js --run --passWithNoTests --maxWorkers=50% --reporter=json --outputFile=../vitest-fail.json` | **1** |
| none found | `… related src/lonely.js --run --passWithNoTests --maxWorkers 4 --reporter=json --outputFile=../vitest-none.json` | **0** |
| none found, **no** `--passWithNoTests` | `… related src/lonely.js --run --reporter=json --outputFile=../vitest-none2.json` | **0** (!) |
| collection error (module throws at import) | `test/throws.test.js` = `…import {add} from '../src/math.js';throw new Error('boom at import');…`; `… related src/math.js --run --passWithNoTests --maxWorkers=2 --reporter=json --outputFile=../vitest-collect-error.json` | **1**, report written |
| syntax error in a test file | `test/broken.test.js` with unbalanced `{`; same `related src/math.js …` command | **1**, **no report written** |
| syntax error in an **unrelated** test file | `broken.test.js` imports math; `… related src/str.js --run --reporter=json --outputFile=../vitest-syntax-unrelated.json` | **1**, no report |
| (contrast) plain run, no match | `… run doesnotexist` | **1** |

Quoted evidence:

```
=== none-nopass … related src/lonely.js --run => exit 0
No test files found, exiting with code 0

=== collect-error (syntax) … => exit 1
⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: Failed to parse source for import analysis because the content contains invalid JS syntax. …
exists: False            # Test-Path ..\vitest-collect-error.json after the syntax-error run

=== collect-syntax-unrelated … related src/str.js … => exit 1
Error: Failed to parse source for import analysis because the content contains invalid JS syntax. …
```

Findings:
- `vitest related` with nothing related **exits 0 even without `--passWithNoTests`** (prints
  `No test files found, exiting with code 0`); `vitest run <filter>` with no match exits 1. So exit 0 is
  not proof that anything ran — the report's `numTotalTests`/`testResults: []` must be checked.
- A **syntax error in any test file** (even one unrelated to the changed files) aborts `related` during
  import analysis: exit 1, "Unhandled Error", and the JSON report file is **not created**. Missing report
  + non-zero exit must be treated as "collection error / identities unavailable", never as pass.
- A runtime throw at import is reported per file: the suite has `"status":"failed"`,
  `"assertionResults":[]`, `"message":"boom at import"`, while `numFailedTests` stays **0** and only
  `numFailedTestSuites` counts it.
- Paths: relative, absolute Windows (`C:\Users\…\vitest-proj\src\math.js`, exit 0, 1 test) and absolute
  forward-slash (`C:/Users/…/src/str.js`, exit 1 — ran the str tests) are all accepted.
- `--maxWorkers`: `=2`, `=50%` and two-token `--maxWorkers 4` all accepted. **`--maxWorkers=abc` is
  silently accepted** (exit 0, tests ran) — the planner must validate the value itself.

### vitest 4.1.11 — `list` (S5 decision)

**Answer: NO — there is no CLI way to list the tests related to an arbitrary set of files without running
`related`.** Evidence:

```
=== list-related-flag :: node … vitest.mjs list --related src/math.js => exit 1
    at Command.checkUnknownOptions (file:///<REPO>/node_modules/vitest/dist/chunks/cac.uFydS1Z4.js:406:17)
=== list-related-positional :: node … vitest.mjs list related src/math.js => exit 0
(empty output — "related" and "src/math.js" are treated as file-name filters; nothing matches)
=== list-files-positional :: node … vitest.mjs list src/math.js => exit 0
(empty output — positional args are test-file name filters, not source files)
```

`vitest list --help` offers `--json [true/path]`, `--filesOnly`, `--staticParse`, `--changed [since]`,
but no related/source-file option. The only non-executing dependency-based listing is **git-based**:

```
# git init + commit, then touch src/str.js
=== list-changed :: node … vitest.mjs list --changed --json => exit 0
[ { "name": "str > ok",  "file": "<ROOT>/vitest-proj/test/str.test.js" },
  { "name": "str > bad", "file": "<ROOT>/vitest-proj/test/str.test.js" } ]
=== list-changed-filesOnly :: … list --changed --filesOnly --json => exit 0
[ { "file": "<ROOT>/vitest-proj/test/str.test.js" } ]
```

Side-effect probe (`test/probe.test.js` writes `probe-top.txt` at module top level and `probe-body.txt`
inside the test body; imports `src/math.js`):

| command | top-level executed | test body executed |
|---|---|---|
| `list --json` (all) | True | False |
| `list --filesOnly --json` | False | False |
| `list --changed --json` (math.js modified) | True | False |
| `list --changed --filesOnly` (math.js modified) | False | False |
| `list --changed --staticParse --json` (math.js modified) | False | False |

So `list` never runs test bodies, but default mode **imports test modules** (top-level code runs); only
`--filesOnly` or `--staticParse` avoid that. `--changed` works from the git working tree/`since` ref, not
from a caller-supplied file list, so it cannot express "these changed files" for an arbitrary diff.
Consequence for 1.3.1: **no `planListRelated` for vitest**; S5 attribution must come from the executed
`related` run's report (jest, by contrast, has a real non-executing listing — below).

### jest 30.5.2 — `--findRelatedTests`

| case | command (cwd = jest-proj) | exit |
|---|---|---|
| list | `node node_modules\jest\bin\jest.js --findRelatedTests src/math.js src/str.js --listTests` | **0** |
| list JSON | `… --findRelatedTests src/math.js --listTests --json` | **0** |
| list, none | `… --findRelatedTests src/lonely.js --listTests` | **0** (empty output) |
| list with a syntax-broken related test | `… --findRelatedTests src/math.js --listTests` | **0** (broken file listed) |
| all passed | `… --findRelatedTests src/math.js --passWithNoTests --maxWorkers=2 --json --outputFile=../jest-pass.json` | **0** |
| some failed | `… --findRelatedTests src/math.js src/str.js --passWithNoTests --maxWorkers=50% --json --outputFile=../jest-fail.json` | **1** |
| none found | `… --findRelatedTests src/lonely.js --passWithNoTests --maxWorkers 4 --json --outputFile=../jest-none.json` | **0** |
| none found, no `--passWithNoTests` | `… --findRelatedTests src/lonely.js --json --outputFile=../jest-none-nopass.json` | **1** |
| collection (syntax) error | `test/broken.test.js` unbalanced `{`; `… --findRelatedTests src/math.js --passWithNoTests --maxWorkers=2 --json --outputFile=../jest-collect-error.json` | **1**, report written |

```
=== list :: … --findRelatedTests src/math.js src/str.js --listTests => exit 0
C:\Users\Marquinho\AppData\Local\Temp\omr-spikeC\jest-proj\test\str.test.js
C:\Users\Marquinho\AppData\Local\Temp\omr-spikeC\jest-proj\test\math.test.js
=== list-json :: … --listTests --json => exit 0
["C:\\Users\\Marquinho\\AppData\\Local\\Temp\\omr-spikeC\\jest-proj\\test\\math.test.js"]
=== none-nopass => exit 1
No files found in C:\Users\Marquinho\AppData\Local\Temp\omr-spikeC\jest-proj.
Pattern: src/lonely.js - 0 matches
=== collect-syntax => exit 1
    SyntaxError: …\jest-proj\test\broken.test.js: Unexpected token (2:0)
Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 passed, 1 total
Test results written to: ..\jest-collect-error.json
```

Findings:
- `--listTests` is a genuine non-executing listing (absolute Windows paths, one per line; `--json` gives a
  JSON array of strings). It tolerates syntax errors (haste-map dependency extraction), so it lists
  `broken.test.js`.
- Unlike vitest, jest needs `--passWithNoTests` for the empty set (1 without it).
- Absolute Windows path accepted (`--findRelatedTests C:\…\jest-proj\src\math.js` → exit 0, 1 test).
- `--maxWorkers=2`, `=50%`, `--maxWorkers 4` accepted; **`--maxWorkers=abc` silently accepted** (exit 0).
- Collection error: suite `"status":"failed"`, `"assertionResults":[]`, `message` starts with
  `"  ● Test suite failed to run"`; top-level `numRuntimeErrorTestSuites: 1`, `numFailedTests: 0`.

### pytest 9.1.1 (venv) / 9.0.2 (PATH)

| case | command (cwd = pytest-proj) | exit |
|---|---|---|
| all passed | `.venv\Scripts\pytest.exe tests/test_math.py -q -p no:cacheprovider --junitxml=../pytest-pass.xml` | **0** |
| some failed | `… tests/test_math.py tests/test_str.py -q -p no:cacheprovider --junitxml=../pytest-fail.xml` | **1** (9.0.2 on PATH: also **1**) |
| none found (dir w/o tests) | `… tests/empty -q -p no:cacheprovider --junitxml=../pytest-none.xml` | **5** |
| none found (source file passed) | `… pkg/mathx.py -q -p no:cacheprovider` | **5** |
| path does not exist (deleted file) | `… tests/test_gone.py -q -p no:cacheprovider --junitxml=../pytest-missing.xml` | **4** (`ERROR: file or directory not found: tests/test_gone.py`) |
| collection error | `… tests/test_math.py tests/test_broken.py -q -p no:cacheprovider --junitxml=../pytest-collect-error.xml` | **2** (`Interrupted: 1 error during collection`) |
| absolute Windows path | `… C:\…\pytest-proj\tests\test_math.py -q -p no:cacheprovider` | 0 |

With `addopts = -n auto` in `pytest.ini` (xdist installed):

| case | exit | note |
|---|---|---|
| some failed | **1** | `created: 16/16 workers` (= CPU count) |
| `PYTEST_XDIST_AUTO_NUM_WORKERS=2` | 1 | `created: 2/2 workers` |
| env=2 **and** CLI `-n 3` | 1 | `created: 3/3 workers` — explicit `-n` wins over addopts/env |
| `-n logical` | — | `created: 16/16 workers` |
| `-n 0` appended | 1 | no workers line; runs in-process |
| none found | **5** | |
| collection error | **1** (!) | `1 passed, 1 error` — xdist does **not** interrupt; exit is 1, not 2 |
| addopts `-n auto` but xdist absent (PATH pytest 9.0.2) | **4** | usage error (`inifile: …pytest.ini`) |
| `-p no:xdist -n 2` | **4** | usage error |

Findings:
- `PYTEST_XDIST_AUTO_NUM_WORKERS` only changes what `-n auto`/`-n logical`… resolve to (`auto` → 2
  workers with env=2); it does not override an explicit numeric `-n`. To cap workers, append `-n <N>` to the
  argv (last `-n` wins over addopts), but **only if xdist is installed** — `-n` without the plugin is a
  usage error (exit 4). When xdist is absent, no cap flag is needed (single process).
- Collection errors are exit 2 without xdist but exit 1 with xdist → exit code alone cannot distinguish
  "test failed" from "collection error"; parse the junit `<error message="collection failure">`.
- A deleted/missing path is exit 4 — deletions must be filtered out before building argv (§1.5-5).
- Passing a non-test source file yields exit 5 (pytest has no "related" mode; scoping must map sources to
  test files itself or run the whole suite).
- In the pytest ini `pythonpath = .` was needed for `from pkg…` imports (fixture detail, not runner behaviour).

### Exit-code summary

| outcome | vitest 4.1.11 `related` | jest 30.5.2 `--findRelatedTests` | pytest 9.x | pytest 9.x + xdist `-n auto` |
|---|---|---|---|---|
| all passed | 0 | 0 | 0 | 0 |
| some failed | 1 | 1 | 1 | 1 |
| none found | 0 (with **or without** `--passWithNoTests`) | 0 with `--passWithNoTests`, 1 without | 5 | 5 |
| collection error (import-time throw / syntax) | 1 (throw: report written; **syntax: no report**, even if file unrelated) | 1 (report written) | 2 | 1 |
| missing path arg | n/a (treated as unrelated) | n/a | 4 | 4 |
| bad `--maxWorkers` value | 0 (silently ignored) | 0 (silently ignored) | — | 4 if `-n` w/o xdist |

### Report shapes (trimmed real samples; full files under `test/fixtures/runner/reports/`)

**vitest `--reporter=json`** (`vitest-fail.json`) — jest-compatible top level; suite `name` is an absolute
**forward-slash** path; `fullName` is space-joined (`"str bad"`), `ancestorTitles` + `title` give the parts:

```json
{"numTotalTestSuites":4,"numPassedTestSuites":2,"numFailedTestSuites":2,"numTotalTests":3,"numPassedTests":2,
 "numFailedTests":1,"success":false,"testResults":[
  {"assertionResults":[{"ancestorTitles":["str"],"fullName":"str ok","status":"passed","title":"ok","failureMessages":[]},
                       {"ancestorTitles":["str"],"fullName":"str bad","status":"failed","title":"bad",
                        "failureMessages":["AssertionError: expected 'A' to be 'b' // Object.is equality\n    at <ROOT>/vitest-proj/test/str.test.js:1:215 …"]}],
   "status":"failed","message":"","name":"<ROOT>/vitest-proj/test/str.test.js"}]}
```

Collection error (`vitest-collect-error.json`): `{"numFailedTestSuites":1,"numFailedTests":0,"success":false,
"testResults":[…,{"assertionResults":[],"status":"failed","message":"boom at import","name":"<ROOT>/vitest-proj/test/throws.test.js"}]}`.
None (`vitest-none.json`): `{"numTotalTestSuites":0,"numTotalTests":0,"success":true,"testResults":[]}`.
Note: vitest's `numTotalTestSuites` counts `describe` blocks too (pass run: 2 suites for 1 file).

**jest `--json --outputFile`** (`jest-fail.json`) — suite `name` is an absolute **backslash** path:

```json
{"numFailedTestSuites":1,"numFailedTests":1,"numPassedTests":2,"numRuntimeErrorTestSuites":0,"numTotalTestSuites":2,
 "numTotalTests":3,"success":false,"wasInterrupted":false,"testResults":[
  {"assertionResults":[{"ancestorTitles":["str"],"fullName":"str bad","status":"failed","title":"bad",
                        "failureMessages":["Error: expect(received).toBe(expected) // Object.is equality …"],"location":null}],
   "message":"  ● str › bad\n\n    expect(received).toBe(expected) …","name":"<ROOT>\\jest-proj\\test\\str.test.js","status":"failed"}]}
```

Collection error (`jest-collect-error.json`): `"numRuntimeErrorTestSuites":1,"numFailedTests":0`, suite
`{"assertionResults":[],"message":"  ● Test suite failed to run\n\n    Jest encountered an unexpected token …","name":"<ROOT>\\jest-proj\\test\\broken.test.js","status":"failed"}`.
None (`jest-none.json`): `"numTotalTests":0,"success":true,"testResults":[]`.
`--listTests --json` stdout: `["<ROOT>\\jest-proj\\test\\math.test.js"]`.

**pytest `--junitxml`** (`pytest-fail.xml`) — no file attribute; identity = `classname` (dotted module
path + class) + `name`; failures are `<failure>`, collection errors are `<error message="collection failure">`
on a pseudo-testcase with `classname=""` and `name="tests.test_broken"`:

```xml
<testsuites name="pytest tests"><testsuite name="pytest" errors="0" failures="1" skipped="0" tests="3" …>
 <testcase classname="tests.test_math" name="test_adds" time="0.002" />
 <testcase classname="tests.test_str.TestStr" name="test_ok" time="0.001" />
 <testcase classname="tests.test_str.TestStr" name="test_bad" time="0.002"><failure message="AssertionError: assert 'A' == 'b' …">…
tests\test_str.py:8: AssertionError</failure></testcase></testsuite></testsuites>
```

```xml
<!-- pytest-collect-error.xml (exit 2): test_math.py's passing test is NOT in the report (session interrupted) -->
<testsuite name="pytest" errors="1" failures="0" skipped="0" tests="1" …>
 <testcase classname="" name="tests.test_broken" time="0.000"><error message="collection failure">…
E   SyntaxError: invalid syntax</error></testcase></testsuite>
<!-- pytest-none.xml (exit 5) and pytest-missing.xml (exit 4): -->
<testsuite name="pytest" errors="0" failures="0" skipped="0" tests="0" … />
```

With xdist (`pytest-xdist-fail.xml`) testcase order is non-deterministic and the failure `message`
contains raw ANSI escapes encoded as `#x1B[91m…` — strip before comparing. The `-q` terminal summary line
`FAILED tests/test_str.py::TestStr::test_bad - AssertionError: …` gives the nodeid form directly
(`observeTests` already matches it).

## Pre-flight / Gather

`src/verify/deterministic.ts:34-67`

```ts
export const DEFAULT_ALLOWLIST = [
  "npm", "npx", "pnpm", "yarn", "bun", "node",
  "tsc", "tsx", "vitest", "jest", "eslint", "prettier",
];

// Any shell-chaining / redirection / substitution metacharacter.
// eslint-disable-next-line no-useless-escape
export const FORBIDDEN_SHELL = /[;&|`$><\n]|\$\(|&&|\|\|/;

// Interpreters that can execute arbitrary inline code via a flag. An allowlisted
// interpreter must not be turned into an arbitrary-code runner (e.g. `node -e ...`).
const INTERPRETERS = new Set([
  "node", "deno", "bun", "tsx", "ts-node", "python", "python3", "ruby", "perl",
]);
// Inline-eval / inline-print flags: -e, -c, -p, --eval, --print (with optional =value).
const EVAL_FLAG_RE = /^-(e|c|p)$|^--(eval|print)(=|$)/i;

export function isCommandAllowed(command: string, allowlist: string[]): boolean {
  const trimmed = command.trim();
  if (!trimmed || FORBIDDEN_SHELL.test(command)) return false;
  const tokens = trimmed.split(/\s+/);
  const firstToken = tokens[0];
  const parts = firstToken.split(/[/\\]/);
  const basename = parts[parts.length - 1];
  if (!allowlist.includes(basename)) return false;
  // Strip a Windows executable suffix before the interpreter check.
  const interpreterBase = basename.replace(/\.(exe|cmd|bat)$/i, "");
  if (INTERPRETERS.has(interpreterBase)) {
    for (const t of tokens.slice(1)) {
      if (EVAL_FLAG_RE.test(t)) return false;
    }
  }
  return true;
}
```

Note: `pytest` and `uv` are **not** in `DEFAULT_ALLOWLIST`; and `-p` is in `EVAL_FLAG_RE`, which only
matters for interpreters (`python -p …` would be rejected; `pytest -p no:cacheprovider` is not an
interpreter invocation).

`src/verify/deterministic.ts:173-182`

```ts
export function resolveRepoCommand(
  check: Check,
  kind: "testsPass" | "buildPasses" | "lintClean",
  defaults: DeterministicDeps["defaults"],
): string {
  if (check.command) return check.command;
  if (kind === "testsPass") return defaults?.testCommand ?? "npm test";
  if (kind === "buildPasses") return defaults?.buildCommand ?? "npm run build";
  return defaults?.lintCommand ?? "npm run lint";
}
```

`src/verify/baseline.ts:4-9` and `:16-55`

```ts
export interface TestObservation {
  code: number;
  failures: string[];
  count?: number;
  complete: boolean;
}

export function observeTests(result: ExecResult): TestObservation {
  const text = (result.stdout + "\n" + result.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  const failures = new Set<string>();
  let count: number | undefined;
  // Counts are only test counts, never file/suite counts. Unknown formats remain
  // useful at the exit-code floor; they must not throw or invent identities.
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const summary = /^(?:Tests:|Tests\s|=+\s|\d+\s+(?:passing|passed))/.test(trimmed)
      || /^\d+\s+(?:failed|failing)\b/.test(trimmed);
    const n = summary ? /\b(\d+)\s+(?:failed|failing)\b/.exec(trimmed) : null;
    if (n) count = Math.max(count ?? 0, Number(n[1]));
    const id = /^FAILED\s+(\S+)(?:\s+-|$)/.exec(trimmed)?.[1]
      ?? /^FAIL\s+(.+\s+>\s+.+)$/.exec(trimmed)?.[1]
      ?? /^--- FAIL:\s+(.+?)\s+\([\d.]+s\)$/.exec(trimmed)?.[1];
    if (id) failures.add(id);
  }
  // Jest's JSON reporter (also used by compatible runners). Only complete
  // assertion inventories count as identity evidence, not suite-level FAILs.
  try {
    const json: unknown = JSON.parse(result.stdout);
    if (json && typeof json === "object" && "testResults" in json && Array.isArray(json.testResults)) {
      for (const suite of json.testResults) {
        if (!suite || typeof suite !== "object" || !Array.isArray(suite.assertionResults)) continue;
        for (const test of suite.assertionResults) {
          if (test?.status === "failed" && typeof test.fullName === "string") {
            failures.add(`${String(suite.name ?? "")} > ${test.fullName}`);
          }
        }
      }
      if ("numFailedTests" in json && typeof json.numFailedTests === "number") count = json.numFailedTests;
    }
  } catch {
    // Not a JSON reporter; the text observations above still apply.
  }
  return {
    code: result.code, failures: [...failures].sort(), count,
    complete: result.code === 0 || (count !== undefined && count > 0 && count === failures.size),
  };
}
```

Relevance: `observeTests` parses the JSON only from **stdout**; with `--outputFile` the report lives in a
file, so runner.ts must read `reportPath` itself. Suite-level collection failures (`assertionResults: []`,
`numFailedTests: 0`) yield `count = 0` → `complete` is false on non-zero exit, which is the safe outcome.

## Cleanup

`Get-CimInstance Win32_Process … | Where CommandLine -match 'omr-spikeC'` returned nothing after the last
run (no leftover node/python/pytest processes from the spike). The fixture dir `%TEMP%\omr-spikeC` is left
in place for re-runs; it is not part of the repo.

## Implementation notes (part 1)

Choices made where the runner.ts design header left room (safer option taken each time):

- Dedup of changed files keeps the first-seen spelling; the canonical path is always gitRoot + relative path, so drive-letter case follows gitRoot.
- vitest subcommands (run/watch/dev/related, bench/list/init/typecheck) are recognised only as the FIRST positional; later positionals are filters.
- A deleted pytest module whose content/name hits are all filtered away (missing, outside the root, or outside runnerCwd/path scopes) is S6 deleted-no-tests, not NoAffected.
- An unreadable pytest config file is ignored with the note `unreadable pytest config ignored: <path>` rather than aborting detection.
- The pytest config-derived cap also looks at PYTEST_ADDOPTS when the config text has none (can only lower the cap).
- NoAffected is returned before entry resolution, so a docs-only change passes even when the runner is not installed. planStaticScoping runs the entry and tmpdir-in-repo checks whenever something would be run, so those S6s are visible to the risk signal without a process.
- Notes not fixed by M: `npm options ignored: <tokens>`, `non-input files skipped: <n>`, `dropped a path containing a NUL byte`, `dropped a path starting with "-": <p>`, bad-bin details (`unreadable package.json <p>`, `package name is not "<pkg>"`, `no bin entry`, `bin escapes the package directory`, `bin is not a .js, .mjs or .cjs file`, `bin entry missing: <p>`).
- Config-trigger basenames are matched case-insensitively on win32.
- resolveEntry reports the venv-fallback note only through planScopedRun/planStaticScoping notes (ResolvedEntry has no notes field).

## Implementation notes (part 2)

Choices made where the runner.ts design header left room (safer option taken each time):

- Detection is shared with lint: `parseInvocation`/`detectImpl` take the accepted runner heads (`vitest`/`jest`/`pytest` for tests, `eslint` for lint), so a lint command such as `vitest`, `pytest` or `uv run pytest` gets the same `unsupported command` reason text as B would produce.
- planRerun finds the target tree's own git root from `cwd` (walking up to `.git`), so a reference worktree gets `gitRoot`/`cwd` of that tree and cwd-relative ids that compare equal. Test files must be absolute and inside that root; others are dropped with `rerun file dropped (relative or outside the git root): <f>`, missing ones with `rerun file missing in this tree: <rel>`. The tmpdir-in-repo check is repeated for the target tree. The runner's detection notes are not copied into the rerun spec.
- planRerun without `deps.entry` resolves the entry from the target tree (a reference worktree without node_modules -> S6 runner-not-installed); 2.1 passes the current tree's entry.
- readResult: a reportPath failing the N.4 guard is neither read nor deleted; the result is the text fallback with note `report path rejected: <path>` (complete false). Text fallback after a non-zero exit adds the note `runner exited <code> without a usable report`.
- JSON: `numRuntimeErrorTestSuites > 0` is honoured for any JSON report (vitest never sets it). Suites without a string `name` are skipped; `numTotalTests` missing gives `total: undefined`.
- junit: the report is usable only when it contains `</testsuites>` (truncation check). pytest exit 5 counts as a clean exit (no "exited but no failure" note). A collection pseudo-case whose module maps to no input keeps its raw dotted name as id and makes the result incomplete. Priority of notes: exit 4, exit 3, unmapped classname, then the generic "exited but lists no failure".
- Lint: `[]` changed files -> NoAffected "no changed lintable files". An unknown eslint version counts as < 9 (no `--no-warn-ignored`, and `--max-warnings` -> Unscoped). `--concurrency off` is kept verbatim and emits no cap. Argv over MAX_ARGV_CHARS -> Unscoped `too many inputs for one command line: <n> files`. Extension matching is case-insensitive.

## QA findings (round 1)

Reviewed `git diff 5e393dc..495a57f`. Unit tests: `npx vitest run --maxWorkers=2 test/unit/runner.test.ts test/unit/deterministic.test.ts`
gave `Test Files 2 passed (2)`, `Tests 306 passed (306)`.

Method: runner.ts and deterministic.ts were bundled with rolldown into `%TEMP%\omr-qa13` and driven with the real fs.
Each spec was spawned the way an ArgvSeam would spawn it (`spawnSync(spec.file, spec.args, {shell: false, env: {...process.env, ...spec.env}})`),
and every run went through `readResult`. The runners were real: vitest 4.1.11, jest 30.5.2, and pytest 9.1.1 with
xdist 3.8.0 from the Spike C venv. The fixtures were copies of the Spike C projects, each with its own `git init`.
In the output below, `<Q>` is `C:\Users\Marquinho\AppData\Local\Temp\omr-qa13`, the long spelling of the path, and
`<R>` is the report path. On this host, `os.tmpdir()` is `C:\Users\MARQUI~1\AppData\Local\Temp`, which is an 8.3 short
name. The scratch directory, its junctions and the reports left by the probes were removed afterwards. A final check
found 0 `omr-verify-*` files and no processes still running.

| id | severity | summary and evidence | fix |
|---|---|---|---|
| QA-1.3-1 | critical | **jest runs 0 tests, and the adapter reports a pass, when cwd is not the realpath.** This happens with an 8.3 short name (the default `os.tmpdir()` here) or with a junction or symlink. jest applies realpath to `rootDir`, so the lexical `--findRelatedTests`/`--runTestsByPath` paths match nothing. `--passWithNoTests` then exits 0, and `readResult` returns `complete: true, total: 0`. Q.2.1 treats that as green. In this repro, `src/str.js` breaks `str.test.js`. Output: `jest-proj 8.3 exit=0 total=0 failingIds=[] complete=true` compared with `jest-proj long exit=1 total=2 failingIds=["test/str.test.js > str > bad"]`. Through a junction: `scoped junction exit=0 total=0 failingIds=[] complete=true` and `rerun junction exit=0 total=0 ...`. vitest and pytest give the same ids from either spelling. | Add `realpath` to the fs seam. Canonicalize `gitRoot`, `runnerCwd`, the spec `cwd` and every input through it before G.4, and run the rest of the pipeline on those real paths. As a second guard in `readResult`, set `complete = false` when `mode === "rerun"` and total is 0 (the inputs are test files), and when jest `related` input includes a test file (`JS_TEST_RE`) but total is 0. Add a unit test that uses a junction or alias fs, and a 3.1 fixture that runs through a junction. |
| QA-1.3-2 | major | **Options that cut the run short are kept, and the partial inventory is reported as complete.** These are pytest `-x`/`--exitfirst`/`--maxfail` (KEEP) and vitest `--bail` and jest `--bail`/`-b` (KEEP). For S2, a new failure can hide behind a pre-existing one, so the id sets compare equal. pytest output: `exit=1 total=1 failingIds=["tests/test_a.py::test_pre_existing"] complete=true`; the same files without `-x` give `failingIds=[..."test_pre_existing","tests/test_str.py::TestStr::test_bad"]`. vitest output: `[vitest run --bail 1] ... failingIds=["test/a.test.js > pre"] complete=true`; without `--bail` it gives `["test/a.test.js > pre","test/str.test.js > str > bad"]`. | Move `-x --exitfirst --maxfail` (pytest) and `--bail` / `--bail -b` (vitest, jest) to DROP, with the note `early-exit option dropped for a full failure inventory`. If they must stay, set `complete = false` whenever one of them is present. The S2 comparison that depends on this belongs to 2.1. |
| QA-1.3-3 | major | **The xdist worker cap (S4) is bypassed in three ways.** In each, `spec.workers=null` and no `-n` appears. PYTEST_XDIST_AUTO_NUM_WORKERS does not override a numeric `-n` (Spike C). The run was checked with a probe test that asserts on `PYTEST_XDIST_WORKER_COUNT`. (a) `cross-env PYTEST_ADDOPTS="-n 3" pytest` in a script. Only `host.pytestAddopts` is scanned, not `det.env`. Result: `budget=2 spec.workers=null '-n' in args=false -> run under WORKERS=3`. (b) Grouped short flags. `pytest -qn3` gives `keptArgs=["-qn3"] xdist=false`, and the run was `WORKERS=3`. (c) Config discovery does not follow pytest's rules. It misses `.pytest.ini`, and `pytest.toml` (pytest 9). It also stops at the nearest directory that holds any config file, even a `pyproject.toml` without a pytest table that pytest itself skips. All three runs were `WORKERS=3`. The control case (`pytest.ini`) was detected and ran with `WORKERS=2`. | (a) Scan `det.env.PYTEST_ADDOPTS` together with `host.pytestAddopts` for XDIST_RE, XDIST_VALUE_RE and COV_RE. (b) Expand grouped short options with argparse rules (`-qn3` becomes `-q -n3`) before D.1, or return S6 for a grouped token that contains `n` or `p`. (c) Follow pytest's inifile search. Start from the common ancestor of the args. Check `pytest.toml`, `.pytest.toml`, `pytest.ini`, `.pytest.ini`, `pyproject.toml` (only with `[tool.pytest.ini_options]` or `[tool.pytest]`), `tox.ini` (only with `[pytest]`) and `setup.cfg` (only with `[tool:pytest]`). Honour `-c`, `--config-file` and `--rootdir`. |
| QA-1.3-4 | major | **pytest config triggers miss `.pytest.ini` and `pytest.toml`/`.pytest.toml`.** A change to either one passes without running anything. Output: `changed .pytest.ini -> {"noAffected":true,"note":"no affected tests: no changed file is a test input"}` and the same for `pytest.toml`. The trigger list follows plan section 1.5-3 "exactly", so the gap is in the plan. | Add `.pytest.ini`, `pytest.toml` and `.pytest.toml` to `TRIGGERS.pytest` and the M/G.7 docs. Record this as a plan amendment to section 1.5-3. |
| QA-1.3-5 | major | **A config file passed with `--config`/`-c` is not a trigger.** This affects vitest, jest and eslint, plus pytest `-c`/`--config-file`. The repro command was `vitest run --config cfg/unit.config.mjs`. The change added a throwing `setupFiles` to `cfg/unit.config.mjs`. The adapter output was `["cfg/unit.config.mjs"] -> ScopedSpec; exit=0 total=0 failingIds=[] complete=true`. The user's own command fails: `exit=1; Test Files 1 failed (1)`. | After D, resolve the values of the config options (vitest `--config -c`, jest `--config -c`, pytest `-c --config-file`, eslint `-c --config`) against runnerCwd. Add them to the trigger set by `key()` of the canonical path. |
| QA-1.3-6 | major | **npm location flags are "ignored", so the wrong package's script runs.** `npm test -w packages/app` resolves the root `scripts.test`. The adapter output was `args: related <Q>\mono\packages\app\src\a.js --dir scripts --run ...` with `notes: ["npm options ignored: -w packages/app"]`, then `exit=0 total=0 failingIds=[] complete=true`. The real `npm test -w packages/app` gives `exit=1; Tests 1 failed (1)`. | Return S6 `unsupported-command "npm -w"` (and the same for `--workspace`, `--workspaces`, `-ws`, `--prefix`, `--include-workspace-root`) wherever they appear. Or resolve the named workspace's package.json. Only options known to be harmless should be "ignored". |
| QA-1.3-7 | minor | **Win32 spellings of an in-repo path are dropped as outside the root.** A config trigger can then be bypassed, and the result is a pass. Changed paths come from the producer's own `filePath` tool arguments (`dispatch.ts` `extractChangedFile`), so the producer controls how they are spelled. Output: `vitest \\?\<Q>\vitest-proj\vitest.config.mjs -> {"noAffected":true,...}` and `pytest \\?\<Q>\pytest-proj\conftest.py -> {"noAffected":true,...}`. The canonical spelling gives `config-changed`. (8.3 aliases of new files could not be reproduced on this volume, because short-name generation is off for new files.) | In G.3, strip the `\\?\` and `\\.\` prefixes, then canonicalize through the realpath seam from QA-1.3-1. When a non-empty change set has every candidate dropped as outside, return S6 `attribution-unavailable` instead of NoAffected. |
| QA-1.3-8 | minor | **A lockfile-only change is classified as non-input and passes.** Output: `jest, changed package-lock.json -> {"noAffected":true,"note":"no affected tests: no changed file is a test input"}`. A dependency upgrade that stays within range changes only the lockfile. | Treat `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock(b)`, `pnpm-workspace.yaml`, `.npmrc` and `.yarnrc.yml` as vitest/jest triggers (S6 config-changed) instead of non-input. |
| QA-1.3-9 | minor | **Lint scoping uses a fixed extension list, so files that the flat config lints are skipped.** Output: `eslint ., changed src/App.vue -> {"noAffected":true,"note":"no changed lintable files"}`. | For eslint >= 9, pass every existing changed file in scope. `--no-warn-ignored` is already added, so files the config does not match are ignored silently. Keep the extension filter only when `--ext` is present, or for eslint < 9. |
| QA-1.3-10 | minor | **Other spellings slip past the D tables.** yargs and cac accept kebab-case, and jest accepts grouped short flags. Rule g keeps the unknown spelling verbatim. Output: `"jest --update-snapshot" -> keptArgs=["--update-snapshot"]`, `"jest -ou" -> keptArgs=["-ou"]`, `--watch-all` and `--list-tests` also kept, and `"vitest run --merge-reports=.vitest-reports" keptArgs=[...]`. jest parses them as the dropped options: `jest -ou => onlyChanged: true updateSnapshot: all` (`--showConfig`). Snapshot rewriting is what DROP `-u` exists to stop. `--onlyFailures`/`-f` is in no table: `"jest -f" -> keptArgs=["-f"]`. In jest 30.5.2 here, `--only-changed` together with `--findRelatedTests` still ran the related tests (`exit=1 total=2`), so no vacuous run was shown for that flag. | Normalize option names before `matchArg`: kebab to camel for vitest and jest, and grouped short flags split for jest and pytest. Add `--onlyFailures -f` to jest DROP. It is also worth making rule g return S6 for vitest and jest, so unknown options fail closed. |
| QA-1.3-11 | minor | **A relative tmpdir puts the report inside the repo and leaves it there.** The tmpdir-in-repo check resolves against `process.cwd()`, but the runner resolves the relative report path against `spec.cwd`. Output: `os.tmpdir() with TEMP=tmp -> "tmp"`, `reportPath=tmp\omr-verify-0f3f7a40-....json`, `report files now inside the repo: ["omr-verify-0f3f7a40-...json"]; readResult source=text ...; still there after readResult: 1`. | Require `P.isAbsolute(host.tmpdir)` (otherwise S6 `tmpdir-in-repo`), and build R from `P.resolve(host.tmpdir)`. |
| QA-1.3-12 | minor | **`readResult` rejects instead of falling back when the junit report is malformed.** `decodeXml` calls `String.fromCodePoint` on `&#x110000;`, which gives `THREW: RangeError Invalid code point 1114112`. The `finally` block still unlinked the report (`J report left behind: false`). The contract says readResult always returns a result, with the text fallback. | Decode only code points in the ranges 0..0xD7FF and 0xE000..0x10FFFF; leave any other value as literal text. Also wrap `parseJunit`/`parseJestJson` in try/catch that falls back to `textResult`. |
| QA-1.3-13 | minor | **A pytest addopts positional turns the scoped run into a directory run.** addopts are prepended, so `addopts = tests` makes pytest collect all of `tests/`. Output: `inputs=1 (test_math.py only); exit=1 total=3 failingIds=["tests.test_str.TestStr::test_bad"] complete=false`. When the whole directory passes, the full suite runs and is reported green. | Tokenize addopts (config and both PYTEST_ADDOPTS sources) and return S6 `unsupported-argument` for any positional in it. |
| QA-1.3-14 | nit | **MAX_ARGV_CHARS ignores Windows quoting and the program path.** Output: `K sum(len+1)=29920 (<= 30000: true); spawn status=null error=ENAMETOOLONG`, with 1870 short paths containing spaces. The failure is still safe: a spawn error gives text fallback with `complete=false`. But N.9 is not met. | Count the quoted form: `+2` for an argument with a space or tab, doubled backslashes before quotes, and `file` plus separators. Or lower the cap to leave about 3 characters per argument of headroom. |
| QA-1.3-15 | nit | **A vitest `setupFiles` change runs the whole suite without saying so.** vitest adds setupFiles to forceRerunTriggers. Changing the config and `cfg/boom.js` ran every test file: `failingIds=["test/--config=evil.test.js","test/a b&c;$(x)%PATH%'é[1].test.js","test/a.test.js","test/math.test.js","test/str.test.js"]`. The outcome is correct but costs a full run. | Add this to section P next to forceRerunTriggers. QA-1.3-5 turns the explicit `--config` case into S6. |
| QA-1.3-16 | deferred by plan (2.1) | Reports are left behind whenever `readResult` is not called. The probes that skipped it left 11 `omr-verify-*.xml` files in `%TEMP%`, since removed. | 2.1 must call `readResult` on every path, including a spawn error, as Q.2.1 already says. Add a 2.1 test for that. |
| QA-1.3-17 | deferred by plan (2.1) | S2 and S5 correctness depend on `complete`, and on the rerun-mode `total === 0` rule from QA-1.3-1 and QA-1.3-2. | 2.1 must treat `complete === false` as not comparable. It must also treat a rerun with total 0 as reference unusable (unverifiable), not as a reference pass. |

### Resolutions (round 1)

Gates after the last fix: `npx vitest run --maxWorkers=2 --coverage --coverage.include=src/verify/runner.ts test/unit/runner.test.ts test/unit/deterministic.test.ts`
gave `Tests 504 passed (504)`, and runner.ts coverage of 99.16% statements, 97.46% branches (1076/1104), 100% functions and 99.79% lines. `npm run typecheck` was clean.
The real-runner repros used `runner.ts` bundled with rolldown into `%TEMP%\opencode\omr-qa131` and spawned with `shell: false`.

- QA-1.3-1 Resolution: 04721af — The planners take a `PlannerFs` (FsSeam plus an optional native `realpath`). cwd, gitRoot, runnerCwd, path scopes, changed files, rerun files and the tmpdir are canonicalized through it (G.3a). A spec planned without realpath carries `lexicalPaths: true`. `readResult` marks a complete zero-test report as `complete: false` for every rerun, for jest related runs given a test file, and for lexical jest specs (I step 2a). Real jest 30.5.2 on the Spike C `jest-proj`, with `src/str.js` changed, gave the same result from the long path, the 8.3 path (`C:\Users\MARQUI~1\...`) and a junction: `exit=1 total=2 failingIds=["test/str.test.js > str > bad"] complete=true` for both scoped runs and reruns. Without realpath, the 8.3 and junction runs still show `exit=0 total=0`, but now `complete=false`. 0 reports were left behind. A seam-level test with a real junction and `fs.promises.realpath` is in runner.test.ts.
- QA-1.3-2 Resolution: aabd59d — pytest `-x --exitfirst --maxfail`, vitest `--bail` and jest `--bail -b` are dropped with the note `early-exit option dropped for a full failure inventory`. Every pytest argv also ends its options with `--maxfail=0`, which overrides an `-x` from addopts. With pytest 9.1.1 and `addopts = -x`, the result was `1 failed` without it, and `2 failed` with it, both with and without `-n 2`. A `bail` set in a vitest or jest config file is a documented P residual.
- QA-1.3-3 Resolution: aabd59d (b) and 1592518 (a, c) — (a) The cross-env `PYTEST_ADDOPTS` is scanned together with the host value, and the cap comes from the value the spawn sees. (b) Grouped short flags are split the way argparse splits them (`-qn3` becomes `-q -n3`), and an unknown letter is S6. (c) The config file is found the way pytest 9 finds it: the `-c`/`--config-file` file alone, or else the first accepted file from pytest.toml, .pytest.toml, pytest.ini, .pytest.ini, pyproject.toml (only with a pytest table), tox.ini (only with `[pytest]`) and setup.cfg (only with `[tool:pytest]`), walking up to the filesystem root. `-o addopts=` replaces the file's addopts. The spec redoes the lookup from the common ancestor of its inputs. Addopts are parsed as ini or TOML and tokenized, so the regexes are gone. Real pytest 9.1.1 and xdist 3.8.0, with a probe that fails when `PYTEST_XDIST_WORKER_COUNT > 2`: cross-env, `-qn3`, `.pytest.ini`, `pytest.toml`, and a non-pytest pyproject.toml above pytest.ini each gave `args-n=2 exit=0 total=1 complete=true`.
- QA-1.3-4 Resolution: 559eb64 — `.pytest.ini`, `pytest.toml` and `.pytest.toml` are pytest triggers. Plan amendment: the section 1.5-3 trigger list gains these three names, and 3.2 must add a fixture for each.
- QA-1.3-5 Resolution: 559eb64 — The values of vitest/jest `--config -c`, pytest `-c --config-file` and eslint `-c --config` are resolved against runnerCwd, canonicalized (`DetectedRunner.configFiles`) and treated as config triggers: S6 `config-changed`, or Unscoped for lint.
- QA-1.3-6 Resolution: aabd59d — Between the script name and `--`, npm accepts only `-s --silent -q --quiet -d --if-present --ignore-scripts --color[=v] --no-color --loglevel=v`; any other token is S6 `unsupported command "npm <token>"`. For pnpm, yarn and bun, a location option after the script name (`-w -ws -C -F -r -g --workspace(s) --include-workspace-root --workspace-root --prefix --dir --cwd --filter --recursive --global`) is S6, unless a `--` comes first.
- QA-1.3-7 Resolution: 04721af — The win32 prefixes `\\?\`, `\\.\` and `\\?\UNC\` are stripped, and paths go through realpath (QA-1.3-1). The trigger check also looks at the basename as it was spelled before realpath. A non-empty change set with every path dropped is S6 `attribution-unavailable` ("change attribution unavailable: no changed path lies inside the git root"), or Unscoped for lint.
- QA-1.3-8 Resolution: 559eb64 — The JS lockfile and workspace files (`package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock(b)`, `pnpm-workspace.yaml`, `.npmrc`, `.yarnrc(.yml)`, `.pnpmfile.cjs`) are vitest, jest and eslint triggers. `uv.lock`, `poetry.lock`, `pdm.lock`, `Pipfile.lock` and `requirements*.txt` are pytest triggers. Lockfiles are no longer non-inputs.
- QA-1.3-9 Resolution: 559eb64 — eslint 9 or later gets every existing changed file in scope, and `--no-warn-ignored` silences the ones it ignores. The extension filter applies only to eslint before 9 or an unknown version. The entry is resolved before filtering.
- QA-1.3-10 Resolution: aabd59d — vitest and jest options are compared in camelCase (`--update-snapshot`, `--watch-all`, `--list-tests`, `--merge-reports`, `--max-workers`, ...). Grouped short flags are split per parser: mri for vitest, yargs for jest (`-ou`), argparse for pytest. Groups the adapter cannot model are S6, including jest `-cjest.config.js`, which yargs reads as `-c -j -e -s -t=.config.js`. `--onlyFailures -f` is in jest DROP. An unknown vitest or jest option is S6 `unsupported-argument`.
- QA-1.3-11 Resolution: 04721af — A relative `host.tmpdir` is S6 `tmpdir-in-repo` ("temp dir is not an absolute path: <tmpdir>"). A tmpdir inside the repo after realpath is S6. The report path is built from `P.resolve(tmpdir)`. `readResult` reads and unlinks only an absolute report path in an absolute tmpdir.
- QA-1.3-12 Resolution: 04721af — Numeric character references outside 0..0xD7FF and 0xE000..0x10FFFF stay literal. A parser exception falls back to text with `report could not be parsed: <message>`. The report is still unlinked, and readResult never rejects.
- QA-1.3-13 Resolution: 1592518 — Addopts from the config, `-o addopts`, the cross-env value and the host `PYTEST_ADDOPTS` go through the D.4 table in "addopts" mode. A positional is S6 `unsupported pytest argument "<p>" in addopts of <file>` (or `in PYTEST_ADDOPTS`, `in -o addopts`), and so is an unknown option's value that names an existing path. The real-pytest repro with `addopts = tests` gave S6 before any spawn.
- QA-1.3-14 Resolution: 04721af — The length check counts the program path plus every argument as libuv quotes it on win32: +2 for a space, tab or quote, doubled backslashes before a quote and at the end, and `""` for an empty argument. MAX_ARGV_CHARS stays 30000.
- QA-1.3-15 Resolution: 559eb64 — Conventional vitest and jest setup-file names that are not test files (`setup.ts`, `vitest.setup.ts`, `setupTests.ts`, `global-setup.ts`, `jest.setupAfterEnv.js`, ...) are config triggers. Section P documents the rest: vitest's setupFiles forced rerun under other names, correct but at full cost, and jest's blind spot. `--config` files are covered by QA-1.3-5.
- QA-1.3-16, QA-1.3-17: deferred by plan to 2.1, unchanged. QA-1.3-1 already added the zero-test guard that QA-1.3-17 relies on (I step 2a).
- Superseded implementation notes: part 1, "The pytest config-derived cap also looks at PYTEST_ADDOPTS when the config text has none", is replaced by the pytest order D.4 now follows (config addopts, then PYTEST_ADDOPTS, then the command, last cap wins). Part 2, "Extension matching is case-insensitive", now applies only to eslint before 9.

Checked, no finding:
- `runner.ts` never imports `child_process`. `rg child_process src/verify/runner.ts` matches only comment lines 12 and 548.
- `spec.file` is only ever `host.execPath`, `<absolute PATH dir>\pytest.exe|uv.exe`, or the `.venv` pytest. `onPath` appends `.exe`, so a `.cmd`/`.bat` shim is never chosen, and relative PATH entries are skipped. npx, pnpm, yarn and bun are parsed only.
- Injection through file names was tested with real runs. vitest and jest were given `test/a b&c;$(x)%PATH%'é[1].test.js` and `test/--config=evil.test.js`. Each stayed a single argv element, so nothing was interpreted and no option was injected. vitest ids: `test/--config=evil.test.js > dash` and `test/a b&c;$(x)%PATH%'é[1].test.js > meta`. jest listed the metachar file as a failed suite (a bare file id); that is still a failure, never a pass. jest and pytest get `--` before the files, and vitest never does.
- An 8.3 cwd gives the same result as the long path for vitest and pytest (`exit=1 total=2 failingIds=[...]`).
- Worker caps: `--maxWorkers=abc`, `0`, `-1`, `99999999999999999999` and `150%` all fall back to the budget with a note. `jest -w4`, `-w=16` and `--max-workers=8` all give `--maxWorkers=2`. `pytest -n auto` gives `-n 2`. `pytest.ini addopts -n 3` ran with `WORKERS=2`. The adapter flag appears exactly once.
- uv allowlist. Refused with and without `uv` on the user allowlist: `uv run --with x pytest`, `uv run -- python -c x`, `UV run python -c x`, `uv.EXE run python x.py`, `uv.com run python x.py`, `uvx pytest`, `uv tool run pytest`. Allowed: `uv run pytest -q`, `C:\x\uv run pytest` (a basename rule, as for every allowlisted tool), and `uv run pytest --with evil`, where `--with` is a pytest argument (usage error).
- Report guard. A `reportPath` pointing at a repo file, a non-UUID temp name, or a path that escapes with `..` is rejected (`report path rejected: ...`), and it is neither read nor unlinked. The report is unlinked in `finally` even when parsing throws. vitest `--output-file=inrepo.json` (kebab): the adapter's later `--outputFile` wins, and no file appeared in the repo.
- Truncated or malformed JSON and XML fall back to text with `complete=false` (unit tests). The junit parser works at regex level and expands no DTD or custom entities (no XXE).
- Identities: pytest `tests/test_str.py::TestStr::test_bad` and vitest/jest `test/str.test.js > str > bad` are cwd-relative. They match between the report and the text formats.

Not verified here (3.1 must cover):
- `host.execPath` defaults to `process.execPath`. The plan assumes this is a Node binary. Nothing in the repo shows which runtime the opencode plugin host uses; if it is Bun or a compiled binary, the spec runs the wrong program. 3.1 should spawn one spec from inside opencode.
- `uv run pytest` in a fresh reference worktree may sync the project environment (creating `.venv`, network access).
