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
//     name and "--" are npm's own flags. Only the harmless ones (-s --silent -q --quiet -d
//     --if-present --ignore-scripts --color[=v] --no-color --loglevel=v) are ignored, with a
//     note; any other token there (-w, --workspace[s], -ws, --prefix, --include-workspace-root, a
//     positional, ...) -> S6 unsupported-command "npm <token>", because it can select another
//     package's script (QA-1.3-6). pnpm, yarn and bun: tokens after the script name are appended,
//     minus a leading "--". Without that "--", a location option (-w -ws -C -F -r -g --workspace
//     --workspaces --include-workspace-root --workspace-root --prefix --dir --cwd --filter
//     --recursive --global, also "=v" forms) -> S6 unsupported-command "<pm> <token>". Options
//     before the subcommand are already S6 ("npm -w", "pnpm --filter").
//   - npm configuration that selects a workspace (QA-1.3-24): a `workspace` or `workspaces` key
//     (also `workspace[]`) in any .npmrc from cwd up to gitRoot -> S6 unsupported-command
//     "npm workspace" in <.npmrc path>; an unreadable one -> "npm" in "<path> (unreadable)"; a
//     non-empty npm_config_workspace(s) variable, any case, in the host env or cross-env -> S6
//     "npm <NAME>" in "the environment" / "cross-env". npm 12.0.2 ran the workspace's script for
//     each. `prefix` and `include-workspace-root` are not checked: set there they did not move
//     `npm test` off the root script (prefix only moves the global prefix). QA-1.3-32: keys are
//     read the way npm's ini parser reads them (a BOM, quotes around the key and JSON escapes
//     inside them, a key without "=", `;`/`#` cutting an unquoted key), and the same check runs
//     for the npx launcher (npm exec honours the workspace config and runs in the workspace's
//     directory), from runnerCwd, in commands and scripts alike. An .npmrc over
//     CONFIG_SIZE_LIMIT -> S6 config-too-large.
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
//   D.0 Spelling normalization (QA-1.3-3b, QA-1.3-10), applied before every table lookup:
//     - vitest and jest: "--kebab-case" is compared as "--camelCase" (yargs and cac accept both);
//       "--no-" stays a negation prefix. The table names are normalized the same way. A kept
//       token keeps the user's spelling.
//     - Grouped short options are split the way the runner's parser splits them:
//         vitest (mri)      flags w u h v, values c r t. Every letter but the last must be a
//                           flag; the last takes "=v" or the next token. "-cfoo", "-w4" -> S6.
//         jest (yargs)      flags b e f h i o u v, values c t w. Flags chain until a value
//                           letter, whose attached value must be "=v" or a number ("-w4",
//                           "-iw4"); "-cjest.config.js" (yargs: c, j, e, s, t=".config.js")
//                           -> S6.
//         pytest (argparse) flags q v x s l h V f, values k m c o W r p n. Flags chain until a
//                           value letter, which takes the rest or the next token: "-qn3" is
//                           "-q -n3", "-vrA" is "-v -rA".
//       A group containing any other letter -> S6 unsupported-argument. eslint is not split.
//   D.1 Algorithm, one token t at a time, left to right:
//     a. t === "--"              -> S6 unsupported-argument "--".
//     b. DROP entry              -> remove t and its value tokens.
//     c. CAP entry               -> remove t and its value, and record the value (E). Special
//                                   entries are noted as "kept" below.
//     d. KEEP-value entry        -> keep t and its value tokens, in order.
//     e. KEEP-flag entry         -> keep t.
//     f. S6 entry                -> S6 unsupported-argument t (lint: Unscoped).
//     g. any other option (a token starting with "-"):
//          vitest and jest: S6 unsupported-argument (QA-1.3-10: an unknown spelling of a DROP
//          option, such as "--update-snapshot", must never pass through). pytest and eslint:
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
//             --clearScreen --inspect --inspect-brk --coverage --no-coverage   (coverage adds the
//             note "coverage disabled for the scoped run")
//     DROP ?  --changed --api --mergeReports --coverage.*
//     DROP 1  --bail   (note "early-exit option dropped for a full failure inventory": a new
//             failure could hide behind an old one, QA-1.3-2)
//     DROP 1  --reporter --outputFile --outputFile.* --shard --minWorkers --min-workers --api.*
//     CAP  1  --maxWorkers --max-workers
//     CAP  0  --no-file-parallelism, "--fileParallelism=false": the token is KEPT and the user
//             cap is {count: 1}
//     KEEP 1  --config -c --root -r --dir --project --environment --pool --testNamePattern -t
//             --mode --testTimeout --hookTimeout --teardownTimeout --retry --exclude
//             --maxConcurrency --slowTestThreshold
//     KEEP ?  --browser --sequence.* --typecheck.* --browser.*
//     KEEP 0  --globals --dom --isolate --no-isolate --allowOnly --silent --hideSkippedTests
//             --logHeapUsage --color --no-color --expandSnapshotDiff --disableConsoleIntercept
//             --typecheck --printConsoleTrace --includeTaskLocation
//     Example: `vitest run --coverage` -> run dropped, --coverage dropped, note added.
//
//   D.3 jest
//     DROP 0  --watch --watchAll --json --findRelatedTests --listTests --onlyChanged -o --lastCommit
//             --changedFilesWithAncestor --updateSnapshot -u --passWithNoTests --runTestsByPath
//             --onlyFailures -f --coverage --collectCoverage --no-coverage   (coverage adds the
//             note from D.2)
//     DROP ?  --bail -b   (the early-exit note from D.2)
//     DROP 1  --outputFile --changedSince --shard --collectCoverageFrom --coverageDirectory
//             --coverageProvider --coverageThreshold
//     DROP *  --reporters --coverageReporters --coveragePathIgnorePatterns
//     CAP  1  --maxWorkers --max-workers -w
//     CAP  0  --runInBand -i   (the token is removed; the user cap is {count: 1})
//     KEEP 1  --config -c --rootDir --testNamePattern -t --testEnvironment --env --testTimeout
//             --testRunner --testSequencer --cacheDirectory --workerIdleMemoryLimit --seed
//             --maxConcurrency --openHandlesTimeout
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
//     DROP 0  -x --exitfirst; DROP 1 --maxfail   (the early-exit note from D.2). The argv also
//             ends the options with "--maxfail=0", which overrides an -x or --maxfail from
//             addopts or PYTEST_ADDOPTS (argparse: the last value of dest "maxfail" wins).
//     DROP ?  --cov
//     DROP 1  --junitxml --junit-xml --pdbcls --cov-report --cov-config --cov-fail-under
//             --cov-context --html --json-report-file
//     -p      "-p no:cacheprovider" (and "-pno:cacheprovider") is dropped, because the adapter
//             adds it once. "-p no:xdist" is kept and forces xdist = false. Any other -p value
//             is KEEP 1.
//     CAP  1  -n --numprocesses --maxprocesses   (values: N, auto, logical; attached "-n4")
//     KEEP 1  -k -m -c --config-file --rootdir -o --override-ini -W --pythonwarnings --tb -r
//             --import-mode --basetemp --durations --durations-min --timeout --ignore
//             --ignore-glob --deselect --confcutdir --dist --capture --log-level --log-cli-level
//     KEEP 0  -v -vv --verbose -s -l --showlocals --strict-markers --strict-config
//             --disable-warnings --no-header --runxfail
//     S6      --co --collect-only --fixtures --fixtures-per-test --markers --setup-plan
//             --setup-only --version -V -h --help --tx --rsyncdir   (--tx starts xdist workers
//             that no -n caps)
//     xdist evidence (QA-1.3-3). pytest reads options from three places, in this order, and the
//     last cap wins: the config file's addopts, PYTEST_ADDOPTS, the command. The adapter reads
//     all three the way pytest does:
//       - Config file (pytest 9 findpaths): the -c/--config-file file alone, when given (read
//         by its extension, always accepted). Otherwise walk from the start directory up to the
//         FILESYSTEM ROOT (not gitRoot: pytest does not stop there) and, in each directory,
//         take the first of pytest.toml, .pytest.toml, pytest.ini, .pytest.ini, pyproject.toml,
//         tox.ini, setup.cfg that pytest accepts: pytest.toml/.pytest.toml ([pytest] table) and
//         pytest.ini/.pytest.ini ([pytest] section) always, even empty; pyproject.toml only
//         with a [tool.pytest.ini_options] or [tool.pytest] table; tox.ini only with [pytest];
//         setup.cfg only with [tool:pytest]. --rootdir does not change this search.
//         Older release lines (QA-1.3-21) are looked up too, because the adapter cannot tell
//         which pytest will run: pytest 8 (pytest.ini, .pytest.ini, pyproject.toml with
//         [tool.pytest.ini_options] only, tox.ini, setup.cfg) and pytest 7.0 (the same without
//         .pytest.ini). Each line picks its own first accepted file; the evidence is the union
//         (xdist and cov from any file, the LOWEST cap among the files, "-p no:xdist" only when
//         every line's file says so). A false xdist hit only costs exit 4 (unverifiable).
//         `-o addopts=<v>` / `--override-ini addopts=<v>` replaces the file's addopts.
//         The keys read are addopts and python_files (G.8, QA-1.3-33).
//         ini files follow iniconfig (column-0 [section], indented continuation lines, # and ;
//         comment lines). A key line splits on its first "=" unless the name before it contains
//         ":", otherwise on its first ":"; whitespace is optional (QA-1.3-31: "addopts:-n 3").
//         TOML is scanned line by line with every value skipped whole (strings, multi-line
//         strings, nested arrays and inline tables), so a header inside a string is not one.
//         Header and key parts are compared DECODED (QA-1.3-31: `"add\u006fpts"`,
//         `[tool."py\u0074est".ini_options]` are the plain names); a quoted part whose escapes
//         do not decode -> S6 `unsupported pytest argument "<raw key>" in <file>`. A key is read
//         only as a single key directly below a [table] header from the line's tables, as a
//         basic, literal or multi-line string, or an array of strings; a string is split with
//         C.1. Anything else (a bare value, a bad escape, an unterminated quote, a second
//         occurrence in any pytest table) -> S6 unsupported-argument `unsupported pytest
//         argument "<key>" in <file>`. So is any other TOML spelling that reaches the same key
//         (QA-1.3-20: a dotted key at the root or under [tool], an inline table such as
//         `ini_options = { addopts = ... }`, an array table), which pytest 9.1.1 honours: the
//         adapter would append no -n. (An appended "-n N" does win over each of those shapes,
//         verified with xdist 3.8.0, but it can only be appended when xdist is known to be
//         present; otherwise pytest exits 4.) A key the command line overrides with -o is not
//         S6 for its spelling in the file. An unreadable file is noted and skipped. A file over
//         CONFIG_SIZE_LIMIT (1 MiB) -> S6 config-too-large, even one pytest would skip after
//         reading it (QA-1.3-34). Each file is read once per planner call and parsed once per
//         reading (ctx.cache); with PlannerFs.stat the size is checked before the read.
//       - PYTEST_ADDOPTS: host.pytestAddopts and the cross-env value (C.3). Both are scanned for
//         evidence; the cap comes from the value the spawn will see (cross-env wins).
//       - The command (D.1).
//     Each addopts source goes through D.1 with the pytest table in "addopts" mode: a positional
//     -> S6 unsupported-argument `... "<p>" in addopts of <file>` / `in PYTEST_ADDOPTS` /
//     `in -o addopts`, because pytest would collect it on top of the inputs (QA-1.3-13). An
//     unknown option followed by a non-option token takes it as its value, unless that token
//     names an existing path (S6). Either reading is safe: a missing path makes pytest exit 4.
//     xdist = (a CAP entry or --dist in any source) and no "-p no:xdist" in any source.
//     covInConfig = a --cov option in the config or PYTEST_ADDOPTS. userWorkers = the last cap
//     over config, PYTEST_ADDOPTS and the command, so a config "-n 1" is never raised.
//     Start directory: runnerCwd at detection (pytest with no file arguments). The spec redoes
//     the lookup from the common ancestor of its inputs (pytest's rootdir/inifile rule for file
//     arguments), from DetectedRunner.pytestFacts, so tests/unit/pytest.ini counts for inputs
//     under tests/unit. A false xdist match can only add "-n N" without xdist: pytest exit 4,
//     readResult complete=false, unverifiable, never a false pass. Residual (P): a conftest.py
//     or plugin that adds -n through a hook.
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
//     - Result: {file: node (F.1), prefix: [entry], entry, version}.
//     - npx and pnpm exec resolve exactly like direct invocations. They are never executed, so
//       npx can never download a runner.
//   F.1 node (QA-1.3-18). The plugin runtime is Bun, and a compiled opencode reports itself as
//     process.execPath; jest 30 fails every suite under bun.exe ("Attempted to assign to readonly
//     property"). So the JS tools never inherit the runtime blindly:
//       1. host.nodePath when given (absolute, and on win32 with a drive or UNC host; otherwise
//          S6 node-not-found "node path is not absolute: <p>"; with PlannerFs.stat, not an
//          existing file -> "node path is not a file: <p>").
//       2. host.execPath when its basename is node or node.exe. The DEFAULT execPath
//          (process.execPath) also needs process.versions.bun to be undefined. With
//          PlannerFs.stat it must be an existing file, else step 3.
//       3. The first node on a usable host.pathEnv entry: posix "<dir>/node"; win32
//          "<dir>\node<ext>" for each PATHEXT ext in order (the shell's rule). A usable entry is
//          absolute and, on win32, starts with a drive ("C:\") or a UNC host: a root-relative
//          "\Users\..." resolves against whichever drive is current (QA-1.3-36). A hit that stat
//          reports as a directory is skipped (QA-1.3-36). A win32 hit that is not .exe (node.cmd,
//          node.bat) needs a shell -> S6 node-not-found "node on PATH is not an executable file:
//          <f>". Bun's temporary node is skipped three ways (QA-1.3-18, QA-1.3-30): its
//          directory is named bun-node-<hex> (%TEMP%\bun-node-0d9b296af); its realpath is bun or
//          bun.exe (posix symlink); or stat gives it the dev and ino of host.execPath, the
//          non-node runtime (the win32 hard link, nlink=4). fileExists, realpath and stat only.
//       4. Nothing -> S6 node-not-found "node not found: no absolute PATH entry has a node
//          executable".
//     Only JS tools resolve node, after their package entry (a missing package is reported
//     first). pytest and uv are native executables.
//   pytest (launcher "direct"): the first PATH hit, then a venv.
//     - PATH: for each usable entry of host.pathEnv split by P.delimiter (F.1 step 3: relative
//       entries such as "." and win32 root-relative ones are skipped), check win32
//       "<dir>\pytest.exe" or posix "<dir>/pytest"; a hit stat reports as a directory is skipped.
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
//      order -> S6 config-changed. Matching is by basename (real or lexical, 3a), anywhere
//      under gitRoot:
//        vitest  package.json, vitest.config.*, vite.config.*, vitest.workspace.*,
//                vitest.projects.*, tsconfig*.json.
//                Evidence (R): `vitest related package.json` ran every test file.
//        jest    package.json, jest.config.*, babel.config.*, .babelrc, .babelrc.*, tsconfig*.json
//        vitest and jest, also (QA-1.3-8): package-lock.json, npm-shrinkwrap.json,
//                pnpm-lock.yaml, yarn.lock, bun.lock, bun.lockb, pnpm-workspace.yaml, .npmrc,
//                .yarnrc, .yarnrc.yml, .pnpmfile.cjs (a lockfile-only change can upgrade a
//                dependency within its range); and setup files that are not test files
//                (QA-1.3-15: vitest adds setupFiles to forceRerunTriggers and reran every test
//                file; QA-1.3-29: jest's related graph never reaches a setup file, so
//                `--findRelatedTests <setup>` ran 0 tests with exit 0). By name, a SUPERSET of
//                the rule 1.6 risk.ts uses, case-insensitive, JS/TS extensions: *.setup.<ext>;
//                the risk.ts basenames (setupTests, setup-tests, test-setup, global-setup,
//                globalSetup, vitest.setup, jest.setup, setup-jest, jest-setup, vitest-setup,
//                global-teardown); (jest|vitest|test|tests)[._-]?(setup|teardown)<anything>
//                (jest.setupAfterEnv.js, testSetup.ts); setup[._-]?(tests|jest|vitest|env|
//                after-env|files|files-after-env) (setupVitest.ts, setupFilesAfterEnv.ts);
//                global[._-]?(setup|teardown)<anything>; and a bare setup.<ext> or teardown.<ext>
//                below a test, tests, spec, specs, testing, jest, vitest or __tests__ directory
//                (test/setup.js). src/setup.ts and SetupWizard.tsx stay application code. And
//                (G.7a) any file a vitest/jest config names statically.
//   7a. (QA-1.3-29) vitest.config.*/vite.config.* (vitest) or jest.config.*/package.json (jest)
//      in every directory from runnerCwd up to gitRoot, plus the --config file, are read once
//      (CONFIG_SIZE_LIMIT; over it -> S6 config-too-large). The string literals of setupFiles,
//      setupFilesAfterEnv, globalSetup and globalTeardown (one literal, or the literal elements
//      of an array, calls such as require.resolve('./x') included) resolve against the config's
//      directory and runnerCwd (vitest) or rootDir (jest: `<rootDir>` is the config's directory
//      or a literal rootDir); a reference without an extension also matches <ref>.<ext> and
//      <ref>/index.<ext>. Each such file is a trigger. A non-literal value names nothing; the
//      name rule above still applies (P).
//        pytest  conftest.py, pyproject.toml, pytest.ini, setup.cfg, tox.ini (section 1.5-3),
//                plus .pytest.ini, pytest.toml, .pytest.toml (QA-1.3-4: pytest 9 reads them;
//                plan amendment to section 1.5-3, fixtures in 3.2) and uv.lock, poetry.lock,
//                pdm.lock, Pipfile.lock, requirements*.txt (QA-1.3-8), plus (QA-1.3-23) Pipfile,
//                setup.py, requirements*.in, constraints*.txt, and any *.txt or *.in below a
//                directory named "requirements" (requirements/base.txt)
//        all     the package.json that supplied the script (DetectedRunner.source), and every
//                file named by a config option (DetectedRunner.configFiles: vitest/jest
//                --config -c, pytest -c --config-file, eslint -c --config), resolved against
//                runnerCwd and canonicalized (QA-1.3-5)
//        eslint  (K)
//   8. Classification:
//        test file (JS): /\.(test|spec)\.[cm]?[jt]sx?$/ or a "__tests__" segment.
//        test file (py): a .py file matching pytest's python_files (QA-1.3-33; plan amendment to
//                section 1.5-3, which names only test_<stem>.py/<stem>_test.py). The patterns
//                are DetectedRunner.pythonFiles: the union over the configs each pytest release
//                line picks from runnerCwd, and, with path arguments, from their common ancestor
//                (a line whose config sets none, or that finds no config, adds the default
//                "test_*.py *_test.py"), plus every `-o python_files=` in the command, addopts or
//                PYTEST_ADDOPTS. Matching follows pytest's fnmatch_ex: a pattern without a
//                separator matches the basename, one with a separator the whole path (relative
//                patterns get "*" plus a separator in front); win32 folds case. pytest-django's
//                `python_files = tests.py test_*.py *_tests.py` makes pkg/tests.py a test file.
//                A union only ever classifies more files as tests, and an explicit test file is
//                always collected by pytest.
//        non-input (skipped, counted in a note):
//          - extensions .md .mdx .markdown .rst .adoc .txt;
//          - any path with a ".github" segment;
//          - basenames LICENSE, LICENCE, .gitignore, .gitattributes, .editorconfig, .npmignore,
//            .prettierignore. (Lockfiles are triggers now, 7.)
//        vitest/jest:
//          - an existing file becomes an input. A changed test file runs itself (evidence R).
//          - 8a (QA-1.3-37) except an existing test file that the runner's own config statically
//            excludes AND that lies in a Playwright testDir: note `playwright test file excluded
//            by the <runner> config, not run: <rel>`. The exclusion comes from the one config
//            the runner loads (the last --config file, else runnerCwd's single vitest.config.*,
//            else vite.config.*; jest.config.*, else package.json) and only when no projects or
//            workspace key, vitest.workspace/projects file, vitest --root/--dir, or jest
//            --rootDir/--testPathIgnorePatterns can change it. vitest: an `exclude` literal (or
//            --exclude) of the form X/**, X/**/*, or either after **/, X a plain path relative
//            to runnerCwd. jest: a testPathIgnorePatterns literal made only of word characters
//            and . / : - that is a substring of the path (a literal match implies jest's regex
//            match), after <rootDir>. Playwright: playwright.config.* from runnerCwd up to
//            gitRoot; testDir is its literal, the config's directory when absent, or <dir>/e2e
//            when not a literal. Otherwise the file stays an input, and the I 2a guard keeps a
//            0-test run unverifiable (fail-closed).
//          - a gone test file adds the note `deleted test file not run: <rel>`; the risk signal
//            covers it.
//          - any other gone file goes to the stem search (9).
//        pytest: only .py files count; others are skipped.
//          - an existing test file becomes an input, if it lies under runnerCwd and under a path
//            scope (when path scopes exist).
//          - an existing module is looked up with search.findByName(gitRoot, names), where each
//            basename pattern with exactly one "*" and no other wildcard gives a name
//            ("test_*.py" -> test_<stem>.py; by default ["test_<stem>.py", "<stem>_test.py"]).
//            A literal pattern (tests.py) or a path pattern gives none; with no names at all
//            there is no search. Hits are filtered the same way. No hits -> note `no tests named
//            for <rel>`. undefined -> S6 search-failed.
//          - a gone test file adds a note. A gone module uses the stem search plus findByName,
//            and gets S6 when both find nothing.
//        stem = the basename without its last extension. "index" and "__init__" use the parent
//        directory name instead.
//   9. Stem search (section 1.5-5): search.findByContent(gitRoot, stem, globs), with JS_TEST_GLOBS
//      or the pytest globs: ":(glob)**/<pattern>" per python_files basename pattern
//      (PY_TEST_GLOBS for the default), ":(glob)**/*.py" for a path pattern. pytest hits are
//      re-checked against python_files before they are counted.
//        undefined               -> S6 search-failed.
//        []                      -> S6 deleted-no-tests.
//        more than STEM_MATCH_LIMIT files -> S6 stem-too-common.
//        otherwise               -> the existing, inside-root results join the inputs.
//   9a. (QA-1.3-26) The searches run one process each, in sequence. More than SEARCH_LIMIT (50)
//      pending searches (the count below) -> S6 too-many-searches, decided before the first
//      search. 5000 changed pytest modules made 5000 git calls (about 26 minutes at 0.3 s each).
//      Batching (one git grep with several -e, one ls-files) would need a TestSearchSeam change;
//      the cap is the simpler bound, and planStaticScoping applies it identically.
//   10. Inputs empty after steps 8 and 9 -> NoAffected, with the note from M.2.
//   planStaticScoping stops before every search. Each gone non-test source, and each existing
//   pytest module, counts as a pending search. It applies 9a, and (QA-1.3-27) runs the spec-time
//   pytest config lookup (D.4) over the test inputs it already knows, so an addopts S6 there is
//   seen by 1.6 too. When nothing is decidable, the result is {scopable: true, runner,
//   pendingSearches}.
//
// ------------------------------------------------------------------------------------------------
// H. ARGV CONSTRUCTION
//   Notation: F = the sorted absolute inputs, K = runner.keptArgs, N = the effective workers,
//   R = reportPath, E = entry.prefix.
//
//   vitest scoped (mode "related"): file = node (F.1)
//     [...E, "related", ...F, ...K, "--run", "--passWithNoTests", `--maxWorkers=${N}`,
//      "--coverage.enabled=false", "--reporter=json", `--outputFile=${R}`]
//     NEVER add "--" here: cac takes the tokens after "--" out of related's file list, and that
//     ran 0 tests with exit 0 (R).
//   vitest rerun:
//     [...E, "run", ...F, ...K, "--passWithNoTests", `--maxWorkers=${N}`, "--coverage.enabled=false",
//      "--reporter=json", `--outputFile=${R}`]
//     Filters match as substrings. An absolute path selects that file, and at most a longer name
//     with the same prefix (see P).
//   jest scoped: file = node (F.1)
//     [...E, ...K, "--findRelatedTests", "--passWithNoTests", `--maxWorkers=${N}`, "--coverage=false",
//      "--json", `--outputFile=${R}`, "--", ...F]
//   jest rerun: the same, with "--runTestsByPath" in place of "--findRelatedTests".
//   pytest (scoped and rerun are the same; F are test files). E is [] for direct pytest and
//   ["run", "pytest"] for uv:
//     [...E, ...K, "-q", "-p", "no:cacheprovider", `--junitxml=${R}`, "--maxfail=0",
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
//                forward slashes in vitest and backslashes in jest. QA-1.3-35: computed by
//                prefix when s.name lies plainly below spec.cwd (same result; Bun's
//                path.win32.relative is about 13 times slower than node's), else P.relative.
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
//   Step 2a (QA-1.3-1, QA-1.3-19) Zero-test guard, for JSON and junit and for EVERY runner. A
//     complete report with total 0, no failing id and no collection error, from a spec with
//     non-empty inputs, becomes complete = false when
//       - mode is "rerun" (every input is an existing test file), note `rerun ran no tests
//         although every input is a test file`;
//       - the inputs are test files (inputsAreTests: pytest), or related was given a JS test file
//         (G.8 rule; a test file passed to related runs itself), note `<runner> ran no tests
//         although a test file was passed`;
//       - the spec has lexicalPaths, note `<runner> ran no tests and the paths were not
//         canonicalized (no realpath seam)`. QA-1.3-19: vitest through a junction cwd without
//         realpath also ran 0 tests with exit 0, exactly like jest.
//     A legitimately empty selection (a -k/-m/-t filter that deselects every test of a changed
//     test file, or a test file with no tests) is therefore unverifiable, never a pass.
//     realpath stays OPTIONAL in PlannerFs: making it required would break every planner caller
//     that passes a plain FsSeam (1.6 static scoping included), and the lexical run is already
//     fail-closed by this guard. 2.1 must still pass the native realpath (Q).
//     A parser exception is an unusable report: step 4 with the note `report could not be
//     parsed: <message>` (QA-1.3-12). readResult never rejects.
//   Step 3  pytest junit XML, parsed without an XML library, in linear time (QA-1.3-25).
//     - Read each <testcase .../> and <testcase ...>...</testcase> with a forward indexOf scan,
//       with its classname and name attributes. A testcase with no </testcase>, or one that
//       contains another <testcase, makes the report unusable (step 4). Decode &amp; &lt; &gt;
//       &quot; &apos; &#N; and &#xN;. A numeric reference outside 0..0xD7FF and 0xE000..0x10FFFF
//       stays literal text (QA-1.3-12).
//     - A <failure> child marks a failing test.
//     - Only an <error message="collection failure"> child marks a collection error
//       (QA-1.3-22). classname="" alone does not: pytest writes it for a real test outside its
//       rootdir (-c/--config-file elsewhere, --rootdir), and a green run of those tests must stay
//       green. A FAILING case with classname="" is unmapped (below), so it is never a pass. Any
//       other <error> (fixture setup or teardown) marks a failing test.
//     - <skipped> is not a failure.
//     - QA-1.3-35: a case with no <failure>/<error> only counts toward total; its attributes are
//       not decoded. Each input's cwd-relative id prefix is computed once.
//     Module mapping. For each spec input f:
//       dotted(f) = its gitRoot-relative path without ".py", with "/" replaced by ".".
//       The candidates are the segment-suffixes of dotted(f), kept in a map (first input wins).
//       The longest candidate D with classname === D or classname.startsWith(D + ".") names the
//       file: walk the classname's dot prefixes from the longest, one map lookup each. rest = the
//       part of classname after D, split on ".".
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
//   - A lintable file exists and lies inside gitRoot and inside a path scope. eslint >= 9: that
//     is all (QA-1.3-9): the flat config decides what it lints and --no-warn-ignored silences
//     the rest, so a .vue or .md file the config covers is not skipped. eslint < 9 or an
//     unknown version: it must also have an extension from --ext (comma-separated, leading dots
//     optional), by default .js .mjs .cjs .jsx .ts .mts .cts .tsx, because eslintrc lints every
//     explicitly passed file. The entry is resolved before this filter, so "no changed lintable
//     files" before resolution means no existing in-scope file at all.
//   - Config triggers (basename): eslint.config.*, .eslintrc, .eslintrc.*, .eslintignore,
//     package.json, tsconfig*.json, the JS lockfiles and workspace files of G.7, and the
//     --config/-c file -> Unscoped `eslint config changed: <rel>`.
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
//     node-not-found           node not found: no absolute PATH entry has a node executable
//                              node path is not absolute: <path>
//                              node on PATH is not an executable file: <f>   (F.1)
//     too-many-searches        too many changed modules to map: <n> test searches (limit 50)
//                              (G.9a)
//     config-too-large         config file too large to read: <path> (limit 1048576 bytes)
//                              (QA-1.3-34)
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
//   1. No shell, ever. This module never imports child_process. spec.file is one of: node (F.1:
//      host.nodePath, a node-named host.execPath, or node(.exe) from an absolute PATH entry); or a
//      native file named pytest(.exe) or uv(.exe) from an absolute PATH entry or the .venv
//      fallback. It is never a .cmd/.bat/.ps1/.sh shim, and never Bun. npx, pnpm, yarn and bun are
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
//   7. Paths that leave gitRoot are dropped, and PATH entries must be absolute (win32: with a
//      drive or UNC host, QA-1.3-36). Outside gitRoot,
//      the module reads only the runner's own package under node_modules, executables on
//      absolute PATH entries, and the pytest config candidates pytest itself would read above
//      gitRoot (D.4).
//   8. The adapter-owned flags appear exactly once, because D removes user copies: the worker
//      cap, reporter, outputFile, passWithNoTests, run, the coverage switch, junitxml,
//      -p no:cacheprovider and --maxfail=0.
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
//     config-driven tests). vitest adds setupFiles to them (QA-1.3-15 evidence; globalSetup is
//     not verified). Setup files are triggers by name (G.7) and by static reference (G.7a); what
//     remains is a setup file under an unconventional name that a config names only through a
//     non-literal expression (a variable, a computed path). Under vitest that change reruns
//     every test file (correct, at full cost); under jest the related graph does not see it.
//   - G.8a (QA-1.3-37) reads `exclude` literals anywhere in the vitest config, so an
//     `X/**` literal under coverage.exclude also counts. It is only used for a file inside a
//     Playwright testDir, which Playwright itself runs as its own test.
//   - A conftest.py or plugin hook (pytest_load_initial_conftests, pytest_cmdline_main) that
//     adds -n cannot be seen statically; the appended "-n N" only lands when D.4 found xdist.
//   - Tokenizing: npm on Windows (cmd.exe) does not treat '...' as quotes, while C.1 applies
//     POSIX rules everywhere.
//   - A vitest `run <absolute path>` filter may also select a longer name with the same prefix
//     (a.test.ts also selects a.test.tsx). That runs extra tests but never misses one.
//   - A `bail` set in a vitest or jest config file (not on the command line) still cuts the run
//     short: the JS config cannot be read statically. 2.1's S2 comparison inherits this residual
//     (QA-1.3-2 covers the command line; pytest addopts are covered by --maxfail=0).
//   - npm workspace selection from the user or global npmrc (~/.npmrc, $PREFIX/etc/npmrc, or a
//     npm_config_userconfig/globalconfig file) is not read (QA-1.3-24 covers the project .npmrc
//     files and the environment).
//
// ------------------------------------------------------------------------------------------------
// Q. CONSUMER CONTRACT
//
//   1.6 risk.ts takes `ScopingPlan | StaticScoping`. "Scoping impossible" holds when
//       isUnverifiable(plan). Show plan.reason and branch on plan.code. Callers obtain the plan
//       from planStaticScoping, which starts no process. S6Code only grows (round 2 added
//       node-not-found and too-many-searches, round 3 config-too-large), so a switch over it
//       needs a default branch.
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
/** git pathspecs for the section 1.5-5 stem search over pytest test files (the default python_files; G.8). */
export const PY_TEST_GLOBS: readonly string[] = [":(glob)**/test_*.py", ":(glob)**/*_test.py"];
/** pytest's default python_files (G.8, QA-1.3-33). */
export const DEFAULT_PYTHON_FILES: readonly string[] = ["test_*.py", "*_test.py"];
/** Config files above this many bytes are not parsed: S6 config-too-large (QA-1.3-34). */
export const CONFIG_SIZE_LIMIT = 1024 * 1024;
/** A deleted source whose stem appears in more test files than this is S6 stem-too-common. */
export const STEM_MATCH_LIMIT = 20;
/** More changed files needing a process-backed test search than this is S6 too-many-searches (G.9a). */
export const SEARCH_LIMIT = 50;
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
  | "argv-too-long"
  | "node-not-found"
  | "too-many-searches"
  | "config-too-large";

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
  /**
   * The running process's executable. Default: process.execPath. JS tools run under it only when
   * it is node (basename node or node.exe; the default also requires a non-Bun runtime). Under Bun,
   * or inside a compiled binary, node comes from PATH instead (F.1, QA-1.3-18).
   */
  readonly execPath: string;
  /** An explicit absolute node executable for JS tools (F.1). It wins over execPath and PATH. */
  readonly nodePath?: string;
  /** Default: os.tmpdir(). */
  readonly tmpdir: string;
  /** Default: os.availableParallelism(). */
  readonly cores: number;
  /** Default: process.env.PATH ?? "". */
  readonly pathEnv: string;
  /** win32 only, the node PATH lookup (F.1). Default: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD". */
  readonly pathExt?: string;
  /** Default: process.env.PYTEST_ADDOPTS ?? "" (xdist/cov evidence, D.4). */
  readonly pytestAddopts: string;
  /** The environment npm itself sees, read for npm_config_workspace(s) only (B, QA-1.3-24). Default: process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Default: crypto.randomUUID. It must return a UUID (REPORT_NAME_RE). */
  readonly randomId: () => string;
}

