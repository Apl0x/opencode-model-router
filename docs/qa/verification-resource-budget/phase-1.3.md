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

## QA re-review (round 2)

Date: 2026-09-27. Reviewed `git diff d3ae209..bd6c2b1`: runner.ts +842/-152, runner.test.ts +699/-24, this file +24. Unit gate, run once:
`npx vitest run --maxWorkers=2 test/unit/runner.test.ts test/unit/deterministic.test.ts` gave `Test Files 2 passed (2)`, `Tests 504 passed (504)`.

Method: runner.ts was bundled with rolldown 1.2.5 into `%TEMP%\omr-qa13r2` (called `<W>` below, long spelling
`C:\Users\Marquinho\AppData\Local\Temp\omr-qa13r2`; 8.3 spelling `C:\Users\MARQUI~1\...`). It was driven under **node v24.21.0 and
bun 1.3.14**. The real fs was used in two forms: a PlannerFs with `fs.promises.realpath`, and a lexical one without realpath. The search
seam used real `git ls-files` / `git grep`. Specs were spawned with `spawnSync(spec.file, spec.args, {shell: false})`, and every run went
through `readResult`. The runners were vitest 4.1.11, jest 30.5.2, pytest 9.1.1 with xdist 3.8.0 (the Spike C venv), and uv venvs with
pytest 7.0.1/xdist 2.5.0, 7.4.4/3.5.0 and 8.0.0/3.5.0, plus eslint 9.39.5 and npm 12.0.2. The fixtures were copies of the Spike C
projects, each with its own `git init`, plus junction aliases (`jlink`, `vlink`, `plink`).

### Verification of the round-1 resolutions

| id | verdict | evidence |
|---|---|---|
| QA-1.3-1 | verified (with realpath) | jest from the long path, the 8.3 path and a junction, scoped and rerun: 6/6 runs gave `exit=1 total=2 failingIds=["test/str.test.js > str > bad"] complete=true`. Without realpath, jest from 8.3 and from a junction gave `exit=0 total=0 complete=false` with the notes `jest ran no tests and the paths were not canonicalized (no realpath seam)` and `rerun ran no tests although every input is a test file`. Deleted files (the ENOENT walk-up) work: `src/newdir/deeper/gone.js` keeps rel `src/newdir/deeper/gone.js` from all three spellings. With `src/str.js` really deleted and the plan made through the junction: `inputs=["<W>\jest-proj\test\str.test.js"]`, and jest gave `exit=1 failingIds=["test/str.test.js"] collectionError=true`. Under bun, `fs.promises.realpath` behaves like node: the 8.3 name is expanded, the junction is resolved, a missing path gives ENOENT, `\\?\` input is accepted and `::$DATA` maps to the file. Gaps: QA-1.3-18 (jest under bun) and QA-1.3-19 (vitest without realpath). |
| QA-1.3-2 | verified | pytest 7.0.1, 7.4.4, 8.0.0 and 9.1.1 were each run with addopts `-x`, addopts `-x -n 2`, addopts `--maxfail=1`, command `-x` and command `--exitfirst -n 2`. All 20 runs gave `failingIds=["tests/test_a.py::test_pre_existing","tests/test_b.py::test_new"] complete=true`. The same argv without `--maxfail=0` stops at `1 failed` for the addopts cases (control), so the flag works on pytest 7 and 8 and with xdist 2.5 to 3.8. With a real pre-existing failure: vitest `run --bail 1` and `jest --bail` both gave `total=3 failingIds=["test/pre.test.js > pre","test/str.test.js > str > bad"]`. |
| QA-1.3-3 | verified for the reported vectors | Probe: `assert PYTEST_XDIST_WORKER_COUNT <= 2`. These all gave `adapter -n 2, workers=2 -> exit=0`: cross-env `PYTEST_ADDOPTS="-n 3"`, `-qn3`, `.pytest.ini`, `pytest.toml` (array addopts), a non-pytest `tests/pyproject.toml` below `pytest.ini`, host `PYTEST_ADDOPTS`, `setup.cfg`, `tox.ini`, pyproject `[tool.pytest.ini_options]`, `-o "addopts=-n 3"`, `-c cfg/x.ini`, `tests/pytest.ini` (spec-time lookup), and a `pytest.ini` in the parent directory of the repo. A string addopts in `pytest.toml` is rejected by pytest 9.1.1 itself (`config option 'addopts' expects a list for type 'args', got str`), and the user's own command fails the same way. New bypasses: QA-1.3-20 and QA-1.3-21. |
| QA-1.3-4 | verified | `.pytest.ini`, `pytest.toml` and `.pytest.toml` each gave `S6 config-changed`. |
| QA-1.3-5 | verified | The round-1 repro (`vitest run --config cfg/unit.config.mjs` with a throwing `setupFiles`) gave `{"unverifiable":true,"code":"config-changed","reason":"config file changed: cfg/unit.config.mjs"}` before any spawn. `npx jest --config cfg/jest.cfg.js`, `pytest -c cfg/x.ini` and `pytest --config-file=cfg/x.ini` gave S6, and eslint `-c cfg/eslint.cjs` (via `npm run lint`) gave `{"unscoped":true,"reason":"eslint config changed: cfg/eslint.cjs"}`. |
| QA-1.3-6 | verified (command-line flags) | S6 `unsupported-command`: `npm test -w packages/app`, `--workspace=`, `npm -w … test`, `--workspaces`, `-ws`, `--prefix`, `--include-workspace-root`, `npm run test -w=…`, `npm test src/app.ts`, `pnpm test --filter`, `pnpm --filter … test`, `pnpm -r test`, `pnpm test -C`, `yarn workspace app test`, `yarn test --cwd`. `bun run --filter app test` gives S6 `no-script`. The harmless list, checked against real npm 12.0.2: `-s -q -d --if-present --ignore-scripts --color=always --no-color --loglevel=warn` each still ran the root `scripts.test`, and `--ignore-scripts` only skips `pretest`, which the adapter does not run either. `--loglevel warn` (two tokens) fails closed. New gap through `.npmrc`: QA-1.3-24. |
| QA-1.3-7 | verified | These all gave `S6 config-changed`: `\\?\<W>\mono\vitest.config.mjs`, `//?/C:/…/vitest.config.mjs`, `\\.\…\package-lock.json`, `\\?\C:\USERS\…\PNPM-LOCK.YAML`, and the 8.3 spelling of `vite.config.ts`. All candidates outside the root, or only a NUL path, gave `S6 attribution-unavailable`. The ADS spelling `conftest.py::$DATA` writes to `conftest.py` under node and bun, and with realpath it gives `config-changed: conftest.py`. A trailing dot or space (`conftest.py.`) creates a literal file under node 24 and bun 1.3.14. pytest does not load that file (the real run gave exit 0), so NoAffected is correct there. |
| QA-1.3-8 | verified | The JS lockfiles and workspace files (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `bun.lockb`, `.npmrc`, `.yarnrc.yml`, `pnpm-workspace.yaml`, `.pnpmfile.cjs`) give config-changed, and so do `uv.lock`, `poetry.lock` and `requirements-dev.txt`. Gap: QA-1.3-23. |
| QA-1.3-9 | verified | Real eslint 9.39.5, running `npm run lint` = `eslint . --max-warnings 0`. With `ok.js`, `App.vue`, `README.md`, `ignored.js` (config-ignored) and `data.json` changed, all 5 were passed and the run gave `exit=0`, no output. With `a.js` and `App.vue`: `exit=1`, only the `a.js` `no-unused-vars` error. The results were the same with the spec running under bun.exe. |
| QA-1.3-10 | verified | `jest --update-snapshot`, `-ou`, `--watch-all`, `--list-tests`, `-f`, `--only-failures`, `vitest run --merge-reports=.r`, `vitest -uw` and `--update` all give `kept=[]`. `jest -w4`, `-iw4` and `--max-workers=8` give a cap. `jest -cjest.config.js`, `vitest run -cfoo` and `vitest run --fileParallelism false` give S6. The rate of S6 from unknown options is measured below: 2 of 20 commands. |
| QA-1.3-11 | verified | `tmpdir` of `"tmp"` or `".\tmp"` gives `temp dir is not an absolute path`. An in-repo tmpdir, spelled lexically or 8.3, gives `temp dir is inside the repository`. The default host with `TEMP=tmp` gives `os.tmpdir()="tmp" -> S6 tmpdir-in-repo` (node and bun). |
| QA-1.3-12 | verified | `&#x110000;`, `&#xD800;` and `&#99999999999999999999;` stay literal, `readResult` does not reject, and the report is unlinked (`reportLeft=false`). `&#x1F600;` decodes. Truncated XML or JSON gives the text fallback with `complete=false`. |
| QA-1.3-13 | verified | `addopts = tests`, `PYTEST_ADDOPTS=tests`, `PYTEST_ADDOPTS="-x tests/test_a.py"` and cross-env `PYTEST_ADDOPTS=tests` give S6 before any spawn. Common addopts still plan: `-ra -q --strict-markers`, `--doctest-modules`, `--ds myproj.settings`, `-m "not slow" --tb=short`, `--cov=src --cov-report=term-missing` (which adds `--no-cov`), `--ignore tests/x -p no:warnings`, and `-n auto --dist loadscope` (which gives `-n 2`). `--ds tests`, an unknown option followed by an existing path, is S6 by design. |
| QA-1.3-14 | verified | Test set: 1500 files named `<W>\argv\a dir with spaces\file name with spaces NNNN.txt`. The adapter's largest accepted n was 282 (vitest rerun) and 283 (pytest); n+1 gave `argv-too-long`. The real spawns of those specs succeeded (exit 0 and exit 5). A real spawn with the same argv shape first failed at n=312 and n=313 with `ENAMETOOLONG`. The ratio, 1.106, matches 32767/30000, so the libuv quoting count is accurate. Identical under bun. |
| QA-1.3-15 | verified | `vitest.setup.ts`, `setupTests.ts`, `test/setup.ts`, `global-setup.ts` and `jest.setup.js` give `S6 config-changed`. It is over-broad: QA-1.3-28. |

### Answers to the round-2 questions

- `--maxfail=0` on every pytest argv: it breaks nothing. pytest 7.0.1 through 9.1.1, with xdist 2.5.0, 3.5.0 and 3.8.0, accept it and run every test (QA-1.3-2 row). A `-x` in the user's own command is dropped with the early-exit note, and the run goes to completion (`cmd -x: … 2 failed`). The pass/fail outcome is unchanged: any failure still fails. The cost is the time spent past the first failure.
- pytest config discovery up to the filesystem root: this is acceptable, because it reads what pytest reads. The walk calls `dirname` on the lexical path and probes seven fixed names per directory, and no user input reaches a path, so there is no traversal and no symlink loop. The one exception is `-c`/`--config-file`, which pytest also reads. A parent `pytest.ini` with `addopts = -n 3` was capped (`-n 2`, exit 0), and a parent positional addopts gave S6, exactly as pytest reads them. A directory named `pytest.ini` is skipped, as pytest skips it, with the note `unreadable pytest config ignored: …`. A 100 MB `pyproject.toml` with no pytest table in the parent directory cost 391 ms of planning.
- Unknown vitest/jest options are now S6. Of 20 realistic commands, **2/20** are unverifiable: `vitest run --pool=forks --poolOptions.forks.singleFork` (a vitest 1-3 idiom and a worker knob, so S6 is correct) and `jest --testLocationInResults` (vscode-jest). The 18 that plan are: `vitest run --reporter=dot`, `--silent`, `--passWithNoTests`, `--coverage`, `--project unit`, `--environment jsdom`, `--silent=passed-only --reporter=verbose`, `--coverage.enabled --coverage.reporter=lcov --reporter=junit --outputFile=junit.xml` and `--no-file-parallelism --typecheck`; and `jest --ci --runInBand`, `--ci --coverage --maxWorkers=50%`, `--watchAll=false`, `--detectOpenHandles --forceExit`, `--ci --reporters=default --reporters=jest-junit`, `--selectProjects unit`, `--passWithNoTests --silent`, `--env=jsdom --testTimeout=10000` and `--ci --logHeapUsage --no-cache`. Other spot checks gave S6 (not counted in the 20): `jest --no-colors`, `--notify`, `--no-watchAll`, and `vitest run --dangerouslyIgnoreUnhandledErrors`.
- lexicalPaths without realpath: jest is guarded, but vitest is not (QA-1.3-19).
- realpath and deleted files: handled (QA-1.3-1 row).
- npm harmless options: verified against real npm (QA-1.3-6 row).
- Performance: planning is linear, at about 0.4 ms per file with realpath. `planStaticScoping` over 1250, 2500 and 5000 existing sources took 472, 1310 and 1950 ms. With 5000 files, node took 2.0 to 3.2 s with realpath and 0.07 to 1.2 s without it; bun took 2.7 to 4.2 s with realpath and 0.45 to 1.8 s without it. The number of process-backed searches has no bound (QA-1.3-26), and parsing a junit report is superlinear (QA-1.3-25).
- Bun: realpath, `os.tmpdir()` (`C:\Users\MARQUI~1\AppData\Local\Temp`), `os.availableParallelism()` (16) and `process.platform` all match node. The planner output for the whole QA-1.3-4..13 sweep was identical: 119 lines, 0 differences after masking UUIDs. `process.execPath` differs (QA-1.3-18).

### New findings (round 2)

| id | severity | summary and evidence | fix |
|---|---|---|---|
| QA-1.3-18 | major | **Under Bun, the default `host.execPath` is not node, and jest fails every suite.** The plugin runtime is Bun. `process.execPath` is `C:\Users\Marquinho\.bun\bin\bun.exe` under `bun`. A `bun build --compile` binary reports itself (`{"execPath":"<W>\ep.exe","bun":"1.3.14"}`), so inside a compiled opencode the spec would launch opencode. jest 30.5.2 under bun.exe gives `Test suite failed to run TypeError: Attempted to assign to readonly property. at getMockedModuleClass (…jest-runtime/build/index.js:4082:6)`. Result: `bun 1.3.14 spec.file=bun.exe changed src/math.js: exit=1 total=0 failingIds=["test/math.test.js"] collectionError=true complete=true`. Under node the same plan gives `exit=0 total=1 failingIds=[] complete=true`. Every jest check is therefore a false failure. Worse, in S2 both trees produce the same bare-file ids with `complete=true`, so a new failure inside an already listed file cannot be told apart. vitest 4.1.11 and eslint 9.39.5 ran correctly under bun.exe, and pytest is a native exe. | 1.3: do not default to `process.execPath`. Resolve an absolute `node`/`node.exe` from absolute PATH entries, the way F resolves pytest. If none is found, return S6 `runner-not-installed "node"`. Let 2.1 pass `host.execPath` explicitly, and add a unit test with a Bun-like host. 3.1 still spawns one spec from inside opencode (the round-1 "not verified" item now has evidence). |
| QA-1.3-19 | major | **Without realpath (lexical mode), vitest through a junction is a false pass.** Changed `src/str.js`: `vitest junction no-realpath scoped: exit=0 total=0 failingIds=[] complete=true`; with realpath: `exit=1 total=2 failingIds=["test/str.test.js > str > bad"]`. Changed test file: `vitest junction no-realpath, changed test/str.test.js: exit=0 total=0 failingIds=[] complete=true`. The scoped `src/str.js` case gives the same result under bun. The 8.3 cwd is fine for vitest (`exit=1 total=2`). I step 2a applies both the `lexicalPaths` rule and the "related given a test file" rule to jest only. Lexical mode also misses ADS spellings: `conftest.py::$DATA` and `pytest.ini::$DATA` give NoAffected without realpath and config-changed with it. `realpath` is optional in `PlannerFs`, so passing a plain FsSeam compiles. | 1.3: make `realpath` required in the planner inputs, or return S6 when it is absent. At a minimum, extend step 2a to vitest: `lexicalPaths` with total 0 gives incomplete, and `related` given a JS test file with total 0 gives incomplete. Add a junction unit test for vitest. |
| QA-1.3-20 | minor | **The worker cap is bypassed through TOML that the regex parser does not model.** pytest 9.1.1 reads each of these, but the adapter sees no addopts and appends no `-n`. Each gave `adapter no -n, workers=null -> exit=1 WORKERS=3`: a top-level dotted key `tool.pytest.ini_options.addopts = "-n 3"`; `[tool]` + `pytest.ini_options.addopts = …`; the quoted key `"addopts" = "-n 3"` under `[tool.pytest.ini_options]`; and the inline table `[tool.pytest]` `ini_options = { addopts = "-n 3" }`. | 1.3: fail closed. Return S6 unsupported-argument when a TOML candidate contains `addopts` (or a `pytest` key path) that the parser did not attribute, or use a real TOML parser. Add these four shapes to the unit tests and the 3.2 fixtures. |
| QA-1.3-21 | minor | **The config lookup follows pytest 9's names only.** pytest 8.0.0 ignores `pytest.toml` and pytest 7.0.1 ignores `.pytest.ini`, so older pytest reads the next file, which the adapter never looks at. `pytest.toml` + `pytest.ini(-n 3)` under pytest 8.0.0 gave `adapter no -n -> WORKERS=3`. `.pytest.ini` + `tox.ini(-n 3)` under pytest 7.0.1 gave `adapter no -n -> WORKERS=3`. Control: the same files under 9.1.1 gave `WORKERS<=2`. | 1.3: when the chosen file is one that older pytest versions ignore (`pytest.toml`, `.pytest.toml`, `.pytest.ini`), also read the file those versions would pick. Take the union of the xdist and cov evidence and the lowest cap. A false xdist hit only costs exit 4, which is unverifiable. |
| QA-1.3-22 | minor | **When the inputs are not under the rootdir, a green pytest run becomes a collection error.** This happens with `-c`/`--config-file` in another directory, and likewise with `--rootdir`. pytest writes `classname=""` for tests outside its rootdir. `pytest -c cfg/x.ini` gave `exit=0`, `<testcase classname="" name="test_workers" …/>` and `{"ids":["test_workers"],"complete":false,"note":"pytest classname not mapped to a test file: test_workers"}`, with collectionError true. The user's own `pytest -c cfg/x.ini` gave `1 passed`. It fails closed, but every such run is unverifiable. The rule predates this diff. | 1.3: count `classname=""` as a collection case only when it has an `<error message="collection failure">` child. When `-c`, `--config-file` or `--rootdir` puts the rootdir outside the common ancestor of the inputs, return S6 unsupported-argument with a clear reason instead of a run that is certain to be incomplete. |
| QA-1.3-23 | minor | **Python dependency files outside the trigger regex pass without a run** (the same class as QA-1.3-8). `requirements/base.txt`, `constraints.txt` and `Pipfile` give `NoAffected: no affected tests: no changed file is a test input`. `setup.py` is treated as a module (`scopable pending=1`) and usually ends as `no tests named`, then NoAffected. | 1.3: add to `TRIGGERS.pytest` any `*.txt` or `*.in` under a `requirements` directory, `constraints*.txt`, `Pipfile` and `setup.py`. |
| QA-1.3-24 | minor | **npm config redirects `npm test` to another workspace** (the same outcome class as QA-1.3-6). With `.npmrc` `workspace=packages/app`, plain `npm test` ran `app-test` (npm 12.0.2); so did `npm_config_workspace=packages/app` in the env. The adapter planned the root script: `ScopedSpec cwd=<W>\npmrc args=["related","…\packages\app\src\a.js"] notes=[]`. `.npmrc` is only a trigger when it changes. | 1.3: for npm scripts, return S6 when a project `.npmrc` (runnerCwd up to gitRoot) sets `workspace`, `workspaces`, `prefix` or `include-workspace-root`, or when the matching `npm_config_*` variable is in the host env or cross-env. The user and global npmrc go to P as a residual. |
| QA-1.3-25 | minor | **Parsing a junit report can block the plugin's event loop.** readResult runs in-process with no timeout. The classname-to-file mapping costs inputs x path depth x failing cases: `junit 700 inputs x 5000 failing testcases: 3048 ms`, and `x 20000: 12909 ms`. For example, a broken fixture that errors every test in a large scoped run. The testcase regex is quadratic on unclosed tags: 2000, 4000 and 8000 `<testcase …>` without `</testcase>` (a test that rewrites its own report) took 50, 153 and 581 ms. | 1.3: build a `Map` from each dotted suffix to its file once, and walk the classname's dot prefixes (O(depth) per case). Parse testcases with a linear `indexOf` scanner, or send any report above a size cap (for example 50 MB) to the text fallback. |
| QA-1.3-26 | minor | **Process-backed searches have no bound.** planScopedRun makes one sequential search per deleted source and one per pytest module. 5000 pytest modules gave `search-calls=5000`, and 5000 deleted sources gave `search-calls=5000`. One real `git grep` in a repo of 10000 files costs 317 ms, which adds up to about 26 minutes for 2.1. The planner itself is linear. | 1.3/2.1: cap the searches. For example, more than 50 pending searches gives S6 with a new reason "too many changed modules to map". Alternatively, batch them into one `git grep -e a -e b …` and one `git ls-files` call. |
| QA-1.3-27 | nit | **planStaticScoping skips the spec-time pytest config lookup**, so the 1.6 risk signal can report scopable where planScopedRun returns S6. For a changed `tests/unit/test_x.py` with `tests/unit/pytest.ini` `addopts = tests`: `planStaticScoping -> {"scopable":true,…}`, `planScopedRun -> {"unverifiable":true,"code":"unsupported-argument",…tests\unit\pytest.ini}`. | 1.3: in the `!search` branch of classify, run `pytestAtInputs` over the test inputs that are already known. It needs only the fs. |
| QA-1.3-28 | nit | **The setup-file trigger is over-broad.** An application module named `setup.ts` is S6: `npm test \| src/setup.ts -> S6 config-changed`. This fails closed but blocks ordinary app code. | 1.3: match only names with a test marker (`vitest.setup.*`, `jest.setup.*`, `setupTests.*`, `test.setup.*`, `global-setup.*`), or a bare `setup.*` under a `test`/`tests`/`__tests__` directory. |

