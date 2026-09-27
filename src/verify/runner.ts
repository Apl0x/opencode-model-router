// src/verify/runner.ts
//
// RUNNER ADAPTER: design note (plan Task 1.3.1) and typed contract.
// Implementation: Task 1.3.2 (parts 1 and 2).
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
// FsSeam/PlannerFs/RunnerFs for the filesystem, TestSearchSeam for test-file searches (the caller runs git)
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
//   3a. Canonical spelling (QA-1.3-1, QA-1.3-7). win32 first strips the \\?\, \\.\ and \\?\UNC\
//      prefixes. Then abs goes through realOf: fs.realpath (PlannerFs), which resolves symlinks,
//      junctions and 8.3 short names. A missing file keeps its lexical tail below the realpath of
//      its nearest existing ancestor. cwd (hence gitRoot, the package.json and runnerCwd), path
//      scopes, rerun test files and the tmpdir are canonicalized the same way, so every path in a
//      spec is a real path. Reason: jest realpaths rootDir and then matched none of the lexical
//      --findRelatedTests paths (0 tests, exit 0 under --passWithNoTests) for an 8.3 or junction
//      cwd. Without fs.realpath the paths stay lexical and the spec carries lexicalPaths (I 2a).
//      The trigger check (7) also looks at the lexical basename, so a symlink named
//      vitest.config.ts still triggers.
//   4. rel = P.relative(gitRoot, abs). The file is outside the root when rel === "", rel starts
//      with a ".." segment, or P.isAbsolute(rel) (another drive). Outside files are dropped with
//      the note `dropped outside the git root: <candidate>`.
//   4a. A non-empty change set in which EVERY candidate was dropped (outside, NUL) -> S6
//      attribution-unavailable (lint: Unscoped), never NoAffected (QA-1.3-7).
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
//   reportPath = P.join(P.resolve(host.tmpdir), `omr-verify-${host.randomId()}.json`); pytest
//   uses ".xml". A relative host.tmpdir -> S6 tmpdir-in-repo "temp dir is not an absolute path"
//   (the runner would resolve it against spec.cwd, inside the repo: QA-1.3-11). The tmpdir inside
//   gitRoot, lexically or after realpath -> S6 tmpdir-in-repo.
//   The command line must not exceed MAX_ARGV_CHARS; otherwise -> S6 argv-too-long. It is
//   counted as CreateProcess receives it (QA-1.3-14): file plus args, one separator each, and on
//   win32 each argument quoted the way libuv quotes it (+2 for a space, tab or quote, 2n+1
//   backslashes before a quote, doubled trailing backslashes, "" for an empty argument).
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
//   Step 2a (QA-1.3-1) Zero-test guard, for JSON and junit alike. A complete report with total 0,
//     no failing id and no collection error becomes complete = false when
//       - mode is "rerun" (every input is an existing test file), note `rerun ran no tests
//         although every input is a test file`;
//       - jest related was given a JS test file (G.8 rule), note `jest ran no tests although a
//         test file was passed`;
//       - jest ran from a spec with lexicalPaths, note `jest ran no tests and the paths were not
//         canonicalized (no realpath seam)`.
//     A parser exception is an unusable report: step 4 with the note `report could not be
//     parsed: <message>` (QA-1.3-12). readResult never rejects.
//   Step 3  pytest junit XML, parsed at regex level (no XML library).
//     - Read each <testcase .../> and <testcase ...>...</testcase>, with its classname and name
//       attributes. Decode &amp; &lt; &gt; &quot; &apos; &#N; and &#xN;. A numeric reference
//       outside 0..0xD7FF and 0xE000..0x10FFFF stays literal text (QA-1.3-12).
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
//                              change attribution unavailable: no changed path lies inside the
//                              git root   (G.4a)
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
//                              temp dir is not an absolute path: <tmpdir>   (H)
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
//   4. reportPath lives in host.tmpdir and randomId is a UUID. A relative tmpdir, or one inside
//      gitRoot (lexically or after realpath) -> S6. readResult reads and unlinks only an
//      absolute path whose dirname equals the absolute host.tmpdir (case-insensitive on win32)
//      and whose basename matches REPORT_NAME_RE.
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
//      never masquerades as a test failure. It counts the program path and win32 quoting.
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
//       means green with the note "no affected tests ran" (I step 2a already turned the
//       untrustworthy zeros into complete = false). The fs passed to the planners must be a
//       PlannerFs with the native realpath (G.3a).
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

import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as nodePath from "node:path";
import { observeTests } from "./baseline";
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

/**
 * The planners' filesystem seam (G.3a, QA-1.3-1). `realpath` must be the NATIVE realpath
 * (fs.promises.realpath or fs.realpathSync.native): it resolves symlinks, junctions and win32
 * 8.3 short names, and it rejects for a missing path. The JS fs.realpathSync does not expand 8.3
 * names and must not be used. `fileExists` must accept directories as well as files (B step 0).
 * Without `realpath`, paths stay lexical, every spec carries `lexicalPaths: true`, and readResult
 * never trusts a jest run that reports 0 tests.
 */
export interface PlannerFs extends FsSeam {
  realpath?(path: string): Promise<string>;
}

/** Filesystem seam extended with the one mutation readResult needs. */
export interface RunnerFs extends PlannerFs {
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
  /**
   * Set when the fs seam had no realpath, so cwd and inputs may not be the canonical spelling
   * (G.3a). jest matches files against its realpath'd rootDir, so readResult treats a jest run
   * reporting 0 tests as incomplete.
   */
  readonly lexicalPaths?: true;
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
  readonly fs: PlannerFs;
  readonly search: TestSearchSeam;
  readonly host?: Partial<RunnerHost>;
}

/** planScopedRun's input without the process-backed search. */
export type StaticScopingInput = Omit<PlanScopedRunInput, "search">;

/** Lint needs no search: deleted files are simply not linted. */
export type PlanScopedLintInput = Omit<PlanScopedRunInput, "search">;

export interface RerunDeps {
  readonly fs: PlannerFs;
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
// Internal helpers (host, paths, reasons)
// ---------------------------------------------------------------------------------------------

type PathApi = typeof nodePath.posix;

interface Ctx {
  readonly host: RunnerHost;
  readonly P: PathApi;
  readonly win: boolean;
  key(p: string): string;
}

function resolveHost(h: Partial<RunnerHost> | undefined): RunnerHost {
  return {
    platform: h?.platform ?? process.platform,
    execPath: h?.execPath ?? process.execPath,
    tmpdir: h?.tmpdir ?? os.tmpdir(),
    cores: h?.cores ?? os.availableParallelism(),
    pathEnv: h?.pathEnv ?? process.env.PATH ?? "",
    pytestAddopts: h?.pytestAddopts ?? process.env.PYTEST_ADDOPTS ?? "",
    randomId: h?.randomId ?? randomUUID,
  };
}

function makeCtx(h: Partial<RunnerHost> | undefined): Ctx {
  const host = resolveHost(h);
  const win = host.platform === "win32";
  return { host, P: win ? nodePath.win32 : nodePath.posix, win, key: (p: string) => (win ? p.toLowerCase() : p) };
}

function s6(code: S6Code, reason: string): Unverifiable {
  return { unverifiable: true, code, reason };
}

function noAffected(note: string): NoAffected {
  return { noAffected: true, note };
}

function isS6(x: object): x is Unverifiable {
  return isUnverifiable(x);
}

/** True when `abs` is `root` itself or lies below it (G.4 rules; win32 compares case-insensitively). */
function isInside(ctx: Ctx, root: string, abs: string): boolean {
  const rel = ctx.P.relative(root, abs);
  if (rel === "") return true;
  if (ctx.P.isAbsolute(rel)) return false;
  return rel.split(/[\\/]/)[0] !== "..";
}

/** Directories from `from` up to `root`, inclusive. Empty when `from` is not inside `root`. */
function ancestors(ctx: Ctx, from: string, root: string): string[] {
  if (!isInside(ctx, root, from)) return [];
  const out: string[] = [];
  let d = ctx.P.resolve(from);
  for (;;) {
    out.push(d);
    if (ctx.key(d) === ctx.key(ctx.P.resolve(root))) break;
    const parent = ctx.P.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return out;
}

function toSlash(ctx: Ctx, rel: string): string {
  return ctx.win ? rel.replace(/\\/g, "/") : rel;
}

async function findGitRoot(ctx: Ctx, cwd: string, fs: FsSeam): Promise<string | undefined> {
  let d = ctx.P.resolve(cwd);
  for (;;) {
    if (await fs.fileExists(ctx.P.join(d, ".git"))) return d;
    const parent = ctx.P.dirname(d);
    if (parent === d) return undefined;
    d = parent;
  }
}

/** G.3a: drop the win32 `\\?\`, `\\.\` and `\\?\UNC\` prefixes (QA-1.3-7). Other platforms: unchanged. */
function stripWinPrefix(ctx: Ctx, p: string): string {
  if (!ctx.win) return p;
  if (/^[\\/]{2}[?.][\\/]UNC[\\/]/i.test(p)) return `\\\\${p.slice(8)}`;
  if (/^[\\/]{2}[?.][\\/]/.test(p)) return p.slice(4);
  return p;
}

/**
 * G.3a (QA-1.3-1): the canonical spelling of the absolute path `p`, with symlinks, junctions and
 * 8.3 names resolved. A missing tail (a deleted file) is kept lexically below its nearest
 * existing ancestor. Without fs.realpath the result is `p` itself.
 */
async function realOf(ctx: Ctx, fs: PlannerFs, p: string): Promise<string> {
  const rp = fs.realpath;
  if (!rp) return p;
  const tail: string[] = [];
  let head = p;
  for (;;) {
    const real = await rp.call(fs, head).then(
      (x) => stripWinPrefix(ctx, x),
      () => undefined,
    );
    if (real !== undefined) return tail.length === 0 ? real : ctx.P.join(real, ...tail.reverse());
    const up = ctx.P.dirname(head);
    if (up === head) return p;
    tail.push(ctx.P.basename(head));
    head = up;
  }
}

/** An absolute, canonical directory for a caller-supplied cwd. */
async function canonicalCwd(ctx: Ctx, fs: PlannerFs, cwd: string): Promise<string> {
  return realOf(ctx, fs, ctx.P.resolve(stripWinPrefix(ctx, cwd)));
}

async function readJson(fs: FsSeam, path: string): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: JSON.parse(await fs.readFile(path)) as unknown };
  } catch {
    return { ok: false };
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// ---------------------------------------------------------------------------------------------
// C. Script parsing
// ---------------------------------------------------------------------------------------------

/** C.1: POSIX-style subset. Returns undefined on an unterminated quote. */
function tokenize(s: string): string[] | undefined {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === " " || ch === "\t") {
      if (has) out.push(cur);
      cur = "";
      has = false;
      i++;
    } else if (ch === '"') {
      has = true;
      i++;
      let closed = false;
      while (i < s.length) {
        if (s[i] === "\\" && s[i + 1] === '"') {
          cur += '"';
          i += 2;
        } else if (s[i] === '"') {
          closed = true;
          i++;
          break;
        } else {
          cur += s[i];
          i++;
        }
      }
      if (!closed) return undefined;
    } else if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return undefined;
      cur += s.slice(i + 1, end);
      has = true;
      i = end + 1;
    } else {
      cur += ch;
      has = true;
      i++;
    }
  }
  if (has) out.push(cur);
  return out;
}

