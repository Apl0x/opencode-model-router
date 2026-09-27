// src/verify/runner.ts
//
// RUNNER ADAPTER: design note (plan Task 1.3.1) and typed contract.
// Implementation is Task 1.3.2. Every function below is a stub until then, except the type guards.
//
// Plan:     docs/plans/verification-resource-budget-plan.md, section 1.5 (decisions 1-6, 10, 11), Phase 1.3.
// Evidence: docs/qa/verification-resource-budget/phase-1.3.md (Spike C: vitest 4.1.11, jest 30.5.2,
//           pytest 9.x + pytest-xdist 3.8), reports in test/fixtures/runner/reports/, and the
//           extra runs made for this design, listed in section R below.
//
// This module plans verification commands. It never spawns anything and must not import
// child_process. It turns (check command, cwd, changed files, budget) into one of three results:
// an argv spec, a "nothing to run" note, or an S6 `unverifiable` reason. After a run, it turns the
// result into failing test identities. It reaches the outside world only through injected seams:
// FsSeam/RunnerFs for the filesystem, TestSearchSeam for test-file searches (the caller runs git)
// and RunnerHost for platform, execPath, tmpdir, core count, PATH and ids.
//
// Sections: B detection, C script parsing, D user arguments, E worker cap, F entry resolution,
// G changed files, H argv construction, I results and identities, J S5 decision, K lint,
// L allowlist, M reasons, N security, O deviations, P unverified, Q consumers, R extra evidence.
//
// Notation: P = (host.platform === "win32" ? path.win32 : path.posix), used for every path
// operation so Windows cases can be unit-tested on Linux. key(p) = win32 ? p.toLowerCase() : p.
// <where> = "command" (the check command) or "scripts.<name>". <rel> = gitRoot-relative path with
// "/" separators.
//
// ------------------------------------------------------------------------------------------------
// B. RUNNER DETECTION (detectRunner; section 1.5-4)
//
//   Step 0  gitRoot: walk up from cwd until fs.fileExists(<dir>/.git), which accepts a dir or a
//           file, so worktrees work. No .git found -> S6 no-git-root.
//   Step 1  Composite scan (C.2) of the raw command, <where> = "command".
//   Step 2  Tokenize (C.1) and match the head. Tokens must match exactly: no path, no extension.
//
//   head                                                   result
//   -----------------------------------------------------  ------------------------------------------
//   vitest ...                                             vitest, launcher "direct"
//   npx vitest ...          (token[1] is exactly vitest)   vitest, launcher "npx"
//   pnpm exec vitest ...                                   vitest, launcher "pnpm-exec"
//   jest ... | npx jest ... | pnpm exec jest ...           jest, same launchers
//   pytest ...                                             pytest, launcher "direct"
//   uv run pytest ...       (exactly these three tokens)   pytest, launcher "uv-run"
//   npm test | npm t | npm run <s> | npm run-script <s>    package script s ("test" for test/t)
//   pnpm test | pnpm t | pnpm run <s>                      package script
//   yarn test | yarn run <s>                               package script
//   bun run <s>                                            package script
//   bun test ...                                           S6 bun-test (Bun's built-in runner; O.1)
//   NAME=value ... (no cross-env)                          S6 inline-env
//   anything else: dotenv, node, sh, env, npx -y, pnpm dlx, uv run python, uvx, mocha,
//   node --test, cross-env-shell, ...                      S6 unsupported-command
//
//   The unsupported-command construct is the accepted-form prefix plus the first offending token:
//   "dotenv", "npx -y", "pnpm dlx", "uv run python", "npm" (a package manager inside a script).
//
//   Package scripts:
//   - package.json is the nearest one, walking up from cwd to gitRoot (inclusive). None found ->
//     S6 no-package-json. JSON parse error or not an object -> S6 bad-package-json. scripts[s]
//     missing or not a string -> S6 no-script.
//   - Extra args. npm: tokens after "--" are appended to the script. Tokens between the script
//     name and "--" are npm's own flags: ignored, with a note. pnpm, yarn and bun: tokens after
//     the script name are appended, minus a leading "--".
//   - The script text goes through C.2 (<where> = "scripts.<s>"), C.1, C.3 and the head table,
//     restricted to the DIRECT forms (vitest, jest, pytest, npx, pnpm exec, uv run pytest).
//     Only one level of script resolution: a package-manager head inside a script (npm run x,
//     pnpm build) -> S6 unsupported-command.
//   - runnerCwd = dirname(package.json). For direct commands, runnerCwd = cwd.
//   - pre<s>/post<s> scripts are not run. Each one present adds the note
//     `scripts.pre<s> is not run by the scoped command` (no S6: see O.11).
//
// ------------------------------------------------------------------------------------------------
// C. SCRIPT PARSING
//
//   C.1 Tokenizer (a POSIX-style subset, identical on every platform)
//     - Spaces and tabs separate tokens.
//     - "..." groups, and inside it only \" is an escape (it yields "). The quotes are removed.
//     - '...' groups literally. The quotes are removed.
//     - A backslash outside quotes is a literal character, so Windows paths survive.
//     - Adjacent parts join into one token: a"b c"d -> "ab cd".
//     - An unterminated quote -> S6 unterminated-quote.
//     Known divergence: npm on Windows runs scripts through cmd.exe, where '...' does not quote
//     (see P).
//
//   C.2 Composite scan (raw text, quotes IGNORED, like FORBIDDEN_SHELL in deterministic.ts)
//     Scan left to right. The first position with a match wins, and at one position the longer
//     construct wins (&& over &). The constructs are:
//       newline (\r or \n), &&, ||, ;, |, &, >, <, `, $(, $, %VAR% (regex %[A-Za-z_][A-Za-z0-9_]*%;
//       a bare "50%" is not a construct).
//     Reason: composite <where>: "<construct>", where a newline is reported as "newline".
//     Examples: `vitest run && eslint .` -> composite scripts.test: "&&".
//               `npm run a; npm run b` -> composite scripts.test: ";".
//
//   C.3 cross-env (section 1.5-4)
//     If token[0] is "cross-env", every following token matching /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s
//     is consumed into env, and a later assignment of the same name wins. The first other token
//     starts the command. `cross-env X=1 Y="a b" vitest run` gives env {X:"1", Y:"a b"} and
//     runner vitest. cross-env with no command -> S6 unsupported-command "cross-env". cross-env
//     followed by a composite is already S6 composite (C.2 runs first).
//
// ------------------------------------------------------------------------------------------------
// D. USER ARGUMENTS (the tokens after the runner head)
//
//   D.1 Algorithm, one token t at a time, left to right:
//     a. t === "--"              -> S6 unsupported-argument "--".
//     b. DROP entry              -> remove t and its value tokens.
//     c. CAP entry               -> remove t and its value, and record the value (E). Special
//                                   entries are noted as "kept" below.
//     d. KEEP-value entry        -> keep t and its value tokens, in order.
//     e. KEEP-flag entry         -> keep t.
//     f. S6 entry                -> S6 unsupported-argument t (lint: Unscoped).
//     g. any other option (a token starting with "-"):
//          if it contains "=", keep it verbatim;
//          if the next token is absent or starts with "-", keep it verbatim (a flag);
//          otherwise -> S6 ambiguous-option (we cannot tell whether the next token is its value).
//     h. positional (no leading "-"):
//          vitest: the FIRST positional equal to run|watch|dev|related is dropped silently.
//                  One equal to bench|list|init|typecheck -> S6 unsupported-subcommand.
//                  Every other positional is a filter: dropped, with one note
//                  `vitest filters dropped: a, b`.
//          jest:   positionals are testPathPatterns: dropped, note `jest filters dropped: ...`.
//          pytest: a path scope. It is resolved against runnerCwd. If it contains "::" or any of
//                  * ? [ ] { }, or resolves outside gitRoot -> S6 unsupported-argument.
//          eslint: a path scope, with the same rules (-> Unscoped instead of S6).
//   Matching rules:
//     - "--name" matches both "--name" and "--name=v". With the inline "=v" form, the arity is
//       ignored.
//     - An entry ending in ".*" matches by prefix: "--coverage.*" matches "--coverage.reporter=text".
//     - A short entry "-x" with arity 1 also matches the attached form "-xVALUE" (-rA, -n4,
//       -pno:cacheprovider).
//   Arity:
//     0  no value;
//     1  the next token, unconditionally;
//     ?  the next token only if it does not start with "-";
//     *  every following token up to the first one that starts with "-".
//
//   D.2 vitest
//     DROP 0  --run --watch -w --no-watch --ui --open --standalone --update -u --passWithNoTests
//             --clearScreen --inspect --inspect-brk --coverage   (adds note "coverage disabled
//             for the scoped run")
//     DROP ?  --changed --api --mergeReports --coverage.*
//     DROP 1  --reporter --outputFile --outputFile.* --shard --minWorkers --min-workers --api.*
//     CAP  1  --maxWorkers --max-workers
//     CAP  0  --no-file-parallelism, "--fileParallelism=false": the token is KEPT and the user
//             cap is {count: 1}
//     KEEP 1  --config -c --root -r --dir --project --environment --pool --testNamePattern -t
//             --mode --testTimeout --hookTimeout --teardownTimeout --retry --bail --exclude
//     KEEP ?  --browser --sequence.* --typecheck.* --browser.*
//     KEEP 0  --globals --dom --isolate --no-isolate --allowOnly --silent --hideSkippedTests
//             --logHeapUsage --color --no-color --expandSnapshotDiff --disableConsoleIntercept
//             --typecheck
//     Example: `vitest run --coverage` -> run dropped, --coverage dropped, note added.
//
//   D.3 jest
//     DROP 0  --watch --watchAll --json --findRelatedTests --listTests --onlyChanged -o --lastCommit
//             --changedFilesWithAncestor --updateSnapshot -u --passWithNoTests --runTestsByPath
//             --coverage --collectCoverage   (coverage adds the note from D.2)
//     DROP 1  --outputFile --changedSince --shard --collectCoverageFrom --coverageDirectory
//             --coverageProvider --coverageThreshold
//     DROP *  --reporters --coverageReporters --coveragePathIgnorePatterns
//     CAP  1  --maxWorkers --max-workers -w
//     CAP  0  --runInBand -i   (the token is removed; the user cap is {count: 1})
//     KEEP 1  --config -c --rootDir --testNamePattern -t --testEnvironment --env --testTimeout
//             --testRunner --testSequencer --cacheDirectory --workerIdleMemoryLimit --seed
//             --maxConcurrency --openHandlesTimeout
//     KEEP ?  --bail -b
//     KEEP *  --roots --selectProjects --ignoreProjects --projects --testPathPatterns
//             --testPathPattern --testPathIgnorePatterns --testMatch
//     KEEP 0  --ci --silent --verbose --detectOpenHandles --detectLeaks --forceExit --cache
//             --no-cache --colors --watchman --no-watchman --errorOnDeprecated --injectGlobals
//             --noStackTrace --useStderr --workerThreads --randomize --showSeed --clearMocks
//             --resetMocks --restoreMocks --expand -e --logHeapUsage
//     S6      --showConfig --clearCache --init
//
//   D.4 pytest
//     DROP 0  -q --quiet --lf --last-failed --ff --failed-first --nf --new-first --sw --stepwise
//             --sw-skip --stepwise-skip --cache-clear --pdb --trace -f --looponfail --cov-append
//             --cov-branch --no-cov --no-cov-on-fail --self-contained-html --json-report
//     DROP ?  --cov
//     DROP 1  --junitxml --junit-xml --pdbcls --cov-report --cov-config --cov-fail-under
//             --cov-context --html --json-report-file
//     -p      "-p no:cacheprovider" (and "-pno:cacheprovider") is dropped, because the adapter
//             adds it once. "-p no:xdist" is kept and forces xdist = false. Any other -p value
//             is KEEP 1.
//     CAP  1  -n --numprocesses --maxprocesses   (values: N, auto, logical; attached "-n4")
//     KEEP 1  -k -m -c --config-file --rootdir -o --override-ini -W --pythonwarnings --tb -r
//             --import-mode --basetemp --durations --durations-min --timeout --maxfail --ignore
//             --ignore-glob --deselect --confcutdir --dist --capture --log-level --log-cli-level
//     KEEP 0  -x --exitfirst -v -vv --verbose -s -l --showlocals --strict-markers --strict-config
//             --disable-warnings --no-header --runxfail
//     S6      --co --collect-only --fixtures --fixtures-per-test --markers --setup-plan
//             --setup-only --version -V -h --help
//     xdist evidence (DetectedRunner.xdist). It is true when either of these holds, and
//     "-p no:xdist" is absent:
//       - the user args contain a CAP entry or --dist;
//       - XDIST_RE (below) matches the pytest config text or host.pytestAddopts.
//     "pytest config text" is every one of pytest.ini, pyproject.toml, tox.ini and setup.cfg that
//     exists in the nearest directory, from runnerCwd up to gitRoot, holding any of them.
//       XDIST_RE       = /(?:^|[\s"'\[,=])(?:-n|--numprocesses|--maxprocesses|--dist)(?=[\s"'=,\]]|\d|$)/m
//       XDIST_VALUE_RE = /(?:-n|--numprocesses|--maxprocesses)(?:\s*=\s*|\s+|["']\s*,\s*["'])?["']?(\d+|auto|logical)\b/
//     When the command sets no cap, the config value (XDIST_VALUE_RE) is the user cap, so a
//     config "-n 1" is never raised. covInConfig is true when
//     /(?:^|[\s"'\[,=])--cov(?=[=\s"',\]]|$)/m matches the config text or host.pytestAddopts.
//     A false match can only add "-n N" without xdist, which gives pytest exit 4, then
//     readResult complete=false, then unverifiable: never a false pass.
//
//   D.5 eslint (lint scoping, K)
//     DROP 0  --fix --fix-dry-run
//     DROP 1  --fix-type -o --output-file
//     CAP  1  --concurrency   (N or auto; "off" is KEEP, not a cap)
//     KEEP 1  -c --config --ext --parser --parser-options --resolve-plugins-relative-to --rulesdir
//             --plugin --rule --env --global --ignore-path --ignore-pattern --cache-location
//             --cache-strategy -f --format --max-warnings --report-unused-disable-directives-severity
//             --flag
//     KEEP 0  --cache --quiet --no-eslintrc --no-config-lookup --no-ignore --no-inline-config
//             --report-unused-disable-directives --color --no-color --no-error-on-unmatched-pattern
//             --exit-on-fatal-error --pass-on-no-patterns --stats --debug
//             (--no-warn-ignored is deduplicated: dropped here, re-added by K)
//     UNSCOPED --init --print-config --inspect-config --env-info -v --version -h --help --stdin
//              --stdin-filename
//
// ------------------------------------------------------------------------------------------------
// E. WORKER CAP (section 1.5-11; S4)
//
//   B = budget.maxWorkers if it is a safe integer >= 1, else 1.
//   C = input.cores ?? host.cores (default os.availableParallelism()), a safe integer >= 1, else 1.
//   The user value V comes from the LAST cap token (the runners use last-wins too). For pytest,
//   when the command has no cap token, V comes from the config (D.4).
//     /^\d+$/                            -> {count: n}. n = 0 is valid only for pytest -n;
//                                           for vitest/jest, 0 is invalid.
//     /^(\d{1,3})%$/, p in 1..100        -> {percent: p}   (vitest, jest)
//     "auto" | "logical"                 -> {auto: true}   (pytest; eslint "auto")
//     anything else (abc, 1.5, -1, 0%, 150%)
//                                        -> invalid. The value is ignored and a note
//                                           `invalid worker cap "<V>" ignored` is added.
//                                           Spike C: vitest and jest accept --maxWorkers=abc
//                                           silently and run with their own default, so the
//                                           budget applies instead.
//   effectiveWorkers(user, budget, C):
//     none or invalid -> B
//     count n         -> min(n, B)   (pytest 0 -> 0: runs in-process, never raised)
//     percent p       -> min(max(1, ceil(p * C / 100)), B)
//     auto            -> min(C, B)
//   Test values, with B = 2:
//     none -> 2; 1 -> 1; 8 -> 2; 50% with C=16 -> 2; 50% with C=1 -> 1;
//     "--maxWorkers 4" (two tokens) -> 2; "--maxWorkers=abc" -> 2 plus the note.
//   Every user cap token is removed in D, and the adapter emits exactly one flag (H). The router
//   never raises a cap.
//
// ------------------------------------------------------------------------------------------------
// F. ENTRY RESOLUTION (resolveEntry)
//
//   JS tools: vitest -> package "vitest", bin key "vitest"; jest -> "jest"/"jest";
//   eslint -> "eslint"/"eslint".
//     - For dir = cwd, its parent, ... up to gitRoot (inclusive, never above), check
//       pj = P.join(dir, "node_modules", pkg, "package.json") with fs.fileExists; the first hit
//       wins. This covers hoisted monorepos (found at the root) and pnpm, where
//       node_modules/<pkg> is a symlink into .pnpm/... that fileExists and readFile follow. The
//       lexical path goes into argv.
//     - Nothing found -> S6 runner-not-installed "<pkg>", or yarn-pnp when <gitRoot>/.pnp.cjs
//       exists.
//     - Unparseable package.json, or its "name" is not <pkg> -> S6 bad-bin.
//     - bin is either a string (Spike C: jest "./bin/jest.js") or an object keyed by the bin name
//       (vitest {"vitest": "./vitest.mjs"}). Missing -> bad-bin.
//     - entry = P.resolve(pkgDir, bin). It must stay inside pkgDir (P.relative(pkgDir, entry) has
//       no ".." segment and is not absolute), end in .js, .mjs or .cjs, and exist. Otherwise
//       -> bad-bin.
//     - Result: {file: host.execPath, prefix: [entry], entry, version}.
//     - npx and pnpm exec resolve exactly like direct invocations. They are never executed, so
//       npx can never download a runner.
//   pytest (launcher "direct"): the first PATH hit, then a venv.
//     - PATH: for each ABSOLUTE entry of host.pathEnv split by P.delimiter (relative entries such
//       as "." are skipped), check win32 "<dir>\pytest.exe" or posix "<dir>/pytest".
//     - venv fallback: for dir = runnerCwd ... gitRoot, check win32 ".venv\Scripts\pytest.exe" or
//       posix ".venv/bin/pytest", and add the note `pytest resolved from <path>`.
//     - Nothing found -> S6 runner-not-installed "pytest".
//     - Result: {file: exe, prefix: [], entry: exe}.
//     PATH comes first so the adapter runs the program the shell would have run for the same
//     command.
//   uv (launcher "uv-run"): PATH only, "uv.exe" or "uv". Result: {file: uv, prefix: ["run",
//     "pytest"], entry: uv}. Nothing found -> runner-not-installed "uv".
//
// ------------------------------------------------------------------------------------------------
// G. CHANGED FILES (planScopedRun, planStaticScoping, planScopedLint)
//
//   1. changedFiles === "unavailable" -> S6 attribution-unavailable (lint: Unscoped).
//      [] -> NoAffected "no changed files, no affected tests" (section 1.5-6).
//   2. The candidates are each c.path, plus c.previousPath when present (the source of a rename).
//   3. abs = P.resolve(cwd, candidate). This resolves "..", "." and mixed separators, and an
//      absolute input keeps its drive. A path containing "\0" is dropped, with a note.
//   4. rel = P.relative(gitRoot, abs). The file is outside the root when rel === "", rel starts
//      with a ".." segment, or P.isAbsolute(rel) (another drive). Outside files are dropped with
//      the note `dropped outside the git root: <candidate>`.
//        "src/../../x" is outside -> dropped.
//        "packages/a/../b/x.ts" is inside -> kept as packages/b/x.ts (see O.9).
//        win32 P.relative compares case-insensitively, so "c:\repo\a.ts" is inside a gitRoot of
//        "C:\repo".
//   5. canonical = P.join(gitRoot, rel), so drive-letter case and separators follow gitRoot.
//      Deduplicate by key and sort by key. Spaces and unicode need nothing special: each path is
//      one argv element.
//   6. exists = fs.fileExists(canonical). A path that does not exist is "gone": deleted, or the
//      source side of a rename. Git status strings are NOT trusted, because tool statuses are
//      "written"/"modified" and porcelain codes differ. tree.ts records only rename
//      destinations, so 2.1 should pass previousPath.
//   7. Config triggers are checked on every canonical path, gone or not. The first hit in sorted
//      order -> S6 config-changed. Matching is by basename, anywhere under gitRoot:
//        vitest  package.json, vitest.config.*, vite.config.*, vitest.workspace.*,
//                vitest.projects.*, tsconfig*.json.
//                Evidence (R): `vitest related package.json` ran every test file.
//        jest    package.json, jest.config.*, babel.config.*, .babelrc, .babelrc.*, tsconfig*.json
//        pytest  conftest.py, pyproject.toml, pytest.ini, setup.cfg, tox.ini (section 1.5-3,
//                exactly)
//        all     the package.json that supplied the script (DetectedRunner.source)
//        eslint  (K)
//   8. Classification:
//        test file (JS): /\.(test|spec)\.[cm]?[jt]sx?$/ or a "__tests__" segment.
//        test file (py): basename /^test_.*\.py$/ or /_test\.py$/.
//        non-input (skipped, counted in a note):
//          - extensions .md .mdx .markdown .rst .adoc .txt;
//          - any path with a ".github" segment;
//          - basenames LICENSE, LICENCE, .gitignore, .gitattributes, .editorconfig, .npmignore,
//            .prettierignore;
//          - lockfiles package-lock.json, npm-shrinkwrap.json, pnpm-lock.yaml, yarn.lock,
//            bun.lockb, bun.lock.
//        vitest/jest:
//          - an existing file becomes an input. A changed test file runs itself (evidence R).
//          - a gone test file adds the note `deleted test file not run: <rel>`; the risk signal
//            covers it.
//          - any other gone file goes to the stem search (9).
//        pytest: only .py files count; others are skipped.
//          - an existing test file becomes an input, if it lies under runnerCwd and under a path
//            scope (when path scopes exist).
//          - an existing module is looked up with
//            search.findByName(gitRoot, ["test_<stem>.py", "<stem>_test.py"]). Hits are filtered
//            the same way. No hits -> note `no tests named for <rel>`. undefined -> S6
//            search-failed.
//          - a gone test file adds a note. A gone module uses the stem search plus findByName,
//            and gets S6 when both find nothing.
//        stem = the basename without its last extension. "index" and "__init__" use the parent
//        directory name instead.
//   9. Stem search (section 1.5-5): search.findByContent(gitRoot, stem, globs), with JS_TEST_GLOBS
//      or PY_TEST_GLOBS.
//        undefined               -> S6 search-failed.
//        []                      -> S6 deleted-no-tests.
//        more than STEM_MATCH_LIMIT files -> S6 stem-too-common.
//        otherwise               -> the existing, inside-root results join the inputs.
//   10. Inputs empty after steps 8 and 9 -> NoAffected, with the note from M.2.
//   planStaticScoping stops before every search. Each gone non-test source, and each existing
//   pytest module, counts as a pending search. When nothing is decidable, the result is
//   {scopable: true, runner, pendingSearches}.
//
// ------------------------------------------------------------------------------------------------
// H. ARGV CONSTRUCTION
//   Notation: F = the sorted absolute inputs, K = runner.keptArgs, N = the effective workers,
//   R = reportPath, E = entry.prefix.
//
//   vitest scoped (mode "related"): file = host.execPath
//     [...E, "related", ...F, ...K, "--run", "--passWithNoTests", `--maxWorkers=${N}`,
//      "--coverage.enabled=false", "--reporter=json", `--outputFile=${R}`]
//     NEVER add "--" here: cac takes the tokens after "--" out of related's file list, and that
//     ran 0 tests with exit 0 (R).
//   vitest rerun:
//     [...E, "run", ...F, ...K, "--passWithNoTests", `--maxWorkers=${N}`, "--coverage.enabled=false",
//      "--reporter=json", `--outputFile=${R}`]
//     Filters match as substrings. An absolute path selects that file, and at most a longer name
//     with the same prefix (see P).
//   jest scoped: file = host.execPath
//     [...E, ...K, "--findRelatedTests", "--passWithNoTests", `--maxWorkers=${N}`, "--coverage=false",
//      "--json", `--outputFile=${R}`, "--", ...F]
//   jest rerun: the same, with "--runTestsByPath" in place of "--findRelatedTests".
//   pytest (scoped and rerun are the same; F are test files). E is [] for direct pytest and
//   ["run", "pytest"] for uv:
//     [...E, ...K, "-q", "-p", "no:cacheprovider", `--junitxml=${R}`,
//      ...(xdist ? ["-n", String(N)] : []), ...(covInConfig ? ["--no-cov"] : []), "--", ...F]
//     env.PYTEST_XDIST_AUTO_NUM_WORKERS = String(N >= 1 ? N : min(C, B)). It is always set:
//     harmless without xdist, and it caps `-n auto|logical` from sources the adapter cannot see.
//     Spike C: it does not override a numeric -n, so the appended "-n N" does that job, because
//     the last -n wins over addopts.
//     workers = xdist ? N : null.
//   env = the cross-env assignments, then the adapter's own entries. The ArgvSeam merges env
//   over process.env.
//   reportPath = P.join(host.tmpdir, `omr-verify-${host.randomId()}.json`); pytest uses ".xml".
//   The tmpdir being inside gitRoot -> S6 tmpdir-in-repo.
//   The sum of (arg.length + 1) over args must not exceed MAX_ARGV_CHARS; otherwise -> S6
//   argv-too-long.
//
// ------------------------------------------------------------------------------------------------
// I. RESULTS AND IDENTITIES (readResult; plan 1.3.2.f)
//
//   In a finally block, always call fs.unlink(spec.reportPath) when it passes the N.4 check.
//   Errors are ignored.
//   Step 1  Read the report. If it is missing, unreadable or unparseable (for example
//           truncated), go to step 4.
//   Step 2  vitest/jest JSON (the top level is jest-compatible). Require an object whose
//           testResults is an array.
//     total = numTotalTests, when it is a number.
//     For each suite s:
//       rel    = P.relative(spec.cwd, s.name) with "/" separators. s.name is absolute, with
//                forward slashes in vitest and backslashes in jest.
//       failed = the assertionResults with status "failed".
//       For each a in failed: id = `${rel} > ${[...a.ancestorTitles, a.title].join(" > ")}`.
//         This is the same form vitest prints in text ("FAIL test/str.test.js > str > bad").
//         fullName is NOT used: it is space-joined and ambiguous.
//       If s.status === "failed" and failed is empty, the whole file failed: an import-time
//         throw, jest's "Test suite failed to run", or a jest syntax error. Then id = rel (a bare
//         file id) and collectionError = true.
//       Any failure adds P.normalize(s.name) to failingFiles.
//     jest: numRuntimeErrorTestSuites > 0 -> collectionError = true.
//     complete = true. Exception: exit != 0 with no failing id and no collection error ->
//     complete = false, note `runner exited <code> but its report lists no failure` (vitest
//     unhandled errors, coverage thresholds).
//   Step 3  pytest junit XML, parsed at regex level (no XML library).
//     - Read each <testcase .../> and <testcase ...>...</testcase>, with its classname and name
//       attributes. Decode &amp; &lt; &gt; &quot; &apos; &#N; and &#xN;.
//     - A <failure> child marks a failing test.
//     - An <error message="collection failure"> child, or classname="", marks a collection
//       error. Any other <error> (fixture setup or teardown) marks a failing test.
//     - <skipped> is not a failure.
//     Module mapping. For each spec input f:
//       dotted(f) = its gitRoot-relative path without ".py", with "/" replaced by ".".
//       The candidates are the segment-suffixes of dotted(f).
//       The longest candidate D with classname === D or classname.startsWith(D + ".") names the
//       file. rest = the part of classname after D, split on ".".
//       id = `${P.relative(spec.cwd, f) with "/"}::${[...rest, name].join("::")}`. This matches
//       pytest's "FAILED <nodeid>" text.
//       A collection pseudo-case maps `name` the same way and gets a bare file id.
//       An unmatched case gets id `${classname}::${name}`, complete = false, and the note
//       `pytest classname not mapped to a test file: <classname>`.
//     total = the number of testcases that are not collection pseudo-cases.
//     Exit codes:
//       5 -> total 0 and no failures (no tests collected).
//       4 -> complete = false, note "pytest usage error (exit 4)".
//       3 -> complete = false, note "pytest internal error (exit 3)".
//       Collection errors come from the XML, never from the exit code. Spike C: 2 without xdist,
//       1 with it.
//   Step 4  Fallback when there is no usable report: obs = observeTests(execResult) from
//           ./baseline.
//     failingIds = obs.failures. vitest "FAIL <rel> > ..." and pytest "FAILED <nodeid>" already
//     have the formats above.
//     failingFiles = the part before " > " or "::", resolved against spec.cwd, when present.
//     total = undefined. complete = false. source = "text".
//     collectionError = (execResult.code !== 0). Spike C: a syntax error in ANY vitest test file
//     aborts `related` with exit 1 and writes no report. It must never read as a pass.
//     Exit 0 with no report -> note "runner exited 0 without writing its report" (still
//     complete = false).
//   Output lists are deduplicated and sorted. The ids are cwd-relative, so a reference worktree
//   rerun (same relative layout) produces ids that compare equal.
//
// ------------------------------------------------------------------------------------------------
// J. S5 ATTRIBUTION DECISION: planListRelated does NOT exist, and 2.2 uses mode B.
//
//   Evidence (Spike C): vitest 4.1.11 has no non-executing "related" listing.
//     - `list --related` is an unknown option.
//     - `list <file>` treats the files as test-name filters.
//     - `list --changed` is git-based and cannot take the caller's file set.
//   jest 30 does have one (`--findRelatedTests ... --listTests`). A jest-only planListRelated is
//   still rejected, for two reasons:
//     - mode B must exist for vitest anyway. A jest-only mode A would double 2.2's attribution
//       paths and test matrix, for a saving that only appears on the failure path of a batch
//       with two or more requests;
//     - --listTests is still one process per request (a haste-map build) under the slot and caps.
//   pytest needs no listing: this module computes its affected set, so ScopedSpec.inputs ARE the
//   test files (inputsAreTests = true). 2.2 charges a failing pytest file f to every request
//   whose own plan's inputs contain f, without starting a process.
//   Mode B for vitest and jest, when the union run fails and the batch has more than one request:
//   run each request's own planScopedRun spec (vitest cannot intersect `related` with a file
//   filter), all under one slot hold. Each request is charged the failures its own run
//   reproduces. A union failure that no per-request run reproduces (a flaky test) must not
//   become a pass for any request. A batch of one needs no attribution.
//
// ------------------------------------------------------------------------------------------------
// K. LINT SCOPING (planScopedLint; section 1.5-10)
//
//   The result is LintSpec | NoAffected | Unscoped. Unscoped means "run the resolved command as
//   today (runShell with the allowlist, under S3/S4)". Lint never returns Unverifiable.
//   - Detection uses the B and C rules with the heads eslint, npx eslint and pnpm exec eslint,
//     plus package scripts (the default lint command is "npm run lint"). Anything else (tsc &&
//     eslint, next lint, biome, a wrapper) -> Unscoped, with the reason text B/C would produce.
//   - Arguments follow D.1 and D.5. Positionals are path scopes, and there are none by default,
//     meaning runnerCwd. A positional containing * ? [ ] { } -> Unscoped
//     `eslint glob pattern in <where>: "<p>"`.
//   - A lintable file exists, lies inside gitRoot and inside a path scope, and has an extension
//     from --ext (comma-separated, leading dots optional). Without --ext the extensions are
//     .js .mjs .cjs .jsx .ts .mts .cts .tsx.
//   - Config triggers (basename): eslint.config.*, .eslintrc, .eslintrc.*, .eslintignore,
//     package.json, tsconfig*.json -> Unscoped `eslint config changed: <rel>`.
//   - "unavailable" -> Unscoped "change attribution unavailable".
//   - No lintable files -> NoAffected "no changed lintable files".
//   - Entry: node_modules/eslint (F). Missing -> Unscoped "runner not installed: eslint".
//   - version major >= 9 -> add "--no-warn-ignored"; otherwise explicitly passed ignored files
//     emit warnings that break --max-warnings. major < 9 with --max-warnings -> Unscoped
//     "eslint <9 cannot scope ignored files under --max-warnings".
//   - Worker cap: only when the user set --concurrency N|auto -> `--concurrency=<E rule>`.
//   - argv = [...E, ...K, ...(v9 ? ["--no-warn-ignored"] : []), ...F]. F is absolute, with no
//     "--" (not verified for eslint). Exit code: 0 pass, 1 lint errors, 2 fatal.
//
// ------------------------------------------------------------------------------------------------
// L. ALLOWLIST CHANGE (Task 1.3.3, in deterministic.ts; this module does not implement it)
//
//   DEFAULT_ALLOWLIST gains "pytest", and NOT "uv".
//   In isCommandAllowed, after the FORBIDDEN_SHELL check and tokenization: when the first
//   token's basename, minus .exe/.cmd/.bat, is "uv", return
//     allowlist.includes("pytest") && tokens[1] === "run" && tokens[2] === "pytest".
//   This runs BEFORE the generic allowlist test, so it holds even when a user allowlist contains
//   "uv". Refused: `uv run python -c ...`, `uv run --with x pytest`, `uv pip ...`. `uvx` is not
//   on the allowlist. Every existing allowlist test stays green.
//
// ------------------------------------------------------------------------------------------------
// M. REASON STRINGS (stable: they reach the orchestrator, and tests assert them verbatim)
//
//   M.1 S6 reasons, as code -> template:
//     attribution-unavailable  change attribution unavailable
//     no-git-root              no git repository at or above <cwd>
//     no-package-json          no package.json between <cwd> and the git root
//     bad-package-json         unreadable package.json: <path>
//     no-script                package.json has no string scripts.<s>: <path>
//     composite                composite <where>: "<construct>"
//     unterminated-quote       unterminated quote in <where>
//     inline-env               inline environment assignment "<NAME>=" in <where> (only cross-env
//                              is supported)
//     unsupported-command      unsupported command "<prefix>" in <where>
//     bun-test                 "bun test" runs Bun's built-in test runner, not scripts.test (use
//                              "bun run test")
//     unsupported-subcommand   unsupported vitest subcommand "<sub>" in <where>
//     unsupported-argument     unsupported <runner> argument "<token>" in <where>
//     ambiguous-option         ambiguous <runner> option "<opt>" in <where>: cannot tell whether
//                              "<next>" is its value
//     runner-not-installed     runner not installed: <vitest|jest|pytest|uv>
//     yarn-pnp                 yarn Plug'n'Play has no node_modules to resolve <pkg> from
//     bad-bin                  invalid bin for <pkg>: <detail>
//     config-changed           config file changed: <rel>
//     deleted-no-tests         deleted source <rel>: no test file references "<stem>"
//     stem-too-common          deleted source <rel>: "<stem>" appears in <n> test files (limit 20)
//     search-failed            test search failed for <rel>
//     tmpdir-in-repo           temp dir is inside the repository: <tmpdir>
//     argv-too-long            too many inputs for one command line: <n> files
//   M.2 NoAffected notes:
//     "no changed files, no affected tests"                          (section 1.5-6, exactly)
//     "no affected tests: no changed file is a test input"           (docs only, dropped paths,
//                                                                     deleted tests)
//     "no affected tests: no test files map to the changed modules"  (pytest)
//     "no changed lintable files"                                    (lint)
//     "no rerun: none of the test files exist in this tree"          (planRerun)
//   M.3 Unscoped (lint) reasons: the B/C/D texts above with "S6" read as "Unscoped", plus the K
//       texts.
//
// ------------------------------------------------------------------------------------------------
// N. SECURITY INVARIANTS (the 1.3 QA review checks each one in code)
//
//   1. No shell, ever. This module never imports child_process. spec.file is one of:
//      host.execPath; or a native file named pytest(.exe) or uv(.exe) from an absolute PATH entry
//      or the .venv fallback. It is never a .cmd/.bat/.ps1/.sh shim. npx, pnpm, yarn and bun are
//      only parsed, never executed.
//   2. File arguments are argv elements, each absolute, normalized and inside gitRoot, so no
//      file argument can start with "-". A file literally named "--config=evil" becomes
//      "<root>/--config=evil". As a second guard, an input starting with "-" after normalization
//      is dropped with a note. jest and pytest also get "--" before the files (verified in R);
//      vitest never does.
//   3. No input list is ever empty. "vitest related" with no files runs nothing and exits 0 (R),
//      while "vitest run" and "pytest" with no files run the WHOLE suite. An empty list becomes
//      NoAffected.
//   4. reportPath lives in host.tmpdir and randomId is a UUID. A tmpdir inside gitRoot -> S6.
//      readResult reads and unlinks only a path whose dirname equals host.tmpdir
//      (case-insensitive on win32) and whose basename matches REPORT_NAME_RE.
//   5. A JS entry resolves inside <dir>/node_modules/<pkg>/, for some dir from runnerCwd up to
//      gitRoot. The package name must match, and bin must stay inside the package dir with a
//      .js/.mjs/.cjs extension.
//   6. User script tokens only ever become argv of the executable the planner chose. They can
//      add runner options (the same trust as `npm test` today), but they cannot choose the
//      program. The package.json that supplied the script is a config trigger, so a producer
//      that rewrites the script gets S6 instead of a run of its own command.
//   7. Paths that leave gitRoot are dropped, and PATH entries must be absolute. Outside gitRoot,
//      the module reads only the runner's own package under node_modules and executables on
//      absolute PATH entries.
//   8. The adapter-owned flags appear exactly once, because D removes user copies: the worker
//      cap, reporter, outputFile, passWithNoTests, run, the coverage switch, junitxml and
//      -p no:cacheprovider.
//   9. The argv-length cap (H) exists so that a failed spawn (Windows' limit is 32767 chars)
//      never masquerades as a test failure.
//
// ------------------------------------------------------------------------------------------------
// O. DEVIATIONS FROM PLAN (evidence wins, and each one is deliberate)
//
//   1. `bun test` is S6, not scripts.test, although section 1.5-4 lists it. Bun runs its built-in
//      test runner for `bun test` (Bun docs, R). `bun run test` resolves scripts.test.
//   2. "--" before the file arguments is used for jest and pytest only. vitest's cac drops the
//      tokens after "--" from related's file list, which ran 0 tests with exit 0 (R). The
//      universal guard against flag injection is the absolute-path rule (N.2).
//   3. planScopedRun returns ScopedSpec | NoAffected | Unverifiable (the plan says ScopedSpec |
//      Unverifiable). Section 1.5-6 needs a "pass with a note, spawn nothing" outcome.
//   4. planStaticScoping is new. Section 1.5-17 requires the risk signal's "scoping impossible"
//      flag to be decided with no process at all. The section 1.5-5 git grep and the pytest name
//      mapping need one, so planStaticScoping is planScopedRun minus the searches. 1.6 codes
//      against it.
//   5. planListRelated does not exist (J), even though jest has --listTests.
//   6. vitest and jest have config triggers too. Section 1.5-3 lists pytest only, but S6 names
//      "config-file change", and `vitest related package.json` ran the whole suite (R).
//   7. readResult returns more than {failingIds, failingFiles, collectionError, total}: total is
//      number | undefined (unknown in the text fallback), and it adds complete, source and note,
//      because a text fallback is never a complete inventory.
//   8. planRerun takes a fifth argument, deps. It has to drop test files missing from the target
//      tree (R: jest --runTestsByPath on a missing file exits 1; pytest exits 4). It may also
//      reuse the current tree's entry for a reference worktree that has no node_modules.
//   9. "`..` traversal (dropped)" is implemented as resolve first, then drop if outside the
//      root. "a/../b" inside the repo is a real change, so it is kept, normalized.
//   10. Unverifiable carries a stable `code` next to `reason`, for risk.ts and the tests.
//   11. pre/post lifecycle scripts are not run and are not S6 (a note only). A hook is not a
//       test, and skipping one can at worst produce a failure or a collection error.
//
// ------------------------------------------------------------------------------------------------
// P. NOT YET VERIFIED. The 3.1 fixtures must cover these; a failure means a design bug.
//
//   - jest `--coverage=false` overrides collectCoverage: true set in the config.
//   - pytest `--no-cov` also suppresses a --cov-fail-under that comes from addopts.
//   - vitest behaves consistently with "--no-file-parallelism" plus "--maxWorkers=1".
//   - Custom vitest forceRerunTriggers in the user's config cannot be read statically and can
//     make `related` run every file. This is an accepted residual risk (plan section 5,
//     config-driven tests).
//   - Tokenizing: npm on Windows (cmd.exe) does not treat '...' as quotes, while C.1 applies
//     POSIX rules everywhere.
//   - A vitest `run <absolute path>` filter may also select a longer name with the same prefix
//     (a.test.ts also selects a.test.tsx). That runs extra tests but never misses one.
//
// ------------------------------------------------------------------------------------------------
// Q. CONSUMER CONTRACT
//
//   1.6 risk.ts takes `ScopingPlan | StaticScoping`. "Scoping impossible" holds when
//       isUnverifiable(plan). Show plan.reason and branch on plan.code. Callers obtain the plan
//       from planStaticScoping, which starts no process.
//   2.1 testsPass: plan = planScopedRun(...).
//       - NoAffected -> pass, with the note.
//       - Unverifiable -> S6.
//       - ScopedSpec -> run argv(spec.file, spec.args, {cwd: spec.cwd, env: spec.env,
//         lowPriority, signal, timeoutMs}) under the slot. Then ALWAYS call
//         readResult(spec, result, fs), even after a timeout or abort, because it deletes the
//         report.
//       Green means !timedOut && complete && !collectionError && failingIds is empty. total === 0
//       means green with the note "no affected tests ran".
//       S2: map failingFiles into the reference worktree (gitRoot-relative), call
//       planRerun(runner, mapped, refRunnerCwd, budget, {fs, entry}), and compare failingIds.
//       testScope "full" is outside this module, except that its recheck uses planRerun.
//   2.2 batch: the key is (spec.gitRoot, spec.runner, spec.entry, key-sorted JSON of spec.env).
//       The union run is planScopedRun over the union of the requests' changed files, with the
//       same command and cwd. Attribution follows J.
//
// ------------------------------------------------------------------------------------------------
// R. EXTRA EVIDENCE (runs made for this design, with Spike C's fixtures %TEMP%\omr-spikeC and
//    versions)
//
//   vitest related test/math.test.js --run          -> exit 0, ran math.test.js: a test file passed
//                                                      to related runs itself.
//   vitest related --run ... -- src/math.js         -> exit 0, 0 tests.
//   vitest related src/str.js ... -- src/math.js    -> ran str only: cac drops the tokens after
//                                                      "--" from the file list.
//   vitest related --run (no files)                 -> exit 0, testResults [].
//   vitest related package.json --run               -> ran ALL test files (forceRerunTriggers).
//   vitest run <file> (absolute \, absolute /, relative) -> exactly that file.
//   vitest run <absent absolute file> --passWithNoTests  -> exit 0, total 0.
//   vitest related src/math.js --run --coverage.enabled=false -> exit 0; accepted without a
//                                                      coverage provider installed.
//   jest --findRelatedTests test/math.test.js --listTests -> math.test.js (runs itself).
//   jest --findRelatedTests --listTests -- src/math.js    -> math.test.js ("--" works).
//   jest --runTestsByPath --listTests -- <absolute>       -> exactly that file.
//   jest --runTestsByPath ... -- <absent file>            -> exit 1, numTotalTests 0.
//   jest --findRelatedTests --listTests (no files)        -> exit 1, "requires file paths".
//   jest --findRelatedTests package.json --listTests      -> nothing listed.
//   pytest -q -p no:cacheprovider -o addopts= -- <absolute> -> exit 0 ("--" works).
//   pytest ... -- --config=evil.py -> exit 4 "file or directory not found: --config=evil.py".
//   Bun docs (oven-sh/bun docs/runtime/index.mdx): "If a built-in bun command has the same name,
//   the built-in command takes precedence; use the explicit bun run <script>".