Checked, no finding: `--maxfail=0` on pytest 7 and 8, the harmless npm options, config reads above gitRoot, argv accounting, readResult never rejecting, and the planner's parity between node and bun.

### Deferred by plan

- QA-1.3-16 (2.1): reports are left behind when `readResult` is skipped. Reproduced again: this review's own argv probe spawned 4 specs without `readResult`, which left 4 `omr-verify-*` files in `%TEMP%`. They have been removed.
- QA-1.3-17 (2.1): S2 and S5 must treat `complete === false` as not comparable, and also `collectionError === true`. QA-1.3-18 shows bare-file collection ids with `complete=true` that are identical in both trees.
- 3.1: the `host.execPath` check now has evidence (QA-1.3-18). `uv run pytest` syncing the environment in a fresh worktree is still unverified.
- 3.2: fixtures for the `.pytest.ini`, `pytest.toml` and `.pytest.toml` triggers (the round-1 plan amendment), plus the TOML shapes from QA-1.3-20.
- P residuals, unchanged: `bail` in a config file, custom forceRerunTriggers, and conftest hooks that add `-n`.

Cleanup: before `<W>` was deleted, its 8 junctions were removed with `rmdir`, so neither `D:\git\omr-p13\node_modules` nor the Spike C
`node_modules` was touched. The uv venvs went with `<W>`. The check afterwards found 0 `omr-verify-*` files in `%TEMP%` and no processes
referring to `omr-qa13r2`.

### Resolutions (round 2)

Gates after the last fix: `npx vitest run --maxWorkers=2 --coverage --coverage.include=src/verify/runner.ts test/unit/runner.test.ts test/unit/deterministic.test.ts`
gave `Tests 567 passed (567)`, and runner.ts coverage of 99.56% statements, 97.88% branches (1202/1228), 100% functions and 99.81% lines. `npm run typecheck` was clean.
Contract changes are additive: `RunnerHost` gains the optional `nodePath`, `pathExt` and `env`; `S6Code` gains `node-not-found` and `too-many-searches`; `SEARCH_LIMIT` is exported. `ChangedPath`, `StaticScoping`, `ScopedSpec` and `PlannerFs` keep their shapes.
Real-runner spot checks used the Spike C venv (pytest 9.1.1, xdist 3.8.0), npm 12.0.2 and bun 1.3.14, in `%TEMP%\opencode\qa13*` scratch directories that were removed afterwards.

- QA-1.3-18 Resolution: ca57cc7 — JS tools no longer default to `process.execPath` (F.1). The order is `host.nodePath` (absolute), then `host.execPath` when its basename is `node`/`node.exe` (the default also needs `process.versions.bun` to be undefined), then the first `node` on an absolute PATH entry. On win32 each PATHEXT extension is tried in order, as the shell does. A `.cmd`/`.bat` hit needs a shell, so it is S6 `node-not-found`, and so is finding no node at all. A PATH node whose realpath is `bun` (the temporary link `bun run` makes) is skipped. Lint gets Unscoped with the same reason, and pytest is unaffected. Under bun 1.3.14, `resolveEntry` for the Spike C `jest-proj` now gives `file=...\nodejs-lts\current\node.exe`, where `execPath` was `...\.bun\bin\bun.exe`. 2.1 may pass `host.nodePath` explicitly.
- QA-1.3-19 Resolution: 5dc5359 — I step 2a now covers every runner. A complete report with total 0 from a spec that has inputs is incomplete when the spec is a rerun, when its inputs are test files (pytest, or a JS test file given to `related`), or when it has `lexicalPaths`. `realpath` stays optional: making it required would break every caller that passes a plain FsSeam, and a lexical run already fails closed. Behaviour change: a pytest scoped run whose test-file inputs collect nothing (exit 5, for example from `-k`/`-m` deselecting everything) is now unverifiable instead of a pass. win32 lexical mode also strips a trailing `::$DATA`, so `conftest.py::$DATA` is a trigger without realpath. A unit test runs a real junction with vitest: the lexical plan's 0-test report gives `complete=false`, and the realpath plan is canonical.
- QA-1.3-20 Resolution: a16d647 — A TOML key that reaches `<table>.addopts` in any spelling other than a bare `addopts` directly under the `[table]` header is S6 `unsupported pytest argument "addopts" in <file>`. That covers dotted keys at the root or under `[tool]`, quoted keys, inline tables and array tables. The question "does an appended `-n <budget>` already enforce the cap?" was answered with real pytest 9.1.1 and xdist 3.8.0. Each of the four QA shapes gave `assert 3 <= 2` failing without `-n` and `1 passed` with `-n 2` appended. So the cap does land, but only when the adapter appends `-n`, and it can do that only when it knows xdist is present (otherwise exit 4). Hence the fail-closed S6. The 3.2 fixtures should still add the four shapes.
- QA-1.3-21 Resolution: a16d647 — The config lookup follows three pytest release lines. pytest 9 uses all seven names. pytest 8 has no `pytest.toml`/`.pytest.toml` and does not read a native `[tool.pytest]` table. pytest 7.0 additionally has no `.pytest.ini`. Each line picks its own first accepted file. The evidence is their union: xdist and cov from any file, the lowest cap (count below auto, invalid last), and `-p no:xdist` only when every line's file says so. A `-c` TOML file is read both ways, and a file that only an older line reads can still be S6.
- QA-1.3-22 Resolution: e4e603e — Only an `<error message="collection failure">` child makes a testcase a collection case. A `classname=""` case is a real test: a green run stays green, and a failing one is unmapped (`pytest classname not mapped to a test file: "" (<name>)`, `complete=false`). Real pytest 9.1.1 with `pytest -c cfg/x.ini`, planned and spawned through the adapter, wrote `<testcase classname="" name="test_workers" …/>` and gave `total=1 complete=true collectionError=false`. The report was deleted. The "S6 when the rootdir is outside the inputs" alternative was not needed.
- QA-1.3-23 Resolution: e7546e2 — `Pipfile`, `setup.py`, `requirements*.in`, `constraints*.txt` and any `*.txt`/`*.in` below a directory named `requirements` are pytest triggers. On win32 the directory and extension match case-insensitively.
- QA-1.3-24 Resolution: e7546e2 — For npm scripts, these are S6 `unsupported-command`: a `workspace`/`workspaces` key (also `workspace[]`) in any `.npmrc` from cwd up to gitRoot, an unreadable `.npmrc`, and a non-empty `npm_config_workspace(s)` variable in any case, in the host env (new optional `RunnerHost.env`) or in cross-env. Deviation from the fix text: `prefix` and `include-workspace-root` are not checked. With npm 12.0.2, `npm_config_prefix=packages/app`, `.npmrc prefix=packages/app` and `.npmrc include-workspace-root=true` each still ran the root `scripts.test`, while `workspace=`, `workspaces=true` and `NPM_CONFIG_WORKSPACE` ran the workspace's script. `npm_config_prefix` is also a common global setting. The user and global npmrc are a P residual.
- QA-1.3-25 Resolution: e4e603e — `parseJunit` is linear. Dotted input suffixes go into a map once (the first input wins a shared suffix). A classname walks its own dot prefixes. Testcases are found with a forward `indexOf` scan, and a testcase that is unclosed or contains another `<testcase` makes the report unusable (text fallback, `complete=false`). The unit test with 700 inputs × 20000 failing testcases runs in about 0.2 s under coverage, against 12.9 s before. 8000 unclosed testcases fall back at once.
- QA-1.3-26 Resolution: a6be0d5 — More than `SEARCH_LIMIT` (50) changed files that need a process-backed search is S6 `too-many-searches`: `too many changed modules to map: <n> test searches (limit 50)`. That covers deleted JS sources and existing or deleted pytest modules. The check runs before the first search, so `planStaticScoping` returns the same S6. Batching into one `git grep -e … -e …` would need a TestSearchSeam change, so the cap was the simpler bound.
- QA-1.3-27 Resolution: a6be0d5 — `planStaticScoping` runs the spec-time pytest config lookup over the test inputs it already knows. The QA repro (`tests/unit/pytest.ini` with `addopts = tests`) is now S6 `unsupported-argument` from both planners.
- QA-1.3-28 Resolution: e7546e2 — The setup-file trigger uses the rule 1.6 `risk.ts` adopted (QA-1.6-21): `*.setup.<js/ts>`, or the basenames `setupTests`, `setup-tests`, `test-setup`, `global-setup`, `globalSetup`, `vitest.setup` and `jest.setup` with a JS/TS extension, case-insensitive. `src/setup.ts` and `SetupWizard.tsx` are inputs again. Trade-off: `test/setup.ts` and `jest.setupAfterEnv.js` are no longer triggers either; section P lists them as a residual.
- QA-1.3-16, QA-1.3-17: deferred by plan to 2.1, unchanged. For 2.1, S2 and S5 must treat `complete === false` AND `collectionError === true` as not comparable (QA-1.3-18 showed identical bare-file collection ids in both trees). The zero-test guard now also makes 0-test pytest and vitest runs incomplete (QA-1.3-19).

## QA re-review (round 3)

Date: 2026-09-27. Reviewed `git diff b952d37..77c6159`: runner.ts +567/-127, runner.test.ts +431, this file +20. Unit gate, run once:
`npx vitest run --maxWorkers=2 test/unit/runner.test.ts test/unit/deterministic.test.ts` gave `Test Files 2 passed (2)`, `Tests 567 passed (567)`.

Method: runner.ts was bundled with rolldown 1.2.5 into `%TEMP%\omr-qa13r3` (called `<W>` below, long spelling
`C:\Users\Marquinho\AppData\Local\Temp\omr-qa13r3`). It was driven under **node v24.21.0 and bun 1.3.14**. The planners got the real fs
(a PlannerFs with `fs.promises.realpath`, or a lexical one without it) and a search seam backed by real `git ls-files` / `git grep`.
Specs were spawned with `spawnSync(spec.file, spec.args, {shell: false})`, and every run went through `readResult`. Runners: vitest
4.1.11, jest 30.5.2, pytest 9.1.1 with xdist 3.8.0 (the Spike C venv), and uv venvs (Python 3.12) with pytest 7.0.1/xdist 2.5.0 and
8.0.0/xdist 3.5.0; npm 12.0.2. Fixtures were fresh copies of the Spike C projects, each with its own `git init`, plus a junction alias
(`vlink`). Worker-cap probe: `assert PYTEST_XDIST_WORKER_COUNT <= 2` (failure text `WORKERS=<n>`). "User's own" means the check
command run by itself in the fixture, without the adapter.

### Verification of the round-2 resolutions

| id | verdict | evidence |
|---|---|---|
| QA-1.3-18 | verified, with gaps (QA-1.3-30, QA-1.3-36) | Under node, `spec.file` = `process.execPath`. Under bun 1.3.14 run directly, jest and vitest specs got `file=C:\Users\Marquinho\scoop\apps\nodejs-lts\current\node.exe`, and jest (`src/math.js` changed) gave `exit=0 total=1 failingIds=[] complete=true`. Round 2 gave `exit=1 total=0 collectionError=true` for the same plan. PATH and PATHEXT: a `node.cmd` ahead of the real dir gives `S6 node-not-found: node on PATH is not an executable file: <W>\nc\node.cmd`. With `.CMD;.EXE`, a dir that holds both files gives the same S6, and with `.EXE;.CMD` it gives `<W>\nb\node.exe`, in the shell's order. A relative `.` entry is skipped even with a `node.exe` in the process cwd. A relative `nodePath` gives `S6 node path is not absolute`. A quoted PATH entry is skipped (S6 when it is the only one). Gap: Bun's own temporary node on win32 is a hard link, not a symlink, so it is not skipped (QA-1.3-30). |
| QA-1.3-19 | verified | vitest through the `vlink` junction without realpath: `src/str.js` gave `exit=0 total=0 complete=false note=vitest ran no tests and the paths were not canonicalized (no realpath seam)`, and `test/str.test.js` gave `note=vitest ran no tests although a test file was passed`. With realpath, both gave `exit=1 total=2 failingIds=["test/str.test.js > str > bad"] complete=true`. In lexical mode, `conftest.py::$DATA`, `CONFTEST.PY::$data`, `pytest.ini::$DATA` and `requirements/base.txt::$DATA` give `S6 config-changed`. `pyproject.toml:$DATA` (one colon) gives NoAffected, which is correct: a write to `a.toml:$DATA` creates a named stream, and the main stream stayed `"orig"`. `pytest -m "<no match>"` on a changed test file gave `exit=5 total=0 complete=false`. Side effect: QA-1.3-37. Identical under bun. |
| QA-1.3-20 | verified for the reported shapes, gap QA-1.3-31 | The root dotted key, `[tool]` + `pytest.ini_options.addopts`, quoted `"addopts"` and the inline table each give `S6 unsupported-argument: unsupported pytest argument "addopts" in <W>\s20-N\pyproject.toml` (node and bun). Escaped spellings still get through (QA-1.3-31). |
| QA-1.3-21 | verified | pytest 8.0.0 with `pytest.toml` + `pytest.ini(-n 3)`; pytest 7.0.1 with `.pytest.ini` + `tox.ini(-n 3)`; pytest 8.0.0 with pyproject `[tool.pytest]` + `tox.ini(-n 3)`: each gave `adapter -n 2 exit=0 total=1 complete=true`, while the user's own pytest gave `exit=1 WORKERS=3`. Control on 9.1.1: `-n 2`, exit 0. Identical under bun. |
| QA-1.3-22 | verified | `pytest -c cfg/x.ini`, changed `tests/test_math.py`: `exit=0 total=1 failingIds=[] collectionError=false complete=true`, and the report was deleted. With a real failure (`tests/test_str.py`), pytest writes `classname=".TestStr"`: `failingIds=[".TestStr::test_bad"] complete=false note=pytest classname not mapped to a test file: .TestStr`. That fails closed, as designed, so every failing run under an out-of-tree `-c` is unverifiable. Real pytest 9.1.1 with hostile ids (`test_h[a>b]`, `test_h[</testcase><testcase classname="q" name="z"/>]`), and with `junit_logging = all` capturing a literal `<testcase …><failure …/></testcase>` plus `</testsuites>` on stderr, gave exactly the 2 real failing ids with `total=3 complete=true`. A module-level `pytest.skip` gives `exit=5 total=1 complete=true` (`classname=""` + `<skipped message="collection skipped">`). That matches the user's own run, a skip. |
| QA-1.3-23 | verified | `requirements/base.txt`, `REQUIREMENTS/Dev.IN`, `reqs/requirements/prod.txt`, `constraints.txt`, `Pipfile`, `setup.py` and `requirements-dev.in` give `S6 config-changed`. `pkg/requirements.py` is a module (`scopable pending=1`). |
| QA-1.3-24 | verified for the documented forms, gaps QA-1.3-32 | `.npmrc` `workspace=packages/app` gives `S6 unsupported command "npm workspace" in <W>\nw\.npmrc`, and real npm 12.0.2 did run `packages/app`'s script. Host `NPM_CONFIG_WORKSPACE`, host `npm_config_workspaces=true` and cross-env `npm_config_workspace` give S6. An empty value is ignored. Identical under bun. Quoted keys, a BOM and `npx` still get through (QA-1.3-32). |
| QA-1.3-25 | verified (linear), bun cost QA-1.3-35 | readResult timings under node: 700 inputs × 20000 failing cases took 464 ms. 200000 passing cases (14 MB) took 1053 ms. One case with a 50 MB body took 1280 ms. 8000 unclosed cases took 108 ms (text fallback). `<testcase` followed by 50 MB with no `>` took 1277 ms (fallback). 1e6 `<testcaseX` decoys took 618 ms. 200000 `<error` tags in one body took 62 ms. A 5 MB `<error` attribute run took 11 ms. Every report was unlinked. Under bun, the first two took 2969 ms and 2464 ms (QA-1.3-35). |
| QA-1.3-26 | verified | 50 changed pytest modules made 50 real git searches (2128 ms) and gave NoAffected. 51 gave `S6 too-many-searches: too many changed modules to map: 51 test searches (limit 50)` after 0 searches, and `planStaticScoping` gave the same S6. |
| QA-1.3-27 | verified | With `tests/unit/pytest.ini` `addopts = tests`, static and scoped both give `S6 unsupported-argument: unsupported pytest argument "tests" in addopts of <W>\pp\tests\unit\pytest.ini`. |
| QA-1.3-28 | verified as specified; regression QA-1.3-29 | `src/setup.ts` and `src/SetupWizard.tsx` are inputs (`scopable`). `vitest.setup.ts` and `src/setupTests.js` give S6. But `test/setup.ts`, `jest-setup.js`, `vitest-setup.ts` and `setupVitest.ts` are now inputs too. Under jest that is a false pass (QA-1.3-29). |

