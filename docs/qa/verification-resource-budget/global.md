# Phase 3.2 — Global adversarial QA review (round 1)

**Status: NOT CLEAN** — 2 major, 4 minor, 3 nit (QA-G-1 … QA-G-9). No false pass was constructed.

## Scope and method

- **Change under review.** `git diff origin/master...vrb/wave-3` (origin/master `60c2de3` v1.14.0, vrb/wave-3 `3939c08`),
  checked against plan §1.2, §1.5 and G1–G8 (§4.1). The repros ran in the `vrb/p32` worktree at `3939c08`
  plus the parallel KNOWN fixes up to `4a2fddb`. Their `src/` delta is the QA-3.1-24 lane detach
  (`wiring.ts createSharedFlight`), the removed unused import (QA-1.2-12), the QA-2.3-18 protocol line
  and the QA-3.1-27 tool label. It touches none of the code sites named in the findings below.
- **Environment.** Windows 11, 16 cores, Bun 1.3.14 (opencode's runtime), Node v24.21.0, git 2.51, uv 0.11.7.
- **Harness.** The real plugin factory and the real verification wiring, with only the opencode host faked:
  `test/integration/e2e/harness.ts` (`createE2EPlugin`) and `test/integration/e2e/fixture-repo.ts`
  (`prepareFixtureRepo`, real `npm ci` / `uv sync`, runner probe logs).
  - vitest 4.1.11, jest 30.5.2 and pytest run for real, as do the reference worktrees and the slot.
  - The harness sets `MODEL_ROUTER_ENFORCE=1` ("enforced"). The shipped default is `mode: "advisory"`
    (`tiers.json`). The verification path is identical for both: `shouldVerifyTask` (dispatch.ts:580)
    and the `router_verify` registration (index.ts) only test `mode !== "off"`.
  - `verify: {}` means the §1.4 defaults, unless a repro states otherwise.
- **Scratch drivers.** They live in `%TEMP%\omr-g32\` and are not committed:
  - `drive-a.ts` … `drive-g2.ts`, `e1.mjs`, `hold.ts`, `tree-abort.ts`, run with `bun <file>`;
  - `node\repro.g32.test.ts`, run under Node with `npx vitest run --config %TEMP%\omr-g32\vitest.g32.config.mjs --root D:\git\omr-p32`.
  - Drivers D/E/F/G ran with `TEMP`/`TMP` pointed at a private scratch dir, so the machine-wide slot dir and
    the reference dirs were private to the run.
  - The probe (QA-3.1-9) logs one line per runner main process, with its argv. It is the evidence for
    "a process was, or was not, spawned".
- **Baselines.**
  - `bun test/smoke/bun-runtime.smoke.ts`: `OK: 12 passed, 0 failed, 0 skipped`.
  - `RUN_VERIFY_E2E=1 npx vitest run --maxWorkers=1` on the three files `test/integration/verify-resource-budget{,.deferred,.bound}.test.ts`:
    `Test Files 3 passed (3)`, `Tests 52 passed (52)`, 252 s.
  - `npx vitest run test/unit/config-verify-budget.test.ts test/unit/directives.test.ts test/unit/protocol-directives.test.ts`:
    `Tests 111 passed (111)`.
- **Hygiene.** At the end, `Get-CimInstance Win32_Process` matched nothing for the scratch paths, `omr-ref-`,
  `setInterval`, `sleep 3` or `hold.ts`. Every driver killed its own leftover PIDs. Scratch dirs were removed
  with links unlinked first.

KNOWN items (being fixed in parallel, or pending an owner decision) are not re-reported. None was observed to be
worse than described. Owner-decision recommendations are in the last section.

---

## Attempt 1 — construct a false pass

**Method.** Introduce a real failing test through every change shape and path named in the mandate, then read
the verdict. A pass on an introduced failure would be critical.

| # | Vector | Repro | Verbatim evidence (trimmed) | Outcome |
|---|---|---|---|---|
| 1a | vitest, deferred → `router_verify` | drive-a A1–A5: default dispatch breaks `src/m01.js`; `router_verify` from `orch` | A1 footer `[router] unverified · vrf_1322… · risk low (1-5 files changed)`, probes `[]`; A5 `fail … introduced failures: test/m01-1.test.js > m01 (1) > double doubles the value, …`; probe argv `["related","…\\src\\m01.js","--run","--passWithNoTests","--maxWorkers=2",…]` then the reference run `["run","…omr-ref-50924-…\\test\\m01-1.test.js",…]`; replay `fail (cached verdict; nothing was run)`, probes `[]` | defence holds |
| 1b | vitest, required | drive-a A10; drive-d D1 | `testsPass: introduced failures: test/m19-2.test.js > m19 (2) > combined uses m09` | defence holds |
| 1c | jest | drive-g G1 (break `a01`); G2 (pre-existing fixture failure + the producer also edits that test file + breaks `a02`) | G1 `introduced failures: test/a01-1.test.js > a01 (1) > multiplies by 1, …`; G2 `introduced failures: test/a02-1.test.js > a02 (1) > multiplies by 2, test/a04-2.test.js > a04 (2) > chains through a02; observed failures: …, test/preexisting.test.js > preexisting failure > asserts something false` | defence holds (only the introduced ids are named) |
| 1d | pytest | drive-g G3 (break `mod01`) | `[router ✓ accepted: deterministic] Verification caveats — NOT verified …: testsPass: cannot attribute failures: reference unusable (runner-unsupported): pytest cannot be pinned to the reference …` | unverifiable, never a pass (accepted residual) |
| 1e | batch windows + concurrent dispatches | drive-d D2: two deferred delegations (break m02, m03), then `router_verify(pending)` racing a required gate that breaks m04, max 1 slot | gate: `introduced failures: test/m04-1… test/m08-3…; observed failures: …, test/m04-2.test.js > m04 (2) > combined uses m02, …`. The m02 failure, introduced by an earlier deferred delegation, is observed but correctly **not** blamed on D2c (it fails at D2c's reference). | defence holds |
| 1f | shared snapshot flight / concurrent in one tree | drive-b B6: two required dispatches with `VERIFY_WAIT:0s`, started together under a slow git; only one edits (breaks m07) | both: `testsPass: scoping impossible (attribution-unavailable) … the dispatch-time change baseline was discarded: tool "edit" ran in an overlapping directory before it resolved` | unverifiable, never a pass |
| 1g | unknown tool / write during an in-flight capture | drive-b B5 (`VERIFY:required VERIFY_WAIT:0s`, edit + break m06 while the capture runs) | same caveat as 1f; probes `[]` | unverifiable, never a pass |
| 1h | commits since dispatch, no tool event | drive-g2 G4: shell edit of m03 + `git commit`, no edit event | `introduced failures: test/m03-1.test.js > m03 (1) > double doubles the value, …` | defence holds |
| 1i | rename, no tool event | drive-g2 G5: `git mv src/m06.js src/lib/m06.js`, tests not updated | `introduced failures: test/m06-1.test.js, test/m13-2.test.js` (collection errors, bare-file ids) | defence holds |
| 1j | delete a module and its only test | drive-g2 G8 | `testsPass: scoping impossible (deleted-no-tests): deleted source src/m18.js: no test file references "m18"` | unverifiable, never a pass |
| 1k | 8.3 paths | drive-a ran with plugin dir `C:\Users\MARQUI~1\…` (A5 verdict above); drive-g2 G6: plugin dir 8.3, edit path long form | G6 `introduced failures: test/m08-1.test.js > m08 (1) > double doubles the value, …` | defence holds |
| 1l | background | drive-g G7 (`background: true`, break m09) | `[router] Background verification found introduced failures: - vrf_62da… · the work · failing: test/m09-1.test.js > …`; second system transform: no notice (`delivered once: true`) | defence holds |
| 1m | drift | e2e `3.1.2.g: an edit after the producer returned is reported as drift, not a pass` (in the 52/52 run) | — | defence holds |
| 1n | lineage | code read: a `router_verify` fail records a rejection (pending.ts:1129), as a required gate does (wiring.ts:1607) | — | defence holds (not re-executed) |
| 1o | reference fidelity (ignored inputs at the reference) | code read: any non-inert `unreproduced` entry → unusable `unreproduced-inputs` (deterministic.ts:1063-1067) | — | defence holds |

**Outcome: failed. No false pass was constructed.** The import-graph blind spot (a fixture read from disk, a
computed import) passes as "no affected tests". It is an accepted design residual (plan §5; ADR 0003
"Consequences", line 115). It is not re-reported, apart from its documentation gap (QA-G-7).

## Attempt 2 — construct a command injection

**Method.** Put shell metacharacters where the router builds an argv or tests an allowlist: file names, script
names, the new `uv run pytest` / `pytest` allowlist entries, and a bare CR. Run under Bun.

- **File names → argv (drive-f F1).** New test `test/a&mkdir PWNED1&b.test.js`. The runner argv received it as
  one literal: `["related","C:\\…\\test\\a&mkdir PWNED1&b.test.js"]`. `PWNED1 created: []`. Clean pass.
- **Composite `scripts.test` (F2).** `"test": "vitest run & mkdir PWNED2"` →
  `testsPass: scoping impossible (composite): composite scripts.test: "&"`. Runner argv `[]`, `PWNED2 created: []`.
- **`git grep` stem.** Code read: the stem is passed after `-e` (wiring.ts:1103), so a stem such as
  `-Ocalc` is never parsed as an option.
- **Allowlist (`isCommandAllowed`).**
  - Accepted: `uv run pytest`, `uv run pytest -q tests`, `uv run  pytest`, `uv.exe run pytest`.
  - Refused: `uv run python -c 1`, `uv run --with x pytest`, `uv tool run pytest`, `uvx pytest`.
  - Refused by `FORBIDDEN_SHELL`: `uv run pytest ^& calc`.
  - `npm test\rcalc` and `uv run pytest\rcalc` pass both tests. A bare CR is not a separator for cmd.exe:
    `spawnSync('echo a\rmkdir PWNEDCR', {shell:true})` printed `"amkdir PWNEDCR\r\n"` under Node and Bun, and no
    directory was created.
- **`.cmd` / `.bat`.** The Bun smoke: `PASS exec: runArgv refuses a .cmd target and it does not run`.
  JS runners resolve to a real `node.exe`, never bun (`PASS runner: planScopedRun's spec runs node, not bun`).
- **Pre-existing, unchanged.** `FORBIDDEN_SHELL` is not changed by this diff. `npx`/`node` in the allowlist
  already run arbitrary code (the allowlist is not a sandbox), and so does the producer's test code.

**Outcome: failed (defence holds).**

## Attempt 3 — make cleanup delete real data

**Method.** Attack the fs primitives the cleanup relies on, under both runtimes. Then make the reference run
itself create links to real data inside the worktree.

- **E1 (`e1.mjs`, Bun and Node).** A junction `victim\deep\link` → `real` (holding `SENTINEL`), then
  `fs.promises.rm(victim, {recursive:true, force:true, maxRetries:0})`:
  - `bun 1.3.14 lstat(junction).isSymbolicLink() = true isDirectory() = false`
  - `bun 1.3.14 after fs.promises.rm(victim, recursive): victim exists = false | SENTINEL survives = true`
  - `node 24.21.0 lstat(junction).isSymbolicLink() = true isDirectory() = false`
  - `node 24.21.0 … SENTINEL survives = true`
- **E2 (`drive-e2.ts`, Bun).** A committed test creates `coverage/live` → **the live repo** and `coverage/data`
  → a sentinel dir, from its `process.cwd()`. `coverage/` is ignored and inert, so the recheck runs. The
  producer breaks m01, so the test also runs inside the reference worktree. Runner cwds:
  `[…\vitest-app-5e5ffb9f, …\omr-ref-3608-c816b748170123d7]`.
  - After cleanup: `SENTINEL survives: true`, `live src files after: 20` (before: 20),
    `live node_modules sentinel survives: true`, `live package.json survives: true`.
  - The `omr-ref-3608-…` dir was still present right after the gate returned, because removal is
    asynchronous. It was gone before the plugin's dispose finished; the tmp dir held no `omr-ref-*`.
- **drive-d end state.** `sentinel exists: true`, `omr-ref dirs left in tmpdir: []`, `slot dir entries: []`.
  The Bun smoke: `PASS reference: dispose keeps the real node_modules and leaves no omr-ref dir`.
- **GC scope.** Code read, reference.ts:1958-2056: only this repo's registered `omr-ref-*` worktrees and
  orphans that point at this repo are candidates. Every removal goes through the same
  `removeReferenceDir` (unlink links, sweep, guarded `fs.rm`).

**Outcome: failed (defence holds).** E1 also closes the "Bun unverified" note in reference.ts:686-693 (QA-G-8).

## Attempt 4 — deadlock the slot

**Method.** Nest acquisitions inside one gate, overlap a batch with a gate, and use a second process that
crashes or hangs while holding the only slot. drive-d used `maxConcurrentVerifications: 1`,
`slotWaitMs: 20000` and a private slot dir.

- **D1: one gate, four command checks** (`testsPass` with a failure + recheck, `buildPasses`, `run npm test`,
  `lintClean`). It finished in `12985` ms with the correct `NOT ACCEPTED` verdict. Probes:
  `["main:related(8)","main:run(9)","main:run(1)"]`. A nested acquisition would have read "slot busy" after 20 s.
- **D2: batch + foreground.** `router_verify(pending)` over 2 handles, racing a required gate: `21645` ms, all
  verdicts correct.
- **D3: crash.** A holder process (`hold.ts`, prints `HELD …\verify-slots`) was killed with `taskkill /F`.
  The next required gate got the slot and finished in `5078` ms.
- **D3: hung live holder.** `20844` ms, then
  `[router ✓ accepted: deterministic] … verification slot busy (waited 20009ms)`. It is bounded, not deadlocked.
- **Two instances in two processes.** e2e `3.1.2.c: two plugin instances in two processes share the
  machine-wide bound` (in the 52/52 run); the Bun smoke `PASS slot: max 1 across two Bun processes`.

**Outcome: failed (defence holds).**

## Attempt 5 — run a full suite with the default config

**Method.** Look for any path where the default config runs the whole test set. That covers commands the router
builds itself (G1), and the deferred default itself.

- **A8 (Bun) / N-A8 (Node): SUCCEEDED.** A default (deferred) dispatch whose DoD is
  `check: testsPass command="npm test"` + `check: run command="npm test"`, and whose producer changed nothing,
  ran the **full** `vitest run` synchronously in the after hook:
  - probe `[{"kind":"main",…,"argv":["run"]}]`, `afterMs: 3640` (Node `3512`);
  - output `[router ✓ accepted: deterministic] Verification notes: - no changed files, no affected tests`.
  - The command is the orchestrator's own `run`, which G1 permits for a *gated* delegation. But this one was
    deferred: see QA-G-1.
- **C1 (Bun) / N-C1 (Node): SUCCEEDED.** `VERIFY:required`, pytest-app, the producer adds a new module
  `app/app.py` that **no test imports**. The router-built pytest command received **all 21 collected test
  files** (`test_mod01_1.py` … `test_mod10_3.py`; Node `[21]`). → QA-G-2.
- **C2 (Bun).** A new module named `app/mod0[1-2]_[1-3].py` was mapped to
  `["test_mod01_1.py","test_mod01_2.py","test_mod01_3.py","test_mod02_1.py"]` through an unescaped pathspec glob.
  On POSIX, `app/*.py` would name every test (code read). → QA-G-3.
- **Defences that held.**
  - The router never ran a test command at dispatch (A1, B1–B3 probes `[]`).
  - Scoped runs are `related <files>` / `run <failing files>` (A5, A6, A10, D1, D2 argv).
  - A composite script is S6 (F2).

**Outcome: succeeded** → QA-G-1 (major), QA-G-2 (major), QA-G-3 (minor).

## Attempt 6 — make a deferred delegation spawn a verification process, or be labelled verified, with the default config

**Method.** Default config, native `task` path, probe log and after-hook timing.

- **Defences that held.**
  - A1: deferred, footer `[router] unverified · vrf_… · risk low`, probes `[]`, `afterMs: 472`.
  - B1–B3 (slow git): probes `[]`, footer `unverified · … · risk high (changed files could not be attributed)`.
  - e2e `3.1.2.f: 20 parallel deferred delegations spawn no runner and take no slot` and
    `3.1.2.h (background: false): 3 s later still no runner` (52/52).
- **A7 (Bun) / N-A7 (Node): SUCCEEDED.** DoD `testsPass` + `buildPasses command="npm run build"`, default mode,
  producer changed nothing:
  - probe `[{"kind":"build",…}]` (the build ran), `afterMs: 1169`;
  - output `[router ✓ accepted: deterministic]`.
  - This contradicts the protocol text the orchestrator receives: *"a DoD containing testsPass defers by default
    as a whole (its build, lint, run and criteria checks too)"*.
- **A8: SUCCEEDED** (full suite, see Attempt 5).
  - Root cause: `finishDeferred` returns `{ deferred: false, reason: "no-change" }` (wiring.ts:1502). The
    native path then runs "today's required gate" (index.ts:1304-1310), over the **whole** DoD.
  - The fallback itself is listed in CONFIG_REFERENCE "Which delegations defer" since `a1c3256`. Its
    consequences are not: the build or the full suite runs synchronously, and the result is labelled
    "✓ accepted".
  - The `delegate` tool has the same fall-through (index.ts:685-707, code read), where a failure also
    enters the escalation ladder.
- **A9: documented behaviour, contradicts G7.** A DoD with `buildPasses` only (no `testsPass`) is gated
  synchronously by default: probe `[{"kind":"build",…}]`, `afterMs: 833`. → QA-G-4.

**Outcome: succeeded** → QA-G-1 (major), QA-G-4 (minor).

## Attempt 7 — make a subagent choose its own verification mode, or read another session's handles

**Method.** Direct calls from the wrong session, and a subagent dispatching its own work with `VERIFY:deferred`.

- **A3.** `router_verify({handles:[vrf_…]})` from `orch2` → `- vrf_1322… · unknown handle`.
- **A4.** The same from the producer's child session `child-c1` → `unknown handle`.
  `pending: true` from `child-c1` → `no unverified delegations in this session; nothing was run`.
  Probes `[]` for A3/A4.
- **A2.** The pending list appears in `orch`'s system prompt only (`- vrf_1322… · risk low · the work`). None in `orch2`.
- **A6.** Subagent `child-c1` (parent `orch`) dispatches `VERIFY:deferred` + testsPass + breaks m02. It got the
  **required** gate (`afterMs: 7499`, `[router ⚠ NOT ACCEPTED] … introduced failures: test/m02-1.test.js …`,
  no footer, no handle).
- **Code read.** Directives come only from the orchestrator-authored `prompt`/`description`
  (`dispatchDirectiveText`, wiring.ts:419). Forcing notes and footers neutralize directive colons (QA-2.4-6).

**Outcome: failed (defence holds).**

## Attempt 8 — make the dispatch wait longer than `VERIFY_WAIT`

**Method.** Make every index-reading git call slow with a repo `core.fsmonitor` hook `sleep 3; false`. With it,
`git status` took `6216` ms. Then time the before hook (drive-b).

| directive | before hook (ms) | deferred after hook (ms) |
|---|---|---|
| `VERIFY_WAIT:1s` | 1010 | 2019 |
| `VERIFY_WAIT:0s` | 23 | 2005 |
| none (default 5 s) | 5004 | 2008 |

The after hook stays inside `DEFERRED_FINISH_MS` (2 s), an accepted residual. e2e
`3.1.2.g: VERIFY_WAIT:0s returns from the before hook quickly` passes.

**Outcome: failed (defence holds).**

## Attempt 9 — leave an orphan process

**Method.** Leave descendants behind at budget expiry, after a normal exit, and from the router's own git calls.

- **D4b: expiry.** `gateBudgetMs: 12000`, a test that hangs with one child and one `detached: true` grandchild.
  - Gate returned in `12411` ms: `[router ✓ accepted: none] … verification gate timed out after 12000ms`.
  - 3 s later: `[{"p":61108,"alive":false},{"p":51784,"alive":false},{"p":46476,"alive":false}]`
    (worker, child, detached grandchild).
  - e2e `3.1.2.d: a gate that hits its budget returns on time and leaves no orphan` passes.
  - **Defence holds.**
- **D4a (Bun) / N-D4a (Node): SUCCEEDED.** A *passing* test spawns
  `spawn(process.execPath, ["-e","setInterval(()=>{},1000)"], {detached:true, stdio:"ignore"}).unref()`.
  The required gate passes (no router text), and 5 s later:
  `{"pid":33016,"alive":true}` (Node `{"pid":39308,"alive":true}`). → QA-G-5.
- **tree-abort (Bun): SUCCEEDED.** `snapshotTree` on a repo with the fsmonitor hook, aborted at 500 ms:
  `snapshot settled after 516 ms: undefined`. Then `Win32_Process` showed
  `sh.exe "C:/Program Files/Git/usr/bin/sh.exe" -c "sleep 3; false \"$@\"" …` still running, parent `51816`
  being the killed git. → QA-G-6.

**Outcome: succeeded** → QA-G-5 (minor), QA-G-6 (minor).

---

## G1–G8 verdicts

| G | Verdict | Evidence |
|---|---|---|
| G1 No suite per delegation | **NOT MET** | Held: no test at dispatch (A1, B1–B3 probes `[]`, 3.1.2.f); scoped argv (A5/A6/A10/D1/D2); composite → S6 (F2). Broken: QA-G-2 (C1, all 21 test files for a module no test imports), QA-G-3 (C2). |
| G2 Guardrail when verification runs | **MET** | Attempt 1 table: introduced failures named (1a–1c, 1e, 1h, 1i, 1k, 1l). Pre-existing failures not blamed (1c G2, 1e D2c). Anything unprovable is unverifiable (1d, 1f, 1g, 1j). No false pass. |
| G3 Bounded CPU/RAM | **MET, with caveat** | Runner workers are serialized under the slot (D1–D3, 3.1.2.b/c, Bun smoke slot checks), `--maxWorkers=2` in every argv. Caveat: descendants left by a normal exit keep running outside the slot (QA-G-5). |
| G4 Nothing outlives its budget | **MET for runner trees, with caveat** | D4b (all dead within 3 s), 3.1.2.d. Caveat: the snapshot's git descendants survive an abort (QA-G-6). |
| G5 Safe cleanup | **MET** | E1 (Bun + Node primitives), E2 (junctions to the live repo inside the reference worktree), drive-d end state, Bun smoke (d). |
| G6 Compatibility | **MET except the CodeQL clause** | 111/111 config/directive/protocol unit tests; 52/52 e2e. CI matrix not re-run here. `.github/workflows` = publish, smoke-keyless, smoke-upstream, smoke, test: no CodeQL (KNOWN QA-3.1-23, owner decision). |
| G7 Speed first, zero idle cost | **NOT MET** | Held: `VERIFY_WAIT` bound (Attempt 8); no spawn for deferred delegations that changed files (A1, 3.1.2.f/h); after hook ≤ ~2 s (accepted residual). Broken: QA-G-1 (A7/A8, a deferred delegation spawns a build or the full suite and is labelled "✓ accepted"); QA-G-4 (A9, non-testsPass DoDs gate synchronously by default). |
| G8 Orchestrator in control and informed | **MET** | A2–A6: risk + handle on every deferred result, pending list per session, handles unreadable from other or child sessions, a subagent's `VERIFY:deferred` ignored. |

## Findings

| ID | Severity | Evidence | Fix |
|---|---|---|---|
| QA-G-1 | **major** | **A deferred (default) delegation whose producer changed nothing runs its whole DoD synchronously.** A7/N-A7: `testsPass` + `buildPasses` → probe `{"kind":"build"}`, `[router ✓ accepted: deterministic]`. A8/N-A8: `testsPass` + `run command="npm test"` → probe `argv ["run"]` (the full vitest suite), `afterMs` 3640/3512 ms, `✓ accepted`. Cause: `finishDeferred` returns `{deferred:false, reason:"no-change"}` (wiring.ts:1499-1503, QA-2.4-10). The caller then runs "today's required gate" (index.ts:1304-1310 native; index.ts:685-707 `delegate`, code read, where a failing check also escalates). QA-2.4-10 assumed that gate "runs no process". That holds only for a testsPass-only DoD. Since `a1c3256`, CONFIG_REFERENCE "Which delegations defer" lists "the producer changed files" as a condition. It does not say that the fallback then runs the build or `run` checks (a full suite here) synchronously, or labels the result "✓ accepted". The model-facing protocol line ("a DoD containing testsPass defers by default as a whole (its build, lint, run and criteria checks too)"), VERIFICATION.md:190, §1.5-16 and G7 still promise the opposite. | In `finishDeferred`, take the no-change shortcut only when every check of the DoD is `testsPass` (nothing else can spawn or grade). Otherwise register the delegation as deferred with the empty, attributed change set (risk low), so `router_verify` runs the rest on demand. Add wiring tests on both paths (native `task` and `delegate`): testsPass+buildPasses and testsPass+run with no change → footer present, no process spawned (probe/argv seam), never labelled accepted. |
| QA-G-2 | **major** | **pytest scoping maps a module no test imports to the full test set (G1).** C1/N-C1: new module `app/app.py` in pytest-app → the router-built pytest argv held all 21 collected test files. Stem `app` is a whole word in every `from app.modNN import …`. The existing-module branch (runner.ts:4411-4426) has no `STEM_MATCH_LIMIT`, unlike JS gone sources (runner.ts:4402) and pytest gone modules (runner.ts:4433). A module named like its package (`app/app.py`, `pkg/pkg.py`) is a common layout, so this is not adversarial. | Match import-shaped occurrences of the module's dotted path instead of the bare stem: `import <pkg>.<stem>`, `from <pkg>.<stem> import`, `from <pkg> import … <stem>`, `from .<stem> import`, `from . import <stem>`. Keep failing closed (unmatched → S6 `unmapped-module`), and apply `STEM_MATCH_LIMIT` to the hits (→ S6 `stem-too-common`). Add C1 as a fixture test. |
| QA-G-3 | minor | **Unescaped stems in `:(glob)` pathspecs.** C2: `app/mod0[1-2]_[1-3].py` → `findByName` (wiring.ts:1098, names from runner.ts:3760-3766) matched `test_mod01_1.py`, `test_mod01_2.py`, `test_mod01_3.py`, `test_mod02_1.py`, all unrelated. On POSIX, a module `app/*.py` yields `test_*.py` = every test (code read; `*` is illegal on NTFS). Over-inclusion only, never a miss. | Escape `*`, `?`, `[`, `]` and `\` in the stem before building glob pathspecs, or treat such a stem as S6. |
| QA-G-4 | minor | **G7 and §1.5-15 vs non-testsPass DoDs.** A9: `buildPasses` only, default config → build spawned synchronously (`afterMs` 833). This is documented (protocol: "Required-mode delegations and DoDs without testsPass are gated before return"; VERIFICATION.md:190). But plan G7 says no verification process is spawned without `VERIFY:required`, `router_verify` or `background`. §1.5-15 says an explicit acceptance block "does not imply required". | Owner decision. Recommended: amend G7 (and §1.5-15) to state the exception explicitly, as G1 does for `run`: DoDs without `testsPass` keep the synchronous gate. The alternative is to defer every DoD with a command check. |
| QA-G-5 | minor | **Descendants left running by a normal exit are never swept.** D4a/N-D4a: a passing test's detached grandchild is alive 5 s after the gate returned (pid 33016 Bun, 39308 Node). exec.ts:356-363 settles on `close` without a sweep. The Windows sweeper is only armed while pipes stay open after exit (exec.ts:343-353). The leftover runs outside the slot, so G3's machine-wide bound does not count it, and repeated verifications accumulate them. G4 covers only expiry. | Windows: run the existing sweep after every verification run's exit (at least for runs under the slot), or put the child in a Job Object with KILL_ON_JOB_CLOSE. POSIX: signal the process group after exit, as the kill path already does. At minimum, document it next to the other orphan limits (VERIFICATION.md "Windows limits", ADR 0003). |
| QA-G-6 | minor | **`snapshotTree`'s git bypasses the tree kill.** tree.ts:45-51 `execGit` uses `execFile({signal, timeout})`, which ends git.exe only. tree-abort repro: aborted at 500 ms, settled at 516 ms, and git's `sh.exe -c "sleep 3; false …"` (parent = the killed git) was still running. The snapshot runs inside the gate deadline (`prepareVerification`) and the deferred finish, so G4's "expiry kills the whole process tree" does not hold for this step. Exposure is limited to what git spawns (fsmonitor hooks, filter processes such as git-lfs). | Route `SnapshotGit` through exec.ts `runArgv` (tree kill, sweep, low priority), as reference.ts already does, or kill the tree on abort/timeout. |
| QA-G-7 | nit | **VERIFICATION.md does not state the JS import-graph residual.** "Residual limits" (line 242) names the file-read / dynamic-import blind spot only for pytest. The verdict table says "pass … or no test is affected". The same limit for vitest/jest (`related` / `--findRelatedTests` follow static imports only) is stated only in ADR 0003 §Consequences. | Add one "Residual limits" line under "Required path" for JS runners, mirroring ADR 0003 line 115. |
| QA-G-8 | nit | **reference.ts:686-693 (OPEN RISKS) still calls Bun's junction behaviour unverified.** E1 verified it on Bun 1.3.14/win32: `lstat(junction).isSymbolicLink() = true`, and a recursive `fs.promises.rm` does not follow a junction (`SENTINEL survives = true`). E2 and the Bun smoke verify the dispose path. | Record the evidence in the comment, and keep "other Bun versions unverified". |
| QA-G-9 | nit | **The orphan sweeper inherits the host's cwd.** The e2e harness overrides `USERPROFILE`, so Windows PowerShell 5.1 (the sweeper, exec.ts:629) resolves LocalAppData to a missing dir. It then wrote `Microsoft\Windows\PowerShell\ModuleAnalysisCache` (573,626 bytes) into its cwd, the worktree root (created 01:42:01 during drive-b; not gitignored; removed by this review). opencode's cwd is the user's project, so any relative write by the sweeper lands in the project. | Spawn the sweeper with `cwd: os.tmpdir()`. Also have the e2e harness set `LOCALAPPDATA` with `USERPROFILE`. |

## Owner decisions pending (recommendations only)

- **QA-3.1-18 (a clean required PASS adds no router text).** Recommend adding a one-line
  `[router ✓ verified: testsPass — <n> affected tests passed (<runner>)]`.
  - C1, D4a and F1 return the bare `<task_result>`. That is indistinguishable from a delegation that was never
    gated (enforcement off, no DoD).
  - With QA-G-1 fixed, the orchestrator otherwise has no positive signal that verification happened.
- **QA-3.1-21 (unverifiable rendered "✓ accepted").** Recommend a distinct header such as
  `[router ⚠ accepted UNVERIFIED: <first reason>]`.
  - Every unverifiable result in this review starts with `[router ✓ accepted: …]`: B5, B6, D3 (slot busy),
    F2, G3, G8.
  - D4b even reads `[router ✓ accepted: none]` after `verification gate timed out after 12000ms`.
  - The caveat block below it is correct, but the leading check mark is what a model skims.
- **QA-3.1-23 (no CodeQL workflow).** Recommend enabling GitHub's CodeQL default setup (no workflow file to
  maintain) and confirming it reports on the release PR. G6 and the 3.1 DoD name CodeQL. Otherwise, amend G6.

## Round log

- Round 1 (this document): 9 findings open (QA-G-1 … QA-G-9). Status **NOT CLEAN**.