import type { ExecResult, FsSeam } from "./types";

// ---------------------------------------------------------------------------------------------
// Constants (contract values quoted by the design above)
// ---------------------------------------------------------------------------------------------

/** git pathspecs for the section 1.5-5 stem search over JS/TS test files. */
export const JS_TEST_GLOBS: readonly string[] = [":(glob)**/*.test.*", ":(glob)**/*.spec.*", ":(glob)**/__tests__/**"];
/** git pathspecs for the section 1.5-5 stem search over pytest test files. */
export const PY_TEST_GLOBS: readonly string[] = [":(glob)**/test_*.py", ":(glob)**/*_test.py"];
/** A deleted source whose stem appears in more test files than this is S6 stem-too-common. */
export const STEM_MATCH_LIMIT = 20;
/** Upper bound on the summed (arg.length + 1) of a spec's args (Windows CreateProcess: 32767). */
export const MAX_ARGV_CHARS = 30000;
/** Report files: `${tmpdir}/omr-verify-<uuid>.json|.xml`. readResult touches nothing else. */
export const REPORT_NAME_RE = /^omr-verify-[0-9a-f-]{36}\.(json|xml)$/;

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

/** Test runners the adapter can scope. */
export type RunnerKind = "vitest" | "jest" | "pytest";
/** Every tool whose entry resolveEntry can locate. */
export type ToolKind = RunnerKind | "eslint";
/** How the runner was invoked. The launcher is parsed, never executed. */
export type Launcher = "direct" | "npx" | "pnpm-exec" | "uv-run";
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** Stable S6 reason codes (section M.1). */
export type S6Code =
  | "attribution-unavailable"
  | "no-git-root"
  | "no-package-json"
  | "bad-package-json"
  | "no-script"
  | "composite"
  | "unterminated-quote"
  | "inline-env"
  | "unsupported-command"
  | "bun-test"
  | "unsupported-subcommand"
  | "unsupported-argument"
  | "ambiguous-option"
  | "runner-not-installed"
  | "yarn-pnp"
  | "bad-bin"
  | "config-changed"
  | "deleted-no-tests"
  | "stem-too-common"
  | "search-failed"
  | "tmpdir-in-repo"
  | "argv-too-long";