/**
 * The planners' filesystem seam (G.3a, QA-1.3-1). `realpath` must be the NATIVE realpath
 * (fs.promises.realpath or fs.realpathSync.native): it resolves symlinks, junctions and win32
 * 8.3 short names, and it rejects for a missing path. The JS fs.realpathSync does not expand 8.3
 * names and must not be used. `fileExists` must accept directories as well as files (B step 0).
 * Without `realpath`, paths stay lexical, every spec carries `lexicalPaths: true`, and readResult
 * never trusts a run that reports 0 tests (I step 2a, any runner: QA-1.3-19). It stays optional so
 * a plain FsSeam still type-checks; 2.1 must pass the native realpath.
 * `stat` (optional, round 3) is fs.promises.stat(path, { bigint: true }) mapped to FileStat. With it,
 * config files are size-checked before they are read (QA-1.3-34), a directory named node(.exe) is
 * not a node (QA-1.3-36), and a PATH node that is the same file as a non-node runtime (Bun's
 * temporary hard link, QA-1.3-30) is skipped. 2.1 should pass it.
 */
export interface PlannerFs extends FsSeam {
  realpath?(path: string): Promise<string>;
  stat?(path: string): Promise<FileStat>;
}

/** What PlannerFs.stat reports. bigint dev/ino keep win32 file ids exact. */
export interface FileStat {
  readonly isFile: boolean;
  readonly size: number | bigint;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
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
  /** pytest: what the command itself says, so each spec can redo the config lookup from its inputs (D.4). */
  readonly pytestFacts?: PytestFacts;
  /** Absolute canonical paths of the --config/-c (pytest: -c/--config-file) values. Config triggers (G.7, QA-1.3-5). */
  readonly configFiles?: readonly string[];
  /**
   * pytest: the python_files patterns the user's run can use (G.8, QA-1.3-33): the union over the
   * configs every pytest release line picks (defaults where a line's config sets none) and every
   * `-o python_files=` override. Undefined means DEFAULT_PYTHON_FILES.
   */
  readonly pythonFiles?: readonly string[];
}