const COMPOSITE_MULTI = ["&&", "||", "$("];
const COMPOSITE_SINGLE = new Set([";", "|", "&", ">", "<", "`", "$"]);
const PERCENT_VAR_RE = /%[A-Za-z_][A-Za-z0-9_]*%/y;

/** C.2: the first composite construct in the raw text (quotes ignored), or undefined. */
function findComposite(s: string): string | undefined {
  for (let i = 0; i < s.length; i++) {
    const two = s.slice(i, i + 2);
    if (COMPOSITE_MULTI.includes(two)) return two;
    const ch = s[i];
    if (ch === "\r" || ch === "\n") return "newline";
    if (COMPOSITE_SINGLE.has(ch)) return ch;
    if (ch === "%") {
      PERCENT_VAR_RE.lastIndex = i;
      const m = PERCENT_VAR_RE.exec(s);
      if (m) return m[0];
    }
  }
  return undefined;
}

const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

type Invocation<K extends ToolKind> =
  | { readonly type: "direct"; readonly kind: K; readonly launcher: Launcher; readonly env: Record<string, string>; readonly args: string[] }
  | {
      readonly type: "script";
      readonly manager: PackageManager;
      readonly name: string;
      readonly env: Record<string, string>;
      readonly extra: string[];
      readonly notes: string[];
    };

function unsupported(prefix: string, where: string): Unverifiable {
  return s6("unsupported-command", `unsupported command "${prefix}" in ${where}`);
}

/** The runner heads a detection accepts: JS tools by bare name, plus pytest when `py` is set. */
interface Heads<K extends ToolKind> {
  readonly js: readonly K[];
  readonly py?: K & "pytest";
}
const TEST_HEADS: Heads<RunnerKind> = { js: ["vitest", "jest"], py: "pytest" };
const LINT_HEADS: Heads<"eslint"> = { js: ["eslint"] };

/** B step 2 + C.3: classify a token list. `allowScripts` is false inside a package script. */
function parseInvocation<K extends ToolKind>(
  tokens: readonly string[],
  where: string,
  allowScripts: boolean,
  heads: Heads<K>,
): Invocation<K> | Unverifiable {
  const env: Record<string, string> = {};
  let t = tokens;
  if (t[0] === "cross-env") {
    let i = 1;
    for (; i < t.length; i++) {
      const m = ASSIGN_RE.exec(t[i]);
      if (!m) break;
      env[m[1]] = m[2];
    }
    if (i >= t.length) return unsupported("cross-env", where);
    t = t.slice(i);
  }
  const h = t[0] ?? "";
  const inline = ASSIGN_RE.exec(h);
  if (inline) {
    return s6("inline-env", `inline environment assignment "${inline[1]}=" in ${where} (only cross-env is supported)`);
  }
  const direct = (kind: K, launcher: Launcher, args: string[]): Invocation<K> => ({ type: "direct", kind, launcher, env, args });
  const jsKind = (x: string | undefined): K | undefined => heads.js.find((k) => k === x);
  const hk = jsKind(h);
  if (hk) return direct(hk, "direct", t.slice(1));
  if (h === "pytest" && heads.py) return direct(heads.py, "direct", t.slice(1));
  if (h === "npx") {
    const r = jsKind(t[1]);
    return r ? direct(r, "npx", t.slice(2)) : unsupported(`npx ${t[1] ?? ""}`.trim(), where);
  }
  if (h === "uv") {
    if (t[1] === "run" && t[2] === "pytest" && heads.py) return direct(heads.py, "uv-run", t.slice(3));
    return unsupported(t[1] === "run" ? `uv run ${t[2] ?? ""}`.trim() : `uv ${t[1] ?? ""}`.trim(), where);
  }
  if (h === "pnpm" && t[1] === "exec") {
    const r = jsKind(t[2]);
    return r ? direct(r, "pnpm-exec", t.slice(3)) : unsupported(`pnpm exec ${t[2] ?? ""}`.trim(), where);
  }
  if (h !== "npm" && h !== "pnpm" && h !== "yarn" && h !== "bun") return unsupported(h, where);
  if (!allowScripts) return unsupported(h, where);

  const sub = t[1];
  const script = (name: string | undefined, rest: string[]): Invocation<K> | Unverifiable => {
    if (name === undefined) return unsupported(`${h} ${sub}`, where);
    if (h === "npm") {
      const dd = rest.indexOf("--");
      const ignored = dd < 0 ? rest : rest.slice(0, dd);
      const notes = ignored.length > 0 ? [`npm options ignored: ${ignored.join(" ")}`] : [];
      return { type: "script", manager: "npm", name, env, extra: dd < 0 ? [] : rest.slice(dd + 1), notes };
    }
    return { type: "script", manager: h, name, env, extra: rest[0] === "--" ? rest.slice(1) : rest, notes: [] };
  };
  if (h === "npm") {
    if (sub === "test" || sub === "t") return script("test", t.slice(2));
    if (sub === "run" || sub === "run-script") return script(t[2], t.slice(3));
  } else if (h === "pnpm") {
    if (sub === "test" || sub === "t") return script("test", t.slice(2));
    if (sub === "run") return script(t[2], t.slice(3));
  } else if (h === "yarn") {
    if (sub === "test") return script("test", t.slice(2));
    if (sub === "run") return script(t[2], t.slice(3));
  } else {
    if (sub === "test") {
      return s6("bun-test", `"bun test" runs Bun's built-in test runner, not scripts.test (use "bun run test")`);
    }
    if (sub === "run") return script(t[2], t.slice(3));
  }
  return unsupported(`${h} ${sub ?? ""}`.trim(), where);
}

// ---------------------------------------------------------------------------------------------
// D. User arguments
// ---------------------------------------------------------------------------------------------

type Arity = "0" | "1" | "?" | "*";
type ArgAction = "drop" | "cap" | "cap1-keep" | "cap1-drop" | "keep" | "s6";
interface ArgEntry {
  readonly names: readonly string[];
  readonly action: ArgAction;
  readonly arity: Arity;
  readonly note?: string;
}

const COVERAGE_NOTE = "coverage disabled for the scoped run";
const e = (names: string, action: ArgAction, arity: Arity, note?: string): ArgEntry => ({ names: names.split(" "), action, arity, note });