/** S6: scoping is impossible. The reason names the construct (section M.1) and never triggers a full suite. */
export interface Unverifiable {
  readonly unverifiable: true;
  readonly reason: string;
  readonly code: S6Code;
}

/** Nothing to run: the check passes with this note (section 1.5-6, M.2). */
export interface NoAffected {
  readonly noAffected: true;
  readonly note: string;
}

/** Lint only: run the resolved lint command unchanged, as today (section 1.5-10). */
export interface Unscoped {
  readonly unscoped: true;
  readonly reason: string;
}

/** One changed file as attributed to the producer. Structurally compatible with dispatch.ts ChangedFile. */
export interface ChangedPath {
  /** Absolute, or relative to the planner's cwd. */
  readonly path: string;
  /** Informational only. Existence is decided through the fs seam (G.6). */
  readonly status?: string;
  /** The source path of a rename, when known. It is treated as a gone file. */
  readonly previousPath?: string;
}

export interface RunnerBudget {
  /** enforcement.verify.maxWorkers (integer >= 1, default 2). Invalid values are treated as 1. */
  readonly maxWorkers: number;
}

/** A user worker-cap value after parsing (section E). */
export type UserWorkerCap =
  | { readonly count: number }
  | { readonly percent: number }
  | { readonly auto: true };