/** The pytest command's own worker, xdist and config facts (D.4, QA-1.3-3). */
export interface PytestFacts {
  /** The raw value of the last cap token on the command line. */
  readonly cap?: string;
  /** The command has a cap entry or --dist. */
  readonly xdist: boolean;
  /** The command has "-p no:xdist". */
  readonly noXdist: boolean;
  /** -c / --config-file, absolute and canonical: pytest reads only this file. */
  readonly configFile?: string;
  /** The value of `-o addopts=<v>` / `--override-ini addopts=<v>`: it replaces the config's addopts. */
  readonly overrideAddopts?: string;
  /** The patterns of every `-o python_files=<v>` on the command line (QA-1.3-33): they replace the config's. */
  readonly pythonFiles?: readonly string[];
}

/** What resolveEntry needs. DetectedRunner satisfies it. */
export interface EntryRequest {
  readonly kind: ToolKind;
  readonly launcher: Launcher;
  readonly gitRoot: string;
}

export interface ResolvedEntry {
  /** node (F.1) for JS tools; the native pytest/uv executable otherwise. */
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
  /** node (F.1) for vitest/jest; the native pytest/uv executable otherwise. Never a shim, never Bun. */
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
   * (G.3a). jest and vitest match files against a realpath'd root, so readResult treats a run
   * reporting 0 tests as incomplete (I step 2a).
   */
  readonly lexicalPaths?: true;
}

/** An executable scoped eslint run (section K). Pass or fail comes from the exit code. */
export interface LintSpec {
  readonly runner: "eslint";
  /** node (F.1). */
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
  /** host.execPath is a node executable JS tools can run under (F.1, QA-1.3-18). */
  readonly execIsNode: boolean;
  /** Per-call caches (QA-1.3-34): a config file is read, and parsed per reading, once per plan. */
  readonly cache: {
    readonly texts: Map<string, Promise<TextRead>>;
    readonly parsed: Map<string, ConfigParse>;
    readonly exists: Map<string, Promise<boolean>>;
  };
}

function resolveHost(h: Partial<RunnerHost> | undefined): RunnerHost {
  return {
    platform: h?.platform ?? process.platform,
    execPath: h?.execPath ?? process.execPath,
    ...(h?.nodePath !== undefined ? { nodePath: h.nodePath } : {}),
    tmpdir: h?.tmpdir ?? os.tmpdir(),
    cores: h?.cores ?? os.availableParallelism(),
    pathEnv: h?.pathEnv ?? process.env.PATH ?? "",
    pathExt: h?.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    pytestAddopts: h?.pytestAddopts ?? process.env.PYTEST_ADDOPTS ?? "",
    env: h?.env ?? process.env,
    randomId: h?.randomId ?? randomUUID,
  };
}

function makeCtx(h: Partial<RunnerHost> | undefined): Ctx {
  const host = resolveHost(h);
  const win = host.platform === "win32";
  const P = win ? nodePath.win32 : nodePath.posix;
  const named = /^node(?:\.exe)?$/.test(win ? P.basename(host.execPath).toLowerCase() : P.basename(host.execPath));
  // F.1: an explicit execPath is trusted by name; the default also needs a runtime that is not Bun.
  // Neither may sit in Bun's temporary bun-node-<hex> directory (QA-1.3-30: `bun --bun run`).
  const bunDir = BUN_NODE_DIR_RE.test(P.basename(P.dirname(host.execPath)));
  const execIsNode = named && !bunDir && (h?.execPath !== undefined || process.versions.bun === undefined);
  const cache = { texts: new Map(), parsed: new Map(), exists: new Map() };
  return { host, P, win, key: (p: string) => (win ? p.toLowerCase() : p), execIsNode, cache };
}

/** A config file's text (BOM removed), or why it could not be used (QA-1.3-34). */
type TextRead = { readonly text: string } | "unreadable" | "too-large";

/**
 * QA-1.3-34: every config file the planners parse (pytest configs, .npmrc, the JS runner configs)
 * is read at most once per call, through this cache, and never parsed above CONFIG_SIZE_LIMIT: a
 * 100 MB pytest config cost up to 86 s and 9 GB. With fs.stat the size is checked before the
 * read; without it, after. A leading UTF-8 BOM is dropped (npm's ini parser trims it, QA-1.3-32).
 */
async function readConfigText(ctx: Ctx, fs: PlannerFs, p: string): Promise<TextRead> {
  const k = ctx.key(p);
  const hit = ctx.cache.texts.get(k);
  if (hit) return hit;
  const read = (async (): Promise<TextRead> => {
    try {
      const st = fs.stat ? await fs.stat(p) : undefined;
      if (st && !st.isFile) return "unreadable";
      if (st && Number(st.size) > CONFIG_SIZE_LIMIT) return "too-large";
      const text = await fs.readFile(p);
      return text.length > CONFIG_SIZE_LIMIT ? "too-large" : { text: text.replace(/^\uFEFF/, "") };
    } catch {
      return "unreadable";
    }
  })();
  ctx.cache.texts.set(k, read);
  return read;
}

function tooLarge(p: string): Unverifiable {
  return s6("config-too-large", `config file too large to read: ${p} (limit ${CONFIG_SIZE_LIMIT} bytes)`);
}

/** fileExists, cached per call (the pytest config walk probes the same names from several starts). */
function existsCached(ctx: Ctx, fs: FsSeam, p: string): Promise<boolean> {
  const k = ctx.key(p);
  let r = ctx.cache.exists.get(k);
  if (!r) {
    r = fs.fileExists(p);
    ctx.cache.exists.set(k, r);
  }
  return r;
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

/**
 * G.3a (QA-1.3-19): a changed or rerun path as the producer spelled it, minus win32 spellings of
 * the same file: the prefixes (stripWinPrefix) and the unnamed data stream suffix `::$DATA`, which
 * writes the file itself. realpath resolves those too; this keeps lexical mode equal.
 */
function lexicalSpelling(ctx: Ctx, p: string): string {
  const q = stripWinPrefix(ctx, p);
  return ctx.win ? q.replace(/::\$DATA$/i, "") : q;
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

/** npm options between the script name and "--" that are safe to ignore (B, QA-1.3-6). */
const NPM_HARMLESS_RE = /^(?:-s|--silent|-q|--quiet|-d|--if-present|--ignore-scripts|--no-color|--color(?:=.*)?|--loglevel=.*)$/s;
/** pnpm/yarn/bun options that select another package or directory (QA-1.3-6). */
const PM_LOCATION_RE =
  /^(?:-w|-ws|-C|-F|-r|-g|--workspace|--workspaces|--include-workspace-root|--workspace-root|--prefix|--dir|--cwd|--filter|--recursive|--global)(?:=.*)?$/s;

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
      // B (QA-1.3-6): only npm options that cannot pick another package, directory or script.
      const bad = ignored.find((x) => !NPM_HARMLESS_RE.test(x));
      if (bad !== undefined) return unsupported(`npm ${bad}`, where);
      const notes = ignored.length > 0 ? [`npm options ignored: ${ignored.join(" ")}`] : [];
      return { type: "script", manager: "npm", name, env, extra: dd < 0 ? [] : rest.slice(dd + 1), notes };
    }
    const location = rest[0] === "--" ? undefined : rest.find((x) => PM_LOCATION_RE.test(x));
    if (location !== undefined) return unsupported(`${h} ${location}`, where);
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
const EARLY_EXIT_NOTE = "early-exit option dropped for a full failure inventory";
const e = (names: string, action: ArgAction, arity: Arity, note?: string): ArgEntry => ({ names: names.split(" "), action, arity, note });

const VITEST_ARGS: readonly ArgEntry[] = [
  e("--run --watch -w --no-watch --ui --open --standalone --update -u --passWithNoTests --clearScreen --inspect --inspect-brk", "drop", "0"),
  e("--coverage --no-coverage", "drop", "0", COVERAGE_NOTE),
  e("--changed --api --mergeReports", "drop", "?"),
  e("--coverage.*", "drop", "?", COVERAGE_NOTE),
  e("--bail", "drop", "1", EARLY_EXIT_NOTE),
  e("--reporter --outputFile --outputFile.* --shard --minWorkers --min-workers --api.*", "drop", "1"),
  e("--maxWorkers --max-workers", "cap", "1"),
  e("--no-file-parallelism --fileParallelism=false", "cap1-keep", "0"),
  e("--config -c --root -r --dir --project --environment --pool --testNamePattern -t --mode --testTimeout --hookTimeout --teardownTimeout --retry --exclude --maxConcurrency --slowTestThreshold", "keep", "1"),
  e("--browser --sequence.* --typecheck.* --browser.*", "keep", "?"),
  e("--globals --dom --isolate --no-isolate --allowOnly --silent --hideSkippedTests --logHeapUsage --color --no-color --expandSnapshotDiff --disableConsoleIntercept --typecheck --printConsoleTrace --includeTaskLocation", "keep", "0"),
];

const JEST_ARGS: readonly ArgEntry[] = [
  e("--watch --watchAll --json --findRelatedTests --listTests --onlyChanged -o --lastCommit --changedFilesWithAncestor --updateSnapshot -u --passWithNoTests --runTestsByPath --onlyFailures -f", "drop", "0"),
  e("--coverage --collectCoverage --no-coverage", "drop", "0", COVERAGE_NOTE),
  e("--bail -b", "drop", "?", EARLY_EXIT_NOTE),
  e("--outputFile --changedSince --shard --collectCoverageFrom --coverageDirectory --coverageProvider --coverageThreshold", "drop", "1"),
  e("--reporters --coverageReporters --coveragePathIgnorePatterns", "drop", "*"),
  e("--maxWorkers --max-workers -w", "cap", "1"),
  e("--runInBand -i", "cap1-drop", "0"),
  e("--config -c --rootDir --testNamePattern -t --testEnvironment --env --testTimeout --testRunner --testSequencer --cacheDirectory --workerIdleMemoryLimit --seed --maxConcurrency --openHandlesTimeout", "keep", "1"),
  e("--roots --selectProjects --ignoreProjects --projects --testPathPatterns --testPathPattern --testPathIgnorePatterns --testMatch", "keep", "*"),
  e("--ci --silent --verbose --detectOpenHandles --detectLeaks --forceExit --cache --no-cache --colors --watchman --no-watchman --errorOnDeprecated --injectGlobals --noStackTrace --useStderr --workerThreads --randomize --showSeed --clearMocks --resetMocks --restoreMocks --expand -e --logHeapUsage", "keep", "0"),
  e("--showConfig --clearCache --init", "s6", "0"),
];

const PYTEST_ARGS: readonly ArgEntry[] = [
  e("-q --quiet --lf --last-failed --ff --failed-first --nf --new-first --sw --stepwise --sw-skip --stepwise-skip --cache-clear --pdb --trace -f --looponfail --cov-append --cov-branch --no-cov --no-cov-on-fail --self-contained-html --json-report", "drop", "0"),
  e("-x --exitfirst", "drop", "0", EARLY_EXIT_NOTE),
  e("--maxfail", "drop", "1", EARLY_EXIT_NOTE),
  e("--cov", "drop", "?"),
  e("--junitxml --junit-xml --pdbcls --cov-report --cov-config --cov-fail-under --cov-context --html --json-report-file", "drop", "1"),
  e("-n --numprocesses --maxprocesses", "cap", "1"),
  e("-k -m -c --config-file --rootdir -o --override-ini -W --pythonwarnings --tb -r --import-mode --basetemp --durations --durations-min --timeout --ignore --ignore-glob --deselect --confcutdir --dist --capture --log-level --log-cli-level", "keep", "1"),
  e("-v -vv --verbose -s -l --showlocals --strict-markers --strict-config --disable-warnings --no-header --runxfail", "keep", "0"),
  e("--co --collect-only --fixtures --fixtures-per-test --markers --setup-plan --setup-only --version -V -h --help --tx --rsyncdir", "s6", "0"),
];

const ESLINT_ARGS: readonly ArgEntry[] = [
  e("--fix --fix-dry-run --no-warn-ignored", "drop", "0"),
  e("--fix-type -o --output-file", "drop", "1"),
  e("--concurrency", "cap", "1"),
  e("-c --config --ext --parser --parser-options --resolve-plugins-relative-to --rulesdir --plugin --rule --env --global --ignore-path --ignore-pattern --cache-location --cache-strategy -f --format --max-warnings --report-unused-disable-directives-severity --flag", "keep", "1"),
  e("--cache --quiet --no-eslintrc --no-config-lookup --no-ignore --no-inline-config --report-unused-disable-directives --color --no-color --no-error-on-unmatched-pattern --exit-on-fatal-error --pass-on-no-patterns --stats --debug", "keep", "0"),
  e("--init --print-config --inspect-config --env-info -v --version -h --help --stdin --stdin-filename", "s6", "0"),
];

/**
 * D.0 (QA-1.3-10): yargs (jest) and cac (vitest) read `--kebab-case` as `--camelCase`. Both the
 * tables and the user tokens are compared in camelCase; "--no-" stays a negation prefix.
 */
function camelOption(t: string): string {
  if (!t.startsWith("--")) return t;
  const eq = t.indexOf("=");
  const name = eq < 0 ? t : t.slice(0, eq);
  const neg = name.startsWith("--no-") ? "--no-" : "--";
  return neg + name.slice(neg.length).replace(/-([A-Za-z0-9])/g, (_m, c: string) => c.toUpperCase()) + (eq < 0 ? "" : t.slice(eq));
}

const camelTable = (t: readonly ArgEntry[]): readonly ArgEntry[] => t.map((x) => ({ ...x, names: x.names.map(camelOption) }));

const ARG_TABLES: Record<ToolKind, readonly ArgEntry[]> = {
  vitest: camelTable(VITEST_ARGS),
  jest: camelTable(JEST_ARGS),
  pytest: PYTEST_ARGS,
  eslint: ESLINT_ARGS,
};

/**
 * D.0 (QA-1.3-3b, QA-1.3-10): short options per parser. `flags` take no value, `values` take one.
 *   mri (vitest/cac): every letter of a group is a flag except the last, which takes "=v" or the
 *                     next token; attached values ("-cfoo") do not exist.
 *   yargs (jest):     flags chain until a value letter; an attached value must be "=v" or a number.
 *   argparse (pytest): flags chain until a value letter, which takes the rest or the next token.
 */
const SHORT_GROUPS: Partial<Record<ToolKind, { readonly style: "mri" | "yargs" | "argparse"; readonly flags: string; readonly values: string }>> = {
  vitest: { style: "mri", flags: "wuhv", values: "crt" },
  jest: { style: "yargs", flags: "befhiouv", values: "ctw" },
  pytest: { style: "argparse", flags: "qvxslhVf", values: "kmcoWrpn" },
};

/**
 * Split a grouped short-option token the way the runner's parser does: `-qn3` -> `-q -n3`,
 * `-ou` -> `-o -u`. Returns [t] when t is not a group, undefined for a group the adapter cannot
 * model (an unknown letter, or an attached value the parser would read differently) -> S6.
 */
function expandShort(kind: ToolKind, t: string): string[] | undefined {
  const g = SHORT_GROUPS[kind];
  if (!g || t.startsWith("--") || !/^-[A-Za-z]./s.test(t)) return [t];
  const yargsValue = (rest: string) => g.style !== "yargs" || rest === "" || /^(?:=.*|-?\d+(?:\.\d*)?)$/s.test(rest);
  if (g.style === "mri") {
    const eq = t.indexOf("=");
    const letters = t.slice(1, eq < 0 ? undefined : eq);
    const out: string[] = [];
    for (let i = 0; i < letters.length; i++) {
      const c = letters[i];
      const last = i === letters.length - 1;
      if (!g.flags.includes(c) && !(last && g.values.includes(c))) return undefined;
      out.push(last && eq >= 0 ? `-${c}${t.slice(eq)}` : `-${c}`);
    }
    return out;
  }
  if (g.values.includes(t[1])) return yargsValue(t.slice(2)) ? [t] : undefined;
  const out: string[] = [];
  for (let i = 1; i < t.length; i++) {
    const c = t[i];
    if (g.values.includes(c)) {
      const rest = t.slice(i + 1);
      if (!yargsValue(rest)) return undefined;
      out.push(`-${c}${rest}`);
      return out;
    }
    if (!g.flags.includes(c)) return undefined;
    out.push(`-${c}`);
  }
  return out;
}

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
  /** pytest: a --cov option was seen (D.4). */
  readonly cov: boolean;
  /** The raw values of the config-file options (D.1 config values). */
  readonly configs: string[];
  /** pytest: the value of `-o addopts=<v>`. */
  readonly overrideAddopts: string | undefined;
  /** pytest: the values of every `-o python_files=<v>` (QA-1.3-33). */
  readonly overridePythonFiles: string[];
  readonly notes: string[];
}

