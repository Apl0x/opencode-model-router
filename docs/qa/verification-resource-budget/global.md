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
- Round 2 (below): QA-G-1 … QA-G-9 and QA-3.1-18/-21/-23 resolved. 5 new findings (QA-G-10 … QA-G-14): 1 critical
  (QA-G-10, a false pass introduced by the QA-G-2 fix), 1 minor, 3 nit. Status **NOT CLEAN**.

---

# Round 2 (re-review)

**Status: NOT CLEAN** — 1 critical (QA-G-10), 1 minor (QA-G-12), 3 nit (QA-G-11, QA-G-13, QA-G-14).
All nine round-1 findings and the three owner items are resolved. The QA-G-2 fix introduces a
**false pass**: a pytest test that imports the changed module in a common wrapped-import layout is
not selected, and the result reads `[router ✓ verified: deterministic]`. It was reproduced end to
end under Node and Bun.

## Scope and method (round 2)

- **Change under review.** `git diff b85068b..7859b65` (b00a0e4, b5b2ce7, 28b8e3c, 5e94b13, 99ffe4c, a55dbb8,
  dffc596, 987ad86, 32dac0a, 9d06d3c, 7859b65), plus the pre-review KNOWN fixes `3939c08..4a2fddb`. Their
  only `src/` behaviour change is the `createSharedFlight` detach (39610c9). Following the convergence rule,
  untouched code was not re-audited.
- **Environment.** As in round 1: Windows 11, Bun 1.3.14, Node v24.21.0, git 2.51.0.windows.1, uv. POSIX
  checks ran in WSL2 Ubuntu (kernel 6.18, Node v25.9.0, git 2.43.0; there is no Bun in WSL).
