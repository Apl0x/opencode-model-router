# Phase 1.2 — Process controls: QA record

## Pre-flight / Spike A (Windows priority)

Host: Windows 11, node v24.21.0, pwsh 7. Scratch dir `%TEMP%\omr-spikeA`.

Fixtures:
- `gc.cjs` — spawns a grandchild `node -e "setTimeout(()=>{},4000)"`, prints both PIDs, exits
  with `argv[2]` after 2.5 s.
- `t.cmd` — `@echo off` / `"node" "%~dp0gc.cjs" %1` / `exit /b %ERRORLEVEL%`.
- `spike.cjs` — spawns each variant with `stdio: pipe`, `windowsHide`; 900 ms later snapshots
  `Get-CimInstance Win32_Process | select ProcessId,ParentProcessId,Name,Priority` and walks the
  tree below the spawned PID; records the exit code from `close`.

Variant (a) = `spawn(...)` then `os.setPriority(child.pid, PRIORITY_BELOW_NORMAL)` immediately.
Variant (b) = `cmd.exe /d /s /c "start "" /B /WAIT /BELOWNORMAL <target>"` (verbatim args).

Output (`PID<PPID Name P<priority>`; normal = 8, below normal = 6):

```
A node exit3        TREE 11184<1500 node.exe P6 | 56872<11184 conhost.exe P8 | 57164<11184 node.exe P6
A node exit3        EXIT 3
A shell t.cmd exit3 TREE 24712<1500 cmd.exe P6 | 40220<24712 conhost.exe P6 | 36204<24712 node.exe P6 | 48980<36204 node.exe P6
A shell t.cmd exit3 EXIT 3
B node exit0        TREE 2432<1500 cmd.exe P8 | 30368<2432 conhost.exe P8 | 51924<2432 node.exe P6 | 48448<51924 node.exe P6
B node exit0        EXIT 0
B node exit3        TREE 51800<1500 cmd.exe P8 | ... | 15216<51800 node.exe P6 | 28436<15216 node.exe P6
B node exit3        EXIT 0      <-- exit code lost
B t.cmd exit3       TREE 45260<1500 cmd.exe P8 | ... | 49192<45260 cmd.exe P6 | 14156<49192 node.exe P6 | 50340<14156 node.exe P6
B t.cmd exit3       EXIT 0      <-- exit code lost; stdout also gains a stray "D:\...>" prompt
B t.cmd exit0       EXIT 0
B npm.cmd missing-script EXIT 0 <-- npm printed "Missing script" (npm exits 1), exit code lost
B cmd /c exit 3     EXIT 0      <-- exit code lost
```

Follow-up for (b) with explicit propagation, `cmd /d /v:on /s /c "start "" /B /WAIT /BELOWNORMAL <t> & exit !errorlevel!"`:
- `cmd /c exit 3` target → exit 3 (propagates);
- `t.cmd 3` target → exit **0** plus a stray prompt (`start` runs a batch file in a new
  interpreter that does not hand back its errorlevel).

### Decision: (a) `os.setPriority` right after spawn

- (a) grandchildren observed at priority 6 in both the direct-argv and the `shell: true` + `.cmd`
  chain; exit codes 3 preserved in both.
- (b) lowers grandchildren too, but loses exit codes (always 0 as a plain wrapper; still 0 for
  `.cmd` targets like `npm.cmd` even with explicit `exit !errorlevel!`), and leaves the wrapper
  `cmd.exe` at normal priority. It fails the "keeps exit codes" rule.
- Neither is race-free *and* exit-code-preserving, so per the plan rule (a) is used and the startup
  race (anything the child spawns before `setPriority` runs at normal priority) is documented in
  the code comment in `src/verify/exec.ts`. In practice the window is the time between
  `CreateProcess` returning and the next JS line, before the child has loaded its runtime.

Cleanup: all spike processes exited on their own (≤ 4 s lifetimes); a
`Get-CimInstance Win32_Process | ? CommandLine -like '*omr-spikeA*'` afterwards matched only the
query itself.

## POSIX low-priority mechanism (note)

The Spike B results are in the next section. The implementation prepends `nice -n 10` to argv
(`runArgv`) and runs `nice -n 10 /bin/sh -c <command>` for `runShell`. That is the same
`/bin/sh -c` that `shell: true` spawns, so the command keeps its shell semantics and is never
re-quoted.

## Pre-flight / Spike B (POSIX)

Run on GitHub Actions, ubuntu-24.04, Node v24.21.0 — run id 36282266100 (throwaway branch
`vrb/p12-spikeb`, since deleted). Parent shell nice = 0.

**nice inheritance** (`ps -o pid,ppid,ni,comm`):

| Form | child `sh` NI | grandchild `sleep` NI |
|---|---|---|
| `nice -n 10 sh -c 'sleep 30 & sleep 30 & …; exit 0'` | 10 | 10, 10 |
| same, `exit 3` | 10 | 10, 10 |
| `nice -n 10 /bin/sh -c '…; exit 7'` (runShell form) | 10 | 10 |
| node `spawn("nice",["-n","10","sh","-c",…],{detached:true})` | 10 (PGID = own pid) | 10 ×3, same PGID |

**Exit codes preserved:** shell forms returned 0, 3, 7; node `spawn` reported `code=0` and
`code=3` (signal null) as expected. `nice` execs into its target, so no wrapper exit code is involved.

**Tree kill:** `process.kill(-pid, "SIGKILL")` on the detached `nice … sh -c 'sleep 60 & sleep 60'`
tree → child `sig=SIGKILL`; `ps -g <pgid>` afterwards found no processes (exit 1). The runner's
"orphan process" cleanup listed only `sleep`s from the spike's own non-detached shell probes;
these came from the spike script's cleanup, not from exec.ts.

**`test/unit/exec.test.ts` on Linux** (`npx vitest run --maxWorkers=2`): **1 file passed —
17 passed, 2 skipped (19)**, 6.80s. The 2 skipped tests are the `it.runIf(isWin)` `.cmd` cases.
The POSIX tree-kill tests passed: "kills the whole process tree on timeout, not just the shell",
"kills the whole process tree on abort" (×2), and "kills the whole process tree on timeout".
No failures.

## QA findings

Reviewer: heavy QA, adversarial review of `754296c..0b1fb45` against plan §1.3 S4, §1.5, Phase 1.2
and G4.

**Baseline.** On Windows 11 with node v24.21.0:
- `npx vitest run --maxWorkers=2 test/unit/exec.test.ts` passed 19 of 19 tests (Duration 11.00s).
- `npm run typecheck` is clean.

**Repro setup.** The repro scripts lived in `%TEMP%\omr-qa12` and were removed afterwards; no
leftover processes remained. `repro.mjs` imported `src/verify/exec.ts` directly (Node 24 type
stripping). Each fixture's lifetime was 8 s or less. Deadline cases used `timeoutMs: 1500`, or an
abort after 1500 ms. Each case checked whether the descendant was alive at t = 3.5 s (the deadline
plus the "no orphans after" margin) and whether the promise had resolved.

**Result.** 2 major, 5 minor and 4 nit findings. Two more items are deferred by plan. The DoD
(zero open findings) is **not met**: QA-1.2-1 and QA-1.2-2 need a fix round.

### QA-1.2-1 — major — Windows: a deadline after the direct child exited kills nothing, and descendants outlive it

- **Where:** `src/verify/exec.ts:109` (`if (exited && isWin) return;`), with `:121` and `:123`.
- **Spec:**
  - Phase 1.2 Goal: "It kills the whole tree".
  - G4: "Its expiry kills the whole process tree; no orphans after 3 s. Proven by 1.2".
- **Evidence.** Fixture `early-exit`: the direct child (node) spawns a grandchild with
  `stdio: inherit, detached: true`. `detached` keeps it out of libuv's job, the same as a child of
  cmd.exe, python or a native launcher. The direct child exits 0 at 300 ms; the grandchild lives 8 s.
  ```
  [early-exit/timeout] t=3519ms pids={"child":49192,"grandchild":47476} grandchildAlive=true resolved=NO
    taskkill /T on exited parent 49192: exit 128: ERRO: o processo "49192" não foi encontrado.
    CIM ParentProcessId=49192: 47476 node.exe created=21:52:59.636
    result after 8140ms: {"code":1,"timedOut":true,"stderr":""}
  [early-exit/abort] t=3527ms pids={"child":32688,"grandchild":33932} grandchildAlive=true resolved=NO
    result after 8159ms: {"code":1,"timedOut":true,"stderr":""}
  ```
  - At the deadline nothing is killed, and the grandchild is alive 2 s past it.
  - The result arrives only when the grandchild ends by itself. It says `timedOut: true, code: 1`,
    although the direct child exited 0 and nothing was killed.
  - The same window also means an abort after the natural `exit` but before `close` is not a
    no-op on the result (plan: "Abort after natural exit is a no-op").
- **Mitigation observed.** In the same fixture without `detached` (`early-exit-plain`), the
  grandchild died when its Node parent exited (libuv's kill-on-close job object) and the run
  resolved at 398 ms with `code 0`. So vitest and jest workers forked by a live Node runner are
  covered. The exposure is descendants of non-libuv parents (cmd.exe `start /b`, pytest-xdist or
  multiprocessing, native launchers) and `detached` descendants.
- **PID-reuse judgement.** The guard itself is correct. `taskkill /T` on the dead PID cannot help
  (exit 128, "not found", above), and a recycled PID must not be targeted. What is missing is a
  PID-reuse-safe way to reach the orphans.
- **Fix (recommended):** a creation-time-bounded descendant kill.
  1. Record `spawnedAt = Date.now()` after `spawn` and `exitedAt` in the `exit` handler.
  2. In `kill()`, when `exited && isWin`, query the processes with `powershell.exe -NoProfile -c
     "Get-CimInstance Win32_Process -Filter 'ParentProcessId=<pid>'"`. Use `powershell.exe`
     because it is built in; pwsh 7 is not guaranteed and wmic is removed on current Windows 11.
  3. Keep only the roots whose `CreationDate` lies in `[spawnedAt − 1 s, exitedAt]`. A process
     that reuses the PID, and all of its children, are created after `exitedAt`, so the filter
     excludes them. The repro shows that the query finds the orphan together with its
     `CreationDate`.
  4. Run `taskkill /pid <root> /T /F` on each root. A live PID cannot be recycled.

  Report the real exit code when nothing was killed. Add a regression test: the `early-exit`
  fixture with a `detached` grandchild, where the grandchild must be dead within 3 s of the
  deadline.
- **Alternative (acceptable only together with QA-1.2-2):** accept the residual explicitly in the
  plan risk table and in G4's wording ("descendants of an already-exited direct child on Windows
  are not killed"). Justification: libuv jobs cover Node-forked workers, and QA-1.2-2 bounds the
  run and the slot.
- **Resolution: a1415e0 (test follow-up c2e4b8f)**
  - **What changed.** A deadline or abort that arrives after the direct child's `exit` never
    targets the exited PID. The POSIX and Windows paths differ.
  - **POSIX.** The process group is signalled, unless it was already empty at `exit`. A group seen
    empty is never signalled again, which closes the "empty group, recycled id" hole.
  - **Windows.** A sweeper finds the processes whose `ParentProcessId` is the exited PID and whose
    `CreationDate` lies in `[spawnedAt − 50 ms, exitedAt + 50 ms]`. It pins each one with an open
    process handle, re-checks its `StartTime`, and on request runs `taskkill /pid <root> /T /F` on
    every live root. A pinned root that exited meanwhile is swept the same way, over its exact
    lifetime.
  - **The sweeper process.** Windows PowerShell 5.1, run as `powershell.exe -NoLogo -NoProfile
    -NonInteractive`. It is spawned directly, not through `run`, at normal priority. It has a 5 s
    kill-phase timeout and never throws; any failure means "nothing killed".
  - **Why this beats the proposal.**
    1. Pinning closes the PID-reuse window between the query and the kill.
    2. The sweeper is armed 200 ms after an `exit` whose pipes stay open. That pays PowerShell's
       startup before the deadline instead of inside G4's 3 s. Measured here: startup 0.6–1.5 s;
       kill phase about 0.4 s.
    3. It also completes a `taskkill` that raced the exit.
  - **Result semantics.** `timedOut: true` and a non-zero code only when something was killed.
    Otherwise the direct child's own exit code stands.
  - **Tests.** Both use the `test/fixtures/exec/tree.cjs early-exit` fixture. The holder is
    detached on Windows and stays in the process group on POSIX.
    - "a deadline after the direct child exited kills what it left running within 3 s".
    - The same case with an abort, fired after the run has seen `exit`.
  - **Test follow-up (c2e4b8f).** The tests' `alive()` counts a Linux zombie as dead (see
    CI run 36287129177 below).
  - **Residual.** Some descendants cannot be attributed safely:
    - on Windows, a descendant whose parent died before it could be pinned (a detached grandchild
      of a short-lived middle process);
    - on POSIX, a descendant that left the group via `setsid`.

    QA-1.2-2's grace period bounds the run in that case. The QA-1.2-2 test asserts that such a
    holder survives. The plan's risk table and G4's wording should record this.