interface ArgOptions {
  /**
   * The tokens come from addopts or PYTEST_ADDOPTS (D.4, QA-1.3-13): a positional -> S6, and an
   * unknown option's next token is taken as its value unless it names an existing path (S6).
   */
  readonly addopts?: { readonly exists: (abs: string) => Promise<boolean> };
}

/** The options whose value is a config file (D.1 config values, QA-1.3-5). */
const CONFIG_OPTIONS: Record<ToolKind, readonly string[]> = {
  vitest: ["--config", "-c"],
  jest: ["--config", "-c"],
  pytest: ["-c", "--config-file"],
  eslint: ["-c", "--config"],
};

/** D.1 for vitest, jest, pytest and eslint. */
async function processArgs(
  ctx: Ctx,
  kind: ToolKind,
  input: readonly string[],
  where: string,
  runnerCwd: string,
  gitRoot: string,
  opts: ArgOptions = {},
): Promise<ArgResult | Unverifiable> {
  const table = ARG_TABLES[kind];
  const camel = kind === "vitest" || kind === "jest";
  const args = [...input];
  const kept: string[] = [];
  const notes = new Set<string>();
  const filters: string[] = [];
  const pathScopes: string[] = [];
  const configs: string[] = [];
  let capRaw: string | undefined;
  let noXdist = false;
  let xdistArg = false;
  let cov = false;
  let overrideAddopts: string | undefined;
  const overridePythonFiles: string[] = [];
  let firstPositional = true;
  const badArg = (t: string) => s6("unsupported-argument", `unsupported ${kind} argument "${t}" in ${where}`);

  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === "--") return badArg(t);
    const parts = expandShort(kind, t);
    if (!parts) return badArg(t);
    if (parts.length !== 1 || parts[0] !== t) {
      args.splice(i, 1, ...parts);
      i--;
      continue;
    }
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
    const m = matchArg(table, camel ? camelOption(t) : t);
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
      if (m.name === "--cov") cov = true;
      const value = m.inline ? m.value : values[0];
      if (value !== undefined && CONFIG_OPTIONS[kind].includes(m.name)) configs.push(value);
      if (kind === "pytest" && (m.name === "-o" || m.name === "--override-ini") && value !== undefined) {
        if (value.startsWith("addopts=")) overrideAddopts = value.slice("addopts=".length);
        if (value.startsWith("python_files=")) overridePythonFiles.push(value.slice("python_files=".length));
      }
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
      // D.1 g (QA-1.3-10): an option the vitest/jest tables do not know fails closed.
      if (camel) return badArg(t);
      const next = args[i + 1];
      if (t.includes("=") || next === undefined || next.startsWith("-")) {
        kept.push(t);
        continue;
      }
      if (opts.addopts) {
        // Either reading is safe: a path is S6 here, and a missing path makes pytest exit 4.
        if (await opts.addopts.exists(ctx.P.resolve(runnerCwd, next))) return badArg(next);
        kept.push(t, next);
        i++;
        continue;
      }
      return s6("ambiguous-option", `ambiguous ${kind} option "${t}" in ${where}: cannot tell whether "${next}" is its value`);
    }
    // Positional. In addopts it would widen the run to a directory or file (QA-1.3-13).
    if (opts.addopts) return badArg(t);
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
  return { kept, capRaw, userWorkers, pathScopes, noXdist, xdistArg, cov, configs, overrideAddopts, overridePythonFiles, notes: [...notes] };
}

// ---------------------------------------------------------------------------------------------
// D.4 pytest configuration (QA-1.3-3, QA-1.3-13)
// ---------------------------------------------------------------------------------------------

/**
 * pytest's inifile names per release line, each in its search order (_pytest/config/findpaths.py
 * locate_config). QA-1.3-21: pytest 8 does not know pytest.toml/.pytest.toml or the native
 * [tool.pytest] table, and pytest 7.0 does not know .pytest.ini either, so an older pytest reads
 * a file that pytest 9 never reaches. The adapter cannot tell which pytest will run, so it reads
 * the file every line would pick and takes the union of the evidence.
 */
const PYTEST_CONFIG_LINES: readonly { readonly names: readonly string[]; readonly legacy: boolean }[] = [
  { names: ["pytest.toml", ".pytest.toml", "pytest.ini", ".pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg"], legacy: false },
  { names: ["pytest.ini", ".pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg"], legacy: true },
  { names: ["pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg"], legacy: true },
];

/** The pytest ini keys the adapter reads (D.4): addopts (QA-1.3-3) and python_files (QA-1.3-33). */
const PY_KEYS = ["addopts", "python_files"] as const;
type PyKey = (typeof PY_KEYS)[number];

interface ConfigValues {
  readonly addopts?: readonly string[];
  readonly pythonFiles?: readonly string[];
}

/**
 * undefined: not a pytest config (pytest skips it). `bad` names what is present but not understood:
 * "addopts" or "python_files" (an unreadable value, or a TOML spelling other than the bare key
 * under its table), or a raw TOML key or header whose escapes do not decode.
 */
type ConfigParse = { readonly values: ConfigValues; readonly bad: readonly string[] } | undefined;

/**
 * One config file by pytest's per-format rules. `explicit` (-c) files always count. `legacy`
 * reads a TOML file the way pytest 7/8 do: [tool.pytest.ini_options] only, and pytest.toml is not
 * a native config there.
 */
function parsePytestConfig(ctx: Ctx, file: string, text: string, explicit: boolean, legacy: boolean): ConfigParse {
  const base = ctx.P.basename(file);
  let raw: Partial<Record<PyKey, string | readonly string[]>>;
  const bad: string[] = [];
  if (ctx.P.extname(base) === ".toml") {
    const own = !legacy && (base === "pytest.toml" || base === ".pytest.toml");
    const r = tomlPytest(text, own ? ["pytest"] : legacy ? ["tool.pytest.ini_options"] : ["tool.pytest.ini_options", "tool.pytest"]);
    if (r.bad.length === 0 && !r.found && !own && !explicit) return undefined;
    raw = r.values;
    bad.push(...r.bad);
  } else {
    const r = iniPytest(text, ctx.P.extname(base) === ".cfg" ? "tool:pytest" : "pytest");
    if (!r.found && base !== "pytest.ini" && base !== ".pytest.ini" && !explicit) return undefined;
    raw = r.values;
  }
  const values: { addopts?: readonly string[]; pythonFiles?: readonly string[] } = {};
  for (const k of PY_KEYS) {
    const v = raw[k];
    if (v === undefined || bad.includes(k)) continue;
    // A string is split like pytest's shlex (ini values, TOML strings); a TOML array is taken as is.
    const tokens = typeof v === "string" ? tokenize(v.replace(/\r?\n/g, " ")) : v;
    if (tokens === undefined) bad.push(k);
    else if (k === "addopts") values.addopts = tokens;
    else values.pythonFiles = tokens;
  }
  return { values, bad };
}

/**
 * iniconfig rules: `[section]` at column 0, indented continuation lines, # and ; comment lines, and
 * `key = value` or `key: value` with optional whitespace (QA-1.3-31: `addopts:-n 3` is read). A
 * line splits on its first "=" unless the name before it contains ":", otherwise on its first ":".
 */