/** Host facts, injectable for tests. Defaults come from process/os/crypto. */
export interface RunnerHost {
  /** Picks path.win32 or path.posix for every path operation. Default: process.platform. */
  readonly platform: NodeJS.Platform;
  /** Default: process.execPath. */
  readonly execPath: string;
  /** Default: os.tmpdir(). */
  readonly tmpdir: string;
  /** Default: os.availableParallelism(). */
  readonly cores: number;
  /** Default: process.env.PATH ?? "". */
  readonly pathEnv: string;
  /** Default: process.env.PYTEST_ADDOPTS ?? "" (xdist/cov evidence, D.4). */
  readonly pytestAddopts: string;
  /** Default: crypto.randomUUID. It must return a UUID (REPORT_NAME_RE). */
  readonly randomId: () => string;
}

/** Filesystem seam extended with the one mutation readResult needs. */
export interface RunnerFs extends FsSeam {
  /** Delete a file. It must resolve, not reject, when the file is already gone. */
  unlink(path: string): Promise<void>;
}

/**
 * Process-backed searches, implemented by the caller (2.1 wiring) with git through the ArgvSeam.
 * No shell is involved: use `git ls-files -z --cached --others --exclude-standard -- <pathspecs>`
 * and `git grep -l -z -F --untracked -e <needle> -- <globs>`, where git grep exit 1 means [].
 * `undefined` means the search could not run. It is never the same as "no match".
 */