### New findings (round 3)

| id | severity | summary and evidence | fix |
|---|---|---|---|
| QA-1.3-29 | major | **Regression from e7546e2: a jest setup-file change passes without running any test.** The narrowed G.7 rule no longer matches names the round-2 rule caught. jest's related graph never reaches a setup file, so `--findRelatedTests <setup file>` runs 0 tests with exit 0. The input is not a test file and realpath was used, so step 2a does not apply. Repro: `jest.config.js` has `setupFilesAfterEnv: ['<rootDir>/<f>']` (committed), and `<f>` is changed to `throw new Error('setup broke')`. For `<f>` = `jest-setup.js` (the Testing Library convention), `test/setup.js` and `jest.setupAfterEnv.js`, the adapter gave `exit=0 total=0 failingIds=[] collectionError=false complete=true`, which Q.2.1 reports as green. The user's own `jest` gave `exit=1 ● Test suite failed to run`. All three names matched the round-2 regex. The same plan comes out under bun. Section P lists this case, but e7546e2 added that entry itself, so it is not a residual the plan had accepted. P's own header says a failure there "means a design bug". vitest is not affected: its forceRerunTriggers rerun every file, which is correct at full cost. | For vitest and jest, trigger on the union of 1.6's rule and the round-2 names that carry a test marker: `^(?:jest\|vitest\|test)[.-]setup\b`, `setup[.-]?(?:after[.-]?env\|env\|files?\|tests?)`, `setup(?:Jest\|Vitest)`, and a bare `setup.*` under a `test`/`tests`/`__tests__`/`spec` directory. `src/setup.ts` and `SetupWizard.tsx` stay inputs. 1.6 keeps its own rule. Add a unit test per name and a 3.1 jest fixture with `setupFilesAfterEnv`. |
| QA-1.3-30 | minor | **Bun's temporary `node` on win32 is a hard link, so `isBunLink` never skips it.** Under `bun --bun run`, and under `bun run` when node is missing, Bun prepends `%TEMP%\bun-node-<hash>` to PATH. That directory holds `node.exe` and `bun.exe`, each 98480216 bytes (the size of `.bun\bin\bun.exe`), with `nlink=4` and `isSymbolicLink=false`. `fs.promises.realpath` returns `…\bun-node-0d9b296af\node.exe`, so its basename is `node.exe`. The driver was run under `bun --bun run`, where execPath is `…\bun-node-0d9b296af\node.exe` and `process.versions.bun` is `1.3.14`. It gave `spec.file=C:\Users\MARQUI~1\AppData\Local\Temp\bun-node-0d9b296af\node.exe`, and jest (`src/math.js`) gave `exit=1 total=0 failingIds=["test/math.test.js"] collectionError=true complete=true`, the QA-1.3-18 symptom. vitest still passed. On a host with no node at all, this returns Bun where the answer should be S6 `node-not-found`. It is a false failure or unverifiable, never a pass. | On win32, skip a PATH directory whose basename matches `/^bun-node-[0-9a-f]+$/i`. Under Bun, also skip a candidate with the same file identity (`dev`+`ino` from stat) as `process.execPath`. That needs an optional `stat` on PlannerFs. Add a unit test that uses a hard-link fixture. |
| QA-1.3-31 | minor | **The worker cap (S4) is still bypassed through TOML escapes and iniconfig's `key:value`.** pytest 9.1.1 honours each case below, but the adapter sees no addopts and appends no `-n`. Every case gave `adapter no -n -> exit=1 failingIds=["tests/test_workers.py::test_workers"]`, and the user's own run failed with `WORKERS=3`. The cases: pyproject `[tool.pytest.ini_options]` + `"add\u006fpts" = "-n 3"`; `[tool."py\u0074est".ini_options]` + `addopts = "-n 3"`; `pytest.toml` `[pytest]` + `"add\u006fpts" = ["-n", "3"]`; and `addopts:-n 3` (colon with no space) in `pytest.ini`, `tox.ini` and `setup.cfg`. In the last case iniconfig splits on `=`, or on `:` when the name contains no `=`, and needs no whitespace. The adapter's `(?:=\|:\s)` does. The control (`addopts = -n 3`) got `-n 2`. The ini part predates round 2 (1592518). Results were identical under bun. | TOML: decode basic-string escapes in quoted keys and header parts before comparing, or return S6 for any quoted key or header part that contains `\`. ini: follow iniconfig. Split on the first `=` unless the name before it contains `:`, otherwise split on the first `:`. Whitespace is optional. Add all 6 shapes to the unit tests and the 3.2 fixtures. |
| QA-1.3-32 | minor | **npm workspace selection still gets through (QA-1.3-24 class), in one case as a false pass.** (a) Real npm 12.0.2 ran `packages/app`'s script for `.npmrc` `"workspace" = packages/app`, `'workspaces' = true`, and a UTF-8 BOM followed by `workspace=packages/app`. The `ini` parser unquotes keys, and its `\s` eats the BOM. The adapter planned the root script (ScopedSpec) each time. (b) `npx`/`npm exec` also honour workspace config: with `.npmrc` `workspace=packages/app`, `npm exec -c "node -p process.cwd()"` printed `<W>\nw\packages\app`. `npx vitest run` is a direct invocation, so `npmWorkspaceConfig` is never consulted. Repro: the root `vitest.config.mjs` has `include: ['test/**/*.test.js']`, and `packages/app/test/a.test.js` fails after `packages/app/src/a.js` changes. The adapter ran at `<W>\nw` and gave `exit=0 total=0 complete=true` (a pass). The user's own `npx vitest run` gave `exit=1 Test Files 1 failed (1)`. | Strip a leading BOM. Accept optional `"`/`'` around the key: `/^[ \t]*["']?(workspaces?)["']?[ \t]*(?:\[\])?[ \t]*=/im`. Run `npmWorkspaceConfig` for the `npx` launcher as well (npm exec reads the same .npmrc and `npm_config_*`). |
| QA-1.3-33 | major | **A pytest test file outside the default naming passes without being run.** G.8 recognizes test files only by `PY_TEST_RE` (`test_*.py`, `*_test.py`), following plan section 1.5 (L279). pytest's `python_files` setting is not read. pytest-django's documented `python_files = tests.py test_*.py *_tests.py` is common. A changed `pkg/tests.py` or `pkg/str_tests.py` is treated as a module. The name search for `test_tests.py`/`tests_test.py` finds nothing, and the result is `NoAffected: no affected tests: no test files map to the changed modules`. The user's own pytest gave `exit=1 AssertionError: broken by the change`. This predates round 2 and is in neither P nor the plan. | Read `python_files` from the configs `findPytestConfigs` already loads (ini: whitespace-separated; TOML: string or array). Use it (fnmatch on the basename) both to classify changed `.py` files and to build the findByName names. If the value cannot be parsed, return S6 `unsupported-argument`. At minimum, return S6 whenever `python_files` is set. Plan amendment to section 1.5 (L279). Add a 3.2 fixture with the pytest-django setting. |
| QA-1.3-34 | minor | **Large pytest configs block the event loop for up to a minute and use gigabytes of memory.** Detection reads the config before the trigger check, and `findPytestConfigs` parses each file once per release line (up to 3×). The lookup also runs twice, at detection and at spec time, and `tomlHiddenAddopts` adds a per-line regex pass. The file sits in the repo, which the producer controls. `planStaticScoping` timings: a 100 MB `pyproject.toml` with no pytest table and 1 KB lines took 9432 ms and 414 MB RSS under node, and 1480 ms under bun. The same size in 4-byte lines took 85939 ms and 2429 MB under node, and 52584 ms and 6080 MB under bun. A 100 MB `tox.ini` in 4-byte lines took 46739 ms and 3366 MB under node, and 72109 ms and 9356 MB under bun. Round 2 measured 391 ms for a 100 MB pyproject.toml in the parent directory. | Cap the size of a pytest config file. For example, a file over 1 MiB gives S6 `unsupported-argument "pytest config too large: <path>"`, since pytest itself would read it. Memoize `parsePytestConfig` per (path, legacy) across both lookups. Scan lines with `indexOf` instead of `split` into an array. |
| QA-1.3-35 | nit | **readResult's constant is 3 to 6 times higher under Bun, the real runtime.** 700 inputs × 20000 failing cases took 464 ms under node and 2969 ms under bun. 200000 passing cases took 1053 ms and 2464 ms. Bun's `path.win32.relative` is about 13 times slower: 20000 calls took 74 ms under node and 953 ms under bun. `relOf` runs once per failing case, and attributes are decoded for every case, passing ones included. The cost is linear, and a large improvement on round 2's 12.9 s. | Memoize `relOf` per input file (there are at most `inputs.length` distinct values). Parse attributes only for a case whose body holds `<failure`, `<error` or the collection marker; a passing case only increments `total`. |
| QA-1.3-36 | nit | **resolveNode accepts a directory and a drive-relative PATH entry.** `fileExists` also accepts directories. With a directory named `node.exe` on PATH, the result was `file=<W>\nd\node.exe`, and the spawn gave `exit=-1 … complete=false`. `P.win32.isAbsolute("\\Users\\…")` is true, so a root-relative entry gave `file=\Users\Marquinho\AppData\Local\Temp\omr-qa13r3\nx\node.exe`. `fileExists` resolves that path against the plugin's current drive, and libuv resolves it against `spec.cwd`'s drive. An explicit `host.execPath` named `node.exe` is trusted without an existence check (`<W>\missing\node.exe` was returned). All of these fail closed, but N.1 promises an absolute executable. pytest's `onPath` has the same entry rule. | On win32, accept a PATH entry only when it matches `^[A-Za-z]:[\\/]` or is UNC, for both node and pytest. Optionally add `isFile` to the seam. |
| QA-1.3-37 | minor | **Side effect of 5dc5359: a change only to a test-named file that the vitest config excludes is now unverifiable.** This covers Playwright `e2e/*.spec.ts`, excluded by create-vue and Vite templates through `exclude: [...configDefaults.exclude, 'e2e/**']`. Repro: with `exclude: ['e2e/**', '**/node_modules/**']` and a changed `e2e/login.spec.js`, the result was `exit=0 total=0 complete=false note=vitest ran no tests although a test file was passed`. Before 5dc5359 it was a pass, which matched the user's command, since `vitest run` never runs e2e. It fails closed, but it blocks every e2e-only change. jest has behaved this way since round 1. | Either document it in Q as a known source of unverifiable results, or have 2.1 confirm the selection with the non-importing `vitest list --filesOnly --json <file>` (Spike C: no module code runs). An empty list would then give NoAffected. |

Checked, no finding:
- Adversarial junit that pytest does not write: a `<testcase>` inside an XML comment or CDATA is counted (`J1`: `failingIds=["tests/test_math.py::ghost"]`), and so is an unescaped `>` in an attribute (`J3`: `tests/test_math.py::`). Each only adds or garbles a failure, never removes one. Real pytest escapes `<`, `>` and `"` in attributes (see the QA-1.3-22 row). `<error message='collection failure'>` in single quotes becomes an unmapped failure with `complete=false`. Exit 2 with no cases gives `complete=false`.
- The config union (QA-1.3-21): the lowest cap wins, and `-p no:xdist` counts only when every release line's file says so. A mismatch can only add `-n`, which costs exit 4 (unverifiable), as documented.
- Bun parity: the whole round-3 planner sweep (QA-1.3-18 PATH cases, 19, 20, 21, 22, 24, 31 and the jest setup-file plan) gave identical results under node and bun, apart from `spec.file` in QA-1.3-30.
- `requirements.d/base.txt` gives NoAffected. The round-2 rule names only a `requirements` directory; not flagged.

### Deferred by plan

- QA-1.3-16 and QA-1.3-17 (2.1): unchanged. This round's probes called `readResult` on every spawn, including the failed spawn in QA-1.3-36, and 0 `omr-verify-*` files were left in `%TEMP%`.
- 3.1: `uv run pytest` syncing a fresh reference worktree is still unverified. 3.1 should also launch one spec from inside opencode, checking QA-1.3-30's PATH.
- 3.2: fixtures for the new trigger names (`.pytest.ini`, `pytest.toml`, `.pytest.toml`, `Pipfile`, `setup.py`, `requirements/*.txt`, `constraints*.txt`), the four QA-1.3-20 TOML shapes, and, once fixed, the six QA-1.3-31 shapes and the QA-1.3-33 `python_files` fixture.
- Section P residuals, accepted: `bail` in a config file, custom forceRerunTriggers (vitest setup files under other names: correct at full cost), conftest hooks that add `-n`, and the user or global npmrc. The jest half of the new setup-file entry is not accepted here (QA-1.3-29).

Status: **not clean.** Open: QA-1.3-29 and QA-1.3-33 (major); QA-1.3-30, -31, -32, -34 and -37 (minor); QA-1.3-35 and -36 (nit).

Cleanup: the 5 junctions in `<W>` (`vlink` and the `node_modules`/`.venv` links into `D:\git\omr-p13` and `%TEMP%\omr-spikeC`) were removed with `rmdir` first. The check found 0 reparse points left, and then `<W>` was deleted, including the uv venvs. The link targets are intact. `%TEMP%\bun-node-0d9b296af`, which this review's `bun --bun run` probe created at 02:00, was removed. The check afterwards found 0 `omr-verify-*` files in `%TEMP%` and no processes referring to `omr-qa13r3`. The Spike C fixtures were not modified.

### Resolutions (round 3)

Gates after the last fix: `npx vitest run --maxWorkers=2 --coverage --coverage.include=src/verify/runner.ts test/unit/runner.test.ts test/unit/deterministic.test.ts`
gave `Test Files 2 passed (2)`, `Tests 680 passed (680)`, and runner.ts coverage of 99.51% statements, 97.78% branches (1632/1669), 100% functions
and 99.86% lines. `npm run typecheck` was clean. runner.ts still imports no `child_process`.
Contract changes are additive: `S6Code` gains `config-too-large`; `PlannerFs` gains the optional `stat` (new exported `FileStat`);
`DetectedRunner` and `PytestFacts` gain the optional `pythonFiles`; `CONFIG_SIZE_LIMIT` and `DEFAULT_PYTHON_FILES` are exported.
2.1 should pass `stat` as `fs.promises.stat(p, { bigint: true })` mapped to `{ isFile, size, dev, ino }`, next to the native realpath.
Real-runner checks: runner.ts (and the a43b87e copy, as "before") was driven under bun 1.3.14 from `%TEMP%\omr-fix13r3`. The planners used the
real fs (native realpath, bigint stat) and a search seam backed by `git ls-files` / `git grep`. Specs were spawned with `spawnSync(file, args,
{shell: false})`, and every run went through `readResult`. Runners: pytest 9.1.1 + xdist 3.8.0 (the Spike C venv, by junction), jest 30.5.2 and
vitest 4.1.11 (Spike C `node_modules`, by junction), npm 12.0.2. Cleanup: the 7 junctions were removed with `rmdir` first (0 reparse points
left), then the directory; the Spike C venv and `node_modules` are intact. The `%TEMP%\bun-node-0d9b296af` that the `bun --bun run` probe
created was removed. The final check found 0 `omr-verify-*` files, 0 `bun-node-*` directories and no process referring to the scratch
directory.