### QA-1.2-2 — major — the result waits for `close`, so a descendant that holds a pipe and survives the kill keeps the run (and the S3 slot) past the deadline

- **Where:** `src/verify/exec.ts:125` (`child.on("close", …)` is the only success path).
- **Spec:** G4: "No slot wait, run, recheck or batch step outlives it". S4 replaces a "gate timeout
  that abandons the command without killing it".
- **Evidence (the kill path, not QA-1.2-1's exited path).** Fixture `broken-tree`: the direct
  child stays alive. A middle process spawns a `detached` great-grandchild that inherits the pipes,
  then exits, so the great-grandchild's parent is dead. At the deadline, `taskkill /pid <child> /T`
  kills the child but cannot walk to the re-parented process.
  ```
  [broken-tree/timeout] t=3525ms pids={"middle":49716,"grandchild":25988} grandchildAlive=true resolved=NO
    result after 8302ms: {"code":1,"timedOut":true,"stderr":""}
  ```
  The deadline was 1500 ms; the promise resolved at 8302 ms. The POSIX analogue (a descendant that
  calls `setsid`, so `kill(-pgid)` misses it and it keeps stdout open) follows from Node's `close`
  semantics. It was not reproduced here, because the host is Windows.
- **Impact:** Phase 2 wraps runs in `slot.acquire` (S3), so the machine-wide slot is held for the
  whole lifetime of the stray process, not for `gateBudgetMs`.
- **Fix:**
  1. In `kill()`, including the branch that returns early for `exited && isWin`, arm one grace
     timer (for example 2000 ms, `unref()`'d).
  2. When the timer fires, call `child.stdout?.destroy()` and `child.stderr?.destroy()`.
  3. Then call `finish(exitCode ?? 1)`, using the code captured on `exit`, and append
     `[output streams force-closed <n> ms after kill: a descendant still held them]` to stderr.
  4. Clear the timer in `finish`.

  Add a test with the `broken-tree` fixture: it resolves within the deadline plus the grace period,
  with `timedOut: true`.
- **Resolution: a1415e0**
  - **The grace timer.** Every kill arms a `KILL_GRACE_MS` timer: 2000 ms, `unref()`'d, cleared on
    settle.
  - **When it fires with the pipes still open:**
    1. `stdout` and `stderr` are destroyed.
    2. A direct child that did not exit gets `SIGKILL`.
    3. The run resolves `{ code: exitCode || 1, timedOut: true }` with `[output streams
       force-closed 2000 ms after the kill: a descendant still held them]` on stderr.
  - **A sweep still running at `close`.** The run waits for it, bounded by the same timer, so
    `timedOut` reflects what was actually killed.
  - **Test.** The `broken-tree` fixture resolves 2000–4000 ms after the abort, with the
    force-closed note. Its unreachable holder is still alive, which is the documented residual, and
    the test releases it.

### QA-1.2-3 — minor — Windows env merge is case-sensitive, so an override whose key has a different case is silently dropped

- **Where:** `src/verify/exec.ts:70` (`{ ...process.env, ...opts.env }`).
- **Spec:** 1.2.2 / types.ts: "Merged over process.env; never replaces it". §1.5-4 puts `cross-env`
  assignments into the spec's `env`.
- **Evidence.** Node's spawn on win32 de-duplicates keys case-insensitively and keeps the first
  key in sorted order:
  ```
  [env] override {"PATH":"OVERRIDE"} -> child sees {"PATH":"OVERRIDE","TEMP":"C:\\Users\\MAR"}
  [env] override {"path":"OVERRIDE"} -> child sees {"Path":"C:\\Program F","TEMP":"C:\\Users\\MAR"}
  [env] override {"Temp":"OVERRIDE"} -> child sees {"Path":"C:\\Program F","TEMP":"C:\\Users\\MAR"}
  ```
  Whether an override wins depends on how its key sorts against the existing key, not on
  precedence.
- **Fix:** on win32, before assigning each override key, delete every inherited key whose
  `toUpperCase()` equals the override key's `toUpperCase()`. Add a Windows test: `env: { path: "X" }`
  → the child sees `X`, and no second Path/PATH entry exists.
- **Resolution: 20da594**
  - **Change.** `mergeEnv`: on win32, every inherited key that matches an override key
    case-insensitively is deleted before the override is set.
  - **Test (Windows).** `{ path: "OMR-X", Temp: "C:\omr-temp-override" }`: the child sees both
    values, and exactly one PATH key and one TEMP key.

### QA-1.2-4 — minor — POSIX `lowPriority` breaks the spawn-error contract (`nice` exits 127 instead of an ENOENT `error`)

- **Where:** `src/verify/exec.ts:38` and `src/verify/exec.ts:49`.
- **Spec:** "A spawn error (non-existent executable) resolves `{code:1, timedOut:false}` with the
  error in `stderr`".
- **Evidence (from the spec; not reproduced, because the host is Windows).** With the `nice` prefix,
  Node spawns `nice` successfully. `nice` then fails to exec the target and exits 127 (not found) or
  126 (not executable) with its own message. Node emits no ENOENT `error`. The Linux spawn-error
  test (`exec.test.ts:153`) does not set `lowPriority`, so CI cannot see this. Production runs with
  `lowPriority: true` by default (§1.4), so the 1.3 adapter would see 127, not 1.
- **Fix:** when `run` wrapped the target in `nice`, map exit 126/127 whose stderr starts with
  `nice:` to `{code: 1, stderr: "exec failed: …"}`. Pass `--` before the target
  (`nice -n 10 -- file …`). Run the spawn-error test on both platforms with and without
  `lowPriority`.
- **Resolution: ce0d15e**
  - **Change.**
    - Both entry points now run `nice -n 10 -- <target>`.
    - In `runArgv`, a nice exit of 127 or 126 whose stderr starts with `nice:` resolves as code 1
      with `exec failed: spawn <file> ENOENT|EACCES (nice: …)`.
    - `runShell` keeps `/bin/sh`'s own 127. Its nice target is always `/bin/sh`, so a missing
      command is the shell's 127 with or without `lowPriority`.
  - **Tests.**
    - The spawn-error test runs with and without `lowPriority` on both platforms.
    - A POSIX-only test covers 127, 126 (a non-executable file) and a name that starts with `-`,
      which proves `--`. It also checks that `runShell` gives the same 127 either way.
  - **Linux CI:** green.

### QA-1.2-5 — minor — `timeoutMs` ≥ 2^31 (or `Infinity`) kills the command immediately

- **Where:** `src/verify/exec.ts:112`.
- **Spec:** §1.4 allows any "integer ≥ 1" for `gateBudgetMs` and `recheckTimeoutMs`, and §1.5-13
  passes `min(budget, remaining)` down.
- **Evidence:**
  ```
  TimeoutOverflowWarning: 2147483648 does not fit into a 32-bit signed integer. Timeout duration was set to 1.
  [timeoutMs=2^31] resolved in 466ms: code=1 timedOut=true
  ```
  A user who sets a large `gateBudgetMs` would get every verification reported as timed out.
- **Fix:** do not arm the timer when `!Number.isFinite(timeoutMs)`. Otherwise clamp with
  `Math.min(Math.max(timeoutMs, 0), 2 ** 31 - 1)`. Add a test for `2 ** 31`: the command completes
  normally.
- **Resolution: ce0d15e**
  - **Change.** `deadlineOf`:
    - `Infinity` arms no timer;
    - `NaN` counts as absent;
    - any other value becomes `Math.min(Math.max(t, 0), 2 ** 31 - 1)`.
  - **Tests.**
    - `2 ** 31`, `Number.MAX_SAFE_INTEGER` and `Infinity` complete normally with no
      `TimeoutOverflowWarning`.
    - `-5` expires at once.

### QA-1.2-6 — minor — POSIX `detached` (new session) trees survive opencode exit; there is no exit cleanup

- **Where:** `src/verify/exec.ts:74` (`detached: !isWin`). `rg "process\.on\(|process\.once\(" src`
  returns no matches.
- **Spec:** QA focus: "`detached` side effects on POSIX (a detached child that survives opencode
  exit)". G4.
- **Evidence (from Node's documented behaviour; not reproduced, because the host is Windows).**
  `detached: true` makes the child "the leader of a new process group and session". A terminal
  hang-up (SIGHUP) or a tty Ctrl-C does not reach it. When opencode exits mid-run, the tree keeps
  running at nice 10 until the suite ends by itself, and indefinitely when no deadline was passed
  (QA-1.2-7).
- **Contrast on Windows:** non-detached children sit in libuv's kill-on-close job, so opencode exit
  kills them (see the `early-exit-plain` observation in QA-1.2-1).
  - **Corrected by QA-1.2-18:** the job holds only the processes libuv spawned itself (it allows
    silent breakaway), so opencode exit killed the direct child (`cmd.exe`) but not the tree below
    it. Windows now has the same exit hook (`taskkill /T` of each direct child that has not
    exited); see the round-3 resolutions.
- **Status:** the `detached` flag predates this phase (it is in the `754296c` context lines), but
  the plan puts this case in this phase's QA focus.
- **Fix:**
  1. Keep a module-level `Set<number>` of live POSIX group ids: add after spawn, delete in `finish`.
  2. Lazily install one `process.once("exit", …)` handler that runs `process.kill(-pgid, "SIGKILL")`
     for each id in a try/catch. `process.kill` is synchronous, so it is allowed in `exit`.
  3. Document that death by an unhandled signal (the host's SIGTERM/SIGHUP policy) remains
     opencode's concern.
- **Resolution: 48d88ca**
  - **Tracking.** A module-level `Set` holds the live POSIX group ids:
    - an id is added after spawn;
    - it is removed when the run settles;
    - it is also removed at `exit` if the group is already empty.
  - **The hook.** One `process.once("exit", killTrackedProcessGroups)` is installed lazily on the
    first run. It SIGKILLs every group still in the set.
  - **Documentation.** The file header states that death by an unhandled signal skips `exit` hooks.
  - **Test (POSIX).** After several runs exactly one hook is registered. Calling it mid-run kills
    the fork fixture's grandchild.

### QA-1.2-7 — nit — a run with neither `timeoutMs` nor `signal` has no deadline

- **Where:** `src/verify/exec.ts:33`, `:48` (`opts = {}`) and `:112`.
- **Spec:** 1.2.2 makes `timeoutMs?` optional in the seam, so the type is as specified. G4:
  "Nothing outlives its budget".
- **Evidence:** today's only caller (`src/verify/wiring.ts:110-112`) always passes a
  `cwd ?? directory` and a `timeoutMs ?? 120000` default, so nothing is unbounded yet. `cwd` also
  silently defaults to opencode's own `process.cwd()`.
- **Fix:** document on `ExecOptions` that callers must bound every run with `timeoutMs` or
  `signal`. Optionally apply a defensive 120000 ms default when both are absent (the same default as
  `DeterministicDeps.timeoutMs`). Phase 3.2 should re-check that every 1.3/1.5/2.x call site passes
  a deadline.
- **Resolution: ce0d15e** (decided: document and add the default)
  - **Change.**
    - `RunOptions.timeoutMs` now documents that callers must bound every run.
    - A run with neither `timeoutMs` nor `signal` gets `DEFAULT_TIMEOUT_MS` = 120000 (the same as
      the `DeterministicDeps` default).
  - **No caller breaks.**
    - The only production caller, `wiring.ts` `execSeam`, always passes `timeoutMs ?? 120000`.
    - `baseline-wiring.test.ts` mocks `runShell`.
    - Every exec test passes `timeoutMs` or `signal`.
    - The four wiring test files pass.
  - **Unchanged.** `cwd` still defaults to `process.cwd()`; wiring passes `cwd ?? directory`.
  - **Phase 3.2** should still re-check every call site.

### QA-1.2-8 — minor — multi-byte UTF-8 characters split across chunks become U+FFFD (pre-existing)

- **Where:** `src/verify/exec.ts:100-101` (`String(chunk)` per Buffer chunk).
- **Evidence:** 65535 × `a` followed by `é`/`日本` produced damaged characters:
  ```
  [utf8] code=0 length=145543 replacementChars=7
  ```
  This damages non-ASCII test names in the text-parsing fallback (`observeTests`, §1.5-2) and in
  failure evidence.
- **Fix:** call `child.stdout?.setEncoding("utf8")` and `child.stderr?.setEncoding("utf8")`, which
  use a StringDecoder, then concatenate the strings.
- **Resolution: a55731e**
  - **Change.** `setEncoding("utf8")` on both streams.
  - **Test.** 200000 × `aé日本😀` on stdout and stderr decodes byte-exact, with no U+FFFD. The test
    failed against the pre-fix code.

### QA-1.2-9 — nit — `maxBuffer` is not a cap, and truncation leaves no marker

- **Where:** `src/verify/exec.ts:100-101`; the JSDoc at `:26` says "Per-stream cap in characters;
  output past it is dropped".
- **Evidence:**
  ```
  [maxBuffer=1000] stdout.length=65536 stderr="" (no truncation marker)
  ```
  The cap is exceeded by up to one pipe chunk (64 KiB here, 65 times the cap), and a truncated
  stream cannot be told apart from a complete one. The test (`exec.test.ts:145-151`) only asserts
  `< 5 MiB`.
- **Fix:** append `s.slice(0, limit - stdout.length)` and record `truncated` for each stream. Put a
  marker (`[stdout truncated at <limit> chars]`) on stderr or a `truncated?: boolean` field on the
  result. The test should assert `stdout.length <= maxBuffer` and the marker.
- **Resolution: a55731e**
  - **Change.** An exact per-stream cap:
    - the chunk that crosses the cap is sliced, never inside a surrogate pair;
    - later chunks are drained and dropped;
    - `[stdout truncated at <n> chars]` and `[stderr truncated at <n> chars]` are appended to
      stderr.
  - **Stderr notes.** All notes now go at the end of stderr, including `[low priority not
    applied …]`. None contains summary or identity tokens.
  - **Tests.**
    - `maxBuffer: 1000` gives exactly 1000 stdout chars and the exact stderr markers.
    - A surrogate pair at the cut is kept whole.

### QA-1.2-10 — nit — the "abort after natural exit" test does not cover the window the Windows guard exists for

- **Where:** `test/unit/exec.test.ts:176-182`.
- **Spec:** "Abort after natural exit is a no-op (no `taskkill` of a recycled PID: a `settled`
  guard)".
- **Evidence:** the test aborts only after the promise has settled, when the listener has already
  been removed, so it cannot fail. The `exited && isWin` branch (`exec.ts:109`) is not tested at all.
  QA-1.2-1's `early-exit/abort` repro shows that this window changes the result (`code 1,
  timedOut: true` for a child that exited 0).
- **Fix:** add the `early-exit` fixture case with the abort fired between `exit` and `close`. Assert
  no kill of the direct PID, plus the behaviour chosen in QA-1.2-1.
- **Resolution: a1415e0 (test follow-up c2e4b8f)**
  - **Tests.** Two tests cover the window between `exit` and `close`. Both abort only after the run
    has seen the child's `exit`.
    - `early-exit` (a leftover is reachable): the holder dies, the result is `code 1, timedOut:
      true`, and stderr has the sweep note.
    - `unreachable` (nothing is reachable): the result is `{ code: 0, stdout: "", stderr: "",
      timedOut: false }`, i.e. the abort is a no-op.
  - **No kill of the direct PID.** This is structural: after `exit`, the Windows path only runs
    the sweeper.
  - **Abort racing the exit.** An abort can land after the OS ended the child but before libuv
    delivered `exit`. It cannot be told apart from an abort of a running command, so it counts as
    a kill; the comment in `kill()` documents this.
  - **Why the tests wait.** The tests wait 300 ms after the OS-level death before aborting. A
    stress run, 15 iterations under 6 CPU burners, failed 4 of 15 without the wait (resolved in
    about 100 ms with `timedOut: true` and empty stderr) and 0 of 15 with it.

### QA-1.2-11 — nit — the Windows priority test depends on PowerShell 7

- **Where:** `test/unit/exec.test.ts:91` (`execFileSync("pwsh", …)`).
- **Evidence:** `pwsh` is not installed by default on Windows (GitHub's Windows runners have it;
  developer machines may not), and this test would fail with ENOENT there.
- **Fix:** use `powershell.exe` (Windows PowerShell 5.1, always present), with the same
  `Get-CimInstance` query.
- **Resolution: 20da594**
  - **Change.** `priorityOf` runs `powershell.exe -NoProfile -NonInteractive -Command` with the
    same `Get-CimInstance` query.
  - **Also.** The QA-1.2-1 sweeper uses the same binary, by its full `%SystemRoot%` path.

### QA-1.2-12 — deferred by plan (3.2) — the `rg child_process src` acceptance check lists `src/index.ts`

- **Evidence:** `rg -n child_process src` lists:
  - `src/index.ts:74 import { exec as nodeExec } from "node:child_process";`
  - `src/verify/exec.ts`
  - `src/verify/tree.ts`
  - `src/verify/wiring.ts:7` (a comment only)

  `git show 754296c:src/index.ts | rg child_process` → `74:import { exec as nodeExec } …`, so the
  import predates this phase. `rg nodeExec src/index.ts` matches only that import line: it is a dead
  import that spawns nothing.
- **Status:** the acceptance intent holds (no new spawn path). Phase 3.2's re-check should delete
  the unused import and update the acceptance wording.

### QA-1.2-13 — deferred by plan (2.1) — production callers do not pass `lowPriority` or `env` yet

- **Where:** `src/verify/wiring.ts:106-114`. The `execSeam` adapter narrows `opts` to
  `{ cwd, timeoutMs, signal }`, so verification still runs at normal priority.
- **Status:** plan 2.1.2.b wires low priority, the slot and the deadline into every check kind.
  Phase 2.1 QA should confirm that `lowPriority` (default `true`, §1.4) reaches `runShell` and
  `runArgv`.

### Checked, no finding

- **Priority race (Windows).** `setPriority` runs right after `spawn`, and anything spawned before
  it runs at normal priority. This is accepted by the plan rule ("If neither does both, use (a) and
  document the startup race in the code comment"); the comment is at `exec.ts:86-89`. Spike A
  observed P6 grandchildren in both the argv chain and the `shell: true` + `.cmd` chain. BELOW_NORMAL
  is inherited by `CreateProcess` children. The window length ("few microseconds") is not measured.
  POSIX has no race, because `nice` execs its target.
- **PID reuse.**
  - Windows: the direct child's PID is pinned while libuv holds its handle, until `exit`, and the
    `exited` guard stops `taskkill` after that.
  - POSIX: a group id cannot be reused while the group has members, and an empty group gives ESRCH,
    so `child.kill` is a no-op.
  - The gap is coverage, not safety: see QA-1.2-1.
- **Abort-listener leak.** Listeners use `{ once: true }` and are removed in `finish`. The
  pre-aborted and synchronous-throw paths return before adding one. The test with 25 runs sharing
  one signal leaves 0 listeners.
- **setPriority failure text on stderr.** `deterministic.ts:151,226` and `baseline.ts:17` parse
  `stdout + "\n" + stderr`. The `[low priority not applied: …]` line has no summary or identity
  tokens, and stdout is untouched.
- **Windows `.cmd` quoting.** The `runShell` `shell: true` path is unchanged from `754296c`
  (`cmd.exe /d /s /c "<command>"`). A quoted `.cmd` path with `lowPriority` keeps exit 3, and
  `npm.cmd --version` exits 0 (test passes). `runArgv` resolves a `.cmd` as EINVAL through the
  synchronous `try/catch` and never rejects.
- **ENOENT and EINVAL never reject.** ENOENT goes through `error` → `finish(1, err)`, and EINVAL
  through the `try/catch`. Both are covered by tests.
- **types.ts contract.** `ExecOptions` is exactly `{ cwd?, timeoutMs?, signal?, lowPriority?, env? }`
  and `ArgvSeam` is `(file, args, opts?) => Promise<ExecResult>`, as in 1.2.2. It was committed first
  (`31043d9`).
- **Required tests.** All of plan 1.2.3's cases are present. Coverage gaps are QA-1.2-9 and
  QA-1.2-10.

## Fix round (QA-1.2-1 … QA-1.2-11)

Commits on `vrb/p12`, each pushed:
- `20da594`: QA-1.2-3 and -11.
- `a55731e`: QA-1.2-8 and -9.
- `ce0d15e`: QA-1.2-4, -5 and -7.
- `48d88ca`: QA-1.2-6.
- `a1415e0`: QA-1.2-1, -2 and -10.
- `c2e4b8f`: a test follow-up for QA-1.2-1 and -10.

QA-1.2-12 and QA-1.2-13 remain deferred by plan (3.2 and 2.1).

**Windows 11, node v24.21.0, head `c2e4b8f`:**
- `npm run typecheck` is clean.
- `npx vitest run --maxWorkers=2 test/unit/exec.test.ts` passed twice in a row: 31 passed and
  2 skipped (the POSIX-only cases), in 23.40 s and 23.47 s. Three more consecutive runs at
  `a1415e0` were also green.
- `baseline-wiring`, `cwd-scoping`, `enforcement-defaults` and `wiring` tests: 4 files, 85 passed,
  1 skipped.
- **Regression check.** The new Windows-applicable tests were run against the pre-fix `exec.ts`,
  and 11 of them failed:
  - the `early-exit` and `broken-tree` cases waited 20 s on the holder;
  - the no-op case got `code 1, timedOut: true`;
  - U+FFFD appeared in the output;
  - the 2^31 timeout killed at once;
  - the env case was lost.
- **Orphans.** Afterwards, `Get-CimInstance Win32_Process` filtered on the fixture and scratch
  command lines matched nothing.

**Linux CI.** This ran on the throwaway branch `vrb/p12-ci`: `vrb/p12` plus a temporary workflow,
`on: push: branches: [vrb/p12-ci]`, ubuntu-latest, with a node 20 and 24 matrix. The workflow ran
`npm ci` and then `npx vitest run --maxWorkers=2 test/unit/exec.test.ts` twice. The workflow was
never committed to `vrb/p12`. The branch has since been deleted remotely and locally, and the
temporary worktree has been removed.
- **Run 36287129177** (at `a1415e0`):
  - node 20: green.
  - node 24: failed "an abort between the child's exit and the pipes closing…" at
    `expect(alive(holder)).toBe(false)`. The run had resolved 662 ms after the abort.
  - Cause: after the group SIGKILL, the re-parented holder stays a zombie until its new parent
    reaps it, and `kill(pid, 0)` still succeeds on a zombie.
  - Fix: `c2e4b8f`, a test-only change; `alive()` reads `/proc/<pid>/stat`.
- **Run 36287282255** (at `c2e4b8f`), on ubuntu-24.04 with GNU coreutils nice 9.4: green on
  node v20.20.2 and v24.21.0.
  - Each node version ran twice in a row: 30 passed and 3 skipped (the Windows-only cases), about
    15.6 s per run.
  - QA-1.2-1 deadline case: 3004 ms. QA-1.2-10 abort case: 657 ms. QA-1.2-2 grace case: 2254 ms.
  - The POSIX `nice` exec-failure test and the exit-hook test passed.
  - A leftover-process step (`ps -eo pid,pgid,sid,ni,etime,args` filtered on the fixtures)
    printed `none` on both.

**Accepted residuals.** Each one is documented in `src/verify/exec.ts`.
1. **Unattributable descendants are not killed.** This covers a descendant whose parent died
   before it could be attributed: on Windows, one that was never pinned; on POSIX, one that called
   `setsid` and left the group. Such a descendant is not killed. The run and its slot are still
   bounded by the 2 s grace period (QA-1.2-2). The plan's risk table and G4's wording should say so.
2. **Daemons of a finished command are not swept.** When a command completes naturally, `close`
   fires and anything it left in the background is not swept. That is not a deadline expiry, and
   it is unchanged from before.
3. **Death by an unhandled signal skips the exit hook.** If opencode dies from an unhandled
   signal, the POSIX `exit` hook does not run.
4. **An abort that races the exit counts as a kill.** An abort that lands between the OS ending
   the child and libuv delivering `exit` counts as a kill.

## QA re-review (round 2)

Reviewer: heavy QA, adversarial re-review of the fix round, `git diff 5e393dc..2e5cda9` on
`vrb/p12` (`src/verify/exec.ts`, `src/verify/types.ts`, `test/unit/exec.test.ts`,
`test/fixtures/exec/tree.cjs`), against plan Phase 1.2 and G4.

**Setup.**
- Host: Windows 11, 16 logical cores, node v24.21.0.
- `npx vitest run --maxWorkers=2 test/unit/exec.test.ts` passed: 31 passed, 2 skipped (the
  POSIX-only cases), 23.37 s.
- The repro scripts lived in `%TEMP%\omr-qa-r2` and have been removed.
  - `p12.mjs` imported `src/verify/exec.ts` directly.
  - A `hook.mjs` ran first. It wrapped `child_process.spawn`/`execFile` through
    `syncBuiltinESMExports`, so it could count and time every process `exec.ts` starts, including
    the sweeper.
  - The sweep cases used `test/fixtures/exec/tree.cjs early-exit`. They waited until the direct
    child was dead at the OS level, then aborted either after about 30 ms (a **cold** sweep: the
    sweeper is spawned by the kill) or after about 900 ms (a **pre-armed** sweep). They polled
    the holder every 20 ms from the abort.
  - Load runs started 16 `node` busy loops, one per logical core, before the cases.
- The branch history was rewritten, so the Resolution lines above quote old SHAs. They map by
  subject as follows:
  - `20da594` → `aa902e8`;
  - `a55731e` → `6367006`;
  - `ce0d15e` → `810eaf3`;
  - `48d88ca` → `90570a0`;
  - `a1415e0` → `6966a5c`;
  - `c2e4b8f` → `6edb7be`.

**Result.**
- All 11 round-1 findings are verified.
- QA-1.2-1 holds on an idle machine and under the verification's own below-normal load. Under
  normal-priority CPU saturation it does not: see QA-1.2-14.
- There are 3 new findings: 1 minor and 2 nit.
- The DoD (zero open findings) is **not met**.

### Round-1 findings

| Finding | Status | Evidence |
|---|---|---|
| QA-1.2-1 | verified, with a load limit (QA-1.2-14) | `exec.ts:239-248` never targets the exited PID: Windows calls `sweep()`, POSIX signals the group unless `groupGone`. Measured sweeps, holder dead after the abort: idle cold +1010/+1017/+1021 ms; idle pre-armed +277/+277/+322 ms; below-normal burners, the verification's own load: cold +1509/+1627/+1708 ms, pre-armed +923/+943/+1085 ms. All of these fall within G4's 3 s, and every result is `code 1, timedOut: true` with `[killed 1 process tree(s) left running by the exited command: …]`. Both lifecycle tests pass. |
| QA-1.2-2 | verified | `onGrace` (`exec.ts:212-225`) destroys the pipes, SIGKILLs a direct child that did not exit, and settles. In every sweep run under normal-priority saturation (12 runs) the result arrived +2001 to +2032 ms after the abort, with `[output streams force-closed 2000 ms after the kill: a descendant still held them]`, so the run and its slot are bounded even when the sweep is late. The `broken-tree` test passes. |
| QA-1.2-3 | verified | `mergeEnv` (`exec.ts:301-312`). Repro: `{"PATH":"X1","Path":"Y2"}` → the child sees `[["Path","Y2"]]`; `{"Path":"Y2","PATH":"X1"}` → `[["PATH","X1"]]`; `{"path":"Z3"}` → `[["path","Z3"]]`. There is exactly one key, and the last override wins, in a deterministic order. POSIX is unchanged. |
| QA-1.2-4 | verified (code; not re-run: Windows host) | Both entry points pass `--` (`exec.ts:79`, `:91`). The mapping at `:183-187` applies only to `runArgv`, only when not killed, and only for exit 126/127 with a `nice:` prefix. The POSIX test at `exec.test.ts:214-234` passed in the recorded Linux CI run 36287282255. |
| QA-1.2-5 | verified | `deadlineOf` (`exec.ts:287-293`). The `2 ** 31`, `MAX_SAFE_INTEGER`, `Infinity` and `-5` tests pass. |
| QA-1.2-6 | verified (code; not re-run: Windows host) | `trackGroup`/`untrackGroup` and a single lazy `process.once("exit")` hook (`exec.ts:363-381`). The groups are untracked on settle and when seen empty at `exit`. The POSIX hook test passed in CI run 36287282255. |
| QA-1.2-7 | verified (code); the test gap is QA-1.2-16 | `DEFAULT_TIMEOUT_MS = 120_000` is applied only when both `timeoutMs` and `signal` are absent (`exec.ts:289`). |
| QA-1.2-8 | verified | `setEncoding("utf8")` is set on both streams (`exec.ts:163-164`). The UTF-8 split test passes. |
| QA-1.2-9 | verified | The exact cap with surrogate protection and end-of-stderr markers (`exec.ts:320-340`, `:189-191`). The `maxBuffer: 1000` and surrogate tests pass. |
| QA-1.2-10 | verified | The abort between `exit` and `close` is covered by the two lifecycle tests, and both pass. The no-op case resolves to `{ code: 0, stdout: "", stderr: "", timedOut: false }`. |
| QA-1.2-11 | verified | `priorityOf` runs `powershell.exe` (`exec.test.ts:108-109`). The sweeper uses the `%SystemRoot%` path (`exec.ts:408-410`). |

### Focus checks (no finding)

- **The sweeper does not run on every exec.**
  - Across 4 ordinary runs (`runShell echo`, `runArgv node`, `runShell npm.cmd --version` with
    `lowPriority`, and `runShell node exit 3`), there were 0 PowerShell spawns.
  - One spawn happens only when a pipe holder outlives the exit by more than `SWEEP_ARM_MS`. In the
    test run, the child exited at once and a detached holder kept the pipes for 1.2 s. The result
    was `code=0 timedOut=false`, with 1 spawn, and 0 sweepers alive 300 ms later: `dispose()`
    ended it.
- **No orphaned sweeper.**
  - In all 30 sweep runs, including the ones where the sweeper hit `SWEEP_TIMEOUT_MS`, no sweeper
    was alive after its run.
  - The sweeper is a non-detached child, so it sits in libuv's kill-on-close job on opencode exit.
  - EOF on its stdin ends `ReadLine`.
- **No injection through the PID values.** The script interpolates only `pid` (`child.pid`, a
  number) and `Math.floor`/`Math.ceil` results (`exec.ts:441-448`). Inside the script, `taskkill.exe`
  is resolved by PowerShell, which never runs a command from the current directory. The
  PowerShell path is absolute when `SystemRoot` is set.
- **A missing `powershell.exe`.** An asynchronous `error` event leads to `end()` and then
  `report([])`, so nothing is killed and nothing throws. That degradation is silent: see QA-1.2-15.
- **PID pinning and the `+50 ms` slack.** A PID recycled within the `to` slack could expose a new
  owner's child to the sweep. Measurement: 735 `cmd.exe` processes churned for 8 s gave 124 PID
  reuses, and the minimum gap between the old owner's exit and the new owner's spawn was 1142 ms,
  with 0 reuses within 200 ms. The slack is not a practical hazard on this host. Pinning plus
  the `StartTime` re-check covers the query-to-kill window.
- **The `nice` 126/127 mapping and false positives.** A misclassification needs a `runArgv` target
  whose own first stderr bytes are `nice:` and whose exit is 126 or 127. For example, a wrapper
  script whose first failing step is its own `nice` call. `runArgv` targets are adapter-built
  (`process.execPath <runner entry>`, `pytest`, `uv`, per §1.5-1), and none of them prints that.
  The worst case is still a failure (code 1 instead of 127). No finding.
- **The timeout clamp, the 120 s default and the exit hook:** covered in the table above.

### New findings

| ID | Severity | Where | Evidence | Fix |
|---|---|---|---|---|
| QA-1.2-14 | minor | `exec.ts:67` (`SWEEP_TIMEOUT_MS = 5000`), `:440-505` (`armSweeper`) | **Normal-priority saturation.** Under 16 normal-priority busy loops (16 cores), the Windows sweep misses G4's 3 s, and sometimes it never kills. Holder dead after the abort, two runs of the unchanged code:<br>• cold: +3977, +4819, +4574, +3912 and +3716 ms, and **once alive after 9 s**; the sweeper had been ended by the 5 s limit (`exit signal SIGTERM`);<br>• pre-armed: +3850, +3284, +4361, +3775, +4129 and +4951 ms (the sweeper was SIGTERM'd at 5.7 s of life).<br>So all 12 runs missed 3 s, and 1 of the 12 never killed. Pre-arming does not help, because under this load PowerShell has not finished starting and pinning by exit + 0.9 s.<br>**Comparison under the same load.** The primary path (a live direct child, `taskkill /T /F` from node) killed the grandchild at +869, +1057 and +950 ms. The below-normal load results are in the QA-1.2-1 row.<br>**Experiment (not a proposed change).** Raising the sweeper to `PRIORITY_HIGH` right after spawn gave +2748, +2212, +2311 and +2111 ms, and 2 of 6 runs alive after 9 s. The CIM query runs in the WMI provider host, which is not raised, so priority alone does not fix it. The run itself stayed bounded at +2.0 s in every case (QA-1.2-2). | 1. Make `SWEEP_TIMEOUT_MS` bound only a hung sweeper, for example 30000 ms. By then the grace timer has already settled the run, so a late kill costs the run nothing, and it turns "never" into "late".<br>2. Record the load dependence in G4's wording and in the risk table (see the proposal below).<br>3. Optionally, `setPriority(ps.pid, PRIORITY_HIGH)` after the spawn: it lowers the median, not the tail.<br>No unit test: this is load-dependent. 3.1.2.d should run its no-orphans check once on the Windows runner with a normal-priority CPU burner. |
| QA-1.2-15 | nit | `exec.ts:463-476` and `:478-497` | **Sweeper failures are silent.** Four causes all resolve as "nothing killed", and the result cannot tell them apart from "nothing to kill":<br>• the sweeper's stderr is `ignore`d;<br>• `error` and `close` both call `end()`;<br>• `report()` passes only `killedPids()`;<br>• the 5 s limit does the same.<br>Evidence:<br>• In the QA-1.2-14 run where the limit ended the sweeper, the result carried only the force-closed note.<br>• Under Constrained Language Mode (simulated with `$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'` in `powershell.exe`), each construct the script needs fails: `[Diagnostics.Process]::GetProcessById` and `[Console]::Out.WriteLine` ("A invocação de método tem suporte apenas nos tipos principais deste modo de linguagem", pt-BR host: method invocation is supported only on core types), and the `[DateTimeOffset]` cast ("Esse modo de linguagem dá suporte apenas para os tipos principais": this language mode supports only core types). `Pin` swallows the error, so on an AppLocker/WDAC machine the QA-1.2-1 fix is inert with no trace. | 1. Have the script print a sentinel after pinning, for example `pinned <n>`.<br>2. Have `kill()` append `[orphan sweep unavailable: <spawn error \| exit <code> \| timed out after <n> ms \| no sentinel>]` to the notes when the sentinel is missing or the limit fires.<br>3. State the FullLanguage requirement in the `armSweeper` doc comment.<br>4. Test it by pointing the sweeper at a script that exits 1 before the sentinel, through a test-only override of the PowerShell path, and assert the note. |
| QA-1.2-16 | nit | `exec.ts:289`, `test/unit/exec.test.ts` | **The 120 s default is untested.** `rg DEFAULT_TIMEOUT_MS test src` matches only `src/verify/exec.ts` (`:45`, `:59`, `:289`). Every `runShell`/`runArgv` call in the test file passes `timeoutMs`, so neither arm of `t === undefined` (no signal → 120000; signal only → no timer) runs. This counts against §4.2's ≥ 90 % branch target for `exec.ts`. | Add two tests with `vi.spyOn(globalThis, "setTimeout")`. With no `timeoutMs` and no `signal`, a quick `runArgv` arms a timer of `DEFAULT_TIMEOUT_MS`. With only a `signal`, it arms no deadline timer. Alternatively, export `deadlineOf` and test it pure. |

### Round-2 resolutions

- **QA-1.2-14 — Resolution: 98ae488.** `SWEEP_TIMEOUT_MS` is now 30000 ms and bounds only a
  hung sweeper; the run is already settled by the 2 s grace, so a slow sweep under load turns
  "never" into "late". The limit timer is `unref`'d, so it never keeps opencode alive, and the
  sweeper stays a non-detached child that dies with opencode (libuv job). The live-child
  `taskkill /T` keeps its own 5000 ms limit (`TASKKILL_TIMEOUT_MS`). The optional
  `PRIORITY_HIGH` was not applied: it lowered the median but not the tail in the QA experiment.
  The load dependence stays in the G4/risk wording below (3.2) and the 3.1.2.d load run (3.1).
- **QA-1.2-15 — Resolution: 98ae488.** The script exits 3 unless it runs in FullLanguage mode and
  prints `pinned <n>` after pinning. When a kill was requested and the marker is missing, the
  result's stderr gets `[orphan sweep unavailable: <spawn error: … | exit <code> | killed by
  <signal> | timed out after 30000 ms | no marker>]`, provided the run has not settled yet; a
  failure after the grace settled the run has no result to carry it, which is documented in the
  `armSweeper` comment together with the FullLanguage requirement. Tests: a test-only
  `setSweeperExecutableForTests` points the sweeper at a missing executable (spawn error) and at
  `node` (exits non-zero before the marker); both assert the note.
- **QA-1.2-16 — Resolution: 98ae488.** `deadlineOf` is exported and tested pure (no options →
  `DEFAULT_TIMEOUT_MS`, `NaN` → default, signal only → none), and a `vi.spyOn(globalThis,
  "setTimeout")` test asserts a real run arms a 120000 ms timer without options and none with only
  a signal.
- `npx vitest run --maxWorkers=2 test/unit/exec.test.ts`: 35 passed, 2 skipped (POSIX-only);
  `npm run typecheck` clean.

**Known-limit example (G4 limit (a), deferred to 3.2).** During the phase 1.5 work an MSYS
`sleep.exe` started by a git filter escaped `taskkill /T`: it was not reachable from the live
tree at the kill. This is the same "descendant whose parent died before the kill" case and is covered by the
same G4 wording.

### Residual limit: decision and plan wording (for 3.2 to apply)

**Decision: the residual is acceptable**, as long as the wording below replaces the absolute claim
and QA-1.2-14 fix 1 lands. The reasons:
1. On Windows, a process whose parent has died cannot be attributed to the run in a PID-safe way
   without a dedicated job object. On POSIX, the same holds for a `setsid` escapee without a
   cgroup or subreaper. Node exposes neither.
2. The resource goal still holds: the run and its slot are released `KILL_GRACE_MS` after the
   deadline in every measured case.
3. Node-forked workers die with their Node parent, through libuv's job.
4. Survivors run at below-normal priority when `lowPriority` is on, which is the default.

Proposed §4.1 G4 text:

> **G4 — Nothing outlives its budget.** Every synchronous verification (a required gate in the
> `delegate` and the native `task` paths, and each `router_verify` call) has one deadline
> (`gateBudgetMs`). No slot wait, run, recheck or batch step outlives it by more than the 2 s kill
> grace: the run resolves and releases its slot at most 2 s after the deadline, even when a
> descendant still holds its output pipes. Its expiry kills every process still attributable to
> the run, and no attributable process is alive 3 s after the deadline on a machine that is not
> saturated by normal-priority load. Attributable means:
> - on POSIX, a member of the run's process group;
> - on Windows, a descendant reachable from the live direct child or, once the direct child has
>   exited, a child it created during its lifetime and that child's live tree, found by the
>   creation-time sweep.
>
> Known limits, each still bounded by the 2 s grace:
> - (a) a descendant whose parent died before the kill (Windows) or that left the process group
>   with `setsid` (POSIX) is not killed;
> - (b) the Windows sweep needs Windows PowerShell 5.1 in FullLanguage mode, and where PowerShell
>   is blocked or constrained it kills nothing;
> - (c) under normal-priority CPU saturation the Windows sweep can finish after 3 s.
>
> Proven by 1.2, the 2.1 deadline and native-`task` tests, the 2.4 `router_verify` deadline test,
> and 3.1.2.d.

§5 risk table, a new row:

> | A descendant escapes the deadline kill: its parent died first (Windows), it called `setsid` (POSIX), PowerShell is blocked or constrained, or normal-priority load starves the Windows sweep | The run and its slot are released 2 s after the deadline anyway (force-closed pipes, `timedOut: true` and a stderr note). POSIX process groups and pinned Windows trees are killed, and Node-forked workers die with their parent (libuv job). Verification descendants run below normal priority, so a survivor cannot starve the machine. The sweep's own failure is reported on stderr (QA-1.2-15). 3.1.2.d asserts the 3 s no-orphans rule for an attributable tree. |

Also align 3.1.2.d ("3 s later no descendant is alive") to "no attributable descendant".

### Deferred by plan (not open)

- **deferred by plan (3.2):**
  - QA-1.2-12, unchanged.
  - Apply the G4 and risk-table wording above and the 3.1.2.d alignment. The plan file is not
    owned by this phase.
- **deferred by plan (2.1):** QA-1.2-13, unchanged. The 2.1 QA should confirm that `lowPriority`
  reaches `runShell` and `runArgv`.
- **deferred by plan (3.1):** 3.1.2.d's run under normal-priority load (QA-1.2-14), and the §4.2
  coverage gate that QA-1.2-16 feeds into.

## QA re-review (round 3)

Reviewer: heavy QA, adversarial re-review of `git diff 347200e..7be5c34` on `vrb/p12`
(`src/verify/exec.ts`, `test/unit/exec.test.ts`), plus a new angle: opencode runs the plugin
under **Bun 1.3.14**, not Node.

**Setup.**
- Host: Windows 11, 16 logical cores, node v24.21.0, bun 1.3.14. Other agents were running tests
  on the same machine, so machine-wide process counts were filtered to this review's own PIDs.
- `npx vitest run --maxWorkers=2 test/unit/exec.test.ts` (node): **35 passed, 2 skipped** (the
  POSIX-only cases), 37 in total, 32.62 s.
- The repro scripts lived in `%TEMP%\omr-qa12r3` and have been removed. No fixture, burner or
  sweeper process was left running.
  - `repro.mjs` imported `src/verify/exec.ts` directly. It ran unchanged under `node` (type
    stripping) and `bun`. The fixtures always ran on node.exe (`OMR_NODE`), because under Bun
    `process.execPath` is `bun.exe`.
  - `exitprobe.mjs` ended the host process while runs were in flight, under both runtimes.
  - `hang.exe` was a stand-in for a hung sweeper. It is a `bun build --compile` binary that
    ignores its arguments and stdin and lives 60 s. It was installed through
    `setSweeperExecutableForTests`.
  - `load.mjs` ran on node only. It wrapped `child_process.spawn` through
    `syncBuiltinESMExports`, so it could time the sweeper and read its output, and for the CLM
    case prefix its script. Its fixture was a copy of `tree.cjs` with a 60 s holder cap, so a late
    kill cannot be mistaken for the holder's own 20 s exit.

**Result.**
- QA-1.2-14, -15 and -16 are verified.
- Bun behaves like Node in every exec.ts path measured except one: `runArgv` on a `.cmd` path
  (QA-1.2-17). Bun spawns through libuv (its ENOENT text names `uv_spawn`), which accounts for
  the parity elsewhere.
- There are 4 new findings: 1 major, 2 minor (one of them owned by 1.5) and 1 nit.
- The DoD (zero open findings) is **not met**.

### Round-2 findings

| Finding | Status | Evidence |
|---|---|---|
| QA-1.2-14 | verified | **Code.**<br>• `SWEEP_TIMEOUT_MS = 30_000` (`exec.ts:72`), with `limit.unref()` (`:544`).<br>• The live-child `taskkill` keeps its own `TASKKILL_TIMEOUT_MS = 5000` (`:74`, `:361`).<br>• The sweeper is still a non-detached `spawn` (`:500-503`).<br>**Still kills under saturation.** 16 normal-priority node busy loops ran on 16 cores. The holder died in 7 of 7 runs, so no run was "never":<br>• cold: +4406, +3834, +3237 and +3565 ms after the abort;<br>• pre-armed: +2899, +3255 and +3133 ms.<br>Each sweeper printed `pinned 1` and the root PID, and closed with code 0 at +3342 to +4847 ms, far below the 30 s limit. Each run itself resolved at +2021 to +2052 ms, `timedOut: true`, with the force-closed note. Six of the seven kills missed 3 s, which is G4 limit (c).<br>**Not orphaned.** The hung `hang.exe` sweeper was alive at the host's `process.exit(0)`, 1 s after the result. One second later it was gone, under node and under bun (libuv job).<br>**The limit fires.** When the host is left to exit on its own, `hang.exe` is dead by the time the host exits, at abort+30040 ms (node) and +30060 ms (bun). That same measurement is QA-1.2-19. |
| QA-1.2-15 | verified | **FullLanguage check** (`exec.ts:474`). The CLM case prefixed the sweeper's `-Command` with `$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; `. (`__PSLockdownPolicy=4` does not force CLM on this host: `powershell.exe` still reports `FullLanguage`.) The sweeper exited with **code 3** and printed nothing.<br>• Cold: the result arrived at abort+2009 ms with stderr `[orphan sweep unavailable: exit 3]` then `[output streams force-closed 2000 ms after the kill: …]`.<br>• Pre-armed: the sweeper had already exited 3 at abort−281 ms. The same two notes arrived at +2002 ms.<br>• The holder was alive in both cases, as expected: the sweep could not run.<br>**The marker.** `pinned 1` was on the sweeper's stdout in all 7 load runs.<br>**The note appears only while the run is pending.**<br>• In the load runs the sweep finished after the grace had settled the run. The result carries only the force-closed note, and no stale or misleading line.<br>• With the hung `hang.exe`, the result at +2005 to +2022 ms has only the force-closed note. The `timed out after 30000 ms` reason arrives 28 s after the run settled and is dropped, as the `armSweeper` comment says.<br>**The test hook is not reachable from production.**<br>• `rg setSweeperExecutableForTests src` matches only its definition (`exec.ts:429`).<br>• The plugin entry `src/index.ts` exports only types (`:106-110`) and `default` (`:1548`).<br>• The only production importer of `exec.ts` is `wiring.ts:20`, and it imports `runShell` alone.<br>Both hook tests pass. |
| QA-1.2-16 | verified | `deadlineOf` is exported (`exec.ts:299`).<br>• The pure test covers `{}` → 120000, `NaN` → 120000, signal only → `undefined`, and signal with `500` → 500.<br>• The `vi.spyOn(globalThis, "setTimeout")` test sees a 120000 ms timer for a bare `runArgv`, and none when only a signal is passed.<br>Together with the earlier `Infinity`, `2 ** 31` and `-5` tests, every branch of `deadlineOf` runs. Both tests pass. |

### Bun compatibility (Windows 11; the same script under both runtimes)

| Aspect | node v24.21.0 | bun 1.3.14 | Verdict |
|---|---|---|---|
| Exit codes. `runShell` `exit 0`, `exit 3` and `exit 3` with `lowPriority`; `runArgv` node `exit(3)`, and `ok`/`exit(3)` with `lowPriority` | 0, 3, 3, 3, 0 (`ok`), 3 | the same | same |
| Spawn error (a missing executable, with and without `lowPriority`) | code 1, `Error: spawn omr-no-such-exe-qa12r3 ENOENT` | code 1, `Error: ENOENT: no such file or directory, uv_spawn 'omr-no-such-exe-qa12r3'` | The contract holds (code 1, error on stderr); only the text differs |
| `lowPriority` → `os.setPriority` on the child PID, inherited by descendants | argv chain: child P6, grandchild P6. `runShell` of a quoted `.cmd`: `cmd.exe` P6, node P6, grandchild P6. `.cmd` exit 3 kept | the same | same |
| Tree kill: deadline 1500 ms, and abort at 1500 ms. Target: `runArgv` or `runShell` of node, whose grandchild is **detached**, so only `taskkill /T` reaches it | child and grandchild dead at t = 1839–1894 ms; resolved at 1838–1873 ms, `code 1, timedOut: true` | dead at 1852–1895 ms; resolved at 1856–1879 ms | same |
| Exited-child sweep (`tree.cjs early-exit`, abort) | holder dead: cold +1352/+1196 ms, pre-armed +625/+657 ms; `[killed 1 process tree(s) …]` | cold +1230/+1291 ms, pre-armed +519/+653 ms; the same note | same |
| Armed sweeper when nothing is killed (the holder releases the pipes) | this run's sweeper: 1 alive while the pipes were held, 0 at 300 ms after the result; `code 0, timedOut: false` | the same | same |
| Kill grace (`broken-tree`, abort) | +2002 ms, force-closed note, holder alive (the documented residual) | +2013 ms, the same | same |
| Env merge on win32: `{path, Temp, omr_x}`, `{PATH:"X1", Path:"Y2"}` and `{Path:"Y2", PATH:"X1"}` | `path=OMR-X`, `Temp=C:\omr-temp-override`, `omr_x=1`; `[["Path","Y2"]]`; `[["PATH","X1"]]`; exactly one key each | the same | same |
| `maxBuffer: 1000` | stdout.length 1000; stderr ends with `[stdout truncated at 1000 chars]` and `[stderr truncated at 1000 chars]` | the same | same |
| `setEncoding("utf8")`: 200000 × `aé日本😀` on both streams | byte-exact, 0 U+FFFD | the same | same |
| Abort listeners after 25 runs sharing one signal (`getEventListeners`) | 0 | 0 | same |
| `timeoutMs` of `2 ** 31`, `-5`, and a pre-aborted signal | 408 ms `code 0`; 513 ms `timedOut: true`; `timedOut: true` | 393 ms; 353 ms; the same | same |
| `runShell` of a quoted `.cmd` path with a space and `lowPriority`; `npm.cmd --version`; `npm.cmd run <missing>` | 3 with `cmdout 3`; 0 with `12.0.2`; 1 with `Missing script` | the same | same |
| **`runArgv` on a `.cmd` path** | code 1, `exec failed: Error: spawn EINVAL` | **Runs it through cmd.exe.** `t.cmd 3` → code 3, `cmdout 3`. `probe.cmd` with the argument `"&echo INJECTED&"` → stdout `probe-ran\r\nINJECTED\r\n`, and cmd.exe complains on stderr that `'\"'` is not a command | **differs: QA-1.2-17** |
| `runArgv` of a batch file by bare name (`npm`; `probe` with `probe.cmd` in the cwd) | ENOENT | ENOENT (`uv_spawn`) | same: only an explicit `.cmd`/`.bat` path is exposed |
| Host `process.exit(0)` with a `runShell` and a `runArgv` run in flight (15 s node targets) | the argv run's node child is gone. The shell run's `cmd.exe` is gone, but **its node child is alive** 1.5 s later, re-parented to the dead `cmd.exe` | the same | same in both: **QA-1.2-18** |
| Hung sweeper at host `process.exit(0)` | killed | killed | same (QA-1.2-14: not orphaned) |
| Hung sweeper, host left to exit on its own | exits at abort+30040 ms; the result came at +2009 ms | +30060 ms; the result came at +2014 ms | same in both: **QA-1.2-19** |
| `process.on("exit")` on a natural exit | fires | fires | same. The POSIX group hook (`process.once("exit")`, `process.kill(-pgid)`) and `nice` cannot be run on this host: 3.1 |
| `process.execPath` | `…\nodejs-lts\current\node.exe` | `C:\Users\Marquinho\.bun\bin\bun.exe` | **differs: QA-1.2-20** (1.5) |
| `windowsHide` (a `GetConsoleWindow()` probe through `runArgv`) | 0 | 0 | Not observable here: the control spawn without `windowsHide` also reports 0, because the host process has no console |

### New findings

| ID | Severity | Where | Evidence | Fix |
|---|---|---|---|---|
| QA-1.2-17 | major | `exec.ts:92-101` (`runArgv`; the JSDoc says a `.cmd` "resolves as a spawn error") | **Under Bun, the production runtime, `runArgv` runs a batch file through cmd.exe, and cmd.exe re-parses its arguments.** This breaks the seam's "arguments reach the child byte-for-byte" contract, and it is the CVE-2024-27980 (BatBadBut) injection class that Node's EINVAL guards against.<br>• `runArgv("<tmp>\probe.cmd", ['"&echo INJECTED&"'])` → code 1 and stdout `probe-ran\r\nINJECTED\r\n`: cmd.exe ran `echo INJECTED`.<br>• `runArgv("<tmp>\dir with space\t.cmd", ["3"])` → code 3, `cmdout 3`.<br>• Node gives `code 1, exec failed: Error: spawn EINVAL` for both.<br>• Bare names (`npm`, `probe`) are ENOENT in both runtimes, so the exposure is an explicit `.cmd`/`.bat` path, such as `node_modules\.bin\vitest.cmd` or a user-configured path.<br>**Impact.** There is no production `runArgv` caller yet (`rg runArgv src` finds only `exec.ts`). §1.5-1's argv adapters are the consumers, and on Windows their arguments (test names, file filters) can contain `&`, `"` or `%`. | 1. In `runArgv`, on win32, refuse a batch target before spawning, whatever the runtime. For example, when `/\.(cmd\|bat)[. ]*$/i` matches `file`, resolve `{ code: 1, stdout: "", stderr: "exec failed: spawn EINVAL (batch files must run through runShell)", timedOut: false }`. That is the result Node gives today.<br>2. Keep the JSDoc as it is: it is then true on both runtimes.<br>3. Add a Windows test: `runArgv(<a .cmd>, ['"&echo X&"'])` → code 1 with EINVAL and no `X` on stdout.<br>4. The 3.1 Bun smoke should run it under bun. |
| QA-1.2-18 | minor | the `exec.ts:27` header ("On Windows, non-detached children sit in libuv's kill-on-close job"), and QA-1.2-6's Windows contrast | **Ending the host kills only the direct child. The tree below `cmd.exe` keeps running, under node and under bun.** Measured 1.5 s after `process.exit(0)` with two runs in flight:<br>• the `runArgv` node child was gone;<br>• the `runShell` `cmd.exe` was gone, but its node child was alive (`51608<45608 node.exe` under node, `25772<13668 node.exe` under bun).<br>**Cause (from libuv's source, not re-read here).** libuv's job allows silent breakaway, so only the processes libuv spawns itself are in the job. Node children (such as vitest workers) die with their node parent, because each node has its own job. Children of `cmd.exe`, npm's shell and native launchers survive.<br>**Impact.** `runShell` is the only production path (`wiring.ts:20`). Quitting opencode mid-verification on Windows leaves `npm test` and the tree below it running until the suite ends. Nothing ends that tree, and it runs at normal priority until 2.1 wires `lowPriority`. POSIX has the exit hook for this case (QA-1.2-6); Windows has nothing. | 1. Extend the lazy exit hook to Windows. Track the PID of each direct child that has not exited yet: add it after `spawn`, delete it at `exit` and on settle.<br>2. In the hook, run `spawnSync("taskkill", ["/pid", pid, "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 2000 })` for each PID. `spawnSync` is allowed in `exit`. The PID cannot be recycled, because libuv still holds the child's handle.<br>3. Correct the `:27` comment.<br>4. Add a Windows test that mirrors the POSIX hook test: call the hook mid-run, and the shell fixture's grandchild must be dead.<br>5. Children that already exited stay under the known residual, because the sweep needs PowerShell. |
| QA-1.2-19 | nit | `exec.ts:542-545` (the comment "A settled run must not keep opencode alive for a hung sweeper") | **The unref'd limit timer does not stop a hung sweeper from keeping the host alive.** The sweeper's `ChildProcess` handle and stdio pipes stay ref'd, so a host that exits by draining its event loop waits for the 30 s limit. Measured with `hang.exe` and the holder released after the result:<br>• node: the result came at abort+2009 ms, and the process exited at +30040 ms (wall time 30885 ms);<br>• bun: +2014 ms and +30060 ms (wall time 31620 ms).<br>Before 98ae488, this wait was bounded at 5 s. Whether opencode ever exits by draining its event loop, rather than by an explicit exit, is not verified. | Once the run has settled with a sweep still pending, call `ps.unref()` and unref the sweeper's stdin and stdout sockets (`.unref?.()`). Otherwise, reword the comment to say that a hung sweeper can keep the host alive for up to `SWEEP_TIMEOUT_MS`. |
| QA-1.2-20 | minor (owned by 1.5) | plan §1.5-1, as quoted in the round-2 record: argv adapters run `process.execPath <runner entry>` | **Under Bun, `process.execPath` is not node.**<br>• Measured: `bun.exe` under bun 1.3.14.<br>• Not verified: inside opencode's compiled binary it is presumably the opencode executable itself.<br>So an adapter that launches `process.execPath <vitest entry>` would run the runner under Bun, or hand the arguments to opencode's CLI, instead of under the project's node. exec.ts itself does not use `process.execPath`, and neither does anything else in `src`. | 1.5's argv adapters should resolve `node` explicitly: on PATH (`node.exe`), or from the project's toolchain. They should not use `process.execPath`.<br>The 3.1 Bun smoke should run one argv adapter end-to-end under opencode.<br>3.2 should fix the plan wording. |