export interface TestSearchSeam {
  /** Absolute paths under gitRoot whose basename is one of `names`. */
  findByName(gitRoot: string, names: readonly string[]): Promise<readonly string[] | undefined>;
  /** Absolute paths under gitRoot that match a pathspec in `globs` and contain `needle` literally. */
  findByContent(gitRoot: string, needle: string, globs: readonly string[]): Promise<readonly string[] | undefined>;
}

export type CommandSource =
  | { readonly type: "command" }
  | {
      readonly type: "script";
      readonly manager: PackageManager;
      readonly name: string;
      /** Absolute path of the package.json that supplied the script. It is a config trigger (G.7). */
      readonly packageJson: string;
    };

/** detectRunner's output: a fully classified invocation (sections B, C, D). */
export interface DetectedRunner {
  readonly kind: RunnerKind;
  readonly launcher: Launcher;
  readonly source: CommandSource;
  readonly gitRoot: string;
  /** The runner's working directory: cwd for direct commands, the package.json dir for scripts. */
  readonly runnerCwd: string;
  /** cross-env assignments. */
  readonly env: Readonly<Record<string, string>>;
  /** User arguments kept verbatim, in order (D). */
  readonly keptArgs: readonly string[];
  /** The last user cap value (D, E). Undefined when there is none or it was invalid. */
  readonly userWorkers?: UserWorkerCap;
  /** pytest: absolute path scopes from the user's positionals (empty means runnerCwd). Always empty for vitest/jest. */
  readonly pathScopes: readonly string[];
  /** pytest: xdist is known to be present and is not disabled (D.4). Always false for vitest/jest. */
  readonly xdist: boolean;
  /** pytest: pytest-cov options found in the pytest config (D.4). Always false for vitest/jest. */
  readonly covInConfig: boolean;
  readonly notes: readonly string[];
}