const VITEST_ARGS: readonly ArgEntry[] = [
  e("--run --watch -w --no-watch --ui --open --standalone --update -u --passWithNoTests --clearScreen --inspect --inspect-brk", "drop", "0"),
  e("--coverage", "drop", "0", COVERAGE_NOTE),
  e("--changed --api --mergeReports", "drop", "?"),
  e("--coverage.*", "drop", "?", COVERAGE_NOTE),
  e("--reporter --outputFile --outputFile.* --shard --minWorkers --min-workers --api.*", "drop", "1"),
  e("--maxWorkers --max-workers", "cap", "1"),
  e("--no-file-parallelism --fileParallelism=false", "cap1-keep", "0"),
  e("--config -c --root -r --dir --project --environment --pool --testNamePattern -t --mode --testTimeout --hookTimeout --teardownTimeout --retry --bail --exclude", "keep", "1"),
  e("--browser --sequence.* --typecheck.* --browser.*", "keep", "?"),
  e("--globals --dom --isolate --no-isolate --allowOnly --silent --hideSkippedTests --logHeapUsage --color --no-color --expandSnapshotDiff --disableConsoleIntercept --typecheck", "keep", "0"),
];

const JEST_ARGS: readonly ArgEntry[] = [
  e("--watch --watchAll --json --findRelatedTests --listTests --onlyChanged -o --lastCommit --changedFilesWithAncestor --updateSnapshot -u --passWithNoTests --runTestsByPath", "drop", "0"),
  e("--coverage --collectCoverage", "drop", "0", COVERAGE_NOTE),
  e("--outputFile --changedSince --shard --collectCoverageFrom --coverageDirectory --coverageProvider --coverageThreshold", "drop", "1"),
  e("--reporters --coverageReporters --coveragePathIgnorePatterns", "drop", "*"),
  e("--maxWorkers --max-workers -w", "cap", "1"),
  e("--runInBand -i", "cap1-drop", "0"),
  e("--config -c --rootDir --testNamePattern -t --testEnvironment --env --testTimeout --testRunner --testSequencer --cacheDirectory --workerIdleMemoryLimit --seed --maxConcurrency --openHandlesTimeout", "keep", "1"),
  e("--bail -b", "keep", "?"),
  e("--roots --selectProjects --ignoreProjects --projects --testPathPatterns --testPathPattern --testPathIgnorePatterns --testMatch", "keep", "*"),
  e("--ci --silent --verbose --detectOpenHandles --detectLeaks --forceExit --cache --no-cache --colors --watchman --no-watchman --errorOnDeprecated --injectGlobals --noStackTrace --useStderr --workerThreads --randomize --showSeed --clearMocks --resetMocks --restoreMocks --expand -e --logHeapUsage", "keep", "0"),
  e("--showConfig --clearCache --init", "s6", "0"),
];

const PYTEST_ARGS: readonly ArgEntry[] = [
  e("-q --quiet --lf --last-failed --ff --failed-first --nf --new-first --sw --stepwise --sw-skip --stepwise-skip --cache-clear --pdb --trace -f --looponfail --cov-append --cov-branch --no-cov --no-cov-on-fail --self-contained-html --json-report", "drop", "0"),
  e("--cov", "drop", "?"),
  e("--junitxml --junit-xml --pdbcls --cov-report --cov-config --cov-fail-under --cov-context --html --json-report-file", "drop", "1"),
  e("-n --numprocesses --maxprocesses", "cap", "1"),
  e("-k -m -c --config-file --rootdir -o --override-ini -W --pythonwarnings --tb -r --import-mode --basetemp --durations --durations-min --timeout --maxfail --ignore --ignore-glob --deselect --confcutdir --dist --capture --log-level --log-cli-level", "keep", "1"),
  e("-x --exitfirst -v -vv --verbose -s -l --showlocals --strict-markers --strict-config --disable-warnings --no-header --runxfail", "keep", "0"),
  e("--co --collect-only --fixtures --fixtures-per-test --markers --setup-plan --setup-only --version -V -h --help", "s6", "0"),
];

const ESLINT_ARGS: readonly ArgEntry[] = [
  e("--fix --fix-dry-run --no-warn-ignored", "drop", "0"),
  e("--fix-type -o --output-file", "drop", "1"),
  e("--concurrency", "cap", "1"),
  e("-c --config --ext --parser --parser-options --resolve-plugins-relative-to --rulesdir --plugin --rule --env --global --ignore-path --ignore-pattern --cache-location --cache-strategy -f --format --max-warnings --report-unused-disable-directives-severity --flag", "keep", "1"),
  e("--cache --quiet --no-eslintrc --no-config-lookup --no-ignore --no-inline-config --report-unused-disable-directives --color --no-color --no-error-on-unmatched-pattern --exit-on-fatal-error --pass-on-no-patterns --stats --debug", "keep", "0"),
  e("--init --print-config --inspect-config --env-info -v --version -h --help --stdin --stdin-filename", "s6", "0"),
];

const ARG_TABLES: Record<ToolKind, readonly ArgEntry[]> = { vitest: VITEST_ARGS, jest: JEST_ARGS, pytest: PYTEST_ARGS, eslint: ESLINT_ARGS };

interface ArgMatch {
  readonly entry: ArgEntry;
  readonly name: string;
  /** The value was attached ("--x=v", "-xV"): arity is ignored. */
  readonly inline: boolean;
  readonly value?: string;
}

function matchArg(table: readonly ArgEntry[], t: string): ArgMatch | undefined {
  for (const entry of table) {
    for (const name of entry.names) {
      if (name.endsWith(".*")) {
        const p = name.slice(0, -1);
        if (t.startsWith(p) && t.length > p.length) {
          const eq = t.indexOf("=");
          return { entry, name, inline: eq >= 0, value: eq >= 0 ? t.slice(eq + 1) : undefined };
        }
      } else if (t === name) {
        return { entry, name, inline: false };
      } else if (t.startsWith(`${name}=`)) {
        return { entry, name, inline: true, value: t.slice(name.length + 1) };
      }
    }
  }
  for (const entry of table) {
    if (entry.arity !== "1") continue;
    for (const name of entry.names) {
      if (/^-[A-Za-z]$/.test(name) && t.startsWith(name) && t.length > 2) {
        return { entry, name, inline: true, value: t.slice(2) };
      }
    }
  }
  return undefined;
}

/** Section E: parse a user worker-cap value for one tool. undefined means invalid. */
function parseCap(kind: ToolKind, raw: string): UserWorkerCap | undefined {
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) return undefined;
    if (n === 0 && kind !== "pytest") return undefined;
    return { count: n };
  }
  const pm = /^(\d{1,3})%$/.exec(raw);
  if (pm && (kind === "vitest" || kind === "jest")) {
    const p = Number(pm[1]);
    return p >= 1 && p <= 100 ? { percent: p } : undefined;
  }
  if (kind === "pytest" && (raw === "auto" || raw === "logical")) return { auto: true };
  if (kind === "eslint" && raw === "auto") return { auto: true };
  return undefined;
}

const PY_SCOPE_BAD_RE = /::|[*?[\]{}]/;
const ESLINT_GLOB_RE = /[*?[\]{}]/;

interface ArgResult {
  readonly kept: string[];
  readonly capRaw: string | undefined;
  readonly userWorkers: UserWorkerCap | undefined;
  readonly pathScopes: string[];
  readonly noXdist: boolean;
  readonly xdistArg: boolean;
  readonly notes: string[];
}