### Checked, no finding

- **The run cannot settle twice when a sweep lands late.** In `finish` (`exec.ts:189`), a sweep
  still pending is not disposed. `onSwept` (`:204-214`) only pushes notes, and `finish` returns
  early once the run has settled.
- **A pre-armed sweeper that failed before the kill.** Its `kill()` reports at once through
  `ended` (`:531-533`). This is the CLM pre-armed case above.
- **The `taskkill` timeout on the live-child path.** If `taskkill` runs past its 5000 ms limit,
  `child.kill()` ends only the direct child. Its `exit` then arms the sweep for what it left
  running (`:279-283`, `killRequested`), so the split of `TASKKILL_TIMEOUT_MS` from
  `SWEEP_TIMEOUT_MS` does not open a new gap.

### Deferred by plan (not open)

- **deferred by plan (3.1)**, the e2e/CI phase:
  - A **Bun smoke** on Windows and Linux that runs `test/unit/exec.test.ts`-equivalent cases under
    bun. It should cover:
    - the QA-1.2-17 refusal;
    - the QA-1.2-18 Windows exit hook;
    - on Linux: `nice`, the process-group kill and the `process.once("exit")` group hook under
      Bun, none of which can run on this host.
  - 3.1.2.d's no-orphans run under normal-priority load (QA-1.2-14, unchanged).
  - The §4.2 coverage gate.