/** What resolveEntry needs. DetectedRunner satisfies it. */
export interface EntryRequest {
  readonly kind: ToolKind;
  readonly launcher: Launcher;
  readonly gitRoot: string;
}

export interface ResolvedEntry {
  /** host.execPath for JS tools; the native pytest/uv executable otherwise. */
  readonly file: string;
  /** Leading args: [entryJs] for JS tools, [] for pytest, ["run", "pytest"] for uv. */
  readonly prefix: readonly string[];
  /** The resolved JS entry or native executable. Part of the S5 batch key. */
  readonly entry: string;
  /** The package.json "version" (JS tools only). */
  readonly version?: string;
}

/** An executable test run (sections H, N). Spawn it with ArgvSeam(file, args, {cwd, env, ...}). */
export interface ScopedSpec {
  readonly runner: RunnerKind;
  readonly mode: "related" | "rerun";
  /** process.execPath for vitest/jest; the native pytest/uv executable otherwise. Never a shim. */
  readonly file: string;
  /** The complete argv after `file` (H). */
  readonly args: readonly string[];
  readonly cwd: string;
  /** cross-env assignments plus the adapter's env. The ArgvSeam merges it over process.env. */
  readonly env: Readonly<Record<string, string>>;
  /** Under os.tmpdir(), never inside gitRoot. readResult deletes it. */
  readonly reportPath: string;
  readonly gitRoot: string;
  /** Same as ResolvedEntry.entry. */
  readonly entry: string;
  /** Absolute files handed to the runner, sorted. They are sources (vitest/jest related) or test files. */
  readonly inputs: readonly string[];
  /** True when `inputs` are test files (pytest, every rerun), so S5 attribution can be static. */
  readonly inputsAreTests: boolean;
  /** The worker cap emitted. null when no cap flag applies (pytest without xdist). */
  readonly workers: number | null;
  readonly notes: readonly string[];
}