- **Drivers.** Scratch drivers live in `%TEMP%\omr-g32r2\` and are not committed.
  - `drv.ts` holds the round-1 harness shape (`createE2EPlugin`) with the real plugin factory and real
    wiring. It also exposes the `delegate` tool, whose fake `session.prompt` runs the producer.
    - It uses `prepareFixtureRepo` (real `npm ci` / `uv sync`) and the runner probe logs. A7's build is
      a `build.cjs` that appends `{"kind":"build"}` to the probe log.
    - Bun runs it through `run-bun.ts`. Node runs it through `node/r2.test.ts` under
      `vitest run --config vitest.r2.config.mjs`.
    - `TEMP`/`TMP` pointed at a private dir, so the slot dir and the reference dirs were private.
  - `tree-abort.ts`, `exec-leftover.ts` and `sweeper-cwd.ts` import `src/verify/{tree,exec}.ts`
    directly. They run under Bun, and under Node through a `module.registerHooks` resolver
    (`ts-resolve.mjs`: extensionless relative imports → `.ts`, type stripping), both on Windows and in WSL.
  - `grep-corpus.mjs` and `meta.mjs` run the exact `git grep -E` argv of `findByContent` with the
    `pyImportPattern` output (`bun -e` over `src/verify/runner.ts`). They run on Windows git and on WSL git.
  - `flight.ts` drives `createSharedFlight` (Bun).
- **Scoped regression checks.**
  - `npx vitest run` on the 10 test files the diff touches in `test/unit` (tree-kill, tree, runner,
    baseline-wiring, dispatch, exec-branches, pending) and `test/integration` (deferred-verification,
    router-verify-tool, delegate-timeout): `Test Files 10 passed (10)`, `Tests 1063 passed | 2 skipped (1065)`.
  - `bun test/smoke/bun-runtime.smoke.ts`: `OK: 12 passed, 0 failed, 0 skipped`. There was no full-suite run.
- **Hygiene.** After the runs, `Win32_Process` matched nothing for `omr-g32r2`, `omr-ref-`, `setInterval`,
  `sleep 3` or `60000)` (other than the querying shell), and neither did WSL `ps`. Every driver killed its
  own leftovers, and so did the decoys. The fixture repos were disposed. The private tmp held no `omr-ref-*`,
  and its `verify-slots` dir was empty. No reparse point was found under the scratch root before its removal.
  The worktree has no `Microsoft\` dir.

## Per-finding verdicts

| ID | Verdict | Evidence (verbatim, trimmed) |
|---|---|---|
| QA-G-1 | **resolved** | **Native `task`, default mode, producer changed nothing.**<br>• **A7** (`testsPass` + `buildPasses`): `afterMs 408` (Node `382`), `probes []`, output `[router] unverified · vrf_951a… · risk low (no changes attributed)`. `router_verify` on that handle: probes `["build"]` → `pass ⏎ [router ✓ verified: deterministic] ⏎ Verification notes: - no changed files, no affected tests`.<br>• **A8** (`testsPass` + `run command="npm test"`): `afterMs 356` (Node `378`), `probes []`, footer, risk low. `router_verify`: probes `["main:run"]` (the orchestrator's own full-suite `run`, now on demand only), `pass`, `✓ verified`.<br>**`delegate` tool.** A7 `762 ms` / A8 `799 ms` (Node `763` / `765`), `probes []`, output `DONE ⏎ ⏎ [router] unverified · vrf_… · risk low (no changes attributed)`. `router_verify`: A7 probes `["build"]`, A8 probes `["main:run"]`, both `pass`.<br>**Controls.**<br>• A `testsPass`-only no-change DoD takes the gate with no process: `afterMs 768` (Node `784`), `probes []`, `[router ✓ verified: deterministic] ⏎ Verification notes: - no changed files, no affected tests`.<br>• `testsPass` + a criterion is deferred (footer). Its `router_verify` spawns nothing (`probes []`, 382 ms) and passes.<br>**Result.** No no-change mixed DoD ran a check or read "verified" before `router_verify` ran its checks. A `testsPass` DoD with criteria cannot slip through: it is deferred (see QA-G-11 for the cost). |
| QA-G-2 | **resolved (C1), with a regression** | C1: new `app/app.py` gives probes `[]` and `[router ⚠ UNVERIFIED: deterministic] ⏎ Verification caveats — NOT verified …: - testsPass: scoping impossible (unmapped-module): no test file maps to the changed module app/app.py` (Bun and Node). The full test set is no longer named. But the import-shaped pattern that replaced the whole-word search misses importers that the old search found. That yields a false pass: **QA-G-10**. |
| QA-G-3 | **resolved** | C2 (Windows, e2e): `app/mod0[1-2]_[1-3].py` gives probes `[]` and `testsPass: scoping impossible (unmapped-module): no test file maps to the changed module app/mod0[1-2]_[1-3].py` (Bun and Node). No unrelated test is named. POSIX (WSL git 2.43, the bracketed pathspec `lit()` builds): `:(glob)**/test_[*].py` matched only `tests/test_*.py`, where the unescaped `test_*.py` matched all 5 files. `test_[[]x[]].py` matched only `tests/test_[x].py`. |
| QA-G-4 | **resolved (amendment)** | 5e94b13 amends G7 and §1.5-15. 99ffe4c updates CONFIG_REFERENCE "Which delegations defer" and VERIFICATION.md. Both state that DoDs without `testsPass` keep the synchronous gate, and that a `testsPass` DoD defers as a whole, also with no change. This matches the QA-G-1 repro above. The protocol line (unchanged since 19dee2a) now describes the behaviour. |
| QA-G-5 | **resolved (POSIX fix + documented limit)** | `exec-leftover.ts`, `runArgv` + 500 ms:<br>• Linux: an unref'd in-group grandchild `alive … false`, and `sleep 30 >/dev/null 2>&1 &` `alive … false`. The round-1 D4a shape (`detached: true`, i.e. `setsid`) is `alive … true` on Linux and on Windows (Bun and Node).<br>• Windows: a non-detached Node grandchild is `false` there too. The router does not sweep after a normal exit on Windows, so it ended with its parent. Inferred, not verified: libuv's kill-on-close job object for non-detached children.<br>• What survives is the stated limit: VERIFICATION.md "What a normal exit leaves running" names `setsid` / Node's `detached: true`, and Windows (no sweep after a normal exit). ADR 0003:168-171 says the same.<br>• (d) `runShell`/`runArgv` are called only from `verify/wiring.ts` (`execSeam`/`argvSeam`: checks, the reference, and `git` diff/grep/ls-files). No non-verification run goes through exec.ts. The settle-time kill keeps the late kill's guards (`!groupGone && ownsTracked(pid, trackToken) && groupAlive(pid)`, exec.ts:255). The group id cannot be reused while a member lives, and a new run that reuses the id overwrites the tracking entry. So an unowned group is not signalled. |
| QA-G-6 | **resolved** | tree-abort (fsmonitor hook `sleep 3; false`, abort at ~0.5–1.3 s):<br>• Bun win32: `snapshot settled 8 ms after the abort … undefined`. Before the abort: `sh.exe prio=6` (below normal, so low priority is preserved). 400 ms after: none left. `decoy alive: true`.<br>• Node win32: `7 ms`, `sh.exe prio=6`, then none, `decoy alive: true`.<br>• Linux (Node 25): `1 ms`. Before: `8574 8573 10 /bin/sh -c sleep 3; false …` and `8575 8573 10 sleep 3` (pgid = git's, nice 10). After: none. `decoy alive: true`.<br>`taskkill` runs by `%SystemRoot%\System32\taskkill.exe`. See QA-G-12 and QA-G-13 for two residual edges. |
| QA-G-7 | **resolved** | VERIFICATION.md "Residual limits (JS runners, QA-G-7)": `vitest related` and `jest --findRelatedTests` follow static imports only … "or report \"no affected tests\"". |
| QA-G-8 | **resolved** | reference.ts:686-695 records the E1/E2 and Bun-smoke evidence on Bun 1.3.14/win32. It keeps other Bun versions, and Bun's held-dir error code, as unverified. |
| QA-G-9 | **resolved** | `sweeper-cwd.ts` (Bun), `LOCALAPPDATA`/`APPDATA`/`USERPROFILE` pointed at a missing dir, cwd = a scratch "project", deadline plus a detached pipe-holding grandchild. Result: `cwd …\g9\proj: entries []`. PowerShell's cache went to `os.tmpdir()` (`g9\tmp\Microsoft\Windows\PowerShell`). With a normal env the sweep reports `[killed 1 process tree(s) left running by the exited command: pid 15840]`. The harness now sets `LOCALAPPDATA`/`APPDATA`. `.gitignore` has `/Microsoft/`. Observation, not a finding: with no LocalAppData the first sweep did not end the leftover within 25 s. That is an environment-only slow start. Inferred: it is unrelated to the cwd change, since before the fix the cache was rebuilt in the project cwd instead. |
| QA-3.1-18 | **resolved** | A `VERIFY:required` clean pass on a native `Task()`: `afterMs 2618` (Node `2593`), probes `["main:related"]`, output `<task_result> ⏎ ⏎ [router ✓ verified: deterministic]`. |
| QA-3.1-21 | **resolved** | (e) `buildAcceptedSuffix` is the only accepted-label site: index.ts:872 (`delegate`), index.ts:1428 (native) and wiring.ts:641 (`router_verify` report). It reads `verified` only for `outcome === "pass"` with no caveat. Every other outcome reads `UNVERIFIED`:<br>• a timeout, a busy slot, no reference, drift, a lineage downgrade (all `unverifiable`);<br>• a skipped verdict (no `outcome`);<br>• a pass with caveats.<br>C1/C2 above read `[router ⚠ UNVERIFIED: deterministic]`. The delegate ladder's give-up is `[router status: unmet] …` (no ✓). The deferred footer is `[router] unverified · …`.<br>Directive tokens: `parseVerifyDirectives` over both rendered labels returned `{"mode":"deferred",…,"modeSource":"default","waitSource":"default"}` and logged nothing. `\bVERIFY\s*:` does not match inside `UNVERIFIED:` or `verified:`. |
| QA-3.1-23 | **resolved (amendment)** | 7859b65 amends G6 and the 3.1 DoD: the repository has no CodeQL workflow, and enabling CodeQL default setup is an owner repo-settings decision. |

**(f) `createSharedFlight` abort-drop (39610c9): no false-pass risk.**

- **Construction.** A sharer can only join a flight that has not started (`lane.next`), or the one its own
  request launches. `advance` clears `lane.next` before it launches that flight. A detached flight is no
  longer reachable from the lane map.
- **Repro.** `flight.ts` uses runs that ignore their abort and take 300 ms. It printed `violations: 0`:
  - A left at 100 ms: `B asked@61 -> run 2 started@109`.
  - C arrived during run 2: `C asked@170 -> run 3 started@417`. D shared run 3 and left early, and C still
    got run 3.
  - The lane retired while E's detached run was still going: `F asked@1163 -> run 5 started@1163`.
- No sharer received a snapshot that started before its own request.

## Resolution lines

- QA-G-1 Resolution: b5b2ce7 — `noChangeGateSpawnsNothing`: only a `testsPass`-only, criterion-free DoD takes the no-change gate; any other no-change DoD is deferred with risk low (docs 99ffe4c).
- QA-G-2 Resolution: dffc596 — `pyImportPattern` import-shaped `git grep -E` plus `STEM_MATCH_LIMIT` for existing pytest modules; C1 is S6 `unmapped-module`. Superseded in part by QA-G-10.
- QA-G-3 Resolution: 32dac0a — `findByName` brackets `* ? [ ] \` in `:(glob)` pathspecs.
- QA-G-4 Resolution: 5e94b13, 99ffe4c — G7 and §1.5-15 amended (owner decision); CONFIG_REFERENCE/VERIFICATION.md state which delegations defer.
- QA-G-5 Resolution: a55dbb8 — POSIX settle-time group kill; `setsid`/`detached` escapees and Windows normal-exit leftovers documented as limits.
- QA-G-6 Resolution: 28b8e3c — `execGit` spawns git (detached on POSIX) and kills its whole tree on abort, timeout or `maxBuffer`.
- QA-G-7 Resolution: dffc596 — VERIFICATION.md "Residual limits (JS runners)".
- QA-G-8 Resolution: 987ad86 — reference.ts OPEN RISKS records the Bun 1.3.14 junction evidence.
- QA-G-9 Resolution: b00a0e4 — sweeper `cwd: os.tmpdir()`; the harness sets `LOCALAPPDATA`/`APPDATA`; `.gitignore` `/Microsoft/`.
- QA-3.1-18 Resolution: 9d06d3c — a clean pass ends with `[router ✓ verified: <method>]`.
- QA-3.1-21 Resolution: 9d06d3c — every accepted non-clean result is headed `[router ⚠ UNVERIFIED: <method>]`.
- QA-3.1-23 Resolution: 7859b65 — G6 amended: no CodeQL workflow; CodeQL default setup left to the owner.
- QA-G-10 Resolution: 29ca663 — the pytest module content search is again `git grep -F -w` on the module's name (index.py by its own name), so every import layout selects its test. Only a module named like the regular package that holds it (`app/app.py` beside `app/__init__.py`) reads its hits and drops a file whose every whole-word occurrence heads a longer one-line import path (`from app.mod01 import x`); an unreadable, oversized or occurrence-free file is kept. `pyImportPattern` and the seam's `regex` option are removed. Tests: the finding's corpus in LF, CRLF and CR, in memory and through real git (all 13 shapes hit, `mod020` does not); literal `mod+1`, `mod.1` and `a(b)`; C1 still maps `app/app.py` to its importer only; and the e2e repro (`tests/test_combo.py` in the pytest argv, `[router ⚠ UNVERIFIED: deterministic]`, `observed failures: tests/test_combo.py::test_combo02`). On the pre-fix `src`, the same e2e gives `[router ✓ verified: deterministic]` with argv `[… tests\test_mod02_1.py]` only.

## New findings (round 2)

| ID | Severity | Evidence | Fix |
|---|---|---|---|
| QA-G-10 | **critical** | **False pass: the QA-G-2 import pattern misses common wrapped imports (introduced by dffc596).**<br>**Repro** (pytest-app, Bun and Node). The base adds `combo02()` to `app/mod02.py`, and `tests/test_combo.py` imports it in isort's default grid wrap: `from app import (mod01, mod03, mod04,` / `                 mod05, mod02)`. The producer breaks `combo02` under `VERIFY:required` + `testsPass command="uv run pytest"`. The pytest argv held only `["test_mod02_1.py"]`, and the output was `<task_result> ⏎ ⏎ [router ✓ verified: deterministic]`. Then `uv run pytest tests/test_combo.py -> exit 1: 1 failed in 0.11s`.<br>**Corpus** (identical on git 2.51 Windows and git 2.43 Linux):<br>• miss: `paren_two_on_line` (`    mod01, mod02,`), `isort_grid`, `backslash_cont` (`from app import mod01, \` / `    mod03, mod02`), and `paren_last_no_comma_crlf` (`    mod02\r`: `$` does not match before a CR, and a CRLF worktree is Git for Windows' default with `core.autocrlf=true`);<br>• hit: `as_alias`, `from_as`, `paren_one_per_line`, `paren_last_no_comma_lf`, `importlib("app.mod02")`, `__import__`, `from ..app import mod02`, `from ..app.mod02 import`, `app.mod02.f()`;<br>• the `mod020` decoy is not matched.<br>The pre-fix search (`git grep -F -w -e mod02`) returns `tests/test_combo.py`, so this is a regression. It is a false pass whenever the module has at least one other importer or a `test_<stem>.py`, since S6 `unmapped-module` covers only zero hits. VERIFICATION.md promises "one name per line of a parenthesised or backslash-continued list", which the CRLF case also breaks. Regex metacharacter stems (`mod+1`, `mod.1`, `a(b)`) escape correctly: exit 0 and only the literal file, on both gits. | Make the pattern over-include, never miss.<br>• Accept the stem at **any** position of a continuation line of a name list: `^[ \t(]*([A-Za-z0-9_]+([ \t]+as[ \t]+[A-Za-z0-9_]+)?[ \t]*,[ \t]*)*<stem>…`.<br>• Allow `\r` wherever `$` ends an alternative.<br>• Or keep the whole-word `-F -w` hits and drop only files whose every occurrence is `<stem>.` followed by another name (the QA-G-2 over-match), in JS after the grep.<br>• Add the corpus above as `pyImportPattern` + `git grep` unit cases, and the repro as a fixture test. |
| QA-G-11 | nit | **`noChangeGateSpawnsNothing` excludes criteria, although the gate never grades criteria when a check exists.** gate.ts:174-193: a DoD with any check is `kind: "deterministic"` and goes to `runDeterministic`. `runChecker` is reached only for criteria-only DoDs. So `testsPass` + criterion (the harness `acceptance()` shape) with no change is deferred. It gets a footer, a pending-list entry for up to 1 h and a `router_verify` that spawns nothing (`probes []`, 382 ms), where the gate would have passed it at once. There is no safety impact, and the behaviour is documented. The code comment's rationale ("or a criterion would be … graded by that gate synchronously", wiring.ts:1517-1519) is inaccurate for such DoDs. | Accept, or test `dod.kind === "deterministic"` plus every check being `testsPass`, and fix the comment. |
| QA-G-12 | minor | **`killGitTree` may `taskkill /T /F` a recycled PID** (28b8e3c, code read; not reproduced). tree.ts kills whenever the call has not settled. It does not track git's `exit`, so it cannot tell a live git from one that exited while a descendant still holds its stdout pipe. In that state, a timeout, an abort or `maxBuffer` runs `taskkill /pid <git pid> /T /F` on a PID Windows may already have reused. exec.ts's own rule (exec.ts:330-331, "The direct child already exited, so its PID may be recycled: never `taskkill` it") is not applied here. The window needs a git descendant that inherits git's stdout and outlives it, which is rare for hooks, since git captures their output. POSIX is safe: the group persists while any member lives. | Record `exit` in `execGit`, and after it skip `taskkill` (Windows) or use exec.ts's `groupAlive` guard (POSIX). |
| QA-G-13 | nit | **POSIX snapshot git now leaves opencode's process group** (28b8e3c, code read). `detached: !isWin` puts git and its hooks in their own group, and tree.ts has no exit hook, unlike exec.ts (QA-1.2-6). A terminal Ctrl-C, or an opencode crash during a snapshot, no longer signals git or a hanging fsmonitor hook. Before the change, the foreground group's SIGINT reached them. This is bounded by the hook's own runtime. | Accept (short-lived), or register the snapshot's pgid in exec.ts's exit-hook tracking. |
| QA-G-14 | nit | **`✓ verified` also labels a pass where no test ran** (9d06d3c). Examples: TP-only no-change `[router ✓ verified: deterministic] ⏎ Verification notes: - no changed files, no affected tests`, and a JS change that no test statically imports (the QA-G-7 residual). This is documented (VERIFICATION.md verdict table: "or no test is affected → labelled `[router ✓ verified: deterministic]`"), and the note is present. But the check mark is what a model skims (the QA-3.1-21 argument). | Accept, or fold the case into the label (for example `[router ✓ verified: deterministic — no affected tests]`), as the QA-3.1-18 recommendation (`<n> affected tests passed`) suggested. |

## G1–G8 after round 2

| G | Verdict | Change since round 1 |
|---|---|---|
| G1 | **MET** | QA-G-2 (C1) and QA-G-3 (C2) resolved: both fail closed with S6, and no test file is named. |
| G2 | **NOT MET** | QA-G-10: a constructed false pass (`[router ✓ verified: deterministic]` over a failing importer). |
| G3 | MET, with caveat | Unchanged caveat, now documented: `setsid`/`detached` escapees on POSIX, and every normal-exit leftover on Windows (QA-G-5). |
| G4 | **MET** | QA-G-6 resolved: the snapshot's git tree dies on abort and timeout (Windows and POSIX). |
| G5 | MET | Not touched. |
| G6 | MET (amended) | QA-3.1-23: G6 amended (no CodeQL workflow). |
| G7 | **MET** | QA-G-1 resolved (no process, footer, risk low on both paths). QA-G-4: G7 amended. |
| G8 | MET | Clean passes now carry `[router ✓ verified: …]`, and unverifiable results carry `[router ⚠ UNVERIFIED: …]`. |

Under the owner rule, only QA-G-10 (critical) is for fixing. QA-G-11 … QA-G-14 (minor/nit) are recorded
for acceptance.

## Round 2 acceptance

- QA-G-10: resolved in 29ca663 (see Resolution lines).
- QA-G-11, -12, -13, -14 accepted per owner rule (post-round-2: only major/critical are fixed).

---

## QA-G-10 fix verification

**Scope.** Only 29ca663: the G.8 existing-module search in `src/verify/runner.ts` (`git grep -F -w <name>`, plus
`keepImporters` for a module named like the regular package that holds it) and `wiring.ts` dropping `-E`. Base
`vrb/p32` at 5bdabce. The goal was to find a **miss**: a test that imports or uses the changed module, is not
selected, and the result is not S6. Over-inclusion is acceptable.

**Verdict: VERIFIED.** No miss is attributable to 29ca663. Every wrapped, continued, CRLF and CR layout selects
its test. The `app/app.py` drop step kept every file that reaches `app.app` in every spelling tried below. It dropped only files whose `app` is the package head of a longer path, which are the documented
indirect residuals. The attack also found three **minor** misses on the general path (QA-G-15 … QA-G-17). All
three predate 29ca663 and lie outside its diff. Under the owner rule they are recorded, not fixed.

### Method

- Unit tests: `npx vitest run --maxWorkers=2 test/unit/runner.test.ts test/unit/baseline-wiring.test.ts` →
  `Test Files  2 passed (2)` / `Tests  795 passed (795)`.
- E2E: `$env:RUN_VERIFY_E2E='1'; npx vitest run --maxWorkers=1 test/integration/verify-resource-budget.test.ts -t pytest`
  → `Test Files  1 passed (1)` / `Tests  13 passed | 28 skipped (41)`. The QA-G-10 repro printed
  `[router ⚠ UNVERIFIED: deterministic]` and `observed failures: tests/test_combo.py::test_combo02`. Its argv
  ended `"--","…\\tests\\test_combo.py","…\\tests\\test_mod02_1.py"`.
- Scratch harness (in `%TEMP%`, deleted afterwards). It ran this commit's real `planScopedRun` over real git
  repositories (Git for Windows 2.51.0), using the wiring's exact argv:
  - `git --no-optional-locks -C <root> grep -l -z -F [-w] --untracked -e <name> -- <globs>`;
  - `ls-files -z --cached --others --exclude-standard`.

  The fs seam was the real worktree (utf8 `readFile`, bigint `stat`).
  - Base fixture: `pyproject.toml` with `testpaths = ["tests"]`, `app/__init__.py`, `app/app.py`, `app/mod01.py`,
    `app/mod02.py`, `tests/test_app.py` (`from app.app import f`) and `tests/test_mod01.py` (`from app.mod01 import X`).
  - `tests/test_app.py` keeps the plan a spec, so a dropped importer shows as a miss rather than as S6.
  - Each case adds `tests/test_atk.py` unless stated. 67 cases ran: 64 matched expectations, and the 3 misses
    became QA-G-15 and QA-G-16.
  - A second run covered deleted modules. Its `app/index.py` case became QA-G-17.
- Real Python (uv 0.11.7, `uv run --no-project --with pytest python -m pytest`) checked each spelling that
  Python accepts.
- git 2.43.0 (WSL, `LC_ALL=C.UTF-8` and `LC_ALL=C`) checked the `-w` retry cases.

### Attempts: the drop step (`app/app.py` beside `app/__init__.py`)

These files are **kept (selected)**. Each harness line read
`SPEC inputs=["tests/test_app.py","tests/test_atk.py"]`, or the file's own path for A40–A43.

| Group | Test file content |
|---|---|
| Basic forms | `from app.app import f`<br>`import app.app as a`<br>`from app import app`<br>`import app.mod01 as m, app.app as n`<br>`from app.mod01 import X as app` |
| Strings | `importlib.import_module("app.app")` after `from app.mod01 import X`<br>`__import__("app.app")`<br>`@patch('app.app.f')`<br>a docstring naming the app<br>a comment `# see app.app` |
| Line ends and whitespace | CRLF: `from app.mod01 import X\r\nfrom app.app import f`<br>CR only: `…\rimport app.app\r`<br>tabs throughout |
| Semicolons | `from app.mod01 import X; from app.app import f`<br>`import app.mod01; import app.app`<br>`import app.mod01 ;import app.app as a` |
| Backslash continuations | `import app.mod01, \` / `    app.app`<br>`from app.\` / `app import f` (inside the dotted name)<br>`from \` / `    app.app import f` |
| Parenthesised imports | `from app.mod01 import (` / `X,` / `)` followed by any of:<br>• `import app.app`<br>• a CRLF `from app.app import (` / `f,` / `)`<br>• `app.app.f()` |
| Unusual statement forms | `from app . app import f` (Python accepts it)<br>`from app.app import *`<br>`if True: from app.app import f`<br>`exec("""` / `from app.app import f` / `""")` |
| Oversized files | over 1 MiB (`from app.mod01 import X` + 1 MiB + 10 of `#`), both with and without a later `import app.app` |
| Over-inclusions | BOM before `from app.mod01 import X`<br>form feed before `from` |
| Relative imports | `tests/__init__.py` + `from .app import f`<br>`app/tests/test_in.py`: `from ..app import f` and `from .. import app`<br>`app/test_in.py`: `from .app import f` and `from . import app` |
| Worktree and git state | `core.autocrlf=true` checkout of a parenthesised `from app.app import (`<br>an untracked `from app.app import (` / `f,` / `)` |

These files are **not selected, as expected**:

| Case | Setup | Harness output |
|---|---|---|
| A00 (control) | `from app.mod01 import X` | `SPEC inputs=["tests/test_app.py"]` |
| A21 | `from ..app.mod01 import X` | not selected |
| A35 | 25 `from app.mod01 import X` decoys | `SPEC inputs=["tests/test_app.py"]`, not `stem-too-common`: the limit is counted after the drop |

A conftest.py naming `app.app` (`from app.app import (\r\n    f,\r\n)`) gives
`S6 unmapped-module: changed module app/app.py is referenced by tests/conftest.py: the tests its fixtures reach cannot be mapped`.

These **residuals** are documented as indirect imports and are recorded here only. Each harness output was
`SPEC inputs=["tests/test_app.py"]`, so the test is not selected.

| Case | Setup |
|---|---|
| A22 | `app/__init__.py` holds `from .app import f`, and the test holds `from app.mod01 import X` |
| A23 | `app/mod01.py` holds `from app.app import f`, and the test holds `from app.mod01 import X` |
| A33 | a conftest.py holding only `from app.mod01 import X` is dropped, with no S6 |

A22 carries little risk:

- An import-time break of `app/app.py` fails every selected direct importer too.
- `from app import <re-export>` is kept, since its `app` heads no longer path.
- The only thing lost is behaviour reached through another submodule, which is the general indirect residual.

The line parse drops a file only when an `app` occurrence is followed by `.segment` on a line that starts with
`from`/`import`. The second segment of `app.app` always survives. No attempted form hides it: `;`, a
continuation inside the path, spaces around the dot, a string or a comment. A dropped file therefore has no
spelling of `app.app` except through indirection or a six-style `app/` on `sys.path`, as VERIFICATION.md already
states.

### Attempts: the general path (`git grep -F -w <name>`)

| Case | Test file content or setup | Result |
|---|---|---|
| G02 | `from app import mod02_helpers, mod02` | selected: git's `-w` retries after the failed first occurrence |
| G01 | `mod02_helpers` only | not selected (a different module) |
| G03 | `def test_mod02_café(): assert app.mod02.value02() == 2` | selected on git 2.51 (Windows) and git 2.43 (Linux, UTF-8 and C locales). The retry stops mid-UTF-8 sequence and still finds `app.mod02`: `tests/test_crlf.py tests/test_g02.py tests/test_g03.py tests/test_g03b.py exit=0` |
| G03b | `xmod02é = 1; import app.mod02` | selected, same run as G03 |
| G04 | `app/módulo.py`, test `from app import módulo` | selected |
| G11 | keyword stem `app/class.py`, test `import_module("app.class")` | selected |
| G11b | soft keyword stem `app/match.py` | selected |
| G05 | `core.autocrlf=true` isort grid | selected |
| G06 | untracked importer | selected |
| G08 | `extra/test_x.py` outside `testpaths` | not selected, correct because not collected |
| G08b | the same without `testpaths` | selected |
| G09a | exactly 20 importers | spec with 20 inputs |
| G09b | 21 importers | `S6 stem-too-common: changed module app/mod02.py: 21 test files import it (limit 20)` |
| G10 | conftest `from app import (mod01,\r\n    mod02)` | `S6 unmapped-module` |

The S6 wording "import it" should now read "name it", as VERIFICATION.md does. This is cosmetic and gets no
finding.

**index.py.** `app/index.py` is searched as `index`, and each of these is selected:

- `from app import (mod01,\r\n    index)`;
- `import app.index as ix`;
- `from .index import x` inside `app/`.

`index/index.py` beside `index/__init__.py` behaves like `app/app.py`: `from index.index import f` is kept, and
`from index.mod import X` is dropped. The naming change creates no miss for an existing module. The deleted
path still has the old naming (QA-G-17).

**Unreadable file.** With `icacls /deny <me>:(R)` on a tracked test file, the wiring's grep prints
`error: failed to stat 'tests/test_locked.py': Permission denied` and exits `exit=0` without the file (see
QA-G-16). pytest cannot read the file either, so it cannot hide a failure the change causes, unless the lock is
transient. For `keepImporters`' own read failure, a file git read but the planner cannot is kept. The unit
tests cover this (`a read that fails`, `a stat that fails`).

### Round 3 findings

| ID | Severity | Evidence | Fix |
|---|---|---|---|
| QA-G-15 | minor | **The content search misses a module name that is not spelled in its UTF-8 NFC bytes.** This predates the diff: every `git grep -F` version has it. Python normalises identifiers with NFKC and decodes a PEP 263 source encoding, so all three spellings below import the module, and a byte search sees none of them.<br>**Spellings** (each checked in `uv run … pytest` before the change):<br>• fullwidth `from ａｐｐ.ａｐｐ import f`;<br>• NFD `from app import módulo`, written as `mo` + U+0301;<br>• `# -*- coding: latin-1 -*-` + `from app import m\xf3dulo`.<br>**After breaking the modules**: pytest gave `FAILED tests/test_nfkc.py::test_nfkc - assert 2 == 1`, `FAILED tests/test_nfd.py::test_nfd - assert 8 == 7` and `FAILED tests/test_latin1.py::test_latin1 - assert 8 == 7`, while `git grep -F -w -e módulo` gave `exit=1`.<br>**Planner results**: A31 gave `SPEC inputs=["tests/test_app.py"]`, and G04b gave `SPEC inputs=["tests/test_módulo.py"]`. Both are false passes.<br>No editor or formatter produces these spellings. | Document it in VERIFICATION.md's residual limits: "a name spelled in a compatibility or decomposed Unicode form, or in a non-UTF-8 source encoding, is not seen". |
| QA-G-16 | minor | **The content search skips test files git does not read, while pytest collects them.** This predates the diff: the argv is unchanged apart from `-E`.<br>**G07**: `.gitignore` holds `tests/test_local_*.py`, and `tests/test_local_x.py` imports `app.mod02` and fails. The plan was `SPEC inputs=["tests/test_ctrl.py"]`, while `uv run … pytest` collects the ignored file: `FAILED tests/test_local_x.py::test_local - assert 2 == 1`. The cause is that `--untracked` honours `.gitignore` and the other standard excludes.<br>**Unreadable file**: git reports `error: failed to stat …: Permission denied` and still exits 0, and the wiring reads only the exit code. This matters only for a transiently locked file.<br>These are local-only files that CI never runs. | Document the ignored-file residual. Optionally, treat an `error:` line on grep's stderr as S6 `search-failed`. |
| QA-G-17 | minor | **A deleted `index.py` is still searched by its directory's name.** This predates 29ca663 and lies outside it: 29ca663 moved only the existing-module search to the module's own name.<br>**Repro** (no `testpaths`): `app/index.py` is deleted, and `app/test_in.py` holds `from .index import x`. The content search ran `grep -F "app"` and returned `SPEC inputs=["tests/test_mod01.py"]`, so the importer, which fails with ImportError, is not run.<br>**Control**: deleted `app/mod02.py` with `from .mod02 import y` gives `grep -F "mod02"` → `SPEC inputs=["app/test_in2.py"]`.<br>The miss needs importers that never contain the package name, such as relative imports inside the package. | Use the same `name` (`index`) in the deleted-module content search. |

**Status after round 3:** QA-G-10 is **verified resolved**. G2 is **MET**, subject to the documented residuals and the
three minor findings above. QA-G-15 … QA-G-17 are minor and predate 29ca663. Under the owner rule they are
recorded for acceptance.

- QA-G-17 Resolution: 2d8df09 — the deleted-module content search now uses the module's own Python name, as the existing-module search does since 29ca663: a deleted `app/index.py` searches `index` (only `__init__.py` uses the package name); `findByName` keeps the stem (`test_app.py`), and the fail-closed rules are unchanged (no hit → S6 `deleted-no-tests`, more than `STEM_MATCH_LIMIT` → S6 `stem-too-common`). Tests (test/unit/runner.test.ts): deleted `app/index.py` with importers `from app.index import x` and `from .index import x` → exactly those two inputs; deleted `tests/pkg/index.py` → its relative importer; deleted `app/mod02.py` still searches `mod02`, deleted `tests/pkg/__init__.py` still searches `pkg`. On the pre-fix `src` the index case fails (`expected [ '/r/tests/test_i1.py', …(5) ] to deeply equal [ '/r/tests/test_i1.py', …(1) ]`).

---

## Final verification (QA-G-17)

**Scope.** `git diff ffbde73..142885e`: 2d8df09 (a deleted module's content search uses its own Python name),
plus the test-only 56e989e and 4266263. The goal was a false pass: a deleted or renamed pytest module whose
importer is not selected while the plan is a spec or NoAffected.

**Verdict: NOT CLEAN.** 2d8df09 resolves QA-G-17. Every direct-importer spelling tried selects its test. The
attack found four false passes, each confirmed with real pytest:

- QA-G-18 is a regression caused by 2d8df09. It falls inside a documented residual.
- QA-G-19 … QA-G-21 predate the diff (ffbde73 gives the same plan). They sit in the deleted-file paths next to it.

### Method

- `npx vitest run --maxWorkers=2 test/unit/runner.test.ts` → `Test Files  1 passed (1)` / `Tests  746 passed (746)`.
- A scratch harness in `%TEMP%` (deleted afterwards) ran the real `planScopedRun` (`uv run pytest`) over real git
  repositories (Git for Windows 2.51.0):
  - It used the wiring's exact argv: `grep -l -z -F [-w] --untracked -e <name> -- <globs>` and
    `ls-files -z --cached --others --exclude-standard`.
  - The fs seam was the real worktree.
  - It ran each case on this commit and on `git archive ffbde73 src`.
  - It checked each attack with `uv run --no-project --with pytest python -m pytest -q`, running both the full
    suite and the planned inputs.
  - Base fixture: `testpaths = ["tests"]`, `app/__init__.py`, `app/mod01.py`, and `tests/test_mod01.py`
    (`from app.mod01 import X`).

**Controls.** Each of these selects its importer at 142885e. The search needle is shown first.

| Case | Result at 142885e |
|---|---|
| `import app.index as i` | `index`, selected |
| QA-G-17 repro (`app/test_in.py`: `from .index import x`) | `index`, `["app/test_in.py"]`. The scoped run fails with `ModuleNotFoundError: No module named 'app.index'`. ffbde73 gave `["tests/test_mod01.py"]`. |
| CRLF `from app import (mod01,\r\n    index)` | `index`, selected |
| rename `app/index.py` → `app/main.py` (previousPath), with a stale `from app.index import x` | `main` + `index` → `["tests/test_new.py","tests/test_old.py"]`. The scoped run exits 2. |
| rename `app/index.py` → `app/index/__init__.py` | selected |
| `pkg/__init__.py` deleted, test `from pkg import helper` | `pkg`, selected |
| src layout (`pythonpath = ["src"]`), `src/lib/index.py` or `src/lib/__init__.py` deleted | `index` or `lib`, selected |
| `app/app.py` and `index/index.py` deleted | selected |
| `app/app.py` deleted, with 21 `from app.mod01` decoys | `S6 stem-too-common: … "app" appears in 23 test files (limit 20)` |
| `app/mod+1.py` deleted, test `import_module("app.mod+1")` | selected |
| `app/[x].py` deleted | `tests/test_[x].py`, found by name |
| `tests/pkg/index.py` deleted, test `from .index import helper` | selected. ffbde73 gave `S6 deleted-no-tests`. |

Deleting an unreferenced `app/index.py` now gives `S6 deleted-no-tests … "index"`. ffbde73 gave
`["tests/test_mod01.py"]`. This moves toward fail-closed, so it gets no finding.

**Test-only commits.**

- 56e989e changes only the tree-kill `afterEach` cleanup. The retry delay goes from 50 to 100 ms. After the
  retries, `EBUSY`, `EPERM` and `ENOTEMPTY` log a warning instead of throwing.
- 4266263 adds two directives tests and removes nothing.

Neither commit weakens an assertion. The new QA-G-17 runner tests assert the exact inputs and the exact needle.

### Final findings

| ID | Severity | Evidence | Fix |
|---|---|---|---|
| QA-G-18 | minor | **Regression inside a documented residual: `app/__init__.py` still imports the deleted `index.py`.**<br>**Setup (X1):** `app/__init__.py` holds `from .index import VERSION`. `tests/test_util.py` holds `assert [1, 2].index(2) == 1`. `app/index.py` is deleted.<br>**At 142885e:** `grep "index"` → `SPEC inputs=["tests/test_util.py"]`. The scoped run gives `exit=0 1 passed`, but the full run gives `exit=2 ModuleNotFoundError: No module named 'app.index' \| ERROR tests/test_mod01.py`.<br>**At ffbde73:** `grep "app"` → `["tests/test_mod01.py"]`, which fails, so the miss is new.<br>**Why minor:** VERIFICATION.md documents package re-exports as a residual. X1b (`app/helpers.py`, same shape) passes at both commits, so the directory-name search covered `index.py` only by accident. | Optional: when a deleted module's sibling `__init__.py` still exists and names it, also search the package name. This covers X1 and X1b. |
| QA-G-19 | critical | **A deleted module that a nested conftest.py imports is not S6.** The gone-module search omits `CONFTEST_GLOB`. The existing-module path fails closed on a conftest hit.<br>**Setup (X2):** `tests/api/conftest.py` holds `from app.helpers import make`, used by a fixture in `tests/api/test_api.py`. `tests/unit/test_unit.py` holds a comment `# string helpers …`. `app/helpers.py` is deleted.<br>**Result:** `SPEC inputs=["tests/unit/test_unit.py"]`. The scoped run gives `exit=0`, but the full run gives `exit=2 ERROR tests/api - ModuleNotFoundError: No module named 'app.helpers'`.<br>**Variants:** X2b (`index.py` with an `.index(` decoy) behaves the same. The control X2c (the same module modified) → `S6 unmapped-module: changed module app/helpers.py is referenced by tests/api/conftest.py …`.<br>**Scope:** ffbde73 gives the same plan. A root `tests/conftest.py` is caught, since every selected test loads it. | Search `[...pyGlobs, CONFTEST_GLOB]` for a gone module too. Return S6 `unmapped-module` on a conftest hit (unscoped `accept`), as the existing-module loop does. |
| QA-G-20 | critical | **A deleted or renamed-away test file that other tests import adds only a note.**<br>**Setup (X3):** rename `tests/test_base.py` → `tests/base.py` (previousPath). `tests/test_a.py` is updated to `from base import Base`. `tests/test_b.py` still holds `from test_base import Base`.<br>**Result:** `grep -w "base"` → `SPEC inputs=["tests/test_a.py"]`. The scoped run gives `exit=0`, but the full run gives `exit=2 ModuleNotFoundError: No module named 'test_base' \| ERROR tests/test_b.py`.<br>**Variant:** X3b (`tests/test_base.py` deleted alone) → `noAffected: no affected tests: no changed file is a test input`, labelled ✓ verified (QA-G-14).<br>**Scope:** this predates 2d8df09 (the `deleted test file not run` branch is unchanged). "Nothing to run" (phase-3.1) assumes a test file is a leaf. | For a gone test file, run the gone-module content search on its module name (`test_base`) and add the hits. A conftest hit gives S6. No hit keeps today's note. |
| QA-G-21 | critical | **A deleted package `__init__.py` misses the in-package tests that import it relatively.** This is the QA-G-17 class, still open for `__init__.py`: `from . import helper` never spells the package name.<br>**Setup (X4):** `tests/pkg/__init__.py` is deleted. `tests/pkg/test_rel.py` holds `from . import helper`. `tests/test_other.py` holds `import pkgutil`.<br>**Result:** `grep "pkg"` → `SPEC inputs=["tests/test_other.py"]`, matched through the substring `pkgutil`. The scoped run gives `exit=0`, but the full run gives `exit=2 ImportError: attempted relative import with no known parent package \| ERROR tests/pkg/test_rel.py`.<br>**Scope:** ffbde73 gives the same plan. Without the decoy, the plan is S6 `deleted-no-tests`. | For a deleted `__init__.py`, also add every in-scope test file under its directory, since those files lose their package. Alternatively, return S6 when any such file exists. |

**Severity rule:** a constructed false pass outside the documented residuals is critical, as this round's
dispatch specifies. One inside a residual is minor. Round 3 rated the pre-existing QA-G-15 … QA-G-17 minor, and
QA-G-19 … QA-G-21 also predate 2d8df09.

**Status:** QA-G-17 is **verified resolved**. The final verification is **NOT CLEAN**:

- QA-G-19, QA-G-20 and QA-G-21 are critical and pre-existing. Under the owner rule they need fixes.
- QA-G-18 is minor and is recorded.