- **deferred by plan (3.2)**, global QA and plan wording:
  - QA-1.2-12;
  - the G4 wording and risk-table row from round 2;
  - the QA-1.2-20 plan wording.
  - Add to the G4 known limits that on Windows, host exit reaches descendants only through the
    exit hook (after QA-1.2-18), and that already-exited children remain under limit (a).
- **deferred by plan (2.1):** QA-1.2-13, unchanged.

### Round-3 resolutions

- **QA-1.2-17 — Resolution: b3fda67.**
  - **Code.** On win32, `runArgv` refuses a target that matches `/\.(cmd|bat)[. ]*$/i` before
    anything is spawned, under any runtime and with or without `lowPriority`. It resolves
    `{ code: 1, stdout: "", stderr: "exec failed: Error: spawn EINVAL (batch files must run
    through runShell)", timedOut: false }`, Node's own result plus the reason. The JSDoc now says
    why: Node refuses the spawn, but Bun runs the file through cmd.exe.
  - **Bare names.** A bare name is not matched. The runtime resolves it with `.com` and `.exe`
    only: a bare `probe` beside `probe.cmd` is ENOENT under node and bun. The argv adapters pass
    absolute `.js`/`.exe` targets.
  - **Bun repro** (bun 1.3.14 and node v24.21.0, the argument `"&echo INJECTED&"`, a batch file
    that writes a marker):
    - Before the fix, bun ran `probe.cmd`, `PROBE.CMD`, `probe.bat` and a cwd-relative
      `probe.cmd` through cmd.exe. Each wrote the marker and printed `probe-ran` and `INJECTED`.
    - Also before the fix, bun ran `probe.cmd  ` (trailing spaces), exit 0. For `probe.cmd.`,
      cmd.exe started and printed `INJECTED`, although it could not find the batch file.
    - After the fix, all 7 spellings give the refusal above under both runtimes: no marker and
      no `INJECTED`.
    - `probe.cmd::$DATA` and `probe.bat::$DATA` are ENOENT under both runtimes, before and after
      the fix, so no batch file runs.
  - **Test.** The old `.cmd` test is replaced. The new test covers 7 absolute spellings and a
    cwd-relative one, each with `lowPriority` false and true. It asserts the exact result, which
    also tells the refusal apart from Node's bare EINVAL, and that the marker file was never
    written.