function iniPytest(text: string, section: string): { found: boolean; values: Partial<Record<PyKey, string>> } {
  let current: string | undefined;
  let found = false;
  let key: string | undefined;
  const values: Partial<Record<PyKey, string>> = {};
  const pyKey = (k: string | undefined): PyKey | undefined => PY_KEYS.find((x) => x === k);
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (/^\s*[#;]/.test(line) || line.trim() === "") continue;
    if (line.startsWith("[")) {
      const head = line.replace(/[#;].*$/, "").trimEnd();
      current = head.endsWith("]") ? head.slice(1, -1) : undefined;
      if (current === section) found = true;
      key = undefined;
    } else if (/^\s/.test(line)) {
      const k = pyKey(key);
      if (current === section && k) values[k] = `${values[k] ?? ""}\n${line.trim()}`;
    } else {
      const kv = iniSplit(line);
      key = kv?.[0];
      const k = pyKey(key);
      if (kv && current === section && k) values[k] = kv[1];
    }
  }
  return { found, values };
}

/** iniconfig's name/value split (QA-1.3-31). undefined: neither "=" nor ":" (iniconfig rejects the line). */
function iniSplit(line: string): [string, string] | undefined {
  const eq = line.indexOf("=");
  if (eq >= 0 && !line.slice(0, eq).includes(":")) return [line.slice(0, eq).trim(), line.slice(eq + 1).trim()];
  const colon = line.indexOf(":");
  return colon < 0 ? undefined : [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
}

const TOML_HEADER_RE = /^[ \t]*(\[\[?)([^\]\r\n]*)\]\]?[ \t]*(?:#.*)?\r?$/;
const TOML_KEY_PART = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')`;
const TOML_KEY_RE = new RegExp(String.raw`^[ \t]*(${TOML_KEY_PART}(?:[ \t]*\.[ \t]*${TOML_KEY_PART})*)[ \t]*=[ \t]*`);
const TOML_PART_RE = new RegExp(String.raw`[ \t]*(${TOML_KEY_PART})[ \t]*(?:\.|$)`, "y");
const TOML_ARRAY_GAP_RE = /(?:[\s,]|#[^\n]*)*/y;

/**
 * QA-1.3-31: a dotted TOML key or header, split into DECODED parts, so `"add\u006fpts"` and
 * `tool."py\u0074est"` compare equal to what pytest's TOML parser reads. []: not a key path (a
 * shell test such as `[[ -n "$X" ]]` inside a string, say); "bad": a quoted part whose escapes do
 * not decode.
 */
function tomlKeyParts(s: string): string[] | "bad" {
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    TOML_PART_RE.lastIndex = i;
    const m = TOML_PART_RE.exec(s);
    if (!m || m[0] === "") return [];
    const raw = m[1];
    if (raw.startsWith('"')) {
      const d = tomlString(raw, 0);
      if (!d) return "bad";
      out.push(d.value);
    } else {
      out.push(raw.startsWith("'") ? raw.slice(1, -1) : raw);
    }
    i = TOML_PART_RE.lastIndex;
  }
  return out;
}

const startsWithPath = (path: readonly string[], prefix: readonly string[]) => prefix.length <= path.length && prefix.every((p, i) => path[i] === p);
const samePath = (a: readonly string[], b: readonly string[]) => a.length === b.length && startsWithPath(a, b);

/**
 * D.4 (QA-1.3-20, QA-1.3-31): the pytest keys (PY_KEYS) of the first matching TOML table, in one
 * pass over the lines. Headers and keys are compared by their decoded parts. Only a bare key
 * directly below a [table] header from `tables` is read, as a string or an array of strings; the
 * same key reached any other way (a dotted key, a quoted key, an inline table on the way, an array
 * table, a second occurrence) is `bad`, and so is an undecodable quoted part anywhere. Each value is
 * skipped as a whole, so a header inside a multi-line string is not a header. `found`: some header
 * or key path outside an array table lies in a table from `tables` (pytest then accepts the file
 * as its config); a dotted key such as `tool.pytest.ini_options.markers` defines the table too.
 */
function tomlPytest(text: string, tables: readonly string[]): { found: boolean; values: Partial<Record<PyKey, string | readonly string[]>>; bad: string[] } {
  const tabs = tables.map((t) => t.split("."));
  const targets = PY_KEYS.flatMap((key) => tabs.map((t) => ({ key, table: t, path: [...t, key] })));
  const values: Partial<Record<PyKey, string | readonly string[]>> = {};
  const bad = new Set<string>();
  let found = false;
  let table: readonly string[] | undefined = [];
  let array = false;
  for (let pos = 0; pos < text.length; ) {
    let eol = text.indexOf("\n", pos);
    if (eol < 0) eol = text.length;
    const line = text.slice(pos, eol);
    const h = TOML_HEADER_RE.exec(line);
    const m = h ?? TOML_KEY_RE.exec(line);
    let next = eol + 1;
    if (m) {
      const raw = m[h ? 2 : 1];
      const parts = tomlKeyParts(raw);
      if (parts === "bad") {
        bad.add(raw.trim());
      } else if (h) {
        // A header that is not a key path (text inside a string) belongs to no table.
        table = parts.length > 0 ? parts : undefined;
        array = h[1] === "[[";
        if (!array && tabs.some((t) => startsWithPath(parts, t))) found = true;
      } else {
        const vStart = pos + m[0].length;
        let end = tomlSkipValue(text, vStart);
        if (table) {
          const full = [...table, ...parts];
          if (!array && tabs.some((t) => startsWithPath(full, t))) found = true;
          for (const t of targets) {
            if (!array && parts.length === 1 && parts[0] === t.key && samePath(table, t.table)) {
              // A second occurrence (the same key in two pytest tables) is a TOML or pytest error.
              const v = values[t.key] === undefined ? tomlValue(text, vStart) : undefined;
              if (v) {
                values[t.key] = v.value;
                end = v.end;
              } else bad.add(t.key);
            } else if (samePath(full, t.path) || (text[vStart] === "{" && t.path.length > full.length && startsWithPath(t.path, full))) {
              bad.add(t.key);
            }
          }
        }
        if (end > eol) next = end;
      }
    }
    pos = next;
  }
  return { found, values, bad: [...bad] };
}

/** The end of the TOML value starting at s[i] (a string, an array or inline table with nesting, or the rest of the line). */
function tomlSkipValue(s: string, i: number): number {
  const lineEnd = (j: number) => {
    const n = s.indexOf("\n", j);
    return n < 0 ? s.length : n;
  };
  if (s[i] === '"' || s[i] === "'") return tomlStringEnd(s, i) ?? lineEnd(i);
  if (s[i] !== "[" && s[i] !== "{") return lineEnd(i);
  let depth = 0;
  for (let j = i; j < s.length; ) {
    const c = s[j];
    if (c === '"' || c === "'") {
      const end = tomlStringEnd(s, j);
      if (end === undefined) return lineEnd(j);
      j = end;
      continue;
    }
    if (c === "#") {
      j = lineEnd(j);
      continue;
    }
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return s.length;
}

/** The end of any TOML string (basic, literal, or their multi-line forms) starting at s[i]; undefined when unterminated. */
function tomlStringEnd(s: string, i: number): number | undefined {
  const q = s[i];
  const q3 = q.repeat(3);
  const multi = s.startsWith(q3, i);
  for (let j = i + (multi ? 3 : 1); j < s.length; j++) {
    const c = s[j];
    if (q === '"' && c === "\\") {
      j++;
      continue;
    }
    if (!multi && (c === "\n" || c === "\r")) return undefined;
    if (!multi && c === q) return j + 1;
    if (multi && s.startsWith(q3, j)) {
      // Up to two more quotes belong to the content ("""a"""" is `a"`).
      let k = j + 3;
      while (k < j + 5 && s[k] === q) k++;
      return k;
    }
  }
  return undefined;
}

const TOML_ESCAPES: Readonly<Record<string, string>> = { '"': '"', "\\": "\\", n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };

/** A TOML string or array of strings at s[i], with the index after it; undefined for anything else. */
function tomlValue(s: string, i: number): { value: string | string[]; end: number } | undefined {
  if (s.startsWith('"""', i) || s.startsWith("'''", i)) {
    const q = s.slice(i, i + 3);
    const end = s.indexOf(q, i + 3);
    if (end < 0) return undefined;
    const raw = s.slice(i + 3, end).replace(/^\r?\n/, "");
    return q === '"""' && raw.includes("\\") ? undefined : { value: raw, end: end + 3 };
  }
  if (s[i] === '"' || s[i] === "'") return tomlString(s, i);
  if (s[i] !== "[") return undefined;
  const out: string[] = [];
  for (let j = i + 1; ; ) {
    TOML_ARRAY_GAP_RE.lastIndex = j;
    j += TOML_ARRAY_GAP_RE.exec(s)?.[0].length ?? 0;
    if (s[j] === "]") return { value: out, end: j + 1 };
    const str = tomlString(s, j);
    if (!str) return undefined;
    out.push(str.value);
    j = str.end;
  }
}

/** A single-line TOML basic ("...") or literal ('...') string starting at s[i]. */
function tomlString(s: string, i: number): { value: string; end: number } | undefined {
  if (s[i] === "'") {
    const end = s.indexOf("'", i + 1);
    if (end < 0 || s.slice(i + 1, end).includes("\n")) return undefined;
    return { value: s.slice(i + 1, end), end: end + 1 };
  }
  if (s[i] !== '"') return undefined;
  let value = "";
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '"') return { value, end: j + 1 };
    if (c === "\n") return undefined;
    if (c !== "\\") {
      value += c;
      continue;
    }
    const n = s[j + 1] ?? "";
    const simple = Object.hasOwn(TOML_ESCAPES, n) ? TOML_ESCAPES[n] : undefined;
    if (simple !== undefined) {
      value += simple;
      j++;
      continue;
    }
    const len = n === "u" ? 4 : n === "U" ? 8 : 0;
    const hex = s.slice(j + 2, j + 2 + len);
    const cp = len > 0 && hex.length === len && /^[0-9a-fA-F]+$/.test(hex) ? Number.parseInt(hex, 16) : -1;
    if (!isXmlCodePoint(cp)) return undefined;
    value += String.fromCodePoint(cp);
    j += 1 + len;
  }
  return undefined;
}

interface PytestConfig extends ConfigValues {
  readonly path: string;
}

/**
 * pytest's inifile selection for every release line (QA-1.3-21): the -c file alone (read both
 * ways), or, per line, the first accepted file walking from `start` up to the filesystem root
 * (above gitRoot too, as pytest does). Returns the distinct configs found, pytest 9's first. An
 * unreadable file is noted and skipped; a file over CONFIG_SIZE_LIMIT is S6 config-too-large
 * (QA-1.3-34). A `bad` key is S6 (some pytest reads it) unless it is in `ignore` (overridden with
 * -o on the command line). Files are read and parsed once per call (ctx.cache).
 * `everyLine` is false when some release line found no config at all.
 */
async function findPytestConfigs(
  ctx: Ctx,
  fs: PlannerFs,
  explicit: string | undefined,
  start: string,
  notes: string[],
  ignore: ReadonlySet<string>,
): Promise<{ configs: PytestConfig[]; everyLine: boolean } | Unverifiable> {
  const load = async (p: string, isExplicit: boolean, legacy: boolean): Promise<ConfigParse | "unreadable" | Unverifiable> => {
    const t = await readConfigText(ctx, fs, p);
    if (t === "too-large") return tooLarge(p);
    if (t === "unreadable") {
      const n = `unreadable pytest config ignored: ${p}`;
      if (!notes.includes(n)) notes.push(n);
      return "unreadable";
    }
    const pk = `${ctx.key(p)}\0${isExplicit}\0${legacy}`;
    if (!ctx.cache.parsed.has(pk)) ctx.cache.parsed.set(pk, parsePytestConfig(ctx, p, t.text, isExplicit, legacy));
    const r = ctx.cache.parsed.get(pk);
    const bad = r?.bad.find((b) => !ignore.has(b));
    return bad === undefined ? r : s6("unsupported-argument", `unsupported pytest argument "${bad}" in ${p}`);
  };
  const out: PytestConfig[] = [];
  const add = (p: string, r: NonNullable<ConfigParse>) => {
    const c = { path: p, ...r.values };
    if (!out.some((o) => o.path === c.path && JSON.stringify(o) === JSON.stringify(c))) out.push(c);
  };
  if (explicit !== undefined) {
    for (const legacy of [false, true]) {
      const r = await load(explicit, true, legacy);
      if (r === undefined || r === "unreadable") continue;
      if (isS6(r)) return r;
      add(explicit, r);
    }
    return { configs: out, everyLine: out.length > 0 };
  }
  const done = PYTEST_CONFIG_LINES.map(() => false);
  let d = start;
  for (;;) {
    for (let l = 0; l < PYTEST_CONFIG_LINES.length; l++) {
      if (done[l]) continue;
      for (const name of PYTEST_CONFIG_LINES[l].names) {
        const p = ctx.P.join(d, name);
        if (!(await existsCached(ctx, fs, p))) continue;
        const r = await load(p, false, PYTEST_CONFIG_LINES[l].legacy);
        if (r === undefined || r === "unreadable") continue;
        if (isS6(r)) return r;
        add(p, r);
        done[l] = true;
        break;
      }
    }
    const up = ctx.P.dirname(d);
    if (done.every(Boolean) || up === d) return { configs: out, everyLine: done.every(Boolean) };
    d = up;
  }
}

/** QA-1.3-21: the lower of two raw config caps (count n < auto; an invalid value ranks last). */
function lowerCap(raw: string, than: string | undefined): boolean {
  if (than === undefined) return true;
  const rank = (x: string) => {
    const c = parseCap("pytest", x);
    return c === undefined ? Number.POSITIVE_INFINITY : "count" in c ? c.count : Number.MAX_SAFE_INTEGER;
  };
  return rank(raw) < rank(than);
}

interface PytestEvidence {
  readonly xdist: boolean;
  readonly covInConfig: boolean;
  readonly userWorkers?: UserWorkerCap;
  /** The union of the python_files patterns every source can apply (QA-1.3-33). */
  readonly pythonFiles: readonly string[];
}

/**
 * D.4: xdist, cov and the user cap from every source pytest reads, in pytest's order (config
 * addopts, then PYTEST_ADDOPTS, then the command; the last cap wins). Both the cross-env and the
 * host PYTEST_ADDOPTS are scanned for evidence; the cap comes from the one the spawn will see.
 */
async function pytestEvidence(
  ctx: Ctx,
  fs: PlannerFs,
  facts: PytestFacts,
  env: Readonly<Record<string, string>>,
  start: string,
  runnerCwd: string,
  gitRoot: string,
  notes: string[],
): Promise<PytestEvidence | Unverifiable> {
  // cap: "config" sources are alternatives (one per pytest line, QA-1.3-21): the lowest cap wins.
  // Later sources override in pytest's order: "wins" always, "if-last" unless cross-env follows.
  const sources: { where: string; text?: string; tokens?: readonly string[]; cap: "config" | "wins" | "none" }[] = [];
  // The config is always looked up: python_files comes from it even when -o addopts replaces its
  // addopts. A key the command line overrides with -o is not S6 when the file spells it oddly.
  const ignore = new Set<string>();
  if (facts.overrideAddopts !== undefined) ignore.add("addopts");
  if (facts.pythonFiles !== undefined) ignore.add("python_files");
  const found = await findPytestConfigs(ctx, fs, facts.configFile, start, notes, ignore);
  if (isS6(found)) return found;
  // QA-1.3-33: every line's config applies its python_files, or pytest's default when it sets none
  // or the line found no config. The union only ever classifies more files as tests.
  const pythonFiles = new Set<string>(found.everyLine ? [] : DEFAULT_PYTHON_FILES);
  for (const cfg of found.configs) for (const p of cfg.pythonFiles ?? DEFAULT_PYTHON_FILES) pythonFiles.add(p);
  for (const p of facts.pythonFiles ?? []) pythonFiles.add(p);
  // "-p no:xdist" in a config disables xdist only when every pytest line reads a config that says
  // so: a line whose config does not block xdist would still honour an -n (QA-1.3-21).
  let configsBlock: boolean;
  if (facts.overrideAddopts !== undefined) {
    sources.push({ where: "-o addopts", text: facts.overrideAddopts, cap: "config" });
    configsBlock = true;
  } else {
    configsBlock = found.everyLine && found.configs.every((c) => c.addopts !== undefined);
    for (const cfg of found.configs) if (cfg.addopts) sources.push({ where: `addopts of ${cfg.path}`, tokens: cfg.addopts, cap: "config" });
  }
  const crossEnv = Object.hasOwn(env, "PYTEST_ADDOPTS");
  if (ctx.host.pytestAddopts !== "") sources.push({ where: "PYTEST_ADDOPTS", text: ctx.host.pytestAddopts, cap: crossEnv ? "none" : "wins" });
  if (crossEnv) sources.push({ where: "PYTEST_ADDOPTS", text: env.PYTEST_ADDOPTS, cap: "wins" });

  let capRaw: string | undefined;
  let xdist = facts.xdist;
  let noXdist = facts.noXdist;
  let cov = false;
  const exists = (p: string) => fs.fileExists(p);
  for (const src of sources) {
    const tokens = src.tokens ?? tokenize(src.text ?? "");
    if (!tokens) return s6("unterminated-quote", `unterminated quote in ${src.where}`);
    const r = await processArgs(ctx, "pytest", tokens, src.where, runnerCwd, gitRoot, { addopts: { exists } });
    if (isS6(r)) return r;
    xdist ||= r.xdistArg;
    if (src.cap === "config") configsBlock &&= r.noXdist;
    else noXdist ||= r.noXdist;
    cov ||= r.cov;
    if (r.capRaw !== undefined && (src.cap === "wins" || (src.cap === "config" && lowerCap(r.capRaw, capRaw)))) capRaw = r.capRaw;
    for (const n of r.notes) if (n.startsWith("invalid worker cap") && !notes.includes(n)) notes.push(n);
    const pf = pythonFilesOverride(r.overridePythonFiles, src.where);
    if (isS6(pf)) return pf;
    for (const p of pf) pythonFiles.add(p);
  }
  if (facts.cap !== undefined) capRaw = facts.cap;
  const userWorkers = capRaw === undefined ? undefined : parseCap("pytest", capRaw);
  return { xdist: xdist && !noXdist && !configsBlock, covInConfig: cov, ...(userWorkers ? { userWorkers } : {}), pythonFiles: [...pythonFiles] };
}

/** The patterns of `-o python_files=<v>` values, split like pytest's shlex (QA-1.3-33). */
function pythonFilesOverride(values: readonly string[], where: string): string[] | Unverifiable {
  const out: string[] = [];
  for (const v of values) {
    const tokens = tokenize(v);
    if (!tokens) return s6("unsupported-argument", `unsupported pytest argument "python_files" in ${where}`);
    out.push(...tokens);
  }
  return out;
}

/** The directory pytest starts its inifile search from: the common ancestor of the file arguments. */
function commonDir(ctx: Ctx, files: readonly string[]): string {
  let dir = ctx.P.dirname(files[0]);
  for (const f of files) {
    while (!isInside(ctx, dir, f)) {
      const up = ctx.P.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return dir;
}

/** D.4 at spec time (QA-1.3-3c): pytest picks its config from the inputs, so redo the lookup there. */
async function pytestAtInputs(
  ctx: Ctx,
  fs: PlannerFs,
  det: DetectedRunner,
  F: readonly string[],
  runnerCwd: string,
  notes: string[],
): Promise<PytestEvidence | Unverifiable | undefined> {
  if (det.kind !== "pytest") return undefined;
  const facts = det.pytestFacts ?? { xdist: det.xdist, noXdist: false };
  const own: string[] = [];
  const ev = await pytestEvidence(ctx, fs, facts, det.env, commonDir(ctx, F), runnerCwd, det.gitRoot, own);
  if (isS6(ev)) return ev;
  for (const n of own) if (!notes.includes(n)) notes.push(n);
  if (det.pytestFacts) return ev;
  // A DetectedRunner built elsewhere: never lose what it already knew.
  const userWorkers = ev.userWorkers ?? det.userWorkers;
  return { xdist: ev.xdist || det.xdist, covInConfig: ev.covInConfig || det.covInConfig, ...(userWorkers ? { userWorkers } : {}), pythonFiles: ev.pythonFiles };
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
  if (inv.manager === "npm") {
    const redirect = await npmWorkspaceConfig(ctx, fs, absCwd, gitRoot, inv.env);
    if (redirect) return redirect;
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

const NPM_WORKSPACE_ENV_RE = /^npm_config_workspaces?$/i;

/**
 * QA-1.3-32: the keys of an .npmrc as npm's `ini` parser reads them: lines split on CR/LF, comment
 * (; #) and blank lines skipped, a line without "=" is a key set to true, and the key text goes
 * through ini's unsafe(): trimmed (JS trim also drops a BOM), a quoted key ('...' or "...") is
 * unquoted and JSON-decoded when it parses ("work\u0073pace" is workspace), an unquoted key stops
 * at the first unescaped ; or #. A trailing [] (array key) is dropped. Keys under a [section]
 * are kept too (a superset). Lower-cased.
 */
function npmrcKeys(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/[\r\n]+/)) {
    if (/^\s*(?:[;#]|$)/.test(line) || /^\[[^\]]*\]\s*$/.test(line)) continue;
    const eq = line.indexOf("=");
    if (eq === 0) continue;
    let key = npmUnsafe(eq < 0 ? line : line.slice(0, eq));
    if (key.length > 2 && key.endsWith("[]")) key = key.slice(0, -2);
    out.push(key.toLowerCase());
  }
  return out;
}

/** ini's unsafe() for a key (see npmrcKeys). */
function npmUnsafe(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    const inner = v.startsWith("'") ? v.slice(1, -1) : v;
    try {
      return String(JSON.parse(inner));
    } catch {
      return inner; // ini keeps the text when JSON.parse fails.
    }
  }
  let out = "";
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === ";" || c === "#") break;
    if (c !== "\\") out += c;
    else if (i + 1 < v.length) out += ";#\\".includes(v[i + 1]) ? v[++i] : `\\${v[++i]}`;
    else out += "\\";
  }
  return out.trim();
}

/**
 * B (QA-1.3-24): npm reads `workspace` / `workspaces` from a project .npmrc and from
 * npm_config_* variables (any case), and then `npm test` runs the workspace's script, not the
 * root one the adapter resolved (npm 12.0.2). Checked: every .npmrc from cwd up to gitRoot, the
 * host env and the cross-env assignments. `prefix` is NOT checked: from .npmrc or the env it only
 * moves the global prefix (npm 12.0.2 still ran the root script), and npm_config_prefix is a
 * common global setting. The user and global npmrc are a P residual.
 */
async function npmWorkspaceConfig(
  ctx: Ctx,
  fs: PlannerFs,
  cwd: string,
  gitRoot: string,
  crossEnv: Readonly<Record<string, string>>,
): Promise<Unverifiable | undefined> {
  for (const [where, env] of [["cross-env", crossEnv], ["the environment", ctx.host.env ?? {}]] as const) {
    const key = Object.keys(env).find((k) => NPM_WORKSPACE_ENV_RE.test(k) && (env[k] ?? "") !== "");
    if (key !== undefined) return unsupported(`npm ${key}`, where);
  }
  for (const d of ancestors(ctx, cwd, gitRoot)) {
    const p = ctx.P.join(d, ".npmrc");
    if (!(await existsCached(ctx, fs, p))) continue;
    const t = await readConfigText(ctx, fs, p);
    if (t === "too-large") return tooLarge(p);
    if (t === "unreadable") return unsupported("npm", `${p} (unreadable)`);
    const key = npmrcKeys(t.text).find((k) => k === "workspace" || k === "workspaces");
    if (key !== undefined) return unsupported(`npm ${key}`, p);
  }
  return undefined;
}

async function finishDetection<K extends ToolKind>(
  ctx: Ctx,
  fs: PlannerFs,
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
  // QA-1.3-32: npx (npm exec) reads the same workspace config as npm and then runs in the
  // workspace's directory, so `npx vitest run` would test another package than the planned one.
  if (launcher === "npx") {
    const redirect = await npmWorkspaceConfig(ctx, fs, runnerCwd, gitRoot, env);
    if (redirect) return redirect;
  }
  const a = await processArgs(ctx, kind, args, where, runnerCwd, gitRoot);
  if (isS6(a)) return a;
  const allNotes = [...notes, ...a.notes];
  const pathScopes = await Promise.all(a.pathScopes.map((p) => realOf(ctx, fs, p)));
  const configFiles = await Promise.all(a.configs.map((c) => realOf(ctx, fs, ctx.P.resolve(runnerCwd, stripWinPrefix(ctx, c)))));
  let userWorkers = a.userWorkers;
  let xdist = false;
  let covInConfig = false;
  let pytestFacts: PytestFacts | undefined;
  let pythonFiles: readonly string[] | undefined;
  if (kind === "pytest") {
    const configFile = configFiles.at(-1);
    const pf = pythonFilesOverride(a.overridePythonFiles, where);
    if (isS6(pf)) return pf;
    pytestFacts = {
      xdist: a.xdistArg,
      noXdist: a.noXdist,
      ...(a.capRaw !== undefined ? { cap: a.capRaw } : {}),
      ...(configFile !== undefined ? { configFile } : {}),
      ...(a.overrideAddopts !== undefined ? { overrideAddopts: a.overrideAddopts } : {}),
      ...(a.overridePythonFiles.length > 0 ? { pythonFiles: pf } : {}),
    };
    // Detection has no inputs yet: start where pytest would with no file arguments.
    const ev = await pytestEvidence(ctx, fs, pytestFacts, env, runnerCwd, runnerCwd, gitRoot, allNotes);
    if (isS6(ev)) return ev;
    ({ xdist, covInConfig, userWorkers } = ev);
    // QA-1.3-33: with path arguments the user's pytest reads the config above their common
    // ancestor (a directory argument is its own start), so its python_files count as well.
    const patterns = new Set(ev.pythonFiles);
    if (pathScopes.length > 0) {
      const scoped = await pytestEvidence(ctx, fs, pytestFacts, env, commonDir(ctx, pathScopes.map((s) => ctx.P.join(s, "_"))), runnerCwd, gitRoot, allNotes);
      if (isS6(scoped)) return scoped;
      for (const p of scoped.pythonFiles) patterns.add(p);
    }
    pythonFiles = [...patterns];
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
    pathScopes,
    xdist,
    covInConfig,
    notes: allNotes,
    configFiles,
    ...(pytestFacts ? { pytestFacts } : {}),
    ...(pythonFiles ? { pythonFiles } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// F. Entry resolution
// ---------------------------------------------------------------------------------------------

async function resolveEntryImpl(
  ctx: Ctx,
  req: EntryRequest,
  cwd: string,
  fs: PlannerFs,
): Promise<{ entry: ResolvedEntry; notes: string[] } | Unverifiable> {
  const P = ctx.P;
  const exe = (name: string) => (ctx.win ? `${name}.exe` : name);
  const onPath = async (name: string): Promise<string | undefined> => {
    for (const dir of ctx.host.pathEnv.split(P.delimiter)) {
      if (!dir || !isFullPath(ctx, dir)) continue;
      const f = P.join(dir, exe(name));
      if ((await fs.fileExists(f)) && (await statOf(fs, f))?.isFile !== false) return f;
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
      if ((await fs.fileExists(f)) && (await statOf(fs, f))?.isFile !== false) return { entry: { file: f, prefix: [], entry: f }, notes: [`pytest resolved from ${f}`] };
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
  const node = await resolveNode(ctx, fs);
  if (typeof node !== "string") return node;
  return { entry: { file: node, prefix: [entry], entry, ...(version !== undefined ? { version } : {}) }, notes: [] };
}

/**
 * F.1 (QA-1.3-18): the node executable that runs a JS tool. Never Bun or a compiled binary:
 * jest fails every suite under bun.exe. Order: host.nodePath, host.execPath when it is node, then
 * the first node on an absolute PATH entry. On win32 each PATHEXT extension is tried in order, as
 * the shell does; a hit that is not a .exe (a .cmd/.bat shim) needs a shell -> S6. Bun's temporary
 * node is skipped by its bun-node-<hex> directory, a realpath to bun (symlink), or the same dev/ino
 * as host.execPath (the win32 hard link, QA-1.3-30); a directory named node is skipped and a
 * root-relative win32 PATH entry is unusable (QA-1.3-36). fileExists, realpath and stat only,
 * nothing is spawned.
 */
async function resolveNode(ctx: Ctx, fs: PlannerFs): Promise<string | Unverifiable> {
  const { P, host } = ctx;
  if (host.nodePath !== undefined) {
    if (!isFullPath(ctx, host.nodePath)) return s6("node-not-found", `node path is not absolute: ${host.nodePath}`);
    // QA-1.3-36: with the stat seam, a configured node must be an existing file.
    const bad = fs.stat !== undefined && (await statOf(fs, host.nodePath))?.isFile !== true;
    return bad ? s6("node-not-found", `node path is not a file: ${host.nodePath}`) : host.nodePath;
  }
  if (ctx.execIsNode && (fs.stat === undefined || (await statOf(fs, host.execPath))?.isFile === true)) return host.execPath;
  const exts = ctx.win ? (host.pathExt ?? "").split(";").map((x) => x.trim().toLowerCase()).filter((x) => x.startsWith(".")) : [""];
  // QA-1.3-30: the running runtime is not node here (Bun, or a compiled binary). A PATH node that
  // is the same file (Bun's temporary node on win32 is a HARD link to bun.exe) is not node either.
  let self: FileStat | undefined | null = null;
  for (const dir of host.pathEnv.split(P.delimiter)) {
    if (!dir || !isFullPath(ctx, dir) || BUN_NODE_DIR_RE.test(P.basename(dir))) continue;
    for (const ext of exts) {
      const f = P.join(dir, `node${ext}`);
      if (!(await fs.fileExists(f))) continue;
      const st = await statOf(fs, f);
      if (st && !st.isFile) continue; // QA-1.3-36: a directory named node.exe.
      if (ctx.win && ext !== ".exe") return s6("node-not-found", `node on PATH is not an executable file: ${f}`);
      if (await isBunLink(ctx, fs, f)) break;
      if (st && self === null) self = await statOf(fs, host.execPath);
      if (st && self && sameFile(st, self)) break;
      return f;
    }
  }
  return s6("node-not-found", "node not found: no absolute PATH entry has a node executable");
}

/** QA-1.3-30: the directory `bun run` puts first on PATH with its temporary node (%TEMP%\bun-node-<hash>, /tmp/bun-node-<hash>). */
const BUN_NODE_DIR_RE = /^bun-node-[0-9a-f]+$/i;

/**
 * N.1/N.7 (QA-1.3-36): a PATH entry or configured executable path the planner may use: absolute,
 * and on win32 with a drive letter or a UNC host. A root-relative "\dir" is absolute to
 * path.win32 but resolves against whichever drive is current (the plugin's for fileExists,
 * spec.cwd's for the spawn), so it names no one file.
 */
function isFullPath(ctx: Ctx, p: string): boolean {
  return ctx.P.isAbsolute(p) && (!ctx.win || /^[A-Za-z]:[\\/]|^[\\/]{2}[^\\/]+[\\/][^\\/]/.test(p));
}

/** PlannerFs.stat when the seam has it and the call succeeds; undefined otherwise. */
async function statOf(fs: PlannerFs, p: string): Promise<FileStat | undefined> {
  if (!fs.stat) return undefined;
  return fs.stat(p).then(
    (s) => s,
    () => undefined,
  );
}

/** The same file (hard links included): equal dev and ino. An ino of 0 (a file system without ids) proves nothing. */
function sameFile(a: FileStat, b: FileStat): boolean {
  return String(a.ino) !== "0" && String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
}

/** A PATH node that is really Bun: `bun run` links a temporary `node` to itself when node is missing. */
async function isBunLink(ctx: Ctx, fs: PlannerFs, f: string): Promise<boolean> {
  if (!fs.realpath) return false;
  const real = await fs.realpath(f).then(
    (x) => stripWinPrefix(ctx, x),
    () => f,
  );
  return /^bun(?:\.exe)?$/i.test(ctx.P.basename(real));
}

// ---------------------------------------------------------------------------------------------
// G + H. Changed files and argv construction
// ---------------------------------------------------------------------------------------------

const JS_TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Python's fnmatch.fnmatch (the matcher behind pytest's python_files), in linear-time form: `*`
 * matches any run of characters (separators included), `?` one character, `[...]` / `[!...]` a set
 * with ranges, and an unclosed `[` is literal. `fold` compares case-insensitively (win32 normcase).
 * A greedy two-pointer match, so a hostile pattern cannot backtrack exponentially.
 */
function fnmatch(pattern: string, name: string, fold: boolean): boolean {
  const pat = fold ? pattern.toLowerCase() : pattern;
  const s = fold ? name.toLowerCase() : name;
  type Tok = { readonly star: true } | { readonly star: false; readonly test: (c: string) => boolean };
  const toks: Tok[] = [];
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "*") {
      if (!toks.at(-1)?.star) toks.push({ star: true });
      continue;
    }
    if (c === "?") {
      toks.push({ star: false, test: () => true });
      continue;
    }
    let close = -1;
    if (c === "[") {
      let j = i + 1;
      if (pat[j] === "!") j++;
      if (pat[j] === "]") j++;
      close = pat.indexOf("]", j);
    }
    if (close < 0) {
      toks.push({ star: false, test: (x) => x === c });
      continue;
    }
    const neg = pat[i + 1] === "!";
    const body = pat.slice(i + (neg ? 2 : 1), close);
    toks.push({ star: false, test: (x) => fnmatchSet(body, x) !== neg });
    i = close;
  }
  let p = 0;
  let k = 0;
  let starP = -1;
  let starK = 0;
  while (k < s.length) {
    const t = toks[p];
    if (t && t.star) {
      starP = p++;
      starK = k;
    } else if (t && t.test(s[k])) {
      p++;
      k++;
    } else if (starP >= 0) {
      p = starP + 1;
      k = ++starK;
    } else {
      return false;
    }
  }
  while (toks[p]?.star) p++;
  return p === toks.length;
}

/** One fnmatch set body: single characters and a-z ranges. */
function fnmatchSet(body: string, c: string): boolean {
  for (let i = 0; i < body.length; i++) {
    if (body[i + 1] === "-" && i + 2 < body.length) {
      if (c >= body[i] && c <= body[i + 2]) return true;
      i += 2;
    } else if (body[i] === c) {
      return true;
    }
  }
  return false;
}

/**
 * G.8 (QA-1.3-33): pytest's python_files rule (_pytest/pathlib.py fnmatch_ex). A pattern without a
 * separator matches the basename; one with a separator matches the whole path, with "*" and a
 * separator put in front of a relative pattern. win32 compares case-insensitively with either
 * separator.
 */
function isPyTestFile(ctx: Ctx, patterns: readonly string[], abs: string): boolean {
  const norm = (s: string) => (ctx.win ? s.replace(/\\/g, "/") : s);
  const base = ctx.P.basename(abs);
  return patterns.some((raw) => {
    const pat = norm(raw);
    if (!pat.includes("/")) return fnmatch(pat, base, ctx.win);
    return fnmatch(ctx.P.isAbsolute(raw) ? pat : `*/${pat}`, norm(abs), ctx.win);
  });
}

/**
 * G.8: the test basenames for a module stem, from each basename pattern with exactly one `*` and no
 * other wildcard ("test_*.py" -> "test_<stem>.py"). A literal name (pytest-django's "tests.py")
 * or a path pattern names no file for a stem.
 */
function pyTestNames(patterns: readonly string[], stem: string): string[] {
  const out = new Set<string>();
  for (const p of patterns) {
    const i = p.indexOf("*");
    if (i < 0 || p.indexOf("*", i + 1) >= 0 || /[\\/?[]/.test(p)) continue;
    out.add(p.slice(0, i) + stem + p.slice(i + 1));
  }
  return [...out];
}

/** G.9: git pathspecs covering the test files of `patterns`; a path pattern widens to every .py file (hits are re-checked). */
function pyTestGlobs(patterns: readonly string[]): string[] {
  return [...new Set(patterns.map((p) => (/[\\/]/.test(p) ? ":(glob)**/*.py" : `:(glob)**/${p}`)))];
}
const NON_INPUT_EXT_RE = /\.(md|mdx|markdown|rst|adoc|txt)$/i;
const NON_INPUT_NAMES = new Set(["LICENSE", "LICENCE", ".gitignore", ".gitattributes", ".editorconfig", ".npmignore", ".prettierignore"]);
/** JS dependency and workspace files (G.7, QA-1.3-8): a lockfile-only change can upgrade a dependency. */
const JS_DEPS = String.raw`package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|pnpm-workspace\.yaml|\.npmrc|\.yarnrc(?:\.yml)?|\.pnpmfile\.cjs`;
const TRIGGERS: Record<RunnerKind, RegExp> = {
  vitest: new RegExp(String.raw`^(?:package\.json|vitest\.config\..+|vite\.config\..+|vitest\.workspace\..+|vitest\.projects\..+|tsconfig.*\.json|${JS_DEPS})$`),
  jest: new RegExp(String.raw`^(?:package\.json|jest\.config\..+|babel\.config\..+|\.babelrc|\.babelrc\..+|tsconfig.*\.json|${JS_DEPS})$`),
  pytest:
    /^(?:conftest\.py|pyproject\.toml|\.?pytest\.ini|\.?pytest\.toml|setup\.cfg|setup\.py|tox\.ini|uv\.lock|poetry\.lock|pdm\.lock|[Pp]ipfile(?:\.lock)?|requirements[\w.-]*\.(?:txt|in)|constraints[\w.-]*\.txt)$/,
};
/** G.7 (QA-1.3-23): pip requirement files kept in a `requirements/` directory (requirements/base.txt, dev.in). */
const PY_REQ_DIR_FILE_RE = /\.(?:txt|in)$/i;
const JS_EXT = String.raw`\.[cm]?[jt]sx?$`;
const JS_EXT_RE = new RegExp(JS_EXT, "i");
/**
 * G.7 (QA-1.3-15, QA-1.3-28, QA-1.3-29): vitest/jest setup files by name. A SUPERSET of the rule
 * 1.6 risk.ts uses (QA-1.6-21: `*.setup.<js/ts>` and its basenames), plus the names with a test
 * marker that round 2 caught: jest-setup.js, jest.setupAfterEnv.js, testSetup.ts, setupVitest.ts,
 * setupFilesAfterEnv.ts, globalTeardown.ts, ... vitest reruns every test for a setupFiles change
 * and jest's related-test graph never reaches one (QA-1.3-29: `--findRelatedTests <setup>` ran 0
 * tests, exit 0), so both fail closed. A bare `setup.ts` or `SetupWizard.tsx` is application code
 * unless it lies in a test directory (SETUP_DIR_RE). All alternatives are anchored and linear.
 */
const SETUP_FILE_RE = new RegExp(
  [
    String.raw`\.setup${JS_EXT}`,
    String.raw`^(?:setupTests|setup-tests|test-setup|global-setup|globalSetup|vitest\.setup|jest\.setup|setup-jest|jest-setup|vitest-setup|global-teardown)${JS_EXT}`,
    String.raw`^(?:jest|vitest|tests?)[._-]?(?:setup|teardown)[\w.-]*${JS_EXT}`,
    String.raw`^setup[._-]?(?:tests?|jest|vitest|env|after[._-]?env|files?(?:[._-]?after[._-]?env)?)${JS_EXT}`,
    String.raw`^global[._-]?(?:setup|teardown)[\w.-]*${JS_EXT}`,
  ].join("|"),
  "i",
);
/** G.7 (QA-1.3-29): a bare setup/teardown file counts when a directory above it is a test directory (test/setup.js). */
const SETUP_BARE_RE = new RegExp(String.raw`^(?:setup|teardown)${JS_EXT}`, "i");
const SETUP_DIR_RE = /^(?:tests?|specs?|testing|jest|vitest|__tests__)$/i;

/** The JS runner config files scanned for static references (G.7a), per directory from runnerCwd up to gitRoot. */
const JS_CONFIG_EXTS = ["js", "ts", "mjs", "cjs", "mts", "cts"];
const JS_CONFIG_NAMES: Readonly<Record<"vitest" | "jest", readonly string[]>> = {
  vitest: ["vitest.config", "vite.config"].flatMap((b) => JS_CONFIG_EXTS.map((x) => `${b}.${x}`)),
  jest: [...JS_CONFIG_EXTS.map((x) => `jest.config.${x}`), "jest.config.json", "package.json"],
};
const PLAYWRIGHT_CONFIG_NAMES = JS_CONFIG_EXTS.map((x) => `playwright.config.${x}`);
/** Config keys whose values name setup files (vitest and jest share them). */
const SETUP_KEYS = ["setupFiles", "setupFilesAfterEnv", "globalSetup", "globalTeardown"] as const;
const CONFIG_KEY_RE =
  /(?<![\w$])["']?(setupFiles|setupFilesAfterEnv|globalSetup|globalTeardown|rootDir|exclude|testPathIgnorePatterns|testDir|projects|workspace)["']?[ \t]*:[ \t\r\n]*/g;

/**
 * G.7a: the string literals a JS/TS/JSON config assigns to CONFIG_KEY_RE's keys, statically: the
 * value is one literal or an array whose literal elements are taken (spreads, calls and variables
 * are skipped; `require.resolve('./x')` inside the array still yields './x'). A key present with no
 * literal value maps to []. Comments are skipped; a template literal with `${` is not static. One
 * forward pass: the key search resumes after each scanned value, so the cost stays linear.
 */
function configLiterals(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = new RegExp(CONFIG_KEY_RE.source, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const vals = out.get(m[1]) ?? [];
    out.set(m[1], vals);
    let i = m.index + m[0].length;
    const literal = (): boolean => {
      const q = text[i];
      let v = "";
      for (i++; i < text.length && text[i] !== q; i++) {
        if (text[i] === "\\") v += text[++i] ?? "";
        else if (text[i] === "\n" && q !== "`") return false;
        else v += text[i];
      }
      i++;
      if (!(q === "`" && v.includes("${"))) vals.push(v);
      return true;
    };
    if (/["'`]/.test(text[i] ?? "")) literal();
    else if (text[i] === "[") {
      for (i++; i < text.length && text[i] !== "]"; ) {
        if (/["'`]/.test(text[i])) {
          if (!literal()) break;
        } else if (text.startsWith("//", i)) {
          const nl = text.indexOf("\n", i);
          i = nl < 0 ? text.length : nl;
        } else if (text.startsWith("/*", i)) {
          const end = text.indexOf("*/", i + 2);
          i = end < 0 ? text.length : end + 2;
        } else i++;
      }
    }
    re.lastIndex = Math.max(re.lastIndex, i);
  }
  return out;
}

/** What the vitest/jest configs say statically (G.7a, QA-1.3-29, QA-1.3-37). */
interface JsConfigFacts {
  /** Keys of the files named as setupFiles/setupFilesAfterEnv/globalSetup/globalTeardown. */
  readonly setupKeys: ReadonlySet<string>;
  /** The same for references without an extension, which jest resolves (compared without the extension, or as a directory index). */
  readonly setupStems: ReadonlySet<string>;
  /** vitest `exclude` globs (and --exclude) or jest testPathIgnorePatterns, from the config the runner itself loads. */
  readonly excludes: readonly { readonly base: string; readonly value: string }[];
}

/**
 * G.7a: read the vitest or jest config files (every directory from runnerCwd up to gitRoot, and the
 * --config file) once. setup references from any of them are triggers: a superset only adds S6.
 * Exclusions (G.8a) can only remove inputs, so they come from the one file the runner loads and
 * only when nothing else can change what applies: the last --config file, else runnerCwd's own
 * config when exactly one candidate of the first kind present exists (vitest.config.* before
 * vite.config.*; jest.config.* before package.json). No exclusions with a `projects`/`workspace`
 * key, a vitest.workspace/projects file, vitest --root/--dir, or jest --rootDir or
 * --testPathIgnorePatterns on the command line. jest `<rootDir>` resolves only when rootDir is
 * absent (the config's directory) or one literal.
 */
async function jsConfigFacts(ctx: Ctx, fs: PlannerFs, det: DetectedRunner): Promise<JsConfigFacts | Unverifiable> {
  const P = ctx.P;
  const kind = det.kind === "jest" ? "jest" : "vitest";
  const files = new Set<string>(det.configFiles ?? []);
  for (const d of ancestors(ctx, det.runnerCwd, det.gitRoot)) {
    for (const n of JS_CONFIG_NAMES[kind]) {
      const p = P.join(d, n);
      if (await existsCached(ctx, fs, p)) files.add(p);
    }
  }
  const kept = det.keptArgs.map(camelOption);
  const optionSet = (names: readonly string[]) => kept.some((t) => names.some((n) => t === n || t.startsWith(`${n}=`)));
  let loaded: string | undefined;
  if (det.configFiles !== undefined && det.configFiles.length > 0) {
    loaded = det.configFiles.at(-1);
  } else {
    const groups = kind === "vitest" ? [JS_CONFIG_NAMES.vitest.slice(0, 6), JS_CONFIG_NAMES.vitest.slice(6)] : [JS_CONFIG_NAMES.jest.slice(0, -1), ["package.json"]];
    for (const g of groups) {
      const own = g.map((n) => P.join(det.runnerCwd, n)).filter((p) => files.has(p));
      if (own.length === 0) continue;
      loaded = own.length === 1 ? own[0] : undefined;
      break;
    }
  }
  const workspaceFile =
    kind === "vitest" &&
    (await Promise.all(["vitest.workspace", "vitest.projects"].flatMap((b) => [...JS_CONFIG_EXTS, "json"].map((x) => existsCached(ctx, fs, P.join(det.runnerCwd, `${b}.${x}`)))))).some(Boolean);
  const cliBlocks = kind === "vitest" ? optionSet(["--root", "-r", "--dir"]) : optionSet(["--rootDir", "--testPathIgnorePatterns"]);
  const setupKeys = new Set<string>();
  const setupStems = new Set<string>();
  const excludes: { base: string; value: string }[] = [];
  for (const file of files) {
    const t = await readConfigText(ctx, fs, file);
    if (t === "too-large") return tooLarge(file);
    if (t === "unreadable") continue;
    const lits = configLiterals(t.text);
    const dir = P.dirname(file);
    const rootLits = lits.get("rootDir");
    const rootDir = rootLits === undefined ? dir : rootLits.length === 1 ? P.resolve(dir, rootLits[0]) : undefined;
    const bases = [...new Set([dir, kind === "jest" ? (rootDir ?? dir) : det.runnerCwd])];
    for (const key of SETUP_KEYS) {
      for (const v of lits.get(key) ?? []) {
        if (v.trim() === "" || /[*?{}]/.test(v)) continue;
        for (const b of bases) {
          const abs = P.resolve(b, v.replace(/<rootDir>/g, b));
          (JS_EXT_RE.test(v) ? setupKeys : setupStems).add(ctx.key(abs));
        }
      }
    }
    if (file !== loaded || workspaceFile || cliBlocks || lits.has("projects") || lits.has("workspace")) continue;
    if (kind === "vitest") {
      for (const v of lits.get("exclude") ?? []) excludes.push({ base: det.runnerCwd, value: v });
    } else {
      for (const v of lits.get("testPathIgnorePatterns") ?? []) {
        if (v.includes("<rootDir>") && rootDir === undefined) continue;
        excludes.push({ base: dir, value: v.replace(/<rootDir>/g, rootDir ?? dir) });
      }
    }
  }
  if (kind === "vitest" && !cliBlocks) {
    for (let i = 0; i < kept.length; i++) {
      if (kept[i] === "--exclude" && i + 1 < kept.length) excludes.push({ base: det.runnerCwd, value: det.keptArgs[++i] });
      else if (kept[i].startsWith("--exclude=")) excludes.push({ base: det.runnerCwd, value: kept[i].slice("--exclude=".length) });
    }
  }
  return { setupKeys, setupStems, excludes };
}

/** G.7a: `abs` is a setup file a config names (with its extension, or without it / as a directory index). */
function isReferencedSetup(ctx: Ctx, facts: JsConfigFacts, abs: string): boolean {
  if (facts.setupKeys.has(ctx.key(abs))) return true;
  const ext = ctx.P.extname(abs);
  const stem = ext === "" ? abs : abs.slice(0, -ext.length);
  return facts.setupStems.has(ctx.key(stem)) || (ctx.P.basename(stem) === "index" && facts.setupStems.has(ctx.key(ctx.P.dirname(abs))));
}

/**
 * G.8a (QA-1.3-37): the runner's own static exclusion covers `abs`. vitest: an exclude glob of the
 * form `X/**`, `X/**` + `/*`, or the same after `**` + `/`, with X a plain path (relative to runnerCwd).
 * jest: a testPathIgnorePatterns entry made only of word characters, ".", "/", ":" and "-" that is
 * a substring of the path: jest matches it as a regex, and a literal match implies a regex match.
 * Anything else is not understood and excludes nothing (the file stays an input: fail-closed).
 */
function excludedByRunner(ctx: Ctx, facts: JsConfigFacts, kind: RunnerKind, abs: string): boolean {
  const slash = (s: string) => s.replace(/\\/g, "/");
  return facts.excludes.some((ex) => {
    if (kind === "jest") {
      const v = slash(ex.value);
      return /^[\w./:-]+$/.test(v) && slash(abs).includes(v);
    }
    const m = /^(?:\.\/)?(\*\*\/)?([\w.-]+(?:\/[\w.-]+)*)\/\*\*(?:\/\*)?$/.exec(ex.value);
    if (!m) return false;
    const rel = slash(ctx.P.relative(ex.base, abs));
    return m[1] ? `/${rel}`.includes(`/${m[2]}/`) : rel.startsWith(`${m[2]}/`);
  });
}

/**
 * G.8a (QA-1.3-37): Playwright test directories: each playwright.config.* from runnerCwd up to
 * gitRoot gives its literal testDir (resolved against the config's directory), the config's
 * directory when testDir is absent (Playwright's default), or `<dir>/e2e` when testDir is not a
 * literal.
 */
async function playwrightDirs(ctx: Ctx, fs: PlannerFs, det: DetectedRunner): Promise<string[] | Unverifiable> {
  const out: string[] = [];
  for (const d of ancestors(ctx, det.runnerCwd, det.gitRoot)) {
    for (const n of PLAYWRIGHT_CONFIG_NAMES) {
      const p = ctx.P.join(d, n);
      if (!(await existsCached(ctx, fs, p))) continue;
      const t = await readConfigText(ctx, fs, p);
      if (t === "too-large") return tooLarge(p);
      if (t === "unreadable") continue;
      const dirs = configLiterals(t.text).get("testDir");
      out.push(dirs === undefined ? d : dirs.length > 0 ? ctx.P.resolve(d, dirs[0]) : ctx.P.join(d, "e2e"));
    }
  }
  return out;
}
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
  const configKeys = new Set((det.configFiles ?? []).map((p) => ctx.key(p)));
  const js = det.kind === "vitest" || det.kind === "jest";
  const facts = js ? await jsConfigFacts(ctx, fs, det) : undefined;
  if (facts && isS6(facts)) return facts;
  for (const f of sorted) {
    const names = namesOf(ctx, f);
    const segs = f.rel.split("/");
    // QA-1.3-29: a setup file by name (not a test file), a bare setup.* in a test directory, or a
    // file the vitest/jest config names as a setup file.
    const setup =
      js &&
      ((!isJsTestPath(f.rel) && (names.some((b) => SETUP_FILE_RE.test(b)) || (names.some((b) => SETUP_BARE_RE.test(b)) && segs.slice(0, -1).some((s) => SETUP_DIR_RE.test(s))))) ||
        (facts !== undefined && isReferencedSetup(ctx, facts, f.abs)));
    const reqDir = det.kind === "pytest" && PY_REQ_DIR_FILE_RE.test(segs[segs.length - 1]) && segs.slice(0, -1).some((s) => ctx.key(s) === "requirements");
    if (setup || reqDir || names.some((b) => TRIGGERS[det.kind].test(b)) || ctx.key(f.abs) === sourcePj || configKeys.has(ctx.key(f.abs))) {
      return s6("config-changed", `config file changed: ${f.rel}`);
    }
  }
  return classify(ctx, input, det, sorted, notes, search, facts);
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
      const lexical = ctx.P.resolve(cwd, lexicalSpelling(ctx, cand));
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
  facts: JsConfigFacts | undefined,
): Promise<ScopingPlan | StaticScoping> {
  const P = ctx.P;
  const fs = input.fs;
  const gitRoot = det.gitRoot;
  // G.8a (QA-1.3-37): a changed test file in a Playwright testDir that the runner's own config
  // statically excludes is not an input: the runner would never run it.
  let pw: string[] | undefined;
  const playwrightOnly = async (abs: string): Promise<boolean | Unverifiable> => {
    if (!facts || facts.excludes.length === 0 || !excludedByRunner(ctx, facts, det.kind, abs)) return false;
    if (pw === undefined) {
      const dirs = await playwrightDirs(ctx, fs, det);
      if (isS6(dirs)) return dirs;
      pw = dirs;
    }
    return pw.some((d) => isInside(ctx, d, abs));
  };
  // G.8: classification.
  const inputs = new Map<string, string>();
  const addInput = (abs: string) => inputs.set(ctx.key(abs), abs);
  const goneSources: FileRef[] = [];
  const modules: FileRef[] = [];
  const goneModules: FileRef[] = [];
  let skipped = 0;
  const inScope = (abs: string) =>
    isInside(ctx, det.runnerCwd, abs) && (det.pathScopes.length === 0 || det.pathScopes.some((s) => isInside(ctx, s, abs)));
  const pyFiles = det.pythonFiles ?? DEFAULT_PYTHON_FILES;

  for (const f of sorted) {
    const base = P.basename(f.abs);
    const nonInput = NON_INPUT_EXT_RE.test(base) || NON_INPUT_NAMES.has(base) || f.rel.split("/").includes(".github");
    if (nonInput || (det.kind === "pytest" && !base.endsWith(".py"))) {
      skipped++;
      continue;
    }
    const exists = await fs.fileExists(f.abs);
    if (det.kind === "pytest") {
      const isTest = isPyTestFile(ctx, pyFiles, f.abs);
      if (exists && isTest) {
        if (inScope(f.abs)) addInput(f.abs);
      } else if (exists) modules.push(f);
      else if (isTest) notes.push(`deleted test file not run: ${f.rel}`);
      else goneModules.push(f);
    } else {
      const isTest = JS_TEST_RE.test(base) || f.rel.split("/").includes("__tests__");
      const e2e = exists && isTest ? await playwrightOnly(f.abs) : false;
      if (typeof e2e === "object") return e2e;
      if (e2e) notes.push(`playwright test file excluded by the ${det.kind} config, not run: ${f.rel}`);
      else if (exists) addInput(f.abs);
      else if (isTest) notes.push(`deleted test file not run: ${f.rel}`);
      else goneSources.push(f);
    }
  }
  if (skipped > 0) notes.push(`non-input files skipped: ${skipped}`);

  const pending = det.kind === "pytest" ? modules.length + goneModules.length : goneSources.length;
  const emptyNote = det.kind === "pytest" && modules.length + goneModules.length > 0 ? NOTE_NO_PY_MAP : NOTE_NO_INPUT;
  // G.9a (QA-1.3-26): the searches are sequential processes (a git grep costs ~0.3 s in a large
  // repo), so their number is bounded. Decided before any search, so static scoping agrees.
  if (pending > SEARCH_LIMIT) {
    return s6("too-many-searches", `too many changed modules to map: ${pending} test searches (limit ${SEARCH_LIMIT})`);
  }

  if (!search) {
    if (inputs.size === 0 && pending === 0) return noAffected(emptyNote);
    const pre = await preflight(ctx, det, fs);
    if (isS6(pre)) return pre;
    const staticNotes = [...notes, ...pre.notes];
    // QA-1.3-27: the spec-time pytest config lookup needs only the fs. Run it over the test inputs
    // known without a search, so 1.6 sees the S6 planScopedRun would return for them.
    if (inputs.size > 0) {
      const known = [...inputs.entries()].sort(byKey).map(([, v]) => v);
      const py = await pytestAtInputs(ctx, fs, det, known, det.runnerCwd, staticNotes);
      if (py !== undefined && isS6(py)) return py;
    }
    return { scopable: true, runner: det.kind, pendingSearches: pending, notes: staticNotes };
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
  // G.8/G.9 (QA-1.3-33): names and globs follow python_files; content hits are re-checked with it.
  const pyNames = (stem: string) => pyTestNames(pyFiles, stem);
  const pyGlobs = pyTestGlobs(pyFiles);
  const byName = async (stem: string): Promise<readonly string[] | undefined> => {
    const names = pyNames(stem);
    return names.length === 0 ? [] : search.findByName(gitRoot, names);
  };

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
    const hits = await byName(stemOf(ctx, f.abs));
    if (hits === undefined) return searchFailed(f);
    const ok = await accept(hits, true);
    if (ok.length === 0) notes.push(`no tests named for ${f.rel}`);
    for (const h of ok) addInput(h);
  }
  for (const f of goneModules) {
    const stem = stemOf(ctx, f.abs);
    const content = await search.findByContent(gitRoot, stem, pyGlobs);
    const named = await byName(stem);
    if (content === undefined || named === undefined) return searchFailed(f);
    const tests = content.filter((h) => isPyTestFile(ctx, pyFiles, h));
    if (tests.length > STEM_MATCH_LIMIT) {
      return s6("stem-too-common", `deleted source ${f.rel}: "${stem}" appears in ${tests.length} test files (limit ${STEM_MATCH_LIMIT})`);
    }
    const ok = await accept([...tests, ...named], true);
    if (ok.length === 0) return s6("deleted-no-tests", `deleted source ${f.rel}: no test file references "${stem}"`);
    for (const h of ok) addInput(h);
  }

  if (inputs.size === 0) return noAffected(emptyNote);
  const pre = await preflight(ctx, det, fs);
  if (isS6(pre)) return pre;
  const F = [...inputs.entries()].sort(byKey).map(([, v]) => v);
  const allNotes = [...notes, ...pre.notes];
  const py = await pytestAtInputs(ctx, fs, det, F, det.runnerCwd, allNotes);
  if (py !== undefined && isS6(py)) return py;
  return buildSpec(ctx, det, pre.entry, F, input.budget, input.cores, allNotes, "related", det.runnerCwd, gitRoot, !fs.realpath, py);
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
  py: PytestEvidence | undefined,
): ScopedSpec | Unverifiable {
  const C = inputCores ?? ctx.host.cores;
  const xdist = py ? py.xdist : det.xdist;
  const covInConfig = py ? py.covInConfig : det.covInConfig;
  const N = effectiveWorkers(py ? py.userWorkers : det.userWorkers, budget, C);
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
      ...E, ...K, "-q", "-p", "no:cacheprovider", `--junitxml=${R}`, "--maxfail=0",
      ...(xdist ? ["-n", String(N)] : []),
      ...(covInConfig ? ["--no-cov"] : []),
      "--", ...F,
    ];
    env.PYTEST_XDIST_AUTO_NUM_WORKERS = String(N >= 1 ? N : effectiveWorkers({ auto: true }, budget, C));
    workers = xdist ? N : null;
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
    const lexical = lexicalSpelling(ctx, f);
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
  const py = await pytestAtInputs(ctx, deps.fs, runner, F, absCwd, notes);
  if (py !== undefined && isS6(py)) return py;
  return buildSpec(ctx, runner, entry, F, budget, deps.cores, notes, "rerun", absCwd, gitRoot, !deps.fs.realpath, py);
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
  const configKeys = new Set((det.configFiles ?? []).map((p) => ctx.key(p)));
  for (const f of sorted) {
    if (namesOf(ctx, f).some((b) => ESLINT_TRIGGER_RE.test(b)) || configKeys.has(ctx.key(f.abs))) return unscoped(`eslint config changed: ${f.rel}`);
  }
  const candidates: string[] = [];
  for (const f of sorted) {
    const inScope = isInside(ctx, det.runnerCwd, f.abs) && (det.pathScopes.length === 0 || det.pathScopes.some((s) => isInside(ctx, s, f.abs)));
    if (inScope && (await fs.fileExists(f.abs))) candidates.push(f.abs);
  }
  if (candidates.length === 0) return noAffected(NOTE_NO_LINT);
  const r = await resolveEntryImpl(ctx, det, det.runnerCwd, fs);
  if (isS6(r)) return unscoped(r.reason);
  const v9 = Number.parseInt(r.entry.version ?? "", 10) >= 9;
  // K (QA-1.3-9): eslint >= 9 decides from its flat config which files it lints, and
  // --no-warn-ignored silences the rest; only older versions need the extension filter.
  const exts = lintExtensions(det.keptArgs);
  const F = v9 ? candidates : candidates.filter((f) => exts.has(P.extname(f).toLowerCase()));
  if (F.length === 0) return noAffected(NOTE_NO_LINT);
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

const ESLINT_TRIGGER_RE = new RegExp(String.raw`^(?:eslint\.config\..+|\.eslintrc|\.eslintrc\..+|\.eslintignore|package\.json|tsconfig.*\.json|${JS_DEPS})$`);
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
    const rel = relSlash(ctx, spec.cwd, s.name);
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

/**
 * QA-1.3-35: `P.relative(base, p)` with "/" separators, as readResult ids need it, without calling
 * P.relative when `p` lies plainly below `base`: the same prefix (either separator; case-insensitive
 * on win32) followed by a tail with no empty, "." or ".." segment. That tail is exactly what
 * P.relative returns there, and it avoids Bun's path.win32.relative (about 13 times slower than
 * node's: 20000 calls took 953 ms). Anything else goes through P.relative.
 */
function relSlash(ctx: Ctx, base: string, p: string): string {
  const norm = (s: string) => (ctx.win ? s.replace(/\//g, "\\") : s);
  const b = norm(base);
  const q = norm(p);
  const sep = ctx.win ? "\\" : "/";
  const head = b.endsWith(sep) ? b : b + sep;
  if (q.length > head.length && ctx.key(q.slice(0, head.length)) === ctx.key(head)) {
    const tail = q.slice(head.length);
    if (tail.split(sep).every((s) => s !== "" && s !== "." && s !== "..")) return tail.replace(/\\/g, "/");
  }
  return ctx.P.relative(base, p).replace(/\\/g, "/");
}

/** A test path by the G.8 JS rule: a .test/.spec file or a file under __tests__. */
function isJsTestPath(p: string): boolean {
  return JS_TEST_RE.test(p.split(/[\\/]/).pop() ?? "") || p.split(/[\\/]/).includes("__tests__");
}

/**
 * I step 2a (QA-1.3-1, QA-1.3-19): a report that lists no test at all is not trusted when the
 * inputs say tests must have run, for every runner: a rerun, inputs that are test files (pytest,
 * or a JS test file given to related), and any spec planned without realpath (jest and vitest
 * both match nothing through a junction cwd).
 */
function zeroTestsGuard(spec: ScopedSpec, r: RunResult): RunResult {
  if (r.total !== 0 || !r.complete || r.failingIds.length > 0 || r.collectionError || spec.inputs.length === 0) return r;
  const note =
    spec.mode === "rerun"
      ? "rerun ran no tests although every input is a test file"
      : spec.inputsAreTests || spec.inputs.some(isJsTestPath)
        ? `${spec.runner} ran no tests although a test file was passed`
        : spec.lexicalPaths === true
          ? `${spec.runner} ran no tests and the paths were not canonicalized (no realpath seam)`
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

/**
 * I step 3: pytest junit XML, parsed without an XML library. undefined = unusable (truncated or
 * malformed). QA-1.3-25: linear in the report and the inputs. Each dotted suffix of each input is
 * put in a map once (the first input wins a shared suffix), a classname walks its own dot
 * prefixes from the longest, and testcases are found with indexOf, never a backtracking regex.
 */
function parseJunit(ctx: Ctx, spec: ScopedSpec, text: string, code: number): RunResult | undefined {
  if (!text.includes("</testsuites>")) return undefined;
  const suffixes = new Map<string, string>();
  for (const f of spec.inputs) {
    const segs = relSlash(ctx, spec.gitRoot, f).replace(/\.py$/, "").split("/");
    for (let i = 0; i < segs.length; i++) {
      const d = segs.slice(i).join(".");
      if (!suffixes.has(d)) suffixes.set(d, f);
    }
  }
  const map = (dotted: string): { file: string; rest: string[] } | undefined => {
    for (let d = dotted; ; ) {
      const file = suffixes.get(d);
      if (file !== undefined) return { file, rest: dotted.slice(d.length + 1).split(".").filter(Boolean) };
      const dot = d.lastIndexOf(".");
      if (dot < 0) return undefined;
      d = d.slice(0, dot);
    }
  };
  // QA-1.3-35: at most one relativisation per input file, however many cases fail in it.
  const rels = new Map<string, string>();
  const relOf = (f: string) => {
    let r = rels.get(f);
    if (r === undefined) {
      r = relSlash(ctx, spec.cwd, f);
      rels.set(f, r);
    }
    return r;
  };
  const ids = new Set<string>();
  const files = new Set<string>();
  let collectionError = false;
  let total = 0;
  let unmapped: string | undefined;
  const cases = junitCases(text);
  if (!cases) return undefined;
  for (const c of cases) {
    const body = c.body;
    // QA-1.3-22: only the collection-failure <error> marks a collection case. pytest also writes
    // classname="" for a test outside its rootdir (-c elsewhere, --rootdir), which is a real test.
    const collection = /<error\b[^>]*\bmessage="collection failure"/.test(body);
    // QA-1.3-35: a passing case only counts; its attributes are never decoded.
    if (!collection) {
      total++;
      if (!/<(?:failure|error)\b/.test(body)) continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of c.attrs.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = decodeXml(a[2]);
    const classname = attrs.classname ?? "";
    const name = attrs.name ?? "";
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
    const hit = map(classname);
    if (hit) {
      ids.add(`${relOf(hit.file)}::${[...hit.rest, name].join("::")}`);
      files.add(hit.file);
    } else {
      ids.add(`${classname}::${name}`);
      unmapped ??= classname === "" ? `"" (${name})` : classname;
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

/**
 * QA-1.3-25: the <testcase> elements of a junit report, in one forward pass. A non-self-closing
 * testcase whose `</testcase>` is missing, or that contains another `<testcase`, makes the report
 * malformed (undefined), never a silently skipped case: pytest writes neither, a test that
 * rewrites its own report can. Attributes are assumed to hold no literal ">" (pytest escapes it).
 */
function junitCases(text: string): { attrs: string; body: string }[] | undefined {
  const out: { attrs: string; body: string }[] = [];
  let pos = 0;
  for (;;) {
    const start = text.indexOf("<testcase", pos);
    if (start < 0) return out;
    pos = start + 9;
    if (!/^[\s/>]/.test(text.slice(pos, pos + 1))) continue;
    const tagEnd = text.indexOf(">", pos);
    if (tagEnd < 0) return undefined;
    if (text[tagEnd - 1] === "/") {
      out.push({ attrs: text.slice(pos, tagEnd - 1), body: "" });
      pos = tagEnd + 1;
      continue;
    }
    // Each search starts after the previous case's end tag, so the whole pass stays linear.
    const close = text.indexOf("</testcase>", tagEnd);
    if (close < 0) return undefined;
    const body = text.slice(tagEnd + 1, close);
    if (body.includes("<testcase")) return undefined;
    out.push({ attrs: text.slice(pos, tagEnd), body });
    pos = close + 11;
  }
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