/** An executable scoped eslint run (section K). Pass or fail comes from the exit code. */
export interface LintSpec {
  readonly runner: "eslint";
  /** host.execPath. */
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly gitRoot: string;
  readonly entry: string;
  readonly inputs: readonly string[];
  /** The --concurrency emitted. null when the user set none (eslint's default is "off"). */
  readonly workers: number | null;
  readonly notes: readonly string[];
}

/** planScopedRun's result. */
export type ScopingPlan = ScopedSpec | NoAffected | Unverifiable;

/** planStaticScoping's "no S6 decidable without a search" outcome. */
export interface StaticScopable {
  readonly scopable: true;
  readonly runner: RunnerKind;
  /** Gone sources and pytest modules whose tests still need a search (G, end of section). */
  readonly pendingSearches: number;
  readonly notes: readonly string[];
}

/** planStaticScoping's result: the risk signal's input (section 1.5-17, Q). */
export type StaticScoping = StaticScopable | NoAffected | Unverifiable;

export interface PlanScopedRunInput {
  /** The resolved check command (resolveRepoCommand). It already passed isCommandAllowed. */
  readonly command: string;
  readonly cwd: string;
  /** "unavailable" when change attribution is unavailable (section 1.5-6). */
  readonly changedFiles: readonly ChangedPath[] | "unavailable";
  readonly budget: RunnerBudget;
  /** Injected core count (percent and auto caps). Default: host.cores. */
  readonly cores?: number;
  readonly fs: FsSeam;
  readonly search: TestSearchSeam;
  readonly host?: Partial<RunnerHost>;
}