- **QA-1.2-18 — Resolution: 78c71dd (tracking order: 0ec7ec5).**
  - **Tracking.** One `tracked` set and one lazy `process.once("exit", killTrackedProcesses)`
    serve both platforms.
    - POSIX is unchanged: process groups, untracked on settle or when seen empty at `exit`.
    - On Windows, each direct child is tracked from spawn until its `exit`. Until then libuv holds
      its handle, so the PID cannot be recycled. The child is not untracked on settle: one that
      outlived the grace is exactly what the hook must end.
    - It is tracked after the priority call, so nothing new sits between the spawn and
      `setPriority`.
  - **The hook on Windows.** It makes one `spawnSync(taskkill, ["/pid", a, "/pid", b, …, "/T",
    "/F"], { windowsHide: true, stdio: "ignore", timeout: 2000 })` call. The hook therefore delays
    exit by at most 2 s however many runs are in flight.
  - **Comments.** The `exec.ts` header and the QA-1.2-6 contrast above are corrected.
  - **Hardening.** `taskkill.exe`, for the hook and for the live-child kill, and `powershell.exe`
    now start by their absolute `%SystemRoot%\System32` path. libuv looks a bare name up in the
    working directory before PATH, and that directory is the user's project. Measured: with a copy
    of `node.exe` named `whoami.exe` in the cwd, `spawnSync("whoami", …, { cwd })` ran the copy.
  - **Tests.**
    - The hook test now runs on both platforms. On Windows it goes through `runShell`: cmd.exe,
      then node, then a grandchild. It asserts that the middle process and the grandchild are dead
      and that there is one listener.
    - A new Windows test starts `test/fixtures/exec/host.mjs exit-mid-run` in its own node. The
      host imports `exec.ts`, starts that `runShell` and calls `process.exit(0)`. The test asserts
      the middle process and the grandchild are dead within 3 s.
    - The host needs Node's type stripping, so the test is skipped on Node 20. The in-process hook
      test still runs there.
    - With the Windows branch of the hook disabled, both tests fail. The in-process test times
      out, and the host test gives `expected false to be true` (the middle process was alive).
  - **Repro.** The host was launched from pwsh, the way opencode is.
    - With the hook disabled, the middle process and the grandchild were alive after the host
      exited, under both node and bun.
    - With the hook, both were dead at the host's exit: node ×1, bun ×2.
    - A bun host started from a node parent lost its tree even without the hook, presumably
      through the parent's job. The 3.1 Bun smoke should therefore not start the bun host from
      node, or it passes vacuously.
