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