/** planScopedRun's input without the process-backed search. */
export type StaticScopingInput = Omit<PlanScopedRunInput, "search">;

/** Lint needs no search: deleted files are simply not linted. */
export type PlanScopedLintInput = Omit<PlanScopedRunInput, "search">;

export interface RerunDeps {
  readonly fs: FsSeam;
  /** Reuse an entry resolved elsewhere, such as the current tree for a reference worktree. Default: resolveEntry(runner, cwd). */
  readonly entry?: ResolvedEntry;
  readonly cores?: number;
  readonly host?: Partial<RunnerHost>;
}

/** readResult's output (section I). */
export interface RunResult {
  /** Stable ids, cwd-relative with "/" separators, sorted: "<file> > a > b", "<file>::Cls::test", or a bare "<file>" for a file-level failure. */
  readonly failingIds: readonly string[];
  /** Absolute paths (native separators) of files with any failure, sorted. */
  readonly failingFiles: readonly string[];
  /** A collection, import or syntax error, or a missing report after a non-zero exit. */
  readonly collectionError: boolean;
  /** Tests executed. undefined when unknown (text fallback). */
  readonly total: number | undefined;
  /** failingIds is a full inventory of the failures. false never yields a pass. */
  readonly complete: boolean;
  readonly source: "report" | "text";
  /** A stable explanation when complete is false or the report and exit code disagree. */
  readonly note?: string;
}

// ---------------------------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------------------------

export function isUnverifiable(x: object): x is Unverifiable {
  return "unverifiable" in x && x.unverifiable === true;
}

export function isNoAffected(x: object): x is NoAffected {
  return "noAffected" in x && x.noAffected === true;
}

export function isUnscoped(x: object): x is Unscoped {
  return "unscoped" in x && x.unscoped === true;
}

export function isScopedSpec(x: object): x is ScopedSpec {
  return "reportPath" in x && "runner" in x;
}

// ---------------------------------------------------------------------------------------------
// Functions (Task 1.3.2 implements them; the signatures are the contract)
// ---------------------------------------------------------------------------------------------

/** 1.3.2.a: classify the check command, or the package script behind it (B, C, D). Reads fs only. */
export async function detectRunner(
  command: string,
  cwd: string,
  fs: FsSeam,
  host?: Partial<RunnerHost>,
): Promise<DetectedRunner | Unverifiable> {
  throw new Error("not implemented: runner.detectRunner (Task 1.3.2.a)");
}

/** 1.3.2.b: locate the JS bin entry or the native executable (F), walking from cwd up to runner.gitRoot. */
export async function resolveEntry(
  runner: EntryRequest,
  cwd: string,
  fs: FsSeam,
  host?: Partial<RunnerHost>,
): Promise<ResolvedEntry | Unverifiable> {
  throw new Error("not implemented: runner.resolveEntry (Task 1.3.2.b)");
}

/** 1.3.2.c: the full planner (B through H), including the section 1.5-5 and pytest searches. */
export async function planScopedRun(input: PlanScopedRunInput): Promise<ScopingPlan> {
  throw new Error("not implemented: runner.planScopedRun (Task 1.3.2.c)");
}

/** 1.3.2.c: the process-free subset of planScopedRun, for the section 1.5-17 risk signal (O.4). */
export async function planStaticScoping(input: StaticScopingInput): Promise<StaticScoping> {
  throw new Error("not implemented: runner.planStaticScoping (Task 1.3.2.c)");
}

/**
 * 1.3.2.e: run exactly `testFiles` (absolute paths in the tree at `cwd`) with the same runner
 * options and caps (H, rerun rows). Used by S2 rechecks in the reference worktree. 2.2's mode B
 * uses a per-request planScopedRun instead (J). Missing, relative or outside-root files are
 * dropped; when none remain -> NoAffected (M.2).
 */
export async function planRerun(
  runner: DetectedRunner,
  testFiles: readonly string[],
  cwd: string,
  budget: RunnerBudget,
  deps: RerunDeps,
): Promise<ScopedSpec | NoAffected | Unverifiable> {
  throw new Error("not implemented: runner.planRerun (Task 1.3.2.e)");
}

/** 1.3.2.f: parse the report (or fall back to observeTests) and always delete the report file (I, N.4). */
export async function readResult(
  spec: ScopedSpec,
  execResult: ExecResult,
  fs: RunnerFs,
  host?: Partial<RunnerHost>,
): Promise<RunResult> {
  throw new Error("not implemented: runner.readResult (Task 1.3.2.f)");
}

/** 1.3.2.g: scope a plain eslint invocation to the changed lintable files (K, section 1.5-10). */
export async function planScopedLint(input: PlanScopedLintInput): Promise<LintSpec | NoAffected | Unscoped> {
  throw new Error("not implemented: runner.planScopedLint (Task 1.3.2.g)");
}

/** Section E: the single worker-cap rule shared by every runner. It never exceeds the budget. */
export function effectiveWorkers(user: UserWorkerCap | undefined, budget: RunnerBudget, cores: number): number {
  throw new Error("not implemented: runner.effectiveWorkers (Task 1.3.2.c)");
}