- **QA-1.2-19 — Resolution: 0ec7ec5.**
  - **Two causes held the host.**
    - When the run settles with its sweep still in flight, `finish` now calls `sweeper.unref()`:
      `ps.unref()` plus `unref` on the stdin and stdout sockets, where the runtime has it.
    - That alone did not help. The kill ended the sweeper's stdin with `end("kill\n")`, and a
      pending pipe shutdown kept the loop alive: on Windows libuv flushes the pipe, and the flush
      waits for the reader (from libuv's source, not re-read here). The kill now `write`s the line.
      `ReadLine` needs only the newline, and the sweeper's exit closes the pipe. `dispose()` still
      ends stdin and then kills the sweeper.
  - **Measurements.** The table gives the time from the result to the host's exit, with a sweeper
    that hangs:

    | Runtime and sweeper stand-in | Before the fix | Unref only, stdin still ended | Write only, no unref | Fixed |
    |---|---|---|---|---|
    | node, node stand-in | — | 28015 ms (test failed) | 28014 ms | 15 ms |
    | bun, `bun build --compile` `hang.exe` | 28042 ms | — | — | 30 ms |

    The stand-in or `hang.exe` was dead after the host exited in every run: as a direct child, it
    sits in libuv's job.
  - **Test.** A Windows test (also type stripping) runs `host.mjs hung-sweeper`.
    - The host wraps `spawn` through `syncBuiltinESMExports` so the sweeper is a node stand-in
      that ignores its arguments and stdin. Bun ignores that wrapper, so the bun repro passes
      `hang.exe` instead.
    - The test asserts a `timedOut` result with the force-closed note, that the host exits less
      than 5 s after the result, and that the stand-in is dead within 3 s.
- **QA-1.2-20 — owned by phase 1.3: see QA-1.3-18** (`docs/qa/verification-resource-budget/phase-1.3.md`
  on `vrb/p13`). The runner must not default to `process.execPath`. It should resolve an absolute
  `node`/`node.exe` from absolute PATH entries, and report `runner-not-installed "node"` when
  there is none. `exec.ts` does not use `process.execPath`. The plan wording stays deferred to 3.2
  (above).
- **Runs.**
  - `npx vitest run --maxWorkers=2 test/unit/exec.test.ts`: 38 passed, 1 skipped (the POSIX-only
    `nice` case), 39 in total, in two consecutive runs on the final code. `npm run typecheck` is
    clean.
  - Load flake. During the work, 42 node processes from other agents held the CPU at 100 %.
    Under that load, "runs grandchildren of runShell below normal priority" failed once, and two
    other `lowPriority` runs hit their 20 s deadline (`expected 1 to be 3`). The tests passed in
    isolation and in every run once the load dropped. The two deadline hits match below-normal
  priority starved by normal-priority load (the QA-1.2-14 conditions). The priority test's own
  message was not captured.

## QA re-review (round 4)

Reviewer: heavy QA, adversarial re-review of the round-3 fixes, `git diff 982f78f..1ae22d6` on
`vrb/p12` (`src/verify/exec.ts`, `test/unit/exec.test.ts`, `test/fixtures/exec/host.mjs`), under
node and under **Bun 1.3.14**, the runtime the plugin actually runs in.

**Setup.**
- Host: Windows 11, 16 logical cores, node v24.21.0, bun 1.3.14. Other agents were using the
  machine, so every process count below is filtered to this review's own PIDs.
- `npx vitest run --maxWorkers=2 test/unit/exec.test.ts` was run once (node): **37 passed,
  1 failed, 1 skipped** (39 in total), 54.44 s.
  - The failure is "lowPriority > runs grandchildren of runArgv below normal priority":
    `Error: timed out waiting for …\omr-exec-0KCncP\grandchild.pid` at
    `waitForFile test/unit/exec.test.ts:143:9`, called from `:596:7`.
  - During the run the CPU was at 100 %. Another agent had 14 normal-priority
    `node -e "for(;;){}"` busy loops running (started 01:55:58–59).
  - The cause is a test-harness limit: see QA-1.2-22.
- The repro scripts lived in `%TEMP%\omr-qa12r4` and have been removed. No fixture, burner, stand-in
  or sweeper process was left running. A `Win32_Process` query on the scratch, fixture and
  stand-in names matched only the query itself, plus an unrelated process whose arguments happen
  to contain `pinned`.
  - `batch.mjs` tried the refusal-bypass spellings under both runtimes.
  - `hookcheck.mjs` imported `exec.ts` with `%SystemRoot%` pointing at a scratch root. Its
    `System32\taskkill.exe` was a `bun build --compile` stand-in that logs its arguments and runs
    the real `taskkill`, so every taskkill `exec.ts` starts could be seen and still took effect.
  - `exithost.mjs` put 3 `runShell` trees and 1 `runArgv` tree (cmd.exe → node → node) in flight,
    then called `process.exit(0)`. It was launched from pwsh, the way opencode is started.
  - `tkload.mjs` timed one 4-tree `taskkill /T /F` with no time limit.
  - `prio.mjs` timed how long a `lowPriority` fixture takes to write its grandchild's PID.
  - `rt.mjs` probed runtime details: the case of environment names, writes to a dead child's
    stdin, the `pid` of a failed spawn, and `spawnSync` with `timeout` inside an `exit` hook.
  - Load runs used 16 normal-priority node busy loops, one per logical core, each ending itself
    after 60–75 s.

**Result.**
- QA-1.2-17, -18, -19 and the -20 cross-reference are verified, along with the absolute-path
  hardening.
- No spelling of a batch target got past the refusal under either runtime.
- The exit hook never passed a stale PID, and one call killed every tree in flight, under both
  runtimes.
- There are 3 new findings: 1 minor and 2 nits.
  - QA-1.2-21 is a load limit of the QA-1.2-18 fix.
  - QA-1.2-22 is the test flake that failed the run above.
  - QA-1.2-23 is a pre-existing POSIX bookkeeping race.
- The DoD (zero open findings) is **not met**.

### Round-3 findings

| Finding | Status | Evidence |
|---|---|---|
| QA-1.2-17 | verified | **Code.** `BATCH_FILE = /\.(cmd\|bat)[. ]*$/i` (`exec.ts:111`) is tested in `runArgv` before `run` (`:130`), on win32 only, whatever `lowPriority` is. The result is exactly `BATCH_REFUSED` (`:113`). The unit test (7 spellings plus one relative to cwd, each with and without `lowPriority`) passes.<br>**Bypass hunt** (`batch.mjs`). Each case passed the argument `"&echo INJECTED&"` to a batch file that writes a marker. The results were the same under node v24.21.0 and bun 1.3.14.<br>• **Refused**: `probe.cmd`, `probe.CmD`, all forward slashes, a `\\?\` prefix, a `\\.\` prefix, UNC `\\127.0.0.1\C$\…\probe.cmd`, and `.\probe.cmd` relative to cwd.<br>• **Not refused, but no batch file ran** (no marker, no `INJECTED`):<br>&nbsp;&nbsp;– NUL bytes (`probe.cmd\0.exe`, `probe.cmd\0`): both runtimes throw `ERR_INVALID_ARG_VALUE … without null bytes`. The throw is caught, so the result is code 1.<br>&nbsp;&nbsp;– `probe.cmd\.`, `probe.cmd\`, `probe.cmd/`, `probe.cmd::$DATA` and `probe.cmd:` are all ENOENT. libuv looks only at the part after the last `\`, `/` or `:`; with no extension there, it tries `.com` and `.exe` only.<br>&nbsp;&nbsp;– A trailing NBSP gives ENOENT. A trailing tab gives EINVAL under node and ENOENT under bun.<br>&nbsp;&nbsp;– A hard link `link.exe` to the batch file gives `spawn UNKNOWN` (node) and `EUNKNOWN` (bun). This fits CreateProcess deciding "batch" from the name it is given.<br>&nbsp;&nbsp;– Batch content in `probe.cmdlong` gives EFTYPE. A bare `probe` gives ENOENT.<br>**8.3 names.** Not reproducible here: this volume no longer creates short names for new files (`dir /x` shows none). The short extension is the first three characters of the long one, so the short name of a `.cmd`/`.bat` file still ends `.CMD`/`.BAT`, and the regex matches it in any case. |
| QA-1.2-18 | verified; load limit: QA-1.2-21 | **Code.** One `tracked` set, with one lazy `process.once("exit", killTrackedProcesses)` (`exec.ts:418-426`).<br>• Windows untracks a child only at its `exit` (`:308`). POSIX untracks on settle (`:222`) and at `exit` when the group is already empty (`:309-312`).<br>• The Windows hook makes one `spawnSync(TASKKILL, [/pid …, /T, /F], { timeout: 2000 })` call (`:433-449`).<br>**No stale PID in the set** (`hookcheck.mjs`, node and bun). The hook was called after each of these, and it started **no** taskkill every time:<br>• 9 natural runs;<br>• 2 deadline kills of live trees (`runShell` and `runArgv`);<br>• an `early-exit` sweep;<br>• a `broken-tree` grace settle;<br>• a spawn error. The `pid` of a failed spawn is `undefined` under both runtimes (`rt.mjs`), so it is never tracked.<br>So under Bun too, `exit` is delivered on every path, and the set holds only live direct children.<br>**One call, several trees.** 4 runs were in flight (3 `runShell` with `lowPriority`, 1 `runArgv`).<br>• One taskkill got exactly 4 `/pid` arguments.<br>• All 8 descendants were dead 844 ms (node) and 812 ms (bun) after the hook started. The hook itself took 843 ms and 810 ms.<br>• A second call started nothing, because the set had been cleared.<br>**A PID that is already gone.** `taskkill /pid 4194300 /pid <cmdA> /pid <cmdB> /T /F` exits 128, and both trees are dead under node and bun. A missing PID does not stop the others.<br>**A real exit** (`exithost.mjs`, launched from pwsh, idle machine): 8 of 8 descendants were dead when the host exited, under node ×2 and bun ×2. The host's wall time was 658–1000 ms.<br>**The 2 s bound holds under Bun.** In an `exit` hook, `spawnSync` of a 20 s sleeper with `timeout: 2000` returned at 2015 ms (node) and 2025 ms (bun), with `ETIMEDOUT`/`SIGTERM`, and no sleeper was left.<br>The in-process hook test and the `exit-mid-run` host test both pass. |
| QA-1.2-19 | verified | **Code.**<br>• `finish` unrefs a sweep still in flight (`exec.ts:225`), and `unref()` covers the process handle, stdin and stdout (`:620-625`).<br>• The kill writes `kill\n` and does not end stdin (`:613`); the limit timer is unref'd (`:608`).<br>**Node.** The "sweep still in flight … does not keep the host alive" test passes.<br>**Bun.** `host.mjs hung-sweeper` ran with a `bun build --compile` `hang.exe` as the sweeper, launched from pwsh. Two runs:<br>• the result was `timedOut: true`, with only the force-closed note;<br>• the host exited **23 ms** and **26 ms** after the result (28042 ms before the fix);<br>• no `hang.exe` was alive afterwards.<br>**The live sweep still works without EOF.** The QA-1.2-1/-10 deadline and abort sweep tests pass.<br>**Writing to a sweeper that already exited adds no failure mode.** A write after the child's `exit` returns normally, and so does one after `close`, under node and bun (`rt.mjs`). |
| QA-1.2-20 | verified (cross-reference) | `origin/vrb/p13`, `docs/qa/verification-resource-budget/phase-1.3.md`:<br>• QA-1.3-18 (major) records `process.execPath` under Bun (line 544);<br>• its resolution `ca57cc7` (line 577) stops the JS tools defaulting to `process.execPath`.<br>On `vrb/p12`, `rg "process\.execPath\|runArgv" src` finds no `process.execPath`, and `runArgv` only inside `exec.ts` (`:3`, `:129`, `:138`). The plan wording stays deferred to 3.2. |
| Hardening (absolute `taskkill.exe` / `powershell.exe`) | verified | **Code.** `SYSTEM32`, `TASKKILL` and `DEFAULT_POWERSHELL` are built from `%SystemRoot%` (`exec.ts:93-95`) and used at `:400`, `:444` and `:489`.<br>**The path is really used.** With `%SystemRoot%` pointed at the scratch root, both the live-child kill and the exit hook ran `<root>\System32\taskkill.exe`, under node and under bun.<br>**The case of the variable does not matter.** A child whose environment block spells the name `SYSTEMROOT` (MSYS/Cygwin style) still resolves `process.env.SystemRoot`, under node and bun.<br>**No finding for reading it from the environment.** Bare names are the fallback only when `SystemRoot` is unset. Whoever controls the environment already controls `PATH` and the command being verified. |

### Bun compatibility (additions to round 3)

| Aspect | node v24.21.0 | bun 1.3.14 | Verdict |
|---|---|---|---|
| The `runArgv` refusal, and the bypass spellings above | as in the table above | the same | same |
| Exit hook: tracked-set hygiene, one call for 4 trees, a gone PID in the list | as above | the same | same |
| `process.exit(0)` from a host launched from pwsh, 4 trees in flight | 8/8 dead at exit | 8/8 dead at exit | same |
| `spawnSync` with `timeout: 2000` inside `exit` | 2015 ms, `ETIMEDOUT` | 2025 ms, `ETIMEDOUT` | same |
| A hung sweeper after the run settled | the test passes | result → exit in 23 and 26 ms | same |
| `process.env.SystemRoot` with a `SYSTEMROOT` key | resolves | resolves | same |
| `pid` of a failed spawn | `undefined` | `undefined` | same |
| A child's environment under `spawnSync` with no `env` option | the current `process.env` | **the environment the process started with**: a variable set at run time was not seen | differs. No finding: the hook's `taskkill` needs no environment, `run` always passes `env` (`exec.ts:173`), and the async spawns did pass the run-time value |

### New findings

| ID | Severity | Where | Evidence | Fix |
|---|---|---|---|---|
| QA-1.2-21 | minor | `exec.ts:82` (`EXIT_TASKKILL_TIMEOUT_MS = 2000`) and `:444-448` | **Under normal-priority saturation, the exit hook's 2 s limit ends `taskkill` part-way, and what it had not reached yet runs on with nothing left to kill it.**<br>**Measured.** `exithost.mjs` ran under 16 normal-priority busy loops, with `lowPriority: false` so that the fixtures could start. There were 6 exits (node ×3, bun ×3).<br>• From `ready` to the host's exit took 1927, 2286, 2150, 2270, 1998 and 2001 ms: the hook sat at its limit.<br>• In the bun exit at 2286 ms, **3 of the 8** descendants were alive at the host's exit and still alive 3 s later. The reviewer killed them.<br>**The same taskkill with no limit** (`tkload.mjs`: one `taskkill /pid a /pid b /pid c /pid d /T /F`):<br>• idle: 309, 321, 364 and 376 ms;<br>• under the same load: 2033, 2124, 2181 and **3383 ms**.<br>So under saturation the limit usually lands before taskkill has finished. `spawnSync`'s timeout then terminates it.<br>This is QA-1.2-14's pattern again: a short limit turns "slow" into "never". This time nothing comes later, because opencode is gone. | 1. Raise `EXIT_TASKKILL_TIMEOUT_MS`, for example to 10000 ms. It only costs time when taskkill is slow: idle exits still take 0.3–0.8 s. And it is the last chance to reach these trees.<br>2. Add to G4's known limits (the wording is deferred to 3.2): under normal-priority saturation, host exit can leave part of a tree when the limit is hit.<br>3. Optionally, 3.1's load run can repeat the `exithost` shape. |
| QA-1.2-22 | nit | `test/unit/exec.test.ts:134-144` (`waitForFile`: 100 × 50 ms = 5 s), used at `:596` and `:610` by the two `lowPriority` grandchildren tests (60 s test timeout) | **The gating run failed here, as in round 3's "Load flake".** Below-normal priority yields to normal-priority load by design, but the harness gives the fixture only 5 s to start.<br>**`prio.mjs` under 16 normal-priority busy loops.**<br>• One `runArgv` `lowPriority` fixture had not written its grandchild's PID after **30 s**. The other two took 138 and 137 ms.<br>• Normal-priority runs took 1021, 137 and 122 ms.<br>• Idle, every run took 120–139 ms.<br>The priority property itself does not depend on timing. The same load also hit the 20 s `timeoutMs` of the `lowPriority` exit-code tests in round 3. | 1. Give `waitForFile` a limit parameter and pass the test's own budget (for example 45 s) in the two `lowPriority` tests.<br>2. Raise `timeoutMs` in the `lowPriority` exit-code tests the same way.<br>3. Alternatively, state in the test file that the `lowPriority` tests need a machine that is not saturated by normal-priority load.<br>This is a test-only change. |
| QA-1.2-23 | nit (pre-existing since `6966a5c`; POSIX only) | `exec.ts:222` together with `:309-312` | **The POSIX tracked set is keyed by a recyclable id, and one run can untrack another run's group.**<br>**How.** When the group is empty at `exit`, the id is untracked there, and `finish` untracks it again. The same happens when the group empties after `exit` but before `close`. In both cases the id is free in between. If a new run's child gets that PID (it leads a group with that id and is tracked), the old run's `finish` deletes the new run's entry. The exit hook then misses that group.<br>**Why it is rare.** The window stays open only while something outside the group holds the pipes: the `setsid` residual, bounded by the deadline plus the 2 s grace. The PID also has to wrap around inside it.<br>**Found by reading.** It cannot be run on this Windows host. `78c71dd` renamed this code without changing it. Windows is not affected: it untracks only at `exit` (`:308`). | 1. Make `tracked` a `Map<pid, runToken>`, and have `untrack` delete an entry only when the token is its own run's. A recycled id overwrites the entry, which is correct: the old group cannot still exist once its id belongs to a new group.<br>2. Record the related residual that no fix can close without pidfd. If the group empties after `exit` and its id is recycled by an unrelated group, the late `kill()` (`:292`) or the exit hook can signal that group. The conditions are the same (a `setsid` escapee holding the pipes, plus PID wrap-around). |

### Checked, no finding

- **Tracking order.** `track(pid)` runs after `setPriority` (`exec.ts:202`), so nothing new
  sits between the spawn and the priority call. `exitHookInstalled` (`:419-425`) installs the hook
  once, and the in-process test asserts exactly one listener after several runs.
- **The hook's own cost when nothing is in flight.** With an empty set it returns before
  spawning (`:440`): each empty call in `hookcheck.mjs` took 0–1 ms.
- **A direct child that exited just before the hook.** Its PID is still tracked until libuv
  delivers `exit`. taskkill then reports it as not found, which does not stop the other PIDs (the
  stale-PID case above). What it left running stays under G4 limit (a), as the header says.
- **The refusal checked before the abort.** A `.cmd` target with a signal that is already aborted
  now resolves as the refusal (`code 1, timedOut: false`), not as a pre-aborted run. Both are "did
  not run"; no caller depends on the difference.
- **Over-refusal.** `probe.cmd.`, `\\?\…\probe.cmd.` and short names that end `.CMD` are refused
  even where no such batch file exists. That only turns a would-be ENOENT into the refusal.

### Deferred by plan (not open)

- **deferred by plan (3.1)**, unchanged from round 3, with these additions:
  - The Bun smoke should also cover the multi-run exit shape (`exithost`: several `runShell`
    trees in flight, then `process.exit(0)`). It should be launched from a shell, not from node.
  - The loaded run should include the exit hook (QA-1.2-21's measurement).
  - The coverage gate is unchanged.
- **deferred by plan (3.2):**
  - QA-1.2-12;
  - the G4 wording and risk-table row;
  - the QA-1.2-20 plan wording;
  - the known limit added in round 3;
  - QA-1.2-21 item 2, once it is resolved.
- **deferred by plan (2.1):** QA-1.2-13, unchanged.

**Status: phase 1.2 QA is not CLEAN.** QA-1.2-21 (minor), QA-1.2-22 (nit) and QA-1.2-23 (nit)
are open.