- QA-1.3-29 Resolution: 5920ea5 — The vitest/jest setup-file trigger is a superset of 1.6's risk.ts rule again (G.7). By name, case-insensitive,
  with a JS/TS extension, it covers `*.setup.*`, every risk.ts basename (`setup-jest`, `jest-setup`, `vitest-setup` and `global-teardown` included),
  `(jest|vitest|test|tests)[._-]?(setup|teardown)*`, `setup(Tests|Jest|Vitest|Env|AfterEnv|Files|FilesAfterEnv)` and
  `global[._-]?(setup|teardown)*`. A bare `setup.*` or `teardown.*` counts below a `test`, `tests`, `spec`, `specs`, `testing`, `jest`, `vitest` or
  `__tests__` directory. Test files stay inputs; `src/setup.ts`, `SetupWizard.tsx` and `src/setupEnvironment.ts` stay application code. By
  reference (G.7a), the string literals of `setupFiles`, `setupFilesAfterEnv`, `globalSetup` and `globalTeardown` are triggers too. They are read
  from `vitest.config.*`/`vite.config.*` or `jest.config.*`/package.json (`"jest"` key), in every directory from runnerCwd up to gitRoot and
  in the `--config` file, and resolved against the config's directory, runnerCwd or `<rootDir>`. A reference without an extension also
  matches `<ref>.<ext>` and `<ref>/index.<ext>`. The section P entry that e7546e2 added is gone. The only thing left is a setup file under an
  unconventional name that a config names through a non-literal expression (P, forceRerunTriggers entry). Real jest 30.5.2:
  `setupFilesAfterEnv: ['<rootDir>/<f>']` in a committed jest.config.js, and `<f>` changed to `throw new Error('setup broke')`, for `<f>` =
  `jest-setup.js`, `test/setup.js`, `jest.setupAfterEnv.js` and the unconventional `src/testing/bootstrap.js`. Before (a43b87e), each gave
  `exit=0 total=0 failingIds=[] collectionError=false complete=true`, a false pass. After, each gave
  `{"unverifiable":true,"code":"config-changed","reason":"config file changed: <f>"}`. The user's own jest gave `exit=1 ● Test suite failed
  to run … setup broke` for all four.
- QA-1.3-30 Resolution: 8b59bd6 — F.1 step 3 skips Bun's temporary node three ways: a PATH directory named `bun-node-<hex>`, a realpath to
  `bun`/`bun.exe` (posix symlink), or the same `dev`+`ino` as `host.execPath` through the new optional `PlannerFs.stat` (the win32 hard link).
  An ino of 0 proves nothing. An `execPath` inside a `bun-node-<hex>` directory is not node even when named `node.exe` (`bun --bun run`).
  Real check under `bun --bun run`, where `fsutil hardlink list` showed `bun-node-0d9b296af\node.exe` as a link of `.bun\bin\bun.exe`: before,
  `spec.file=C:\Users\MARQUI~1\AppData\Local\Temp\bun-node-0d9b296af\node.exe`; after, `spec.file=C:\Users\Marquinho\scoop\apps\nodejs-lts\current\node.exe`.
  A hard link to bun.exe named `<scratch>\hl\node.exe`, first on PATH, was taken before and skipped by identity after.
- QA-1.3-31 Resolution: b846870 — ini lines split the way iniconfig splits them: on the first `=` unless the name before it contains `:`,
  otherwise on the first `:`, with whitespace optional. The TOML reader is now one pass over the lines. It skips every value whole (strings,
  multi-line strings, nested arrays, inline tables), so a header inside a string is not a header. It compares header and key parts decoded,
  so `"add\u006fpts"` and `[tool."py\u0074est".ini_options]` are plain names and are read. A quoted `"addopts"` under the right table is read
  too, where round 2 made it S6. A quoted part whose escapes do not decode is S6 `unsupported pytest argument "<raw key>" in <file>`. So is
  a second occurrence of a key in any pytest table. Dotted keys, inline tables and array tables stay S6 as in QA-1.3-20. Real pytest 9.1.1
  with the `WORKERS<=2` probe: `addopts:-n 3` in pytest.ini gave `exit=1 failingIds=["tests/test_workers.py::test_workers"]` before and
  `exit=0 total=1 complete=true` after. `[tool."py\u0074est".ini_options]` + `"add\u006fpts" = "-n 3"` gave the same pair. The user's own pytest
  failed with `WORKERS=3` both times. All six QA shapes are unit tests.
- QA-1.3-32 Resolution: da34ecb — `.npmrc` keys are read the way npm's `ini` parser reads them: a BOM, quotes around the key (JSON-decoded,
  so `"work\u0073pace"` is `workspace`), a key without `=` (`workspaces` alone is true), an unquoted key cut at the first unescaped `;` or
  `#`, and a trailing `[]`. Real npm 12.0.2 reported an active workspace (`ENOWORKSPACES` from `npm config get`) for `"work\u0073pace"=`,
  `workspace;note=`, bare `workspaces`, a BOM before `workspace=`, and `'workspace' =`. It reported none for `work\;space=`, and the parser
  agrees on all six. The workspace check also runs for the `npx` launcher, from runnerCwd, in commands and inside any package script. npx is
  npm exec, which honours the same config and runs in the workspace's directory (QA evidence). `npx vitest run` with `workspace=` is now
  S6 `unsupported command "npm workspace" in <.npmrc>`, where it was a false pass. `vitest run`, `pnpm exec vitest` and `yarn test` still plan.
- QA-1.3-33 Resolution: b846870 — pytest's `python_files` is read from the configs every release line picks. It is also read from the
  common ancestor of the path arguments, and from every `-o python_files=` in the command, addopts and `PYTEST_ADDOPTS`. The result is the
  union: a line whose config sets none, or that finds no config, adds the default `test_*.py *_test.py` (`DetectedRunner.pythonFiles`).
  Changed `.py` files are classified with pytest's `fnmatch_ex` rule, using a linear-time fnmatch matcher: basename for a pattern without a
  separator, whole path otherwise, case-folded on win32. The `findByName` names come from the basename patterns with exactly one `*`. A
  literal such as `tests.py` names nothing and skips the search. The stem-search globs follow the patterns, and content hits are
  re-checked against them. An unreadable value (not a string or array of strings, an unterminated quote, a dotted or inline spelling) is S6
  `unsupported pytest argument "python_files" in <file>`, unless the command line overrides it with `-o`. Real pytest 9.1.1 with the
  pytest-django setting `python_files = tests.py test_*.py *_tests.py` and `pkg/tests.py` broken: before,
  `{"noAffected":true,"note":"no affected tests: no test files map to the changed modules"}`; after, the inputs were `pkg/str_tests.py` and
  `pkg/tests.py`, with `exit=1 total=2 failingIds=["pkg/tests.py::test_up"] complete=true`. The user's own pytest gave `1 failed, 1 passed`.
  **Plan amendment to section 1.5-3 (plan L279):** the affected set is the changed test files by pytest's `python_files` (default
  `test_*.py`/`*_test.py`), plus the files `python_files` names for a changed module's stem. It is not the fixed `test_<stem>.py`/`<stem>_test.py`
  pair. 3.2 must add a pytest-django fixture (`python_files = tests.py test_*.py *_tests.py`).
- QA-1.3-34 Resolution: b846870 — Every config file the planners parse goes through one per-call cache: pytest configs, `.npmrc` (da34ecb),
  and the vitest/jest/Playwright configs (5920ea5). Each file is read once and parsed once per reading. None is parsed above
  `CONFIG_SIZE_LIMIT` (1 MiB): beyond it, S6 `config-too-large`, "config file too large to read: <path> (limit 1048576 bytes)". That holds
  even for a file pytest would skip after reading it, such as a pyproject.toml without a pytest table in a parent directory. With
  `PlannerFs.stat` the size is checked before the read. A 1 MiB pyproject.toml of `a=1` lines (the worst line shape) plans in well under
  3 s under coverage (unit test). Real 100 MB pyproject.toml with 1 KB lines, `planStaticScoping` under bun: before 617 ms (RSS 276 MB);
  after 88 ms without stat and 6 ms with stat (RSS 148 MB), both S6 `config-too-large`. A unit test checks that detection, the spec-time
  lookup and the three release lines read the file once.
- QA-1.3-35 Resolution: 34fd11d — readResult computes cwd-relative ids by prefix when a path lies plainly below the base: the same prefix
  with either separator, case-folded on win32, and a tail with no empty, `.` or `..` segment. That is exactly what `P.relative` returns
  there; anything else still uses `P.relative`. parseJunit relativises each input once and decodes attributes only for failing and
  collection cases. Under bun 1.3.14 with win32 paths, 700 inputs × 20000 failing cases went from 1150 ms to 155 ms, and 200000 passing
  cases from 645 ms to 67 ms, with identical results.