/** D.1 for vitest, jest, pytest and eslint. */
function processArgs(
  ctx: Ctx,
  kind: ToolKind,
  args: readonly string[],
  where: string,
  runnerCwd: string,
  gitRoot: string,
): ArgResult | Unverifiable {
  const table = ARG_TABLES[kind];
  const kept: string[] = [];
  const notes = new Set<string>();
  const filters: string[] = [];
  const pathScopes: string[] = [];
  let capRaw: string | undefined;
  let noXdist = false;
  let xdistArg = false;
  let firstPositional = true;
  const badArg = (t: string) => s6("unsupported-argument", `unsupported ${kind} argument "${t}" in ${where}`);

  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === "--") return badArg(t);
    if (kind === "pytest" && t.startsWith("-p") && !t.startsWith("--")) {
      const attached = t.length > 2;
      const value = attached ? t.slice(2) : args[i + 1];
      if (value === "no:cacheprovider") {
        if (!attached) i++;
        continue;
      }
      if (value === "no:xdist") noXdist = true;
      kept.push(t);
      if (!attached && value !== undefined) {
        kept.push(value);
        i++;
      }
      continue;
    }
    const m = matchArg(table, t);
    if (m) {
      const values: string[] = [];
      if (!m.inline) {
        if (m.entry.arity === "1") {
          if (i + 1 < args.length) values.push(args[i + 1]);
        } else if (m.entry.arity === "?") {
          if (i + 1 < args.length && !args[i + 1].startsWith("-")) values.push(args[i + 1]);
        } else if (m.entry.arity === "*") {
          for (let j = i + 1; j < args.length && !args[j].startsWith("-"); j++) values.push(args[j]);
        }
      }
      i += values.length;
      if (m.entry.note) notes.add(m.entry.note);
      if (m.name === "--dist") xdistArg = true;
      switch (m.entry.action) {
        case "drop":
          break;
        case "cap": {
          const raw = m.inline ? (m.value ?? "") : (values[0] ?? "");
          if (kind === "eslint" && raw === "off") {
            kept.push(t, ...values);
            break;
          }
          capRaw = raw;
          xdistArg = true;
          break;
        }
        case "cap1-keep":
          kept.push(t);
          capRaw = "1";
          break;
        case "cap1-drop":
          capRaw = "1";
          break;
        case "keep":
          kept.push(t, ...values);
          break;
        case "s6":
          return badArg(t);
      }
      continue;
    }
    if (t.startsWith("-")) {
      const next = args[i + 1];
      if (t.includes("=") || next === undefined || next.startsWith("-")) {
        kept.push(t);
        continue;
      }
      return s6("ambiguous-option", `ambiguous ${kind} option "${t}" in ${where}: cannot tell whether "${next}" is its value`);
    }
    // Positional.
    const first = firstPositional;
    firstPositional = false;
    if (kind === "vitest") {
      if (first && ["run", "watch", "dev", "related"].includes(t)) continue;
      if (first && ["bench", "list", "init", "typecheck"].includes(t)) {
        return s6("unsupported-subcommand", `unsupported vitest subcommand "${t}" in ${where}`);
      }
      filters.push(t);
    } else if (kind === "jest") {
      filters.push(t);
    } else {
      if (kind === "eslint" && ESLINT_GLOB_RE.test(t)) return s6("unsupported-argument", `eslint glob pattern in ${where}: "${t}"`);
      const abs = ctx.P.resolve(runnerCwd, t);
      if (PY_SCOPE_BAD_RE.test(t) || !isInside(ctx, gitRoot, abs)) return badArg(t);
      pathScopes.push(abs);
    }
  }
  if (filters.length > 0) notes.add(`${kind} filters dropped: ${filters.join(", ")}`);
  let userWorkers: UserWorkerCap | undefined;
  if (capRaw !== undefined) {
    userWorkers = parseCap(kind, capRaw);
    if (!userWorkers) notes.add(`invalid worker cap "${capRaw}" ignored`);
  }
  return { kept, capRaw, userWorkers, pathScopes, noXdist, xdistArg, notes: [...notes] };
}