- QA-1.3-36 Resolution: 8b59bd6 — On win32, PATH entries (node, pytest, uv) and `host.nodePath` need a drive (`C:\`) or a UNC host. A
  root-relative `\Users\…` entry is skipped; as a `nodePath` it is S6 `node path is not absolute`. With `stat`, a directory named `node.exe`
  or `pytest.exe` (PATH or `.venv`) is skipped, a `nodePath` must be an existing file (S6 `node path is not a file: <p>`), and an `execPath`
  named node must exist before it is used. Without `stat` behaviour is unchanged (fail-closed at spawn). Real fs: a directory
  `<scratch>\nd\node.exe` first on PATH, and a drive-less `\Users\…\nx` holding a real node.exe, were both returned before and both skipped
  after (`spec.file=…\nodejs-lts\current\node.exe`).
- QA-1.3-37 Resolution: 5920ea5 — Fixed rather than accepted. A changed test file is not an input, with the note `playwright test file
  excluded by the <runner> config, not run: <rel>`, only when both of these hold (G.8a). First, it lies in a Playwright testDir:
  `playwright.config.*` from runnerCwd up to gitRoot, where testDir is its literal, the config's directory when absent, or `<dir>/e2e` when
  not a literal. Second, the runner's own config statically excludes it: vitest `exclude`/`--exclude` of the forms `X/**`, `X/**/*` or either
  after `**/`, or a jest `testPathIgnorePatterns` literal made only of word characters and `. / : -` that is a substring of the path. The
  exclusion is read only from the one file the runner loads: the last `--config`, else runnerCwd's single `vitest.config.*` (before
  `vite.config.*`), or `jest.config.*` (before package.json). It is never read with a `projects`/`workspace` key, a
  `vitest.workspace`/`vitest.projects` file, vitest `--root`/`--dir`, or jest `--rootDir`/`--testPathIgnorePatterns`. Anything else stays
  an input, and the zero-test guard keeps it unverifiable. The heuristic in the dispatch (testDir alone) was not taken: a testDir shared
  with vitest and split by a Playwright `testMatch` would drop real vitest tests (a false pass). Residual (P): an `X/**` literal under
  `coverage.exclude` also counts, but only for a file inside a Playwright testDir. Real vitest 4.1.11, create-vue shape
  (`exclude: [...configDefaults.exclude, 'e2e/**']`, playwright `testDir: './e2e'`): before, `exit=0 total=0 complete=false note=vitest ran
  no tests although a test file was passed`; after, `{"noAffected":true,…}`, and with `src/math.js` also changed, `inputs=[src/math.js]`,
  `exit=0 total=1 complete=true`. The user's own `vitest run` gave `Test Files 1 passed (1)`.
- QA-1.3-16, QA-1.3-17: deferred by plan to 2.1, unchanged. 3.1 and 3.2 (additions to the round-3 list): a jest fixture with
  `setupFilesAfterEnv` under a conventional and an unconventional name, the six QA-1.3-31 shapes, the pytest-django `python_files` fixture,
  the create-vue Playwright layout, and one spec launched from inside opencode under Bun, to check the PATH node (QA-1.3-30).

## QA re-review (round 4)

Date: 2026-09-27. Reviewed `git diff a43b87e..63fc053`: runner.ts +1011/-201, runner.test.ts +554/-7, this file +104. Unit gate, run once:
`npx vitest run --maxWorkers=2 test/unit/runner.test.ts test/unit/deterministic.test.ts` gave `Test Files 2 passed (2)`, `Tests 680 passed (680)`.

Method: runner.ts at 63fc053 was bundled with rolldown 1.2.5 into `%TEMP%\omr-qa13r4` (called `<W>` below). The a43b87e copy was bundled
too, for the QA-1.3-35 comparison. Both ran under **node v24.21.0 and bun 1.3.14**; the node lookup also ran under `bun --bun run` of a
package script. The planners got the real fs: a PlannerFs with `fs.promises.realpath` and a bigint `stat`, or the same fs without `stat`.
The search seam was backed by real `git ls-files` / `git grep`. Specs were spawned with `spawnSync(spec.file, spec.args, {shell: false})`,
and every run went through `readResult`. Runners: vitest 4.1.11 (`D:\git\omr-p13\node_modules`) and jest 30.5.2 (Spike C
`node_modules`), both by junction; pytest 9.1.1 with xdist 3.8.0 from the Spike C uv venv (Python 3.13.11, iniconfig 2.3.0), reached
through `host.pathEnv`. The TOML comparison used `tomllib` from the same interpreter. Each case had its own fresh fixture with its own
`git init`, plus a `playwright.config.js` where the case needs one (Playwright itself is not installed). The worker-cap probe was
`assert PYTEST_XDIST_WORKER_COUNT <= 2` (failure text `WORKERS=<n>`). A changed file was broken (`assert "a".upper() == "B"`, an
`expect(add(1,2)).toBe(4)`, or `throw new Error('setup broke')`). "User's own" means the check command run by itself in the fixture.

### Verification of the round-3 resolutions

| id | verdict | evidence |
|---|---|---|
| QA-1.3-29 | verified; gap QA-1.3-41 | The four round-3 names each gave `S6 config-changed: config file changed: <f>` from both planners: `jest-setup.js`, `test/setup.js`, `jest.setupAfterEnv.js` and `src/testing/bootstrap.js`, each named by `setupFilesAfterEnv: ['<rootDir>/<f>']` in a committed jest.config.js. The user's own jest gave `exit=1 ● Test suite failed to run … setup broke` for each. `src/testing/bootstrap.js` also gave S6 when a config named it in any of these forms: the package.json `"jest"` key; `setupFiles` in jest.config.json; `require.resolve('./src/testing/bootstrap.js')`; a reference without an extension; a directory reference that resolves to `src/testing/index.js`; `config/jest.config.js` with `rootDir: '..'` passed through `--config`; and package.json `"rootDir": "src"` with `<rootDir>/testing/bootstrap.js`. `globalSetup: './scripts/prepare-db.js'` also gave S6, and the user's own run gave `Got error running globalSetup … setup broke`. Gap: an inline JSON `--config` (QA-1.3-41). |
| QA-1.3-30 | verified | resolveEntry was run under node, bun, and `bun --bun run` of a package script. Under the last one, execPath was `C:\Users\MARQUI~1\AppData\Local\Temp\bun-node-0d9b296af\node.exe` and `process.versions.bun` was 1.3.14. With stat, a hard link to bun.exe (`<W>\nodes\hl\node.exe`) first on PATH gave `…\nodejs-lts\current\node.exe` under all three. With that hard link as the only PATH entry, bun and `bun --bun run` gave `S6 node-not-found`; under node, execPath is node and is chosen first. A `bun-node-<hex>` directory on PATH is skipped. Without stat, under bun, the hard link is returned, as documented. An explicit `execPath` that is the hard link is trusted by name (F.1 step 2, documented). |
| QA-1.3-31 | verified | Each of these gave `n=2 exit=0 total=1 complete=true`, while the user's own pytest failed with `WORKERS=3`: `addopts:-n 3` in pytest.ini, tox.ini and setup.cfg; `"add\u006fpts"`; `[tool."py\u0074est".ini_options]`; pytest.toml `"add\u006fpts" = ["-n", "3"]`; `"add\U0000006Fpts"`; `[ tool . pytest . ini_options ]`; and a `[tool.other]` line inside a multi-line string before `addopts`. |
| QA-1.3-31 (behaviour changes) | verified | The quoted keys `"addopts" = "-n 3"` and `'addopts' = '-n 3'` are now read, and each gave `n=2 exit=0` (the user's own run gave `WORKERS=3`). Decoding was compared with tomllib on 22 key and header spellings of `python_files = ["check_*.py"]`. **The adapter reads exactly the spellings tomllib reads as `python_files`**: bare, `"…"`, `'…'`, `\u005f`, `\u005F`, `\U0000005f`, `python_fil\u0065s`, `[tool."pytest".ini_options]`, `[tool.'pytest'."ini_options"]`, `[tool.pytest."ini\u005foptions"]`, a header with a trailing comment, and spaces inside the brackets. It ignores the spellings tomllib reads as another key: `"python\\u005ffiles"`, `"python_files\u0000"`, `"python\tfiles"`, `["tool.pytest".ini_options]` and `[tool.pytest.'ini\u005foptions']`. The spellings tomllib rejects (`\x5f`, `\e`, `\u00`, `\ud800`) give S6 unsupported-argument. Duplicate tables (`addopts` under both `[tool.pytest.ini_options]` and `[tool.pytest]`) give S6, and pytest 9.1.1 itself exits 4 with `Cannot use both [tool.pytest] … and [tool.pytest.ini_options]`. With `-o "addopts=-q"`, the config is still read, so `python_files = check_*.py` applies, and an unreadable `addopts = 3` is then ignored. |
| QA-1.3-32 | verified | This check covers the planner only; the npm behaviour for these spellings is the implementer's evidence. Each of these `.npmrc` spellings gave `S6 unsupported-command "npm workspace(s)" in <.npmrc>` for both `npm test` and `npx vitest run`: `"work\u0073pace"=`, `workspace;note=`, a bare `workspaces`, a BOM before `workspace=`, `'workspace' =`, CRLF lines with tabs around `=`, and a key under `[foo]`. The `[foo]` case is a superset, because npm nests that key under the section. `work\;space=` planned for both commands, which matches how npm reads it. With `npx vitest run`, a host `NPM_CONFIG_WORKSPACE` gave S6, and without it the result was a ScopedSpec. |
| QA-1.3-33 | verified; gaps QA-1.3-39, QA-1.3-40 | With the pytest-django setting `python_files = tests.py test_*.py *_tests.py`, a changed `pkg/tests.py` gave `failingIds=["pkg/tests.py::test_up"]` (user's own run: `1 failed, 1 passed`). A changed module `pkg/str.py` found `pkg/str_tests.py` through `*_tests.py`, and that run failed. Each of the following gave the changed file as the input with `exit=1 total=1 complete=true`, matching the user's own `1 failed`. Config forms: ini continuation lines; `python_files:check_*.py`; a multi-line pyproject array with a comment and a trailing comma; a pyproject string; pytest.toml; native `[tool.pytest]`; setup.cfg; tox.ini. Patterns: the path pattern `tests/*.py`; the sets `check_[a-c]*.py` and `[!_]*_t.py`; `t?_*.py`; and `Check_*.py` against `check_math.py` (win32 folds case). Overrides: `-o python_files=` spelled `-o X`, `-oX`, `-o=X`, `--override-ini=X` and `--override-ini X`; a two-pattern `-o "python_files=x.py check_*.py"`; `-o` inside config addopts; `-o` in host `PYTEST_ADDOPTS`. Also the pytest.toml + pytest.ini release-line union, and `pytest tests` with `tests/pytest.ini`. |
| QA-1.3-34 | verified; nit QA-1.3-42 | A config 4 bytes over 1 MiB gave `S6 config-too-large`, with and without stat, in 1 to 5 ms. This held for a parent pyproject.toml, .npmrc, jest.config.js and playwright.config.js. Configs just under the limit, through `planStaticScoping`: the pytest shapes took 11 to 431 ms under node and 15 to 590 ms under bun, with RSS at most 289 MB. The shapes were `a=1` lines, dotted keys, 200000 nested `[`, quoted keys, tox.ini 4-byte lines, and 262000 continuation lines. The outlier is a jest.config.js of string literals (QA-1.3-42). |
| QA-1.3-35 | verified | readResult at 63fc053 and at a43b87e gave 0 differences on 64 report shapes, under node and under bun. The jest JSON suite names covered forward, back and mixed slashes; the drive letter's case and an all-upper-case path; `..`, `.` and `\\` segments; a trailing dot or space; a `projx` sibling; the cwd itself; another drive; the 8.3 name; `\\?\`; UNC; a relative name; `İ`; and a colon. They also covered posix names, and spec cwds with and without a trailing separator. The junit shapes put runnerCwd below gitRoot and used a lower-case cwd. Timings, old to new: 700 × 20000 failing cases 223 to 116 ms (node) and 1253 to 150 ms (bun); 200000 passing cases 326 to 92 ms (node) and 570 to 58 ms (bun). |
| QA-1.3-36 | verified | With stat, under node, bun and `bun --bun run`: a directory named `<W>\nodes\nd\node.exe` first on PATH is skipped, and so is a drive-less `\Users\…\nodes\nx` entry that holds a link to the real node.exe. A `nodePath` that is that directory or a missing file gives `S6 node path is not a file`. A drive-less `nodePath` gives `S6 node path is not absolute`, with or without stat. An explicit `execPath` of a missing `node.exe` falls through to PATH. Without stat, the directory and the missing paths are returned, as documented (the failure then comes at spawn). |
| QA-1.3-37 | verified as specified; false pass QA-1.3-38 | In the create-vue layout (`exclude: [...configDefaults.exclude, 'e2e/**']`, playwright `testDir: './e2e'`), a changed `e2e/login.spec.js` gave `NoAffected` from both planners. But the exclusion is taken from any `exclude` key in the file, not only `test.exclude` (QA-1.3-38). |

### New findings (round 4)

| id | severity | summary and evidence | fix |
|---|---|---|---|
| QA-1.3-38 | major | **G.8a drops a real vitest test through an `exclude` literal outside `test.exclude`.** Round 3's P entry accepts that a `coverage.exclude` literal counts, because such a file sits in a Playwright testDir "which Playwright itself runs as its own test". That premise fails when Playwright's `testMatch` or `testIgnore` leaves the file out, which is how a repo that shares a directory between the two runners must be set up. Real vitest 4.1.11, with the changed test file made to fail. (a) vitest `test: { include: ['tests/unit/**/*.test.js'], coverage: { exclude: ['tests/**'] } }`, playwright `{ testDir: './tests', testMatch: '**/*.e2e.js' }`, changed `tests/unit/math.test.js`. (b) vitest `coverage: { exclude: ['test/**', 'e2e/**'] }`, playwright `{ testMatch: 'e2e/**/*.pw.js' }` with no testDir (so the testDir is the whole repo), changed `test/math.test.js`. (c) vitest `typecheck: { exclude: ['tests/**'] }`, playwright `{ testDir: './tests', testIgnore: '**/unit/**' }`, changed `tests/unit/math.test.js`. Each gave `{"noAffected":true,"note":"no affected tests: no changed file is a test input"}` from both planners, which Q.2.1 reports as a pass. The user's own `vitest run` gave `exit=1 Test Files 1 failed (1) … expected 3 to be 4`. The results were the same under bun. Playwright was not run; that it skips these files follows from the testMatch and testIgnore shown. | Take vitest exclusions only when the config file has exactly one `exclude` key: count every CONFIG_KEY_RE match, including coverage, typecheck, benchmark and plugin options. Otherwise exclude nothing: the file stays an input, and the zero-test guard makes it unverifiable. Alternatively, drop the rule and have 2.1 confirm with `vitest list --filesOnly --json <file>`. In either case, remove the "Playwright itself runs it" rationale from P, and add (a) to (c) as unit tests and 3.2 fixtures. |
| QA-1.3-39 | minor | **`-c`/`--config-file` in PYTEST_ADDOPTS is not followed.** pytest 9.1.1 prepends PYTEST_ADDOPTS before `determine_setup` (`_pytest/config/__init__.py`, `Config.parse`), so a `-c` there chooses the config file. D.4 reads PYTEST_ADDOPTS for xdist, cap and `-o` evidence, but discards the `configs` that processArgs returns, and looks up the root pytest.ini instead. (a) A python_files false pass. The environment had `PYTEST_ADDOPTS="-c ci/ci.ini --rootdir=."` and `ci/ci.ini` had `python_files = check_*.py`. A broken `tests/check_math.py` gave `{"noAffected":true,"note":"no affected tests: no test files map to the changed modules"}`, and the user's own pytest gave `exit=1 … 1 failed`. (b) S4. With `ci/ci.ini` `addopts = -n 3`, the host-env case produced a spec without `-n` (`n=-`), and the run gave `exit=1 failingIds=["tests/test_workers.py::test_workers"]`: the probe failed, so more than 2 workers ran (the user's own run showed `WORKERS=3`). The same happened through a package script `cross-env PYTEST_ADDOPTS="-c ci/ci.ini --rootdir=." pytest`. The gap is in D.4 from round 1, but (a) is a QA-1.3-33 path. | Treat the last `-c`/`--config-file` across both PYTEST_ADDOPTS sources as the explicit config, in the order pytest sees them. Or return S6 unsupported-argument `"-c" in PYTEST_ADDOPTS`. Add unit tests for the host and cross-env sources. |
| QA-1.3-40 | minor | **pytest's per-argument config fallback is not modelled.** Sometimes nothing sits at or above the common ancestor of the path arguments: no config, no pyproject.toml, no setup.py. pytest 9.1.1 then runs `locate_config` again from each argument (`findpaths.py` `determine_setup`, `if dirs != [ancestor]`). The adapter looks only from the common ancestor, both at detection (pathScopes) and at spec time. (a) `pytest tests/a tests/b`, where `tests/a/pytest.ini` is the only config (`python_files = check_*.py`), with a broken `tests/b/check_math.py`: `NoAffected`. The user's own run gave `exit=1 … 1 failed`. (b) S4. With `tests/a/pytest.ini` `addopts = -n 3`, a plain `pytest`, and changed `tests/a/test_workers.py` and `tests/b/test_b.py`: the spec's inputs have the ancestor `tests`, so no `-n` was appended (`n=-`), and the run gave `exit=1 failingIds=["tests/a/test_workers.py::test_workers"]`, a false failure (the user's own run showed `WORKERS=3`). This needs a repo with no pytest config, pyproject.toml or setup.py at its top, so it is rare. | Handle the case where no release line finds a config from the ancestor, no setup.py lies above it, and the arguments span more than one directory. Either also run the lookup from each argument's directory, taking the union of python_files and the lowest cap as D.4 already does across release lines, or return S6 for that layout. Apply the same rule at spec time to inputs in more than one directory. |
| QA-1.3-41 | minor | **jest's inline JSON `--config` is read as a path, so the setup files it names are not triggers.** jest accepts `--config <path\|json>`. The command was `jest --config '{"setupFilesAfterEnv":["./src/testing/bootstrap.js"]}'`, with `src/testing/bootstrap.js` changed to throw. The adapter gave `inputs=["src/testing/bootstrap.js"] exit=0 total=0 failingIds=[] collectionError=false complete=true`, which is a pass. The user's own jest gave `exit=1 ● Test suite failed to run … setup broke`. The `configFiles` entry is the JSON text resolved as a file name, which never exists. The results were the same under bun. | Take a jest `--config`/`-c` value that starts with `{` and ends with `}` (jest's own test) and scan it with `configLiterals`, with rootDir = runnerCwd. Or return S6 unsupported-argument. Add a unit test. |
| QA-1.3-42 | nit | **Under Bun, scanning a JS config just under the limit takes seconds.** A jest.config.js of 262000 `'a',` literals under `setupFiles` (1 MiB − 64 bytes) took 3645 ms of `planStaticScoping` under bun 1.3.14 and 569 ms under node. The pytest shapes of the same size stayed under 0.6 s. G.7a resolves every literal against up to two bases (a `P.resolve` and a key each). jsConfigFacts also reads every existing `vitest.config.*`/`vite.config.*` (12 names), or `jest.config.*` plus package.json, in each directory from runnerCwd up to gitRoot, so several such files add up. The cost is bounded (QA-1.3-34 works), and it needs a planted config. | Resolve only the literals whose basename (without extension) equals a changed file's stem, or `index` for a directory reference. Or cap the literals per key and return S6 `config-too-large` beyond the cap. |

Checked, no finding:
- Every spawn went through `readResult`. After the node and bun runs, `%TEMP%` held 0 `omr-verify-*` files.
- Planner parity: the pytest sweep (81 lines) and the JS sweep (52 lines) were identical under node 24.21.0 and bun 1.3.14 once durations were masked.
- The python_files union only ever adds inputs. pytest always collects a file given on its command line (`_pytest/python.py`, `pytest_collect_file`, `session.isinitpath`), so classifying too many files as tests never drops a run.
- The fnmatch port follows `fnmatch_ex` (`_pytest/pathlib.py:432`) in every case above: the basename for a pattern without a separator, `*` plus a separator in front of a relative path pattern, and normcase on win32.
- Other JS modules named in a config are not triggers: a jest `transform` or `testEnvironment` file, and a vite plugin that the config imports. This is the plan's accepted "config-driven tests" risk (plan, risk table, L1539). These cases were not re-tested here.

### Deferred by plan

- QA-1.3-16 and QA-1.3-17 (2.1): unchanged.
- 3.1: `uv run pytest` syncing a fresh reference worktree is still unverified, and so is one spec launched from inside opencode under Bun.
- 3.2: fixtures for the new trigger names, the round-3 list, and, once they are fixed, the QA-1.3-38 layouts and the QA-1.3-41 inline config.
- Section P residuals: unchanged, except that the G.8a `coverage.exclude` entry's rationale does not hold (QA-1.3-38).

Status: **not clean.** Open: QA-1.3-38 (major); QA-1.3-39, -40 and -41 (minor); QA-1.3-42 (nit). QA-1.3-29 to -37 are verified.

Cleanup: the 34 junctions under `<W>` (`node_modules` links into `D:\git\omr-p13` and the Spike C jest project) were removed with `rmdir` first,
and the check found 0 reparse points left. Then `<W>` was deleted, together with the hard links it held to `bun.exe` and `node.exe`. The link
targets are intact. `%TEMP%\bun-node-0d9b296af`, which this review's `bun --bun run` probe created, was removed. The final check found 0
`omr-verify-*` files, 0 `bun-node-*` directories, and no process referring to `omr-qa13r4`. The Spike C fixtures were not modified.

### Resolutions (round 4)

Gates after the last fix: `npx vitest run --maxWorkers=2 --coverage --coverage.include=src/verify/runner.ts test/unit/runner.test.ts test/unit/deterministic.test.ts`
gave `Test Files 2 passed (2)`, `Tests 695 passed (695)`, and runner.ts coverage of 99.52% statements, 97.98% branches (1654/1688), 100% functions
and 99.86% lines. `npm run typecheck` was clean. runner.ts still imports no `child_process`.
Contract changes are additive: `DetectedRunner` gains the optional `inlineConfigs`; `PytestFacts` gains the optional `rootdir`; `SETUP_REF_LIMIT`
(1000) is exported; `config-too-large` gains a second reason template, `too many setup references in <path> (limit 1000)`. No S6 code was added.
The G.8a note text `playwright test file excluded by the <runner> config, not run: <rel>` is gone (no consumer read it).
Real-runner checks: runner.ts at abcdb15 ("before") and at 2e55d1e ("after") were driven under bun 1.3.14 from `%TEMP%\omr-fix13r4`. The
planners used the real fs (native realpath, bigint stat) and a search seam backed by `git ls-files` / `git grep`; each fixture was a fresh
directory with its own `git init` and commit. Specs were spawned with `spawnSync(file, args, {shell: false})`, and every run went through
`readResult`. Runners: vitest 4.1.11 (`D:\git\omr-p13\node_modules`, by junction), jest 30.5.2 (Spike C `node_modules`, by junction), pytest
9.1.1 + xdist 3.8.0 (the Spike C venv, through `host.pathEnv`); node v24.21.0 from PATH ran the JS specs. "User's own" is the check command
run by itself in the fixture. Cleanup: the 5 junctions were removed with `rmdir` first (0 reparse points left), then the directory; the link
targets are intact. The final check found 0 `omr-verify-*` files and 0 `bun-node-*` directories in `%TEMP%`, and no process referring to the
scratch directory.

- QA-1.3-38 Resolution: c53656e — The static exclusion is removed, not narrowed (the dispatch's fallback). A sound reading needs vitest's
  `test.exclude` path, `root`/`dir` and `mergeConfig` inputs (create-vue merges an imported vite config) and Playwright's `projects`,
  `testMatch`, `testIgnore` and regex matchers; each is a new way to drop a real test, and the exact answer is available from the runner
  itself. A test file the runner's config excludes is an input again, the pre-round-3 behaviour: an e2e-only change runs 0 tests and the
  zero-test guard (I 2a) makes it unverifiable, never a pass; with a source file in the same change, the source's related tests run.
  Playwright configs are no longer read, and CONFIG_KEY_RE is back to the setup keys and rootDir. Section P now records e2e-only changes
  as unverifiable (the round-3 `coverage.exclude` rationale is gone), and Q 2.1 names `vitest list --filesOnly --json <file>` /
  `jest --listTests --findRelatedTests <file>` as the way 2.1 could turn them into NoAffected. Real vitest 4.1.11, changed test made to
  fail: (a) `coverage: { exclude: ['tests/**'] }` + playwright `testDir: './tests', testMatch: '**/*.e2e.js'`, (b) `coverage.exclude`
  `['test/**', 'e2e/**']` + playwright `testMatch: 'e2e/**/*.pw.js'`, (c) `typecheck: { exclude: ['tests/**'] }` + playwright
  `testIgnore: '**/unit/**'`. Before, each gave `{"noAffected":true,…}`; after, the changed file was the input and the run gave
  `exit=1 total=1 failingIds=["tests/unit/math.test.js > add"]` (b: `test/math.test.js > add`) `complete=true`. The user's own `vitest run`
  gave `exit=1 Test Files 1 failed (1)` for all three. create-vue layout (`exclude: [...configDefaults.exclude, 'e2e/**']`, playwright
  `testDir: './e2e'`), `e2e/login.spec.js` changed: before `NoAffected`; after `inputs=["e2e/login.spec.js"] exit=0 total=0
  complete=false note=vitest ran no tests although a test file was passed` (unverifiable); the user's own run passed. The QA-1.3-37
  unit tests were rewritten: (a)-(c), `test.exclude`, `--exclude` and jest `testPathIgnorePatterns` keep the file as an input.
- QA-1.3-39 Resolution: 2e55d1e — The PYTEST_ADDOPTS value the spawn sees (cross-env, else the host's) is parsed before the config
  lookup. Its last `-c`/`--config-file` is the explicit config unless the command has one, its `-o addopts=`/`-o python_files=` override the
  file's keys (and exempt them from the odd-spelling S6), and its `--rootdir` turns off the QA-1.3-40 fallback; the command's own options
  come later and win. The `-c` file from PYTEST_ADDOPTS is a config trigger. A host value that cross-env replaces is still xdist/cov
  evidence, but its `-p no:xdist` no longer suppresses the appended `-n N` (found while fixing this: the spawn never sees it). Real pytest
  9.1.1 with host `PYTEST_ADDOPTS="-c ci/ci.ini --rootdir=."`: with `python_files = check_*.py` in ci/ci.ini and `tests/check_math.py`
  broken, before `{"noAffected":true,"note":"no affected tests: no test files map to the changed modules"}`, after `inputs=["tests/check_math.py"]
  exit=1 total=1 failingIds=["tests/check_math.py::test_up"] complete=true` (user's own: `exit=1 … FAILED tests/check_math.py::test_up`);
  with `addopts = -n 3` and the `WORKERS<=2` probe, before `n=- exit=1 failingIds=["tests/test_workers.py::test_workers"]`, after
  `n=2 exit=0 total=1 complete=true` (user's own: `exit=1 WORKERS=3`). The host and cross-env sources, the command's `-c` winning, the
  empty cross-env value, the `-p no:xdist` case and the trigger are unit tests.
- QA-1.3-40 Resolution: 2e55d1e — determine_setup's fallback is modelled per release line in `findPytestConfigs`: when the lookup from
  the common ancestor finds no accepted config, no `setup.py` (a file, with stat) lies at or above the ancestor, no `pyproject.toml`
  does either (pytest 9 line only; pytest 8.0 and 7 have no such rule, so the legacy lines ignore it), no `--rootdir` is given (command
  or PYTEST_ADDOPTS; an empty value is none, as pytest's `ns.rootdir or None`), and the argument directories are not just the ancestor,
  each line takes the first accepted config walking up from each argument directory in order. Spec time uses the inputs' directories in
  F's order; detection uses the path arguments in the user's order (python_files). planStaticScoping sees it through the QA-1.3-27
  lookup. Real pytest 9.1.1: (a) `pytest tests/a tests/b`, `tests/a/pytest.ini` with `python_files = check_*.py`, `tests/b/check_math.py`
  broken: before `NoAffected`, after `inputs=["tests/b/check_math.py"] exit=1 total=1 failingIds=["tests/b/check_math.py::test_up"]
  complete=true` (user's own: `exit=1`). (b) plain `pytest`, `tests/a/pytest.ini` with `addopts = -n 3`, changed `tests/a/test_workers.py`
  and `tests/b/test_b.py`: before `n=- exit=1 failingIds=["tests/a/test_workers.py::test_workers"]`, after `n=2 exit=0 total=2
  complete=true`. The setup.py, `--rootdir`, table-less pyproject.toml (pytest 9 line only, shown with a `tests/a/pytest.toml`),
  first-directory-wins and bad-config cases are unit tests.
- QA-1.3-41 Resolution: 5dd8bb2 — A jest `--config`/`-c` value that starts with `{` and ends with `}` (jest-config's isJSONString) is the
  config itself: it is kept out of `configFiles`, recorded in `DetectedRunner.inlineConfigs`, and S6 `unsupported jest argument "<value>" in
  <where>` when JSON.parse rejects it. The setup files it names, at any depth, resolve against runnerCwd and its rootDir and are
  triggers. JSON configs (jest.config.json and package.json's `"jest"`) are now also read with JSON.parse, so JSON escapes in keys and
  paths count (`"setup\u0046iles"`, `"./src/te\u0073ting/…"`), and jest references resolve against every literal rootDir (a superset
  of round 3). Real jest 30.5.2, `jest --config '{"setupFilesAfterEnv":["./src/testing/bootstrap.js"]}'` with bootstrap.js throwing
  `setup broke`: before `inputs=["src/testing/bootstrap.js"] exit=0 total=0 failingIds=[] collectionError=false complete=true` (a pass);
  after `{"unverifiable":true,"code":"config-changed","reason":"config file changed: src/testing/bootstrap.js"}`. The user's own jest gave
  `exit=1 ● Test suite failed to run … setup broke`.
- QA-1.3-42 Resolution: 5dd8bb2 — The cost was path resolution: Bun's `path.win32.resolve` took about 12 µs a call, and every literal
  was resolved against two bases. A reference is now resolved only when its last segment names a changed file (a basename, a stem, or
  the directory of an index file; `""`, `.`, `..`, `<rootDir>` and a drive always resolve), each distinct reference once, and at most
  SETUP_REF_LIMIT (1000) resolutions per plan (references times bases, plus rootDir literals); beyond that, S6 config-too-large `too many
  setup references in <path> (limit 1000)`. The literal scan compares quote characters directly instead of a regex per character.
  `planStaticScoping` under bun 1.3.14, real fs, jest.config.js just under 1 MiB: 262000 `'a',` literals went from 3490-3683 ms to
  149-190 ms (changed `src/math.js` or `src/a.js`, whose stem is `a`); distinct `'d<n>/a',` literals went from 1308-1440 ms to 119 ms
  (changed `src/math.js`) or to the S6 in 89 ms (changed `src/a.js`). A unit test plans a 1 MiB config of literals under 3 s with coverage
  and still finds the real reference in it.

## QA re-review (round 5)

Date: 2026-09-27. Reviewed `git diff abcdb15..HEAD` (c53656e, 5dd8bb2, 2e55d1e, 324b2d7): runner.ts +305/-192, runner.test.ts +226/-64, this
file +75. Unit gate, run once: `npx vitest run --maxWorkers=2 test/unit/runner.test.ts test/unit/deterministic.test.ts` gave `Test Files 2 passed (2)`,
`Tests 695 passed (695)`.

Method: runner.ts at HEAD ("after") and at abcdb15 ("before", from `git cat-file`) were bundled with `bun build --target node` into
`%TEMP%\omr-qa13r5` and driven under **node v24.21.0 and bun 1.3.14**. The planners got the real fs (`fs.promises.realpath` and a bigint
`stat`) and a search seam backed by real `git ls-files` / `git grep`. Specs were spawned with `spawnSync(spec.file, spec.args, {shell:
false})` with the host env plus `spec.env`, and every run went through `readResult`. Runners: vitest 4.1.11 (`D:\git\omr-p13\node_modules`) and
jest 30.5.2 (Spike C `node_modules`), both by junction; pytest 9.1.1 + xdist 3.8.0 (Spike C venv, Python 3.13.11) through `host.pathEnv`.
Each case was a fresh fixture with its own `git init` and commit; the changed file was then broken (`expect(add(1, 2)).toBe(4)`,
`assert 'a'.upper() == 'B'`, or `throw new Error('setup broke')`). Worker probe: `assert PYTEST_XDIST_WORKER_COUNT <= 2` (`WORKERS=<n>`).
"User's own" is the check command run by itself in the fixture. No pytest or setup file exists in any `%TEMP%` ancestor (checked).

### Verification of the round-4 resolutions

| id | verdict | evidence |
|---|---|---|
| QA-1.3-38 | verified | (a) `coverage: { exclude: ['tests/**'] }` + playwright `testDir: './tests', testMatch: '**/*.e2e.js'`, changed `tests/unit/math.test.js`: before `{"noAffected":true,"note":"no affected tests: no changed file is a test input"}`; after `inputs=["tests/unit/math.test.js"] exit=1 total=1 failingIds=["tests/unit/math.test.js > add"] complete=true` (node and bun). User's own: `exit=1 Test Files 1 failed (1)`. create-vue layout, only `e2e/login.spec.js` changed: before `NoAffected`; after `exit=0 total=0 complete=false note=vitest ran no tests although a test file was passed` (unverifiable, never a pass). With `src/math.js` also changed: after `inputs=["e2e/login.spec.js","src/math.js"] exit=0 total=1 complete=true`, and the user's own run passed. jest `testPathIgnorePatterns: ['/node_modules/', '/e2e/']`, only `e2e/login.spec.js` changed: `total=0 complete=false note=jest ran no tests although a test file was passed`. |
| QA-1.3-39 | verified | Host `PYTEST_ADDOPTS="-c ci/ci.ini --rootdir=."`, `python_files = check_*.py`, broken `tests/check_math.py`: before `NoAffected`; after `exit=1 total=1 failingIds=["tests/check_math.py::test_up"] complete=true`. The same env with `addopts = -n 3`: before `n=- exit=1 … WORKERS=3`; after `n=2 exit=0 total=1 complete=true`. Also verified: host `-o "addopts=-n 3"` (before `n=- … WORKERS=3`, after `n=2 exit=0`); `cross-env PYTEST_ADDOPTS="-c ci/ci.ini --rootdir=." pytest` (before `n=- … WORKERS=3`, after `n=2 exit=0`); host `-p no:xdist` replaced by `cross-env PYTEST_ADDOPTS=-q` with config `-n 3` (before `n=- … WORKERS=3`, after `n=2 exit=0`). The user's own run failed with `WORKERS=3` in every worker case. Identical under node and bun. |
| QA-1.3-40 | verified; cost nit QA-1.3-47 | (a) `pytest tests/a tests/b`, `tests/a/pytest.ini` `python_files = check_*.py`, broken `tests/b/check_math.py`: before `NoAffected`; after `exit=1 total=1 failingIds=["tests/b/check_math.py::test_up"] complete=true` (user's own: `1 failed, 1 passed`). (b) plain `pytest`, `tests/a/pytest.ini` `addopts = -n 3`, changed `tests/a/test_workers.py` + `tests/b/test_b.py`: before `n=- exit=1 … WORKERS=3`; after `n=2 exit=0 total=2 complete=true`. With `tests/b/test_b.py` failing in that layout, pytest's rootdir moves to `tests/a` and the case comes back unmapped: `failingIds=["::test_up"] complete=false` (fail-closed, as QA-1.3-22). The installed pytest confirms the modelled rules: `findpaths.py:317` `if rootdir is None and rootdir_cmd_arg is None`, `:323` `if dirs != [ancestor]`, `__init__.py:1537` `rootdir_cmd_arg=ns.rootdir or None`. |
| QA-1.3-41 | verified; nit QA-1.3-46 | `jest --config '{"setupFilesAfterEnv":["./src/testing/bootstrap.js"]}'`, bootstrap throwing: before `exit=0 total=0 failingIds=[] complete=true` (a pass); after `{"unverifiable":true,"code":"config-changed","reason":"config file changed: src/testing/bootstrap.js"}`. Inline `{"rootDir":"src","setupFilesAfterEnv":["./testing/bootstrap.js"]}`: before a pass, after the same S6. `--config '{setupFiles:1}'`: after `S6 unsupported-argument: unsupported jest argument "{setupFiles:1}" in command` (jest itself: `There was an error while parsing the --config argument as a JSON string`). jest.config.json `"setup\u0046ilesAfterEnv": ["./src/te\u0073ting/bootstrap.js"]`: before a pass, after S6 config-changed. The user's own jest gave `exit=1 ● Test suite failed to run … setup broke` each time. A `<rootDir>` inside an inline config on the command line is S6 `composite` (`<` reads as a redirection), so that spelling fails closed before G.7a. Gap: a jest.config.json with a comment (QA-1.3-46). |
| QA-1.3-42 | verified | `planStaticScoping`, jest.config.js just under 1 MiB: 262000 `'a',` literals, changed `src/a.js`: bun 3670-3938 ms before, 103-126 ms after; node 502-594 ms before, 106-168 ms after. 93000 distinct `'d<n>/a',` literals: bun 1375-1642 ms and node 272-302 ms before; after 57-197 ms (changed `src/math.js`) or `S6 config-too-large: too many setup references in …\jest.config.js (limit 1000)` in 131-613 ms (changed `src/a.js`). The `wanted` filter was checked on 14 reference spellings, before and after, both runtimes, with identical plans: `<rootDir>/…/bootstrap.js`, no extension, a directory, a directory with a trailing `/`, `…/index`, `.\\src\\testing\\bootstrap.js`, `./SRC/Testing/BOOTSTRAP.JS`, `rootDir: 'src'` with `<rootDir>/…` and with `./…`, package.json `"jest"`, a `..` segment, and `--config config/jest.config.js` with `rootDir: '..'` all gave S6 config-changed. Two gave a ScopedSpec both before and after: a scalar `globalSetup: require.resolve(…)` (QA-1.3-45) and `bootstrap.js/.` (contrived, not flagged). |

### New findings (round 5)

The round-4 fixes are sound, and the only defects that come from the diff are two nits (QA-1.3-46, QA-1.3-47). The rest are false passes
that predate this diff. The real-runner sweep found them next to the code this diff reworked (pytest config choice and G.7a references).
Each one gives the same result before and after.

| id | severity | summary and evidence | fix |
|---|---|---|---|
| QA-1.3-43 | major | **Pre-existing (D.4, QA-1.3-3c): pytest picks a nearer config for the spec than for the user's run, and that config deselects the failing test.** The spec passes the inputs as file arguments, so pytest's `locate_config` starts from their common ancestor and takes the first config above it. A nested `pytest.ini`, or a package `pyproject.toml` with a pytest table, wins over the root config the user's own run reads. D.4 reads that config only for the cap, xdist and python_files. Its `addopts` (`-m`, `-k`, `--deselect`, `--ignore`) and collection keys (`python_functions`, `python_classes`) still apply to the spawn. (a) Monorepo: root `pyproject.toml` `[tool.pytest.ini_options]`; `packages/foo/pyproject.toml` with `addopts = "-m 'not integration'"`; command `pytest packages`; changed `packages/foo/tests/test_x.py`, whose `@pytest.mark.integration test_db` fails. Adapter: `exit=0 total=1 failingIds=[] complete=true` (pytest: `1 passed, 1 deselected`), which Q.2.1 reports as green. User's own `pytest packages`: `exit=1 FAILED packages/foo/tests/test_x.py::test_db … 1 failed, 1 passed`. (b) Root `pytest.ini` plus `tests/unit/pytest.ini` with `addopts = -m "not slow"`; command `pytest`: the same pass against the user's `1 failed, 1 passed`. Before and after give the same result, under node and bun. | Make the spawn read the config the user's run reads. Either (1) pin it: at detection, record the file every release line picks for the user's run (runnerCwd, or the path-argument ancestor with the QA-1.3-40 fallback), and add `-c <file> --rootdir=<user's rootdir>` to the spec (S6 when the lines disagree, or when the user's run reads no file but the inputs' lookup finds one). Or (2) at spec time, return S6 `unsupported-argument` when the inputs' lookup (`pytestAtInputs`) finds a different config set from the user's run. Option (1) also makes the spec-time lookup and the QA-1.3-40 modelling unnecessary. Add (a) and (b) as unit tests and 3.2 fixtures. |
| QA-1.3-44 | minor | **Pre-existing (G.7a, 5920ea5): setup files named by a project's own config are not triggers, under jest or vitest.** jsConfigFacts reads configs only from runnerCwd up to gitRoot, the `--config` file and the inline config. A project directory's config is never read. jest: root `jest.config.js` `projects: ['<rootDir>/packages/a']`; `packages/a/jest.config.js` `setupFilesAfterEnv: ['<rootDir>/testing/boot.js']`; `packages/a/testing/boot.js` changed to throw. vitest: root `vitest.config.mjs` `test: { projects: ['packages/a'] }`; `packages/a/vitest.config.mjs` `setupFiles: ['./testing/boot.js']`. Adapter, both runners, before and after, node and bun: `inputs=["packages/a/testing/boot.js"] exit=0 total=0 failingIds=[] complete=true` (a pass). User's own: jest `exit=1 ● Test suite failed to run … setup broke`; vitest `exit=1 Test Files 1 failed (1) … Error: setup broke`. So section P's "vitest setup files under other names: correct at full cost" does not hold under `projects`: `vitest related` ran 0 tests. Conventional names (`jest.setup.js`, `test/setup.ts`) are still caught by the G.7 name rule. | In jsConfigFacts, also read the `vitest.config.*`/`vite.config.*` (vitest) or `jest.config.*`/package.json (jest) in each directory from every changed file's directory up to gitRoot. Resolve their references against that directory, which is a project's root and default rootDir. That covers project configs without modelling `projects` globs. It stays bounded by CONFIG_SIZE_LIMIT and SETUP_REF_LIMIT. For inline project objects, add each literal `root` (vitest) or `rootDir` (jest, already done) as a base. Correct the P entry. Add both layouts to 3.2. |
| QA-1.3-45 | minor | **Pre-existing (G.7a): two literal reference forms are missed.** (a) The jest CLI `--rootDir` (a kept argument) overrides the config's rootDir, which jest-config's `setFromArgv` applies before normalize. It is not a base, so `<rootDir>/…` resolves against the config's directory. `jest --rootDir src` with `jest.config.js` `setupFilesAfterEnv: ['<rootDir>/testing/bootstrap.js']`, bootstrap changed to throw: before and after `inputs=["src/testing/bootstrap.js"] exit=0 total=0 complete=true`; user's own `exit=1 ● Test suite failed to run … setup broke`. (b) A scalar call value: `globalSetup: require.resolve('./src/testing/bootstrap.js')`. configLiterals reads only a quote or `[` after the key, although G.7a's comment says calls such as `require.resolve('./x')` are included. Before and after: `exit=0 total=0 complete=true`; user's own `exit=1 Jest: Got error running globalSetup - …\src\testing\bootstrap.js, reason: setup broke`. Both forms need an unconventional file name. | (a) jest: add the last `--rootDir` in keptArgs, resolved against runnerCwd, as a base for every config's references and as `<rootDir>`. (b) For a scalar value, scan the expression up to the next `,` or `}` at depth 0 for string literals, as the array branch already does, so `require.resolve('…')` and `path.resolve(__dirname, '…')` count. Unit tests for both. |
| QA-1.3-46 | nit | **5dd8bb2's JSON path fails open when a jest.config.json has comments.** jest-config reads JSON configs as `parseJson(stripJsonComments(fileContent))` (`jest-config/build/index.js:2367`), so a commented jest.config.json is valid for jest. `parseJson` in runner.ts returns undefined for it, and only the undecoding text scan remains. A config `{ // local setup` + `"setup\u0046ilesAfterEnv": ["./src/testing/bootstrap.js"] }`, bootstrap changed to throw: before and after `exit=0 total=0 complete=true`; user's own `exit=1 … setup broke`. It needs a comment and a `\u` escape in the key or path. | Strip `//` and `/* */` comments outside strings before JSON.parse for `.json` configs, as jest does, or give S6 unsupported-argument when a jest `.json` config still does not parse. Add a unit test. |
| QA-1.3-47 | nit | **2e55d1e's fallback costs about 8 fs checks per distinct input directory, before the argv-too-long check.** No pytest config, pyproject.toml or setup.py anywhere, one changed test file per directory, `planScopedRun` with real fs. 250 directories: node 108-124 ms → 442-505 ms, bun 160-205 ms → 986-1076 ms (`fileExists` calls 315 → 2214). 2000 directories: `planStaticScoping` node 830-1347 ms → 3373-3895 ms, bun 1885-2095 ms → 7519-7783 ms (2065 → 16214 calls). `planScopedRun` spends the same (bun 7821 ms) before returning `S6 argv-too-long: too many inputs for one command line: 2000 files`. The cost is linear, and pytest makes the same lookups itself. | Check the argv length before `pytestAtInputs`: it does not depend on the evidence beyond the `-n N`/`--no-cov` tokens, so take the worst case. Stop each fallback walk below `start`, since the first walk already covered start and its parents. Optional: drop the fallback walks if QA-1.3-43 is fixed by pinning. |

Checked, no finding:
- The QA-1.3-42 budget multiplies references by every rootDir of a file. A jest.config.js of 499 inline projects, each with its own `rootDir` and the shared `<rootDir>/test/setup.ts`, plans; 500 gives `S6 config-too-large: too many setup references` for a change to app code `src/setup.ts`. It fails closed and needs an unrealistic config.
- 2e55d1e: a host `PYTEST_ADDOPTS` that cross-env replaces is still parsed and can still return S6 (a positional, say). This predates the diff and fails closed. An empty `--rootdir=` on the command line overrides a `--rootdir` in PYTEST_ADDOPTS and re-enables the fallback, as pytest's `ns.rootdir or None` does.
- c53656e: CONFIG_KEY_RE no longer consumes `projects`/`exclude` values, so a `setupFiles` literal inside an inline project object is now read rather than skipped. That only adds triggers; its base is QA-1.3-44.
- Every spawn went through `readResult`. The node and bun plans were identical in every case apart from timings.

### Deferred by plan

- QA-1.3-16 and QA-1.3-17 (2.1): unchanged. The round-5 runs left 0 `omr-verify-*` files in `%TEMP%`.
- 3.1: `uv run pytest` syncing a fresh reference worktree is still unverified, and so is one spec launched from inside opencode under Bun
  (QA-1.3-30's PATH).
- 3.2: fixtures for the new trigger names, the round-3 and round-4 lists, the QA-1.3-38 layouts (a)-(c) and the create-vue e2e-only change
  (unverifiable), the QA-1.3-41 inline config, and, once fixed, the QA-1.3-43 monorepo, the QA-1.3-44 project layouts and the QA-1.3-45 forms.
- Section P residuals: unchanged, except that the "custom forceRerunTriggers … correct at full cost" rationale fails under vitest
  `projects` (QA-1.3-44).

Status: **not clean.** Open: QA-1.3-43 (major); QA-1.3-44 and -45 (minor); QA-1.3-46 and -47 (nit). QA-1.3-38 to -42 are verified. The
diff introduced only the two nits; the major and minor findings predate it and give the same results before and after.

Cleanup: the 27 junctions under `%TEMP%\omr-qa13r5` (`node_modules` links into `D:\git\omr-p13` and the Spike C jest project) were removed with
`rmdir` first, and the check found 0 reparse points left. Then the directory was deleted; the link targets are intact. No `bun --bun run`
probe was needed this round. The final check found 0 `omr-verify-*` files and 0 `bun-node-*` directories in `%TEMP%`, and no process
referring to `omr-qa13r5`. The Spike C fixtures were not modified (`git status` clean in the jest project).

### Resolutions (round 5)

Gates after the last fix: `npx vitest run --maxWorkers=2 --coverage --coverage.include=src/verify/runner.ts test/unit/runner.test.ts test/unit/deterministic.test.ts`
gave `Test Files 2 passed (2)`, `Tests 724 passed (724)`, and runner.ts coverage of 99.4% statements (2014/2026), 97.82% branches (1797/1837),
100% functions (212/212) and 99.87% lines (1597/1599). `npm run typecheck` was clean. runner.ts still imports no `child_process`.
Contract changes are additive: no exported type changed (`ChangedPath`, `StaticScoping`, `DetectedRunner` and `S6Code` are as before), and
no S6 code was added. `unsupported-argument` gains four reason templates (M.1): `unsupported pytest config for the scoped inputs: <file|none>
instead of <file|none>`, `unsupported pytest rootdir: the pytest releases pick <a> or <b>`, `unsupported pytest rootdir: pytest expands
variables in <dir>`, and `unsupported <vitest|jest> config: <path> does not parse as JSON`. Behaviour changes a consumer can see: a pytest
spec now carries `--rootdir=<dir>` (and `-c <config>` when every release reads the same accepted one) after `--maxfail=0`; for vitest and
jest, more than SEARCH_LIMIT gone modules or inputs whose paths alone overflow the command line are S6 before any config is read, so such a
change reports `too-many-searches`/`argv-too-long` even when it also touches a config; planStaticScoping now reports `argv-too-long` for such
changes (both runners) where it used to report `scopable`.
Real-runner checks: runner.ts at 6449655 ("before") and at afabb45 ("after") were bundled with `bun build --target node` and driven under
node v24.21.0 and bun 1.3.14 from `%TEMP%\omr-fix13r5`. The planners got the real fs (native realpath, bigint stat) and a search seam
backed by `git ls-files` / `git grep`; each fixture was a fresh directory with its own `git init` and commit, and the changed file was then
broken. Specs were spawned with `spawnSync(file, args, {shell: false})` and every run went through `readResult`. Runners: pytest 9.1.1 +
xdist 3.8.0 (the Spike C venv, through `host.pathEnv`), jest 30.5.2 (Spike C `node_modules`, by junction), vitest 4.1.11
(`D:\git\omr-p13\node_modules`, by junction). "User's own" is the check command run by itself in the fixture; `pin=` lists a pytest
spec's arguments between `--maxfail=0` and `--`. The determine_setup model was
checked against the source of pytest 7.0.0, 7.4.4, 8.0.0, 8.1.0 (wheels unpacked, not installed) and 9.1.1: every release takes the -c file's
directory as the rootdir, only 8.1+ has the table-less pyproject.toml rule, and a `--rootdir` skips the setup.py rule and the fallback in all
of them; the conftest cutoff is the inifile's directory, else the rootdir (8.0+; 7.x: the inifile's directory or none).

- QA-1.3-43 Resolution: 64799b1 — The spec is pinned to the config the user's run reads. determine_setup is modelled per release
  (PYTEST_SETUPS: pytest 9, 8.1-8.4, 8.0/7.x, 7.0), including the 8.1+ rule that a table-less pyproject.toml becomes the inifile and the
  rootdir. At spec time the user's run is looked up again (runnerCwd and the path arguments; a rerun moves both into its tree), the xdist,
  cap, cov and python_files evidence comes from what it reads, and the spec adds `--rootdir=<the user's rootdir>` unless the command or
  PYTEST_ADDOPTS gives one (the releases must agree on it, else S6), and `-c <config>` when every release reads the same accepted config;
  then the inifile, the ini values, the rootdir and the conftest cutoff all match on every release. A -c/--config-file from the command or
  PYTEST_ADDOPTS is already seen by the spawn, so nothing is added. The no-config case, checked as asked: pinning `--rootdir` alone does
  not stop pytest's own locate_config from the inputs' ancestor, so where no single file can be pinned (the releases read different
  files, a table-less pyproject.toml, or none) the spawn's lookup from the inputs' ancestor must give every release the inifile the user's
  run has, none included, else S6 `unsupported pytest config for the scoped inputs: <file> instead of <file|none>`. This keeps pytest.toml
  (pytest 9 only) scopable. A rootdir with `$` (or `%` on win32) is S6, since pytest applies `os.path.expandvars` to `--rootdir`. A
  DetectedRunner without pytestFacts has its kept `-c`/`--rootdir` read back, so neither is doubled. Real pytest 9.1.1, changed file broken:
  (a) monorepo, root `pyproject.toml` table, `packages/foo/pyproject.toml` `addopts = "-m 'not integration'"`, `pytest packages`: before
  `exit=0 total=1 failingIds=[] complete=true` (a pass); after `pin=["-c","pyproject.toml","--rootdir=."] exit=1 total=2
  failingIds=["packages/foo/tests/test_x.py::test_db"] complete=true`; user's own `exit=1 FAILED packages/foo/tests/test_x.py::test_db …
  1 failed, 1 passed`. (b) root `pytest.ini` plus `tests/unit/pytest.ini` `addopts = -m "not slow"`, `pytest`: before a pass; after
  `pin=["-c","pytest.ini","--rootdir=."] exit=1 total=2 failingIds=["tests/unit/test_s.py::test_slow"] complete=true`; user's own `exit=1
  … 1 failed, 1 passed`. No root config, only `tests/unit/pytest.ini` with the same addopts: before a pass; after `S6
  unsupported-argument: unsupported pytest config for the scoped inputs: …\tests\unit\pytest.ini instead of none`; user's own `exit=1`
  (plain `pytest` never reads that file). Root table-less `pyproject.toml`: after `pin=["--rootdir=."] exit=1
  failingIds=["tests/test_a.py::test_up"] complete=true`, as the user's own. Root `pytest.ini` `addopts = -n 3` with the worker probe:
  after `pin=["-c","pytest.ini","--rootdir=.","-n","2"] exit=0` (user's own `WORKERS=3`). Identical under node and bun. Unit tests: (a),
  (b), the rerun tree, no config, a table-less pyproject.toml, pytest.toml, the honoured -c/--rootdir (command, PYTEST_ADDOPTS, kept
  arguments), the rootdir disagreement, `$`/`%` rootdirs, and the fs-root rootdir.
  The QA-1.3-40 modelling is kept for the user's run only: with `--rootdir` pinned the spawn never falls back, so the spec-time walks over
  the inputs' directories are gone. That changes two round-4 results, both towards the user's run. QA-1.3-40 (a) `pytest tests/a tests/b`:
  the user's run falls back to `tests/a/pytest.ini` with rootdir `tests/a`, so the spec now pins both; pytest writes `classname=""` for
  `tests/b/check_math.py` outside that rootdir, and the run reads `exit=1 failingIds=["::test_up"] complete=false` (was `complete=true`),
  never a pass; user's own `exit=1`. QA-1.3-40 (b) plain `pytest`: the user's run does not fall back and reads no config, so the spec now
  gets `--rootdir=.` and no `-n` (was `-n 2` from `tests/a/pytest.ini`); after `exit=0 total=2`, as the user's own `2 passed`. The QA-1.3-40
  unit tests were rewritten to these semantics (path arguments for the fallback, the user's order, setup.py, `--rootdir`, empty
  `--rootdir=`, a table-less pyproject.toml that now splits the releases' rootdirs -> S6, and a bad fallback config).
- QA-1.3-44 Resolution: d1eec4f — jsConfigFacts also reads the vitest (`vitest.config.*`, `vite.config.*`) or jest (`jest.config.*`,
  package.json) configs in every directory from each changed JS/TS module that is not a test file, existing or gone, up to gitRoot, with
  that directory as a base; vitest's literal `root` values (inline projects) are bases too, against the config's directory and runnerCwd.
  The directories are deduplicated (each walk stops at the first directory already listed). To keep the reads bounded, the S6s a large
  change reaches without them come first: more than SEARCH_LIMIT gone modules, or existing inputs whose quoted paths alone exceed
  MAX_ARGV_CHARS. `planStaticScoping` with real fs, 250 changed modules in 250 directories (vitest): node 77-101 ms before, 177-191 ms after;
  bun 146-390 ms before, 217-284 ms after (fileExists 265 -> 3265 under node). 400 such modules: before `scopable` in 122-142 ms (node) and
  196-204 ms (bun); after `S6 argv-too-long` in 120-133 ms and 143-153 ms, with 401 fileExists and no config probe. Section P no longer says
  a vitest setup file under another name is "correct at full cost": under `projects`, `vitest related` runs 0 tests for it; the residual is
  a non-literal reference or a project config outside the file's own directory chain (`../../shared/boot.js`). Real runners, changed
  `packages/a/testing/boot.js` made to throw: jest (root `projects: ['<rootDir>/packages/a']`, `packages/a/jest.config.js`
  `setupFilesAfterEnv: ['<rootDir>/testing/boot.js']`) and vitest (root `test: { projects: ['packages/a'] }`,
  `packages/a/vitest.config.mjs` `setupFiles: ['./testing/boot.js']`): before `inputs=["packages/a/testing/boot.js"] exit=0 total=0
  failingIds=[] complete=true` (a pass) for both; after `S6 config-changed: config file changed: packages/a/testing/boot.js` for both.
  User's own: jest `exit=1 ● Test suite failed to run … setup broke`; vitest `exit=1 Test Files 1 failed (1) … Error: setup broke`. A
  plain vitest source change still runs its related test (`exit=1 failingIds=["test/math.test.js > add"]`, before and after). Unit tests:
  both layouts, a deleted setup file, an inline project's `root`, which changed files add directories, and the cheap S6s reading no config.
- QA-1.3-45 Resolution: d1eec4f — (a) the last jest `--rootDir`/`--root-dir` in keptArgs, resolved against runnerCwd, is a base for every
  config's references and a `<rootDir>` (jest-config's setFromArgv puts it over the config's rootDir). (b) configLiterals scans a key's
  value as a whole expression, up to the next `,` or `;` at depth 0 or the bracket that closes the enclosing object, and takes every
  string literal in it, so `require.resolve('./x')`, `path.resolve(__dirname, 'x')`, a ternary's branches and nested arrays count; a
  template with `${`, a comment and an unterminated string are handled as before. The budget of QA-1.3-42 counts the new bases before any
  root literal is resolved. Real jest 30.5.2, bootstrap made to throw: `jest --rootDir src` with `setupFilesAfterEnv:
  ['<rootDir>/testing/bootstrap.js']`, and `globalSetup: require.resolve('./src/testing/bootstrap.js')`: before `inputs=
  ["src/testing/bootstrap.js"] exit=0 total=0 complete=true` for both; after `S6 config-changed: config file changed:
  src/testing/bootstrap.js` for both. User's own: `exit=1 ● Test suite failed to run … setup broke` and `exit=1 Jest: Got error running
  globalSetup - …\src\testing\bootstrap.js, reason: setup broke`. Unit tests: three `--rootDir` spellings, five value shapes, and where a
  value ends.
- QA-1.3-46 Resolution: afabb45 — JSON configs go through strip-json-comments' rules (the version jest-config uses: `//` and block
  comments outside strings become whitespace, an escaped quote does not end a string, an unterminated comment runs to the end) before
  JSON.parse. A `.json` config that still does not parse is S6 `unsupported <runner> config: <path> does not parse as JSON`, since jest
  fails the user's run on it; an unparseable package.json is skipped, as jest's own lookup (`getPackageJsonJestKey`) skips it. Real jest
  30.5.2: `jest.config.json` `{ // local setup` + `"setup\u0046ilesAfterEnv": ["./src/testing/bootstrap.js"] }`, bootstrap made to throw:
  before `exit=0 total=0 complete=true`; after `S6 config-changed: config file changed: src/testing/bootstrap.js`; user's own `exit=1 ● Test
  suite failed to run … setup broke`. `jest.config.json` `{ "testEnvironment": "node", }` with a source change: before `exit=1
  complete=false note=runner exited 1 without a usable report`; after `S6 unsupported-argument: unsupported jest config: …\jest.config.json
  does not parse as JSON`; user's own `exit=1 JSONError: Expected double-quoted property name in JSON …`. The round-4 unit test that kept
  the literal scan for an unparseable jest.config.json now expects this S6; new tests cover line, block, trailing and unterminated
  comments, markers inside strings, escaped quotes, and package.json.
- QA-1.3-47 Resolution: 64799b1 — With the rootdir pinned (QA-1.3-43) the spec-time lookup no longer walks from each input directory; the
  user's fallback walks stop below the ancestor, which the first walk covered; and a lower bound of the pytest argv (without `-n N`,
  `--no-cov` and the pin) is checked before the lookup in planScopedRun, planStaticScoping (over the test inputs it knows) and planRerun.
  2000 directories, one test file each, no config anywhere, real fs: `planScopedRun` node 1668-1753 ms -> 714-920 ms and bun 4353-4597 ms
  -> 767-803 ms; `planStaticScoping` node 1761-2122 ms -> 699-1612 ms and bun 4598-5817 ms -> 782-834 ms; fileExists 16074 -> 2074 (the
  2000 existence checks of the changed files remain). Both planners now return `S6 argv-too-long: too many inputs for one command line:
  2000 files` (planStaticScoping used to return `scopable`). A unit test plans 2000 inputs in 2000 directories: planScopedRun makes fewer
  than 2100 fs checks, and planScopedRun, planStaticScoping and planRerun all return that S6.

Cleanup: the fixture junctions under `%TEMP%\omr-fix13r5` (`node_modules` links into `D:\git\omr-p13` and the Spike C jest project) were
removed with `rmdir` first and the check found 0 reparse points left; then the directory, with the unpacked pytest wheels, was deleted. The
link targets are intact and the Spike C fixtures were not modified. The final check found 0 `omr-verify-*` files and 0 `bun-node-*`
directories in `%TEMP%`, and no process referring to `omr-fix13r5`.

## QA re-review (round 6)

Date: 2026-09-27. Reviewed `git diff 6449655..HEAD` (64799b1, d1eec4f, afabb45, 891e81a): runner.ts +514/-180, runner.test.ts +263/-33, this
file +109. Unit gate, run once: `npx vitest run --maxWorkers=2 test/unit/runner.test.ts test/unit/deterministic.test.ts` gave `Test Files 2 passed (2)`,
`Tests 724 passed (724)`.

Method: runner.ts at HEAD ("after") and at 6449655 ("before", from `git show`) were bundled with `bun build --target node` into
`%TEMP%\omr-qa13r6` and driven under **node v24.21.0 and bun 1.3.14**, with the round-5 seams: real fs (`fs.promises.realpath`, bigint
`stat`), a search seam on real `git ls-files` / `git grep`, specs spawned with `spawnSync(spec.file, spec.args, {shell: false})` and every run
read through `readResult`. Runners: pytest 9.1.1 + xdist 3.8.0 (Spike C venv); uv venvs (Python 3.12) with pytest 7.0.1, 7.4.4, 8.0.2, 8.1.1,
8.4.2 (+ pytest-cov 7.1.0) and 9.1.1 + pytest-cov 7.1.0; jest 30.5.2 (Spike C `node_modules`) and vitest 4.1.11 (`D:\git\omr-p13\node_modules`),
both by junction. Each case was a fresh fixture with its own `git init` and commit; the changed file was then broken (`assert 'a'.upper() ==
'B'`, `return a - b`, `throw new Error('setup broke')`). "User's own" is the check command run in the fixture (JS with the fixture's
`node_modules\.bin` on PATH). `pin=` lists a pytest spec's arguments between `--maxfail=0` and `--`, relative to the fixture. All 48 plans
and run results of this round were identical under node and bun apart from timings.

### Verification of the round-5 resolutions

| id | verdict | evidence |
|---|---|---|
| QA-1.3-43 | verified for the reported layouts; residual QA-1.3-48; regression QA-1.3-49 | (a) root `[tool.pytest.ini_options]`, `packages/foo/pyproject.toml` `addopts = "-m 'not integration'"`, `pytest packages`: before `exit=0 total=1 failingIds=[] complete=true` (`1 passed, 1 deselected`); after `pin=["-c","pyproject.toml","--rootdir=."] exit=1 total=2 failingIds=["packages/foo/tests/test_x.py::test_db"] complete=true` with pytest 9.1.1 and with 7.0.1; user's own `1 failed, 1 passed`. (b) root pyproject table plus `tests/unit/pytest.ini` `-m "not slow"`, cwd given in its 8.3 spelling `C:\Users\MARQUI~1\…`: `pin=["-c",<long path>\pyproject.toml,"--rootdir=<long path>"] exit=1 failingIds=["tests/unit/test_s.py::test_slow"] complete=true`; user's own `rootdir: C:\Users\MARQUI~1\…`, `1 failed, 1 passed`. Root `pytest.ini` plus the nested one through `planRerun`: `pin=["-c","pytest.ini","--rootdir=."] exit=1 failingIds=["tests/unit/test_s.py::test_slow"]`. Only `tests/unit/pytest.ini`: before `exit=5 total=0 complete=false`; after `S6 … tests\unit\pytest.ini instead of none`; user's own `1 failed`. 18 realistic layouts (QA-1.3-49): 14 are scoped, pinned, and find the broken test with `complete=true`, as the user's own run does (same `rootdir:`/`configfile:`), on 9.1.1; 9 of them also on 8.1.1, 8.0.2 and 7.0.1. Root conftest fixtures (no config; table-less pyproject) and `tests/conftest.py` under a nested test directory resolved on 7.0.1, 8.0.2, 8.1.1 and 9.1.1. Rootdir `sp ace ünï 漢`: `pin=["-c","pytest.ini","--rootdir=."] exit=1 … complete=true`. `a$b` and `a%TEMP%b`: `S6 unsupported pytest rootdir: pytest expands variables in …` while the user's own run works (by design, rare). `pytest tests/a tests/b` with only `tests/a/pytest.ini`: a failure in `tests/b` gives `pin=["-c","tests/a/pytest.ini","--rootdir=tests/a"] exit=1 failingIds=["::test_up"] complete=false note=pytest classname not mapped to a test file` (the user's own prints `rootdir: …\tests\a` and `FAILED tests\a\test_b.py::test_up`); a passing change in `tests/b`, or in both directories, gives `exit=0 total=2`/`total=3 complete=true`. So complete=false needs a failure outside the pinned rootdir, which needs a config inside the first path argument and none at or above the arguments' ancestor. It never hides a failure, passes stay verified, and the layout is rare: acceptable. |
| QA-1.3-44 | verified; cost nit QA-1.3-51 | jest root `projects: ['<rootDir>/packages/*']`, project config in `packages/a/package.json` `"jest": {"setupFilesAfterEnv": ["<rootDir>/testing/boot.js"]}`, boot.js made to throw: before `inputs=["packages/a/testing/boot.js"] exit=0 total=0 complete=true` (a pass); after `S6 config-changed: config file changed: packages/a/testing/boot.js`; user's own `● Test suite failed to run … setup broke`. vitest `test.projects: ['apps/*']`, `apps/web/vite.config.mjs` `setupFiles: [path.resolve(__dirname, 'src/testing/init.js')]`, changed init.js: before `exit=0 total=0 complete=true` (0 tests run for it, a pass whatever it contains); after `S6 config-changed`. No new false S6 on these repos: a plain source change in `packages/a` (own vitest.config with `setupFiles`), `packages/b` (own vitest.config without), the Vite app (its config also has `root: __dirname`, an alias `path.resolve(__dirname, './src')`, a proxy URL `'http://localhost:3000/'` and a comment naming `setupFiles`) and the jest project ran their related test as before, e.g. `inputs=["packages/a/src/math.js"] exit=1 failingIds=["packages/a/test/math.test.js > add"] complete=true`. |
| QA-1.3-45 | (a) verified; (b) verified for one literal per call; residual QA-1.3-50 | (a) `jest --root-dir=src --config jest.config.js`, `setupFilesAfterEnv: ['<rootDir>/testing/bootstrap.js']`, bootstrap throwing: before `exit=0 total=0 complete=true`; after `S6 config-changed: config file changed: src/testing/bootstrap.js`; user's own `● Test suite failed to run … setup broke`. (b) `globalSetup: path.resolve(__dirname, 'src/testing/bootstrap.js')`, and a two-line ternary `process.env.CI ? require.resolve('./src/testing/ci.js') : require.resolve('./src/testing/bootstrap.js')`: after S6 config-changed; user's own `Error: Jest: Got error running globalSetup - …\src\testing\bootstrap.js, reason: setup broke`. |
| QA-1.3-46 | verified | runner.ts's `stripJsonComments` against strip-json-comments 3.1.1 (jest-config's copy): 300000 random strings over `"`, `\`, `/`, `*`, `\n`, `\r`, `a`, space, `{`, `}`, `:`, `,` (length 1-24) gave byte-identical output and the same JSON.parse result, under node and bun. Real jest, `jest.config.json` with `// project settings`, `/* block */`, a trailing `// tail`, `"url": "http://localhost/"`, `"^@/(.*)$": "<rootDir>/src/$1"`, `"testRegex": "/test/.*\\.test\\.js$"`, the array string `"/* not a comment */"` and `"setupFilesAfterEnv": ["<rootDir>/src/testing/boot.js"]`: a source change is not S6 (`exit=1 failingIds=["test/math.test.js > add"] complete=true`), a boot.js change is S6 config-changed. `{ // settings` + `"testEnvironment": "node",` + `}`: before `exit=1 complete=false note=runner exited 1 without a usable report`; after `S6 unsupported-argument: unsupported jest config: …\jest.config.json does not parse as JSON`; user's own `JSONError: Expected double-quoted property name in JSON at position 45 (line 4 column 1)`. |
| QA-1.3-47 | verified | 2000 directories, one test file each, no config, real fs, `pytest`: `planScopedRun` node 2515-2535 ms → 605-767 ms, bun 5307-5758 ms → 912-976 ms; `planStaticScoping` node 2415-2458 ms → 588-664 ms, bun 5248-5257 ms → 950-991 ms; fileExists 16074 → 2074. Both now return `S6 argv-too-long: too many inputs for one command line: 2000 files` (planStaticScoping returned `scopable` before). |

### New findings (round 6)

The pinning holds wherever it pins: every pinned spec in this round read the user's config, rootdir and conftests on every pytest release
tried, and no false pass comes from the diff. It costs verification on one common family of layouts, though (QA-1.3-49). Two false passes
predate the diff and are residuals of the findings it fixed (QA-1.3-48, QA-1.3-50). The JS side adds no false S6, but its new probe is
expensive for large changes (QA-1.3-51).

| id | severity | summary and evidence | fix |
|---|---|---|---|
| QA-1.3-48 | minor | **Residual of QA-1.3-43 (predates the diff; before and after give the same pass): the model of the user's run misses path arguments that pytest's determine_setup sees.** pytest runs determine_setup before it loads plugins from entry points (9.1.1 `_pytest/config/__init__.py`: `parse_known_args` and `determine_setup(… args=ns.file_or_dir …)` at 1532-1536, `load_setuptools_entrypoints("pytest11")` at 1583; 8.4.2 passes `ns.file_or_dir + unknown_args`). So when a plugin option's value is a separate token (`--cov src`, `--cov-config .coveragerc`), that value is a positional there, and when it exists on disk it moves the arguments' common ancestor. The adapter drops `--cov`/`--cov-config` with their values, so pathScopes and the spec-time user run hold only the real path arguments. Layout: root `pytest.ini` (`addopts = -ra`), `tests/unit/pytest.ini` `addopts = -m "not slow"`, `.coveragerc`, `src/`, broken `@pytest.mark.slow test_slow` in `tests/unit/test_s.py`. `pytest --cov src tests/unit` and `pytest --cov=src --cov-config .coveragerc tests/unit`: adapter, before and after, `pin=["-c","tests/unit/pytest.ini","--rootdir=tests/unit"] exit=0 total=1 failingIds=[] complete=true` (`1 passed, 1 deselected`). User's own under 9.1.1 + pytest-cov 7.1.0 and 8.4.2 + pytest-cov 7.1.0: `rootdir: …\B1_covconfig_space`, `configfile: pytest.ini`, `FAILED tests/unit/test_s.py::test_slow … 1 failed, 1 passed`. With `--cov-config=.coveragerc` as one token the user's own run reads `tests/unit/pytest.ini` and passes, as the adapter does. It needs a nested config below the path arguments' ancestor and a plugin option whose separate value is an existing path outside it. | In the user-run model (detection and pytestAtInputs), take as path arguments what `_initini` sees: every token of the command and PYTEST_ADDOPTS that is not an option and not the value of an option pytest knows before plugins load (the builtin options). Values of plugin options (`--cov`, `--cov-config`, `--cov-report`, `--html`, `--json-report-file`, `--timeout`, `--dist`, `-n`) count when they exist, following get_dirs_from_args (`::` stripped, a file counts as its directory). A fail-closed alternative is S6 when such a value exists and the lookup with it differs from the lookup without it. Add a unit test and a 3.2 fixture. |
| QA-1.3-49 | minor | **64799b1: false S6 when a package directory holds a pyproject.toml without a pytest table. Rate: 4 of 18 realistic layouts.** Scoped and pinned (14): root pytest.ini + `tests/`; src layout with a pyproject table (changed source module); root table-less pyproject + root conftest fixture; no config + root conftest; setup.py + setup.cfg `[tool:pytest]`; tox.ini `[pytest]` with `pytest tests`; app/tests with `python_files`; uv workspace with a root pytest table; QA-1.3-43 (a); `pytest tests/unit tests/integration`; no config with `pytest tests`; pytest.toml; tests inside the package with importlib mode; poetry with `tests/conftest.py`. S6 (4), each a verified run before the diff: (i) uv workspace (root pyproject with `[tool.uv.workspace]`, `packages/a/pyproject.toml` with `[project]` only), `pytest`: after `S6 … unsupported pytest config for the scoped inputs: …\packages\a\pyproject.toml instead of …\pyproject.toml`. (ii) the same with `pytest packages/a`: after `S6 … unsupported pytest rootdir: the pytest releases pick …\packages\a or …\L15_uvws_notable_pathpkg`. (iii) `backend/pyproject.toml` with `[project]` only, no root Python config, `pytest backend`: after rootdir S6 as in (ii). (iv) the same with `pytest`: after `S6 … …\backend\pyproject.toml instead of none`. Before: `exit=1 failingIds=["<pkg>/tests/test_a.py::test_up"] complete=true` for (i) under 9.1.1 and for (ii)-(iv) under 9.1.1, 8.0.2 and 7.0.1, matching the user's own (for ii: `rootdir: …\packages\a`, `configfile: pyproject.toml` on 9.1.1; `rootdir: <root>` on 8.0.2 and 7.0.1). The S6 in (i) is not needless: with only `--rootdir` pinned, pytest ≥ 8.1 cuts conftests at `packages/a`. A root autouse fixture that raises gave `1 failed, 1 passed, 2 errors` in the user's own run but `1 failed, 1 passed` for `pytest --rootdir=<root> -- packages/a/tests/test_a.py` on 9.1.1, 8.4.2 and 8.1.1. | (1) When every release agrees on the rootdir and the ≥ 8.1 releases' inifile is a table-less pyproject.toml while the older releases read none, pin `-c <that pyproject.toml>` as well. In (i) with the raising root conftest, `pytest -c pyproject.toml --rootdir=<root> -- packages/a/tests/test_a.py` reproduced the user's own run (`1 failed, 1 passed, 2 errors`) on 9.1.1, 8.4.2, 8.1.1, 8.0.2, 7.4.4 and 7.0.1. Residual: pytest 7's conftest cutoff moves from none to the rootdir, which matters only for a conftest.py above it. (2) Before either S6, model the spawn's own determine_setup per release (arguments F, nothing pinned), and pin nothing when it gives every release the user's inifile and rootdir: that covers (ii) and (iii), which ran correctly unpinned on 9.1.1, 8.0.2 and 7.0.1 before the diff. (iv) stays S6 unless the pin also sets `--confcutdir` (unverified). Add unit tests for the four layouts. |
| QA-1.3-50 | minor | **QA-1.3-45 (b) is partial (predates the diff; before it, configLiterals read nothing from a scalar call at all): a path built from several literals in one call is still missed.** configLiterals takes every literal and resolves each one on its own, so `path.join(__dirname, 'src', 'testing', 'bootstrap.js')` yields `src`, `testing` and `bootstrap.js`, and none of them resolves to the changed file. jest `globalSetup: path.join(__dirname, 'src', 'testing', 'bootstrap.js')`, and `globalSetup: path.resolve(__dirname, 'src/testing', 'bootstrap.js')`, bootstrap made to throw: after `inputs=["src/testing/bootstrap.js"] exit=0 total=0 failingIds=[] complete=true` (a pass) for both; user's own `Error: Jest: Got error running globalSetup - …\src\testing\bootstrap.js, reason: setup broke`. The one-literal forms are caught (QA-1.3-45 row). Like QA-1.3-45, it needs a file name the G.7 name rule does not catch. | In a call's argument list, also join each run of consecutive string literals with "/" and add the result as a reference; `wanted` still filters by the last segment, so the cost stays bounded. Add unit tests for `path.join`/`path.resolve` with two and three literals. |
| QA-1.3-51 | nit | **d1eec4f: the project-config probe costs one fileExists per config name (12 for vitest, 8 for jest) in every distinct directory above the changed modules, and planStaticScoping, the cheap risk signal, pays all of it.** vitest, real fs, 3 runs each, `planStaticScoping`, every outcome `scopable`: 40 packages each with a vitest.config.mjs, 200 changed modules (5 per package, in their own directories): node 75-95 ms → 771-920 ms, bun 143-164 ms → 815-885 ms, fileExists 215 → 7907. 260 changed modules, each in its own 9-deep chain (about what MAX_ARGV_CHARS lets through at this path length): node 95-105 ms → 2637-3279 ms, bun 182-197 ms → 2707-2981 ms, fileExists 275 → 28379. The cost is linear and bounded by the argv check (a shorter repo path lets more files through), and it fails safe. The small JS changes of this round planned in 5-18 ms under node. | Probe each directory once: add an optional `readdir` to PlannerFs (like `stat`), with the per-name probe as the fallback. Or probe only directories whose files could be a project root (holding a package.json, or named by a `projects` literal). Optional. |

Checked, no finding:
- The JS whole-expression scan and the `root` key: extra literals and bases only add triggers. The Vite config above has `root:`,
  `path.resolve` aliases, a URL and a commented `setupFiles`, and a plain source change was still scoped.
- jsCheapChecks counts gone non-test files of any type, as classify's goneSources does, so the early too-many-searches matches the late one.
- parsePytestConfig accepts a section-less `.pytest.ini` on every release line, but pytest up to 8.4.2 accepts only `pytest.ini`
  (8.4.2 `findpaths.py:56` `if filepath.name == "pytest.ini"`; 9.1.1 `:76` `in {"pytest.ini", ".pytest.ini"}`). This predates the diff. It
  cannot produce a wrong `-c`, because the 7.0 line never reads `.pytest.ini` and a `-c` pin needs all four lines to agree; at worst it
  gives a rootdir S6.
- The pinned `-c`/`--rootdir` add two absolute paths to the argv, and buildSpec's full-length check includes them.

### Deferred by plan

- QA-1.3-16 and QA-1.3-17 (2.1): unchanged. This round left 0 `omr-verify-*` files in `%TEMP%`.
- 3.1: `uv run pytest` syncing a fresh reference worktree is still unverified, and so is one spec launched from inside opencode under Bun.
- 3.2: fixtures as listed in round 5. Add this round's layouts: the four QA-1.3-49 layouts, the QA-1.3-48 `--cov src` layout, the
  QA-1.3-50 forms, and the `pytest tests/a tests/b` complete=false case.
- Section P residuals: unchanged.

Status: **not clean.** Open: QA-1.3-48, -49 and -50 (minor); QA-1.3-51 (nit). QA-1.3-43 to -47 are verified for what they reported.
QA-1.3-49 and -51 come from the diff. QA-1.3-48 and -50 predate it: they are residuals of -43 and -45 (b) and give the same results before
and after.

Cleanup: the 16 junctions under `%TEMP%\omr-qa13r6` (`node_modules` links into `D:\git\omr-p13` and the Spike C jest project) were removed
with `rmdir` first, and the check found 0 reparse points left. Then the directory was deleted, including this round's uv venvs. The link
targets are intact, and the Spike C venv and jest project were not modified. The final check found 0 `omr-verify-*` files and 0
`bun-node-*` directories in `%TEMP%`, and no process referring to `omr-qa13r6`.