const XDIST_RE = /(?:^|[\s"'[,=])(?:-n|--numprocesses|--maxprocesses|--dist)(?=[\s"'=,\]]|\d|$)/m;
const XDIST_VALUE_RE = /(?:-n|--numprocesses|--maxprocesses)(?:\s*=\s*|\s+|["']\s*,\s*["'])?["']?(\d+|auto|logical)\b/;
const COV_RE = /(?:^|[\s"'[,=])--cov(?=[=\s"',\]]|$)/m;
const PYTEST_CONFIG_FILES = ["pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg"];

/** D.4: the pytest config text of the nearest directory holding any config file. */
async function readPytestConfig(ctx: Ctx, fs: FsSeam, runnerCwd: string, gitRoot: string, notes: string[]): Promise<string> {
  for (const d of ancestors(ctx, runnerCwd, gitRoot)) {
    const texts: string[] = [];
    let found = false;
    for (const f of PYTEST_CONFIG_FILES) {
      const p = ctx.P.join(d, f);
      if (!(await fs.fileExists(p))) continue;
      found = true;
      try {
        texts.push(await fs.readFile(p));
      } catch {
        notes.push(`unreadable pytest config ignored: ${p}`);
      }
    }
    if (found) return texts.join("\n");
  }
  return "";
}

// ---------------------------------------------------------------------------------------------
// B. Detection
// ---------------------------------------------------------------------------------------------

/** A detection result for any tool kind; Detected<RunnerKind> is a DetectedRunner. */
type Detected<K extends ToolKind> = Omit<DetectedRunner, "kind"> & { readonly kind: K };

async function detectImpl<K extends ToolKind>(
  ctx: Ctx,
  command: string,
  cwd: string,
  fs: PlannerFs,
  heads: Heads<K>,
): Promise<Detected<K> | Unverifiable> {
  const P = ctx.P;
  const absCwd = await canonicalCwd(ctx, fs, cwd);
  const gitRoot = await findGitRoot(ctx, absCwd, fs);
  if (gitRoot === undefined) return s6("no-git-root", `no git repository at or above ${cwd}`);

  const composite = findComposite(command);
  if (composite !== undefined) return s6("composite", `composite command: "${composite}"`);
  const tokens = tokenize(command);
  if (!tokens) return s6("unterminated-quote", "unterminated quote in command");
  const inv = parseInvocation(tokens, "command", true, heads);
  if (isS6(inv)) return inv;

  if (inv.type === "direct") {
    return finishDetection(ctx, fs, inv.kind, inv.launcher, { type: "command" }, gitRoot, absCwd, inv.env, inv.args, "command", []);
  }

  let pkgPath: string | undefined;
  for (const d of ancestors(ctx, absCwd, gitRoot)) {
    const p = P.join(d, "package.json");
    if (await fs.fileExists(p)) {
      pkgPath = p;
      break;
    }
  }
  if (pkgPath === undefined) return s6("no-package-json", `no package.json between ${cwd} and the git root`);
  const parsed = await readJson(fs, pkgPath);
  if (!parsed.ok || !isRecord(parsed.value)) return s6("bad-package-json", `unreadable package.json: ${pkgPath}`);
  const scripts = parsed.value.scripts;
  const text = isRecord(scripts) ? scripts[inv.name] : undefined;
  if (typeof text !== "string") return s6("no-script", `package.json has no string scripts.${inv.name}: ${pkgPath}`);

  const where = `scripts.${inv.name}`;
  const sc = findComposite(text);
  if (sc !== undefined) return s6("composite", `composite ${where}: "${sc}"`);
  const st = tokenize(text);
  if (!st) return s6("unterminated-quote", `unterminated quote in ${where}`);
  const inner = parseInvocation(st, where, false, heads);
  if (isS6(inner)) return inner;
  if (inner.type !== "direct") return unsupported(inv.manager, where);

  const notes = [...inv.notes];
  for (const hook of [`pre${inv.name}`, `post${inv.name}`]) {
    if (isRecord(scripts) && scripts[hook] !== undefined) notes.push(`scripts.${hook} is not run by the scoped command`);
  }
  const source: CommandSource = { type: "script", manager: inv.manager, name: inv.name, packageJson: pkgPath };
  return finishDetection(
    ctx,
    fs,
    inner.kind,
    inner.launcher,
    source,
    gitRoot,
    P.dirname(pkgPath),
    { ...inv.env, ...inner.env },
    [...inner.args, ...inv.extra],
    where,
    notes,
  );
}

async function finishDetection<K extends ToolKind>(
  ctx: Ctx,
  fs: FsSeam,
  kind: K,
  launcher: Launcher,
  source: CommandSource,
  gitRoot: string,
  runnerCwd: string,
  env: Record<string, string>,
  args: readonly string[],
  where: string,
  notes: string[],
): Promise<Detected<K> | Unverifiable> {
  const a = processArgs(ctx, kind, args, where, runnerCwd, gitRoot);
  if (isS6(a)) return a;
  const allNotes = [...notes, ...a.notes];
  let userWorkers = a.userWorkers;
  let xdist = false;
  let covInConfig = false;
  if (kind === "pytest") {
    const cfg = await readPytestConfig(ctx, fs, runnerCwd, gitRoot, allNotes);
    const addopts = ctx.host.pytestAddopts;
    xdist = !a.noXdist && (a.xdistArg || XDIST_RE.test(cfg) || XDIST_RE.test(addopts));
    covInConfig = COV_RE.test(cfg) || COV_RE.test(addopts);
    if (a.capRaw === undefined) {
      const m = XDIST_VALUE_RE.exec(cfg) ?? XDIST_VALUE_RE.exec(addopts);
      if (m) userWorkers = parseCap("pytest", m[1]);
    }
  }
  return {
    kind,
    launcher,
    source,
    gitRoot,
    runnerCwd,
    env,
    keptArgs: a.kept,
    ...(userWorkers ? { userWorkers } : {}),
    pathScopes: a.pathScopes,
    xdist,
    covInConfig,
    notes: allNotes,
  };
}

// ---------------------------------------------------------------------------------------------
// F. Entry resolution
// ---------------------------------------------------------------------------------------------

async function resolveEntryImpl(
  ctx: Ctx,
  req: EntryRequest,
  cwd: string,
  fs: FsSeam,
): Promise<{ entry: ResolvedEntry; notes: string[] } | Unverifiable> {
  const P = ctx.P;
  const exe = (name: string) => (ctx.win ? `${name}.exe` : name);
  const onPath = async (name: string): Promise<string | undefined> => {
    for (const dir of ctx.host.pathEnv.split(P.delimiter)) {
      if (!dir || !P.isAbsolute(dir)) continue;
      const f = P.join(dir, exe(name));
      if (await fs.fileExists(f)) return f;
    }
    return undefined;
  };

  if (req.launcher === "uv-run") {
    const uv = await onPath("uv");
    if (!uv) return s6("runner-not-installed", "runner not installed: uv");
    return { entry: { file: uv, prefix: ["run", "pytest"], entry: uv }, notes: [] };
  }
  if (req.kind === "pytest") {
    const found = await onPath("pytest");
    if (found) return { entry: { file: found, prefix: [], entry: found }, notes: [] };
    const venvRel = ctx.win ? P.join(".venv", "Scripts", "pytest.exe") : P.join(".venv", "bin", "pytest");
    for (const d of ancestors(ctx, cwd, req.gitRoot)) {
      const f = P.join(d, venvRel);
      if (await fs.fileExists(f)) return { entry: { file: f, prefix: [], entry: f }, notes: [`pytest resolved from ${f}`] };
    }
    return s6("runner-not-installed", "runner not installed: pytest");
  }

  const pkg = req.kind;
  let pj: string | undefined;
  for (const d of ancestors(ctx, cwd, req.gitRoot)) {
    const p = P.join(d, "node_modules", pkg, "package.json");
    if (await fs.fileExists(p)) {
      pj = p;
      break;
    }
  }
  if (pj === undefined) {
    if (await fs.fileExists(P.join(req.gitRoot, ".pnp.cjs"))) {
      return s6("yarn-pnp", `yarn Plug'n'Play has no node_modules to resolve ${pkg} from`);
    }
    return s6("runner-not-installed", `runner not installed: ${pkg}`);
  }
  const badBin = (detail: string) => s6("bad-bin", `invalid bin for ${pkg}: ${detail}`);
  const parsed = await readJson(fs, pj);
  if (!parsed.ok || !isRecord(parsed.value)) return badBin(`unreadable package.json ${pj}`);
  const meta = parsed.value;
  if (meta.name !== pkg) return badBin(`package name is not "${pkg}"`);
  const bin = typeof meta.bin === "string" ? meta.bin : isRecord(meta.bin) ? meta.bin[pkg] : undefined;
  if (typeof bin !== "string") return badBin("no bin entry");
  const pkgDir = P.dirname(pj);
  const entry = P.resolve(pkgDir, bin);
  const rel = P.relative(pkgDir, entry);
  if (rel === "" || P.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) return badBin("bin escapes the package directory");
  if (!/\.(?:js|mjs|cjs)$/.test(entry)) return badBin("bin is not a .js, .mjs or .cjs file");
  if (!(await fs.fileExists(entry))) return badBin(`bin entry missing: ${entry}`);
  const version = typeof meta.version === "string" ? meta.version : undefined;
  return { entry: { file: ctx.host.execPath, prefix: [entry], entry, ...(version !== undefined ? { version } : {}) }, notes: [] };
}

// ---------------------------------------------------------------------------------------------
// G + H. Changed files and argv construction
// ---------------------------------------------------------------------------------------------

const JS_TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const PY_TEST_RE = /^test_.*\.py$|_test\.py$/;
const NON_INPUT_EXT_RE = /\.(md|mdx|markdown|rst|adoc|txt)$/i;
const NON_INPUT_NAMES = new Set([
  "LICENSE", "LICENCE", ".gitignore", ".gitattributes", ".editorconfig", ".npmignore", ".prettierignore",
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock",
]);
const TRIGGERS: Record<RunnerKind, RegExp> = {
  vitest: /^(?:package\.json|vitest\.config\..+|vite\.config\..+|vitest\.workspace\..+|vitest\.projects\..+|tsconfig.*\.json)$/,
  jest: /^(?:package\.json|jest\.config\..+|babel\.config\..+|\.babelrc|\.babelrc\..+|tsconfig.*\.json)$/,
  pytest: /^(?:conftest\.py|pyproject\.toml|pytest\.ini|setup\.cfg|tox\.ini)$/,
};
const NOTE_NO_CHANGES = "no changed files, no affected tests";
const NOTE_NO_INPUT = "no affected tests: no changed file is a test input";
const NOTE_NO_PY_MAP = "no affected tests: no test files map to the changed modules";
const NOTE_NO_LINT = "no changed lintable files";
const NOTE_NO_RERUN = "no rerun: none of the test files exist in this tree";

interface FileRef {
  readonly abs: string;
  readonly rel: string;
  /** The basename as the producer spelled it, before realpath (a trigger reached through a symlink). */
  readonly lexBase?: string;
}

function stemOf(ctx: Ctx, abs: string): string {
  const base = ctx.P.basename(abs);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem === "index" || stem === "__init__" ? ctx.P.basename(ctx.P.dirname(abs)) : stem;
}

/** G.3-G.5 for one path: canonical absolute path inside gitRoot, or undefined. */
function canonicalize(ctx: Ctx, cwd: string, gitRoot: string, p: string): FileRef | undefined {
  const abs = ctx.P.resolve(cwd, p);
  const rel = ctx.P.relative(gitRoot, abs);
  if (rel === "" || ctx.P.isAbsolute(rel) || rel.split(/[\\/]/)[0] === "..") return undefined;
  return { abs: ctx.P.join(gitRoot, rel), rel: toSlash(ctx, rel) };
}

async function plan(input: StaticScopingInput, search: TestSearchSeam): Promise<ScopingPlan>;
async function plan(input: StaticScopingInput, search: undefined): Promise<StaticScoping>;
async function plan(input: StaticScopingInput, search: TestSearchSeam | undefined): Promise<ScopingPlan | StaticScoping> {
  const ctx = makeCtx(input.host);
  const P = ctx.P;
  const fs = input.fs;
  if (input.changedFiles === "unavailable") return s6("attribution-unavailable", "change attribution unavailable");
  if (input.changedFiles.length === 0) return noAffected(NOTE_NO_CHANGES);

  const det = await detectImpl(ctx, input.command, input.cwd, fs, TEST_HEADS);
  if (isS6(det)) return det;
  const gitRoot = det.gitRoot;
  const cwd = await canonicalCwd(ctx, fs, input.cwd);
  const notes: string[] = [...det.notes];
  const sorted = await collectChanged(ctx, fs, cwd, gitRoot, input.changedFiles, notes);
  if (sorted.length === 0) return s6("attribution-unavailable", NO_PATH_KEPT);

  // G.7: config triggers.
  const sourcePj = det.source.type === "script" ? ctx.key(det.source.packageJson) : undefined;
  for (const f of sorted) {
    if (namesOf(ctx, f).some((b) => TRIGGERS[det.kind].test(b)) || ctx.key(f.abs) === sourcePj) {
      return s6("config-changed", `config file changed: ${f.rel}`);
    }
  }
  return classify(ctx, input, det, sorted, notes, search);
}

/** Change attribution that names only paths the planner cannot use (G.4a). */
const NO_PATH_KEPT = "change attribution unavailable: no changed path lies inside the git root";

/** The basenames a trigger is matched against (G.7): real and lexical, lower-cased on win32. */
function namesOf(ctx: Ctx, f: FileRef): string[] {
  const names = [ctx.P.basename(f.abs), ...(f.lexBase !== undefined ? [f.lexBase] : [])];
  return names.map((b) => (ctx.win ? b.toLowerCase() : b));
}

/** G.2-G.5: candidates, normalization, dedup, sort. Empty when every candidate was dropped (G.4a). */
async function collectChanged(
  ctx: Ctx,
  fs: PlannerFs,
  cwd: string,
  gitRoot: string,
  changed: readonly ChangedPath[],
  notes: string[],
): Promise<FileRef[]> {
  const files = new Map<string, FileRef>();
  for (const c of changed) {
    for (const cand of [c.path, c.previousPath]) {
      if (cand === undefined) continue;
      if (cand.includes("\0")) {
        notes.push("dropped a path containing a NUL byte");
        continue;
      }
      const lexical = ctx.P.resolve(cwd, stripWinPrefix(ctx, cand));
      const ref = canonicalize(ctx, gitRoot, gitRoot, await realOf(ctx, fs, lexical));
      if (!ref) {
        notes.push(`dropped outside the git root: ${cand}`);
        continue;
      }
      if (ref.abs.startsWith("-")) {
        notes.push(`dropped a path starting with "-": ${cand}`);
        continue;
      }
      const lexBase = ctx.P.basename(lexical);
      const full = lexBase === ctx.P.basename(ref.abs) ? ref : { ...ref, lexBase };
      if (!files.has(ctx.key(ref.abs))) files.set(ctx.key(ref.abs), full);
    }
  }
  return [...files.entries()].sort(byKey).map(([, v]) => v);
}

function byKey(a: readonly [string, unknown], b: readonly [string, unknown]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

async function classify(
  ctx: Ctx,
  input: StaticScopingInput,
  det: Detected<RunnerKind>,
  sorted: readonly FileRef[],
  notes: string[],
  search: TestSearchSeam | undefined,
): Promise<ScopingPlan | StaticScoping> {
  const P = ctx.P;
  const fs = input.fs;
  const gitRoot = det.gitRoot;
  // G.8: classification.
  const inputs = new Map<string, string>();
  const addInput = (abs: string) => inputs.set(ctx.key(abs), abs);
  const goneSources: FileRef[] = [];
  const modules: FileRef[] = [];
  const goneModules: FileRef[] = [];
  let skipped = 0;
  const inScope = (abs: string) =>
    isInside(ctx, det.runnerCwd, abs) && (det.pathScopes.length === 0 || det.pathScopes.some((s) => isInside(ctx, s, abs)));

  for (const f of sorted) {
    const base = P.basename(f.abs);
    const nonInput = NON_INPUT_EXT_RE.test(base) || NON_INPUT_NAMES.has(base) || f.rel.split("/").includes(".github");
    if (nonInput || (det.kind === "pytest" && !base.endsWith(".py"))) {
      skipped++;
      continue;
    }
    const exists = await fs.fileExists(f.abs);
    if (det.kind === "pytest") {
      const isTest = PY_TEST_RE.test(base);
      if (exists && isTest) {
        if (inScope(f.abs)) addInput(f.abs);
      } else if (exists) modules.push(f);
      else if (isTest) notes.push(`deleted test file not run: ${f.rel}`);
      else goneModules.push(f);
    } else {
      const isTest = JS_TEST_RE.test(base) || f.rel.split("/").includes("__tests__");
      if (exists) addInput(f.abs);
      else if (isTest) notes.push(`deleted test file not run: ${f.rel}`);
      else goneSources.push(f);
    }
  }
  if (skipped > 0) notes.push(`non-input files skipped: ${skipped}`);

  const pending = det.kind === "pytest" ? modules.length + goneModules.length : goneSources.length;
  const emptyNote = det.kind === "pytest" && modules.length + goneModules.length > 0 ? NOTE_NO_PY_MAP : NOTE_NO_INPUT;

  if (!search) {
    if (inputs.size === 0 && pending === 0) return noAffected(emptyNote);
    const pre = await preflight(ctx, det, fs);
    if (isS6(pre)) return pre;
    return { scopable: true, runner: det.kind, pendingSearches: pending, notes: [...notes, ...pre.notes] };
  }

  // G.9 and the pytest name mapping.
  const accept = (paths: readonly string[], scoped: boolean): Promise<string[]> =>
    Promise.all(
      paths.map(async (p) => {
        const ref = canonicalize(ctx, gitRoot, gitRoot, p);
        if (!ref || (scoped && !inScope(ref.abs)) || !(await fs.fileExists(ref.abs))) return undefined;
        return ref.abs;
      }),
    ).then((xs) => xs.filter((x): x is string => x !== undefined));
  const searchFailed = (f: FileRef) => s6("search-failed", `test search failed for ${f.rel}`);
  const pyNames = (stem: string) => [`test_${stem}.py`, `${stem}_test.py`];

  for (const f of goneSources) {
    const stem = stemOf(ctx, f.abs);
    const hits = await search.findByContent(gitRoot, stem, JS_TEST_GLOBS);
    if (hits === undefined) return searchFailed(f);
    if (hits.length === 0) return s6("deleted-no-tests", `deleted source ${f.rel}: no test file references "${stem}"`);
    if (hits.length > STEM_MATCH_LIMIT) {
      return s6("stem-too-common", `deleted source ${f.rel}: "${stem}" appears in ${hits.length} test files (limit ${STEM_MATCH_LIMIT})`);
    }
    for (const h of await accept(hits, false)) addInput(h);
  }
  for (const f of modules) {
    const hits = await search.findByName(gitRoot, pyNames(stemOf(ctx, f.abs)));
    if (hits === undefined) return searchFailed(f);
    const ok = await accept(hits, true);
    if (ok.length === 0) notes.push(`no tests named for ${f.rel}`);
    for (const h of ok) addInput(h);
  }
  for (const f of goneModules) {
    const stem = stemOf(ctx, f.abs);
    const byContent = await search.findByContent(gitRoot, stem, PY_TEST_GLOBS);
    const byName = await search.findByName(gitRoot, pyNames(stem));
    if (byContent === undefined || byName === undefined) return searchFailed(f);
    if (byContent.length > STEM_MATCH_LIMIT) {
      return s6("stem-too-common", `deleted source ${f.rel}: "${stem}" appears in ${byContent.length} test files (limit ${STEM_MATCH_LIMIT})`);
    }
    const ok = await accept([...byContent, ...byName], true);
    if (ok.length === 0) return s6("deleted-no-tests", `deleted source ${f.rel}: no test file references "${stem}"`);
    for (const h of ok) addInput(h);
  }

  if (inputs.size === 0) return noAffected(emptyNote);
  const pre = await preflight(ctx, det, fs);
  if (isS6(pre)) return pre;
  const F = [...inputs.entries()].sort(byKey).map(([, v]) => v);
  const allNotes = [...notes, ...pre.notes];
  return buildSpec(ctx, det, pre.entry, F, input.budget, input.cores, allNotes, "related", det.runnerCwd, gitRoot, !fs.realpath);
}

/** H, N.4 (QA-1.3-11): the tmpdir must be absolute and must not be inside gitRoot, lexically or after realpath. */
async function tmpdirCheck(ctx: Ctx, fs: PlannerFs, gitRoot: string): Promise<Unverifiable | undefined> {
  const t = ctx.host.tmpdir;
  if (!ctx.P.isAbsolute(t)) return s6("tmpdir-in-repo", `temp dir is not an absolute path: ${t}`);
  const lexical = ctx.P.resolve(t);
  if (isInside(ctx, gitRoot, lexical) || isInside(ctx, gitRoot, await realOf(ctx, fs, lexical))) {
    return s6("tmpdir-in-repo", `temp dir is inside the repository: ${t}`);
  }
  return undefined;
}

/** Checks that need no search: entry resolution and the tmpdir location (F, H, N.4). */
async function preflight(ctx: Ctx, det: DetectedRunner, fs: PlannerFs): Promise<{ entry: ResolvedEntry; notes: string[] } | Unverifiable> {
  const bad = await tmpdirCheck(ctx, fs, det.gitRoot);
  if (bad) return bad;
  return resolveEntryImpl(ctx, det, det.runnerCwd, fs);
}

/** N.9 (QA-1.3-14): the command line CreateProcess receives, quoted as libuv quotes it on win32. */
function commandLineLength(ctx: Ctx, file: string, args: readonly string[]): number {
  return [file, ...args].reduce((n, a) => n + (ctx.win ? winQuotedLength(a) : a.length) + 1, 0);
}

/** The length of one argument after libuv's quote_cmd_arg (CommandLineToArgvW rules). */
function winQuotedLength(a: string): number {
  if (a === "") return 2;
  if (!/[ \t"]/.test(a)) return a.length;
  let n = 2;
  let slashes = 0;
  for (const ch of a) {
    if (ch === "\\") {
      slashes++;
      continue;
    }
    n += ch === '"' ? 2 * slashes + 2 : slashes + ch.length;
    slashes = 0;
  }
  return n + 2 * slashes;
}

function buildSpec(
  ctx: Ctx,
  det: DetectedRunner,
  entry: ResolvedEntry,
  F: readonly string[],
  budget: RunnerBudget,
  inputCores: number | undefined,
  notes: string[],
  mode: "related" | "rerun",
  cwd: string,
  gitRoot: string,
  lexical: boolean,
): ScopedSpec | Unverifiable {
  const C = inputCores ?? ctx.host.cores;
  const N = effectiveWorkers(det.userWorkers, budget, C);
  const E = entry.prefix;
  const K = det.keptArgs;
  const R = ctx.P.join(ctx.P.resolve(ctx.host.tmpdir), `omr-verify-${ctx.host.randomId()}.${det.kind === "pytest" ? "xml" : "json"}`);
  const env: Record<string, string> = { ...det.env };
  let args: string[];
  let workers: number | null = N;
  const tail = [`--maxWorkers=${N}`];
  if (det.kind === "vitest") {
    const head = mode === "related" ? ["related", ...F, ...K, "--run"] : ["run", ...F, ...K];
    args = [...E, ...head, "--passWithNoTests", ...tail, "--coverage.enabled=false", "--reporter=json", `--outputFile=${R}`];
  } else if (det.kind === "jest") {
    args = [...E, ...K, mode === "related" ? "--findRelatedTests" : "--runTestsByPath", "--passWithNoTests", `--maxWorkers=${N}`, "--coverage=false", "--json", `--outputFile=${R}`, "--", ...F];
  } else {
    args = [
      ...E, ...K, "-q", "-p", "no:cacheprovider", `--junitxml=${R}`,
      ...(det.xdist ? ["-n", String(N)] : []),
      ...(det.covInConfig ? ["--no-cov"] : []),
      "--", ...F,
    ];
    env.PYTEST_XDIST_AUTO_NUM_WORKERS = String(N >= 1 ? N : effectiveWorkers({ auto: true }, budget, C));
    workers = det.xdist ? N : null;
  }
  if (commandLineLength(ctx, entry.file, args) > MAX_ARGV_CHARS) {
    return s6("argv-too-long", `too many inputs for one command line: ${F.length} files`);
  }
  return {
    runner: det.kind,
    mode,
    file: entry.file,
    args,
    cwd,
    env,
    reportPath: R,
    gitRoot,
    entry: entry.entry,
    inputs: F,
    inputsAreTests: mode === "rerun" || det.kind === "pytest",
    workers,
    notes,
    ...(lexical ? { lexicalPaths: true as const } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Functions (Task 1.3.2 implements them; the signatures are the contract)
// ---------------------------------------------------------------------------------------------

/** 1.3.2.a: classify the check command, or the package script behind it (B, C, D). Reads fs only. */
export async function detectRunner(
  command: string,
  cwd: string,
  fs: PlannerFs,
  host?: Partial<RunnerHost>,
): Promise<DetectedRunner | Unverifiable> {
  return detectImpl(makeCtx(host), command, cwd, fs, TEST_HEADS);
}

/** 1.3.2.b: locate the JS bin entry or the native executable (F), walking from cwd up to runner.gitRoot. */
export async function resolveEntry(
  runner: EntryRequest,
  cwd: string,
  fs: FsSeam,
  host?: Partial<RunnerHost>,
): Promise<ResolvedEntry | Unverifiable> {
  const r = await resolveEntryImpl(makeCtx(host), runner, cwd, fs);
  return isS6(r) ? r : r.entry;
}

/** 1.3.2.c: the full planner (B through H), including the section 1.5-5 and pytest searches. */
export async function planScopedRun(input: PlanScopedRunInput): Promise<ScopingPlan> {
  return plan(input, input.search);
}

/** 1.3.2.c: the process-free subset of planScopedRun, for the section 1.5-17 risk signal (O.4). */
export async function planStaticScoping(input: StaticScopingInput): Promise<StaticScoping> {
  return plan(input, undefined);
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
  const ctx = makeCtx(deps.host);
  const P = ctx.P;
  const absCwd = await canonicalCwd(ctx, deps.fs, cwd);
  const gitRoot = await findGitRoot(ctx, absCwd, deps.fs);
  if (gitRoot === undefined) return s6("no-git-root", `no git repository at or above ${cwd}`);
  const notes: string[] = [];
  const inputs = new Map<string, string>();
  for (const f of testFiles) {
    const lexical = stripWinPrefix(ctx, f);
    const usable = P.isAbsolute(lexical) && !f.includes("\0");
    const ref = usable ? canonicalize(ctx, gitRoot, gitRoot, await realOf(ctx, deps.fs, P.resolve(lexical))) : undefined;
    if (!ref) {
      notes.push(`rerun file dropped (relative or outside the git root): ${f}`);
    } else if (!(await deps.fs.fileExists(ref.abs))) {
      notes.push(`rerun file missing in this tree: ${ref.rel}`);
    } else {
      inputs.set(ctx.key(ref.abs), ref.abs);
    }
  }
  if (inputs.size === 0) return noAffected(NOTE_NO_RERUN);
  const badTmp = await tmpdirCheck(ctx, deps.fs, gitRoot);
  if (badTmp) return badTmp;
  let entry = deps.entry;
  if (!entry) {
    const r = await resolveEntryImpl(ctx, { kind: runner.kind, launcher: runner.launcher, gitRoot }, absCwd, deps.fs);
    if (isS6(r)) return r;
    entry = r.entry;
    notes.push(...r.notes);
  }
  const F = [...inputs.entries()].sort(byKey).map(([, v]) => v);
  return buildSpec(ctx, runner, entry, F, budget, deps.cores, notes, "rerun", absCwd, gitRoot, !deps.fs.realpath);
}

/** 1.3.2.f: parse the report (or fall back to observeTests) and always delete the report file (I, N.4). */
export async function readResult(
  spec: ScopedSpec,
  execResult: ExecResult,
  fs: RunnerFs,
  host?: Partial<RunnerHost>,
): Promise<RunResult> {
  const ctx = makeCtx(host);
  const P = ctx.P;
  const allowed =
    P.isAbsolute(ctx.host.tmpdir) &&
    P.isAbsolute(spec.reportPath) &&
    ctx.key(P.dirname(P.resolve(spec.reportPath))) === ctx.key(P.resolve(ctx.host.tmpdir)) &&
    REPORT_NAME_RE.test(P.basename(spec.reportPath));
  try {
    if (!allowed) return textResult(ctx, spec, execResult, `report path rejected: ${spec.reportPath}`);
    let text: string | undefined;
    try {
      text = await fs.readFile(spec.reportPath);
    } catch {
      text = undefined; // Missing or unreadable: step 4.
    }
    if (text === undefined) return textResult(ctx, spec, execResult, undefined);
    let parsed: RunResult | undefined;
    try {
      parsed = spec.runner === "pytest" ? parseJunit(ctx, spec, text, execResult.code) : parseJestJson(ctx, spec, text, execResult.code);
    } catch (err) {
      // I step 1 (QA-1.3-12): a parser failure is an unusable report, never a rejection.
      return textResult(ctx, spec, execResult, `report could not be parsed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return parsed ? zeroTestsGuard(spec, parsed) : textResult(ctx, spec, execResult, undefined);
  } finally {
    if (allowed) {
      try {
        await fs.unlink(spec.reportPath);
      } catch {
        // I: unlink errors are ignored; the seam already resolves for a missing file.
      }
    }
  }
}

/** 1.3.2.g: scope a plain eslint invocation to the changed lintable files (K, section 1.5-10). */
export async function planScopedLint(input: PlanScopedLintInput): Promise<LintSpec | NoAffected | Unscoped> {
  const ctx = makeCtx(input.host);
  const P = ctx.P;
  const fs = input.fs;
  if (input.changedFiles === "unavailable") return unscoped("change attribution unavailable");
  if (input.changedFiles.length === 0) return noAffected(NOTE_NO_LINT);
  const det = await detectImpl(ctx, input.command, input.cwd, fs, LINT_HEADS);
  if (isS6(det)) return unscoped(det.reason);
  const notes = [...det.notes];
  const sorted = await collectChanged(ctx, fs, await canonicalCwd(ctx, fs, input.cwd), det.gitRoot, input.changedFiles, notes);
  if (sorted.length === 0) return unscoped(NO_PATH_KEPT);
  for (const f of sorted) {
    if (namesOf(ctx, f).some((b) => ESLINT_TRIGGER_RE.test(b))) return unscoped(`eslint config changed: ${f.rel}`);
  }
  const exts = lintExtensions(det.keptArgs);
  const F: string[] = [];
  for (const f of sorted) {
    const inScope = isInside(ctx, det.runnerCwd, f.abs) && (det.pathScopes.length === 0 || det.pathScopes.some((s) => isInside(ctx, s, f.abs)));
    if (inScope && exts.has(P.extname(f.abs).toLowerCase()) && (await fs.fileExists(f.abs))) F.push(f.abs);
  }
  if (F.length === 0) return noAffected(NOTE_NO_LINT);
  const r = await resolveEntryImpl(ctx, det, det.runnerCwd, fs);
  if (isS6(r)) return unscoped(r.reason);
  const v9 = Number.parseInt(r.entry.version ?? "", 10) >= 9;
  if (!v9 && det.keptArgs.some((a) => a === "--max-warnings" || a.startsWith("--max-warnings="))) {
    return unscoped("eslint <9 cannot scope ignored files under --max-warnings");
  }
  const workers = det.userWorkers ? effectiveWorkers(det.userWorkers, input.budget, input.cores ?? ctx.host.cores) : null;
  const args = [
    ...r.entry.prefix,
    ...det.keptArgs,
    ...(workers !== null ? [`--concurrency=${workers}`] : []),
    ...(v9 ? ["--no-warn-ignored"] : []),
    ...F,
  ];
  if (commandLineLength(ctx, r.entry.file, args) > MAX_ARGV_CHARS) return unscoped(`too many inputs for one command line: ${F.length} files`);
  return {
    runner: "eslint",
    file: r.entry.file,
    args,
    cwd: det.runnerCwd,
    env: det.env,
    gitRoot: det.gitRoot,
    entry: r.entry.entry,
    inputs: F,
    workers,
    notes: [...notes, ...r.notes],
  };
}

// ---------------------------------------------------------------------------------------------
// I. Result parsing and K. lint helpers
// ---------------------------------------------------------------------------------------------

function unscoped(reason: string): Unscoped {
  return { unscoped: true, reason };
}

const ESLINT_TRIGGER_RE = /^(?:eslint\.config\..+|\.eslintrc|\.eslintrc\..+|\.eslintignore|package\.json|tsconfig.*\.json)$/;
const DEFAULT_LINT_EXTS = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"];

/** K: the --ext values (comma-separated, leading dots optional), or the defaults. */
function lintExtensions(kept: readonly string[]): Set<string> {
  const out: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    const t = kept[i];
    const v = t === "--ext" ? kept[++i] : t.startsWith("--ext=") ? t.slice(6) : undefined;
    for (const x of (v ?? "").split(",")) if (x) out.push(`.${x.replace(/^\./, "")}`.toLowerCase());
  }
  return new Set(out.length > 0 ? out : DEFAULT_LINT_EXTS);
}

/** Dedup, sort and apply the I "exit code but no failure" rule. */
function finishResult(
  ids: Set<string>,
  files: Set<string>,
  collectionError: boolean,
  total: number | undefined,
  code: number,
  forced: string | undefined,
  exitOk: boolean,
): RunResult {
  const silent = !exitOk && ids.size === 0 && !collectionError;
  const note = forced ?? (silent ? `runner exited ${code} but its report lists no failure` : undefined);
  return {
    failingIds: [...ids].sort(),
    failingFiles: [...files].sort(),
    collectionError,
    total,
    complete: forced === undefined && !silent,
    source: "report",
    ...(note !== undefined ? { note } : {}),
  };
}

/** I step 2: the jest-compatible JSON of vitest and jest. undefined = unusable. */
function parseJestJson(ctx: Ctx, spec: ScopedSpec, text: string, code: number): RunResult | undefined {
  const P = ctx.P;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(v) || !Array.isArray(v.testResults)) return undefined;
  const ids = new Set<string>();
  const files = new Set<string>();
  let collectionError = typeof v.numRuntimeErrorTestSuites === "number" && v.numRuntimeErrorTestSuites > 0;
  for (const s of v.testResults.filter(isRecord)) {
    if (typeof s.name !== "string") continue;
    const rel = P.relative(spec.cwd, s.name).replace(/\\/g, "/");
    const results = Array.isArray(s.assertionResults) ? s.assertionResults.filter(isRecord) : [];
    const failed = results.filter((a) => a.status === "failed");
    for (const a of failed) {
      const titles = Array.isArray(a.ancestorTitles) ? a.ancestorTitles.map(String) : [];
      ids.add(`${rel} > ${[...titles, String(a.title)].join(" > ")}`);
    }
    if (s.status === "failed" && failed.length === 0) {
      ids.add(rel);
      collectionError = true;
    }
    if (s.status === "failed" || failed.length > 0) files.add(P.normalize(s.name));
  }
  const total = typeof v.numTotalTests === "number" ? v.numTotalTests : undefined;
  return finishResult(ids, files, collectionError, total, code, undefined, code === 0);
}

/** A test path by the G.8 JS rule: a .test/.spec file or a file under __tests__. */
function isJsTestPath(p: string): boolean {
  return JS_TEST_RE.test(p.split(/[\\/]/).pop() ?? "") || p.split(/[\\/]/).includes("__tests__");
}

/**
 * I step 2a (QA-1.3-1): a report that lists no test at all is not trusted when the inputs say
 * tests must have run: every rerun (inputs are test files), a jest related run given a test file,
 * and any jest run planned without realpath (jest silently matches nothing when cwd is not the
 * realpath).
 */
function zeroTestsGuard(spec: ScopedSpec, r: RunResult): RunResult {
  if (r.total !== 0 || !r.complete || r.failingIds.length > 0 || r.collectionError) return r;
  const note =
    spec.mode === "rerun"
      ? "rerun ran no tests although every input is a test file"
      : spec.runner === "jest" && spec.inputs.some(isJsTestPath)
        ? "jest ran no tests although a test file was passed"
        : spec.runner === "jest" && spec.lexicalPaths === true
          ? "jest ran no tests and the paths were not canonicalized (no realpath seam)"
          : undefined;
  return note === undefined ? r : { ...r, complete: false, note };
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** A code point String.fromCodePoint accepts and XML allows to be a character reference. */
function isXmlCodePoint(n: number): boolean {
  return Number.isSafeInteger(n) && ((n >= 0 && n <= 0xd7ff) || (n >= 0xe000 && n <= 0x10ffff));
}

/** I step 3 (QA-1.3-12): out-of-range numeric references stay literal text instead of throwing. */
function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, g: string) => {
    if (!g.startsWith("#")) return XML_ENTITIES[g];
    const n = g.startsWith("#x") ? Number.parseInt(g.slice(2), 16) : Number(g.slice(1));
    return isXmlCodePoint(n) ? String.fromCodePoint(n) : m;
  });
}

/** I step 3: pytest junit XML at regex level. undefined = unusable (truncated). */
function parseJunit(ctx: Ctx, spec: ScopedSpec, text: string, code: number): RunResult | undefined {
  const P = ctx.P;
  if (!text.includes("</testsuites>")) return undefined;
  const modules = spec.inputs.map((f) => {
    const segs = P.relative(spec.gitRoot, f).replace(/\\/g, "/").replace(/\.py$/, "").split("/");
    return { f, candidates: segs.map((_s, i) => segs.slice(i).join(".")) };
  });
  const map = (dotted: string): { file: string; rest: string[] } | undefined => {
    let best: { file: string; d: string } | undefined;
    for (const m of modules) {
      for (const d of m.candidates) {
        if ((dotted === d || dotted.startsWith(`${d}.`)) && (!best || d.length > best.d.length)) best = { file: m.f, d };
      }
    }
    return best && { file: best.file, rest: dotted.slice(best.d.length + 1).split(".").filter(Boolean) };
  };
  const relOf = (f: string) => P.relative(spec.cwd, f).replace(/\\/g, "/");
  const ids = new Set<string>();
  const files = new Set<string>();
  let collectionError = false;
  let total = 0;
  let unmapped: string | undefined;
  const caseRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of text.matchAll(caseRe)) {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = decodeXml(a[2]);
    const classname = attrs.classname ?? "";
    const name = attrs.name ?? "";
    const body = m[2] ?? "";
    const collection = classname === "" || /<error\b[^>]*\bmessage="collection failure"/.test(body);
    if (collection) {
      collectionError = true;
      const target = classname || name;
      const hit = map(target);
      if (hit) {
        ids.add(relOf(hit.file));
        files.add(hit.file);
      } else {
        ids.add(target);
        unmapped ??= target;
      }
      continue;
    }
    total++;
    if (!/<(?:failure|error)\b/.test(body)) continue;
    const hit = map(classname);
    if (hit) {
      ids.add(`${relOf(hit.file)}::${[...hit.rest, name].join("::")}`);
      files.add(hit.file);
    } else {
      ids.add(`${classname}::${name}`);
      unmapped ??= classname;
    }
  }
  const forced =
    code === 4
      ? "pytest usage error (exit 4)"
      : code === 3
        ? "pytest internal error (exit 3)"
        : unmapped !== undefined
          ? `pytest classname not mapped to a test file: ${unmapped}`
          : undefined;
  return finishResult(ids, files, collectionError, total, code, forced, code === 0 || code === 5);
}

/** I step 4: no usable report; the text observation is never a complete inventory. */
function textResult(ctx: Ctx, spec: ScopedSpec, execResult: ExecResult, why: string | undefined): RunResult {
  const obs = observeTests(execResult);
  const files = new Set<string>();
  for (const id of obs.failures) {
    const m = /^(.*?)(?: > |::)/.exec(id);
    if (m) files.add(ctx.P.resolve(spec.cwd, m[1]));
  }
  const note =
    why ?? (execResult.code === 0 ? "runner exited 0 without writing its report" : `runner exited ${execResult.code} without a usable report`);
  return {
    failingIds: [...new Set(obs.failures)].sort(),
    failingFiles: [...files].sort(),
    collectionError: execResult.code !== 0,
    total: undefined,
    complete: false,
    source: "text",
    note,
  };
}

/** Section E: the single worker-cap rule shared by every runner. It never exceeds the budget. */
export function effectiveWorkers(user: UserWorkerCap | undefined, budget: RunnerBudget, cores: number): number {
  const B = Number.isSafeInteger(budget.maxWorkers) && budget.maxWorkers >= 1 ? budget.maxWorkers : 1;
  const C = Number.isSafeInteger(cores) && cores >= 1 ? cores : 1;
  if (!user) return B;
  if ("count" in user) return Number.isSafeInteger(user.count) && user.count >= 0 ? Math.min(user.count, B) : B;
  if ("percent" in user) {
    if (!(user.percent >= 1 && user.percent <= 100)) return B;
    return Math.min(Math.max(1, Math.ceil((user.percent * C) / 100)), B);
  }
  return Math.min(C, B);
}
