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

### Round-4 resolutions

- QA-1.2-21 — Resolution: 2d6ff09 — `EXIT_TASKKILL_TIMEOUT_MS` raised from 2000 to 10_000 ms. The comment now states that host exit may be delayed up to 10 s, and only while a verification is in flight (with none, the hook spawns nothing). G4 known limit (wording deferred to 3.2): under normal-priority CPU saturation that slows taskkill past this limit, host exit can still leave part of a tree.
- QA-1.2-22 — Resolution: 2d6ff09, 33f1d14 — 2d6ff09: `waitForFile` takes a limit; the two `lowPriority` grandchild tests wait 30 s for the fixture with `timeoutMs: 30000` (test timeout 90 s), and the `lowPriority` exit-code tests use `timeoutMs: 60_000`, but their vitest timeout stayed at 20 s. 33f1d14: the vitest timeout of the exit-code tests (two sequential 60 s runs) and of the Windows `.cmd` exit-code test (a 20 s and a 60 s run) is raised to 130 s. Test-only change.
- QA-1.2-23 — Resolution: 2d6ff09 — `tracked` is a `Map<pid, token>`; each run tracks with its own token and `untrack` deletes only when the token matches, so a recycled id tracked by a new run survives the old run's second untrack. Unit test `tracked-process bookkeeping (QA-1.2-23)` via `trackingForTests`. Documented residual (needs pidfd): a group that empties after `exit` and whose id is recycled by an unrelated group can be signalled by the late kill or the exit hook.
- Verification: `npx vitest run --maxWorkers=2 test/unit/exec.test.ts` twice, 39 passed / 1 skipped each (36.3 s, 35.1 s); `npm run typecheck` clean; no fixture processes left.

## QA re-review (round 5)

Reviewer: heavy QA, adversarial re-review of the round-4 fixes, `git diff a3fb8af..a14ba68` on
`vrb/p12` (`2d6ff09`, `9d49eea`, `33f1d14`, `a14ba68`: `src/verify/exec.ts`,
`test/unit/exec.test.ts` and this file), under node and **Bun 1.3.14**. The POSIX paths were run
on Linux under WSL.

**Setup.**
- Hosts:
  - Windows 11, 16 logical cores, node v24.21.0, bun 1.3.14. Other agents were using the machine.
  - WSL 2 Ubuntu (kernel 6.18.33.1-microsoft-standard-WSL2, `pid_max` 4194304), node v25.9.0.
- `npx vitest run --maxWorkers=2 test/unit/exec.test.ts` was run once (node): **38 passed,
  1 failed, 1 skipped** (40 in total), 58.87 s.
  - The failure is "process lifecycle around the direct child's exit > an abort between the
    child's exit and the pipes closing kills the leftovers, not the exited PID":
    `AssertionError: expected true to be false`. In that test only
    `expect(alive(holder)).toBe(false)` (`exec.test.ts:443`) produces this message, so the run
    resolved while the holder was still alive. See QA-1.2-26.
  - No test the diff added or changed failed. The new bookkeeping test passed.
- `npm run typecheck` is clean.
- The repro scripts lived in `%TEMP%\omr-qa12r5` (and `/tmp/omr-qa12r5` in WSL) and have been
  removed. Afterwards, a `Win32_Process` query on the scratch, fixture and stand-in names matched
  nothing, and so did `ps` in WSL.
  - `exithost.mjs` imported `exec.ts` with `%SystemRoot%` pointed at a scratch root. Its
    `System32\taskkill.exe` was a `bun build --compile` stand-in that logs its arguments and then
    either hangs for 60 s or runs the real taskkill. The host put 2 `runShell` trees
    (cmd.exe → node → node) in flight and called `process.exit(0)`. It was launched from pwsh.
  - `hyg.mjs` used the same root with the forwarding stand-in, so every taskkill the exit hook
    starts could be seen.
  - `posix.mjs` ran as root in its own PID namespace (`unshare -p -f --mount-proc`), so it could
    give a chosen PID to a new run through `/proc/sys/kernel/ns_last_pid`. It wrapped
    `child_process.spawn` through `syncBuiltinESMExports` to learn each run's direct child. It ran
    against the new `exec.ts` and against `a3fb8af`'s.
  - `sweeptime.mjs` repeated the failing test's sequence 8 times, with timings.
  - `graceverdict.mjs` repeated that sequence with a sweeper stand-in: a `bun build --compile`
    binary set through `setSweeperExecutableForTests`. It kills the holder with the real taskkill
    at once and prints the holder's PID either 0 ms or 2500 ms later.
  - `vacuous.mjs` repeated the `lowPriority` grandchild test with a fixture that starts its
    grandchild late.

**Result.**
- QA-1.2-21, -22 and -23 are verified. -22 has one gap (QA-1.2-25).
- `trackingForTests` is not reachable from the plugin's exports.
- There are 4 new findings: 1 minor and 3 nits.
  - QA-1.2-25 is a gap in this round's diff.
  - The other three are in older code. They were found through the failing gating run and the
    POSIX repro.
- The DoD (zero open findings) is **not met**.

### Round-4 findings

| Finding | Status | Evidence |
|---|---|---|
| QA-1.2-21 | verified | **Code.** `EXIT_TASKKILL_TIMEOUT_MS = 10_000` (`exec.ts:89`) is used only by the hook's single `spawnSync` (`:466-470`). The comment (`:81-88`) matches the round-4 measurements.<br>**The limit holds under both runtimes.**<br>• With the hanging stand-in, the host exited 10174 ms (node) and 10167 ms (bun) after `ready`. There was one call, `/pid <a> /pid <b> /T /F`. The stand-in was dead after the host exited: `spawnSync`'s timeout ended it. The 4 descendants were still alive, as expected with a stand-in that kills nothing; the reviewer ended them.<br>• With the forwarding stand-in, 4 of 4 descendants were dead when the host exited, under node and bun, 2422 and 2413 ms after `ready`. That time includes starting the ~98 MB stand-in.<br>**No cost when idle.** Called with nothing in flight, the hook started no taskkill and took 0–1 ms. |
| QA-1.2-22 | verified, with a gap: QA-1.2-25 | **Code.**<br>• `waitForFile(path, limitMs = 5000)` (`exec.test.ts:134`).<br>• The grandchild tests wait 30 s for the fixture, with a 90 s vitest timeout (`:613`, `:620`, `:628`, `:635`).<br>• The exit-code tests use `timeoutMs: 60_000` with a 130 s vitest timeout (`:639-641`).<br>**The budgets fit.** 30 s of waiting, at most 30 s of `priorityOf`, the 2 s grace and 5 s of `waitForExit` stay under 90 s. Two runs of 60 s plus 2 s stay under 130 s.<br>**Gap.** The `.cmd` test got the 130 s vitest timeout, but its `lowPriority` `t.cmd` run still has `timeoutMs: 20000` (`:646`): QA-1.2-25.<br>**A window checked and refuted.**<br>• The 30 s wait now equals the run's own 30 s deadline.<br>• On Windows, `priorityOf` returns 0 for a PID with no process: the query prints nothing and `Number("")` is 0. `lowered(0)` is true.<br>• With a fixture that wrote its grandchild's PID at 29821 ms (`lowPriority: false`), the query still saw the live grandchild at priority 8, and the assertion failed as it should. `priorityOf` is a synchronous `execFileSync`, so the deadline timer fired only after it returned; the run settled at 31134 ms.<br>• A dead process can pass only if the file appears within one 50 ms poll before the deadline.<br>• Optional hardening, not a finding: make `priorityOf` throw on empty output. |
| QA-1.2-23 | verified; the late-kill side is QA-1.2-27 | **Code.**<br>• `tracked` is a `Map<number, symbol>` (`exec.ts:433`), and each run has its own `Symbol("run")` (`:209`).<br>• `untrack` deletes only when the token matches (`:443-445`). It is called at `:230`, `:316` and `:319`.<br>• The hook iterates `tracked.keys()` (`:456`).<br>**POSIX, real processes** (WSL, own PID namespace).<br>• Run A's child exited with its group empty; a `setsid` holder kept the pipes. So A untracked PID 77 at `exit`.<br>• `ns_last_pid` then gave PID 77 to run B's child, at the first attempt.<br>• New code: B was tracked, A settled (its second untrack), and B was **still tracked**. The exit hook then killed B's group, and B resolved with `code 1`.<br>• `a3fb8af`'s code, same sequence: the hook did **not** reach B, which was still pending 5 s after the hook. The round-4 defect is reproduced, and the new code fixes it.<br>**POSIX hygiene.** Each run's PID was untracked after:<br>• a natural `runArgv`;<br>• `runShell` `exit 3`;<br>• both of those with `lowPriority`;<br>• a `nice` exec failure;<br>• a deadline on a live group;<br>• a deadline after the child's exit with a group member left (`[killed the process group…]`);<br>• a grace settle with a `setsid` escapee.<br>A spawn error has no PID and is never tracked.<br>**Windows, node and bun.** The hook started no taskkill after:<br>• 5 natural runs;<br>• 2 deadline kills of live trees;<br>• an `early-exit` sweep;<br>• a `broken-tree` grace settle;<br>• a spawn error.<br>With one run in flight, the hook made one call (`/pid <cmd.exe> /T /F`) and the tree was dead. A second call started nothing.<br>**Why Windows is safe.** An entry cannot be overwritten before its owner's `exit`: libuv holds the handle until then, and the untrack runs in that same callback.<br>**The unit test passes.** With the old `Set` semantics, its first `isTracked` check would fail. |
| `trackingForTests` reachability | verified | • `rg trackingForTests src` matches only its definition (`exec.ts:448`).<br>• The only runtime export of `src/index.ts` is `default` (`:1548`); `:106-110` are `export type` lines.<br>• The only production importer of `exec.ts` is `wiring.ts:20`, and it imports only `runShell`.<br>• `package.json` has no `exports` map (`main: ./src/index.ts`, `files: src/`). A deep import of `src/verify/exec.ts` is therefore possible, the same as for `setSweeperExecutableForTests` (round 3).<br>• The test's PID, 2_000_000_123, is above Linux's `pid_max` limit and never a live Windows PID. If the test fails midway, the leftover entry only makes the hook report "not found" or `ESRCH`. |

### New findings

| ID | Severity | Where | Evidence | Fix |
|---|---|---|---|---|
| QA-1.2-24 | minor (pre-existing since `6966a5c`; Windows) | `exec.ts:269-282` (`onGrace`), with `:334-341` (`close`) and `:249-259` (`onSwept`) | **The grace can settle a swept run as a natural exit, and the result then loses the kill.**<br>**How.**<br>1. The sweep's taskkill ends the holder, so the pipes close. `close` waits for the sweep's report (`sweepPending`).<br>2. If the report has not arrived when the grace fires, `onGrace` sees `closed` and calls `finish(closeCode)` with `killed` still false.<br>3. The result is `{ code: 0, timedOut: false }` with no note. The report that comes later is dropped, because the run has settled.<br>**What this contradicts.**<br>• The header: "`timedOut` is true exactly when the deadline or abort had to end something".<br>• QA-1.2-2's resolution: the run waits for the sweep, "bounded by the same timer, so `timedOut` reflects what was actually killed".<br>The same abort therefore gives `code 1, timedOut: true` or `code 0, timedOut: false`, depending on how fast PowerShell prints.<br>**Measured** (`sweeptime.mjs`, the failing test's sequence, the real PowerShell sweeper):<br>• runs 0–4: the holder died at +1157 to +1346 ms; `code 1, timedOut: true`, with `[killed 1 process tree(s)…]`;<br>• **run 5: the holder died at +1829 ms; the result came at +2016 ms as `code 0, timedOut: false`, with empty stderr**.<br>**Deterministic** (`graceverdict.mjs`, a stand-in that kills at once and reports 2500 ms later): the holder died at +1664 ms, and the result came at +2004 ms as `{"code":0,"stdout":"","stderr":"","timedOut":false}`. With a 0 ms report, the same fixture gave `code 1, timedOut: true` and the kill note at +1761 ms.<br>In a second 2500 ms run, the stand-in's kill itself landed after the grace (+2382 ms). The force-closed path then gave `timedOut: true`, which is correct.<br>**Impact.** A deadline that had to kill a leftover can be reported as a clean `code 0` when the direct child exited 0. This is more likely under load, when PowerShell is slow. | 1. In `onGrace`, when `closed && sweepPending`, check whether the sweeper has printed `pinned <n>` with n > 0.<br>&nbsp;&nbsp;– If it has, it may have killed: set `killed = true` and add a note, for example `[orphan sweep still reporting at settle: it may have ended what held the pipes]`.<br>&nbsp;&nbsp;– If it has not pinned yet, it cannot have killed anything, so the natural result stands. This keeps the QA-1.2-10 no-op.<br>&nbsp;&nbsp;– `Sweeper` needs an accessor for the pinned count.<br>2. Add a Windows test: the `early-exit` fixture, with a stand-in sweeper (through `setSweeperExecutableForTests`) that pins, kills the holder at once and reports after `KILL_GRACE_MS`. Assert `timedOut: true`. |
| QA-1.2-25 | nit (test-only; a gap in the QA-1.2-22 fix) | `test/unit/exec.test.ts:646` | The `.cmd` exit-code test's first run, `runShell("<t.cmd>", { timeoutMs: 20000, lowPriority: true })`, keeps its 20 s deadline. That is the budget that failed under load in round 3 ("two other `lowPriority` runs hit their 20 s deadline (`expected 1 to be 3`)"). The `.cmd` test is one of the two tests that can fail with that message. | Raise it to `timeoutMs: 60_000`, as in the other exit-code tests. Two runs of 60 s plus 2 s fit in the 130 s vitest timeout. |
| QA-1.2-26 | nit (test-only; pre-existing) | `test/unit/exec.test.ts:421` and `:443` | **The gating run failed here.** Both lifecycle tests assert that the holder is dead the moment the run resolves.<br>• The run resolves at most `KILL_GRACE_MS` (2 s) after the kill. So the tests require the Windows sweep to finish within 2 s, which is stricter than G4's 3 s. When the sweep is slower, the grace settles the run first.<br>• Measured (`sweeptime.mjs` run 6, with other agents' work taking the CPU to 100 %): the result came at +2021 ms with the force-closed note, and the holder died at +4088 ms.<br>• Idle, the sweep kills at +1.2 to +1.35 s, which leaves 0.65–0.8 s of margin. | 1. Check the holder with `waitForExit` up to G4's bound (3 s after the deadline or the abort), not at the result.<br>2. When the sweep is late, the result carries the force-closed note, not the sweep note. Either accept both notes, or state in the test file that these tests need a machine that is not saturated by normal-priority load, as QA-1.2-22 option 3 did. That load is G4 limit (c), which 3.1's loaded run covers. |
| QA-1.2-27 | nit (pre-existing since `6966a5c`; POSIX) | `exec.ts:300-305` (the late kill) and `:430-432` (the residual comment) | **The late kill can SIGKILL another run's group, although the map now shows when.**<br>**How.**<br>1. A run whose group empties after `exit` stays tracked (`groupGone` is false).<br>2. If its id is recycled by a new run's group, the new run overwrites the entry.<br>3. A deadline or abort of the old run still calls `signalGroup(pid, "SIGKILL")`.<br>**Measured** (WSL, own PID namespace; the new code and `a3fb8af` behave the same):<br>• Run A's child exited with a group member left and a `setsid` holder on the pipes, so A was still tracked at exit.<br>• The member then exited, and `ns_last_pid` gave PID 84 to run B.<br>• Aborting A killed B's group. B resolved `{ code: 1, timedOut: false }`, a false failure.<br>• A resolved `timedOut: true` with `[killed the process group left running by the exited command]`, but the group it killed was B's.<br>**Why it is fixable.** The comment calls this residual "not fixable without pidfd". That holds for an unrelated group. For a run of this process, the token shows the recycle: A's own entry is deleted only once its group was seen empty (`groupGone`) or at settle.<br>**Rarity.** The conditions are QA-1.2-23's: a `setsid` escapee on the pipes, plus PID wrap-around. | 1. Signal only while the entry is still the run's own: `pid && !groupGone && tracked.get(pid) === trackToken && signalGroup(pid, "SIGKILL")`. After the exit hook has cleared the map, opencode is exiting anyway.<br>2. Narrow the comment to unrelated groups.<br>3. Add a POSIX test. Overwrite a running run's entry with `trackingForTests.track(pid, Symbol())` to stand in for the recycle. Then abort the run, and assert that there is no `[killed the process group…]` note and that the group member is still alive. |

### Checked, no finding

- **The hook's longer limit costs time only while a run is in flight.** With an empty map, the
  Windows hook returns before spawning anything (`exec.ts:462`). POSIX signals synchronously and
  is unchanged.
- **`waitForFile`.** The loop makes `limitMs / 50` iterations of at least 50 ms each, so the
  wall-clock wait is never shorter than the limit.
- **The bookkeeping test and the exit hook.** Its `track` installs the exit hook when it runs
  first, and `exitHookInstalled` keeps it to one listener. The hook test (`:521-543`) asserts one
  listener. The bookkeeping test untracks its own entry before it ends.

### Deferred by plan (not open)

- **deferred by plan (3.1):** unchanged from round 4.
- **deferred by plan (3.2):** unchanged from round 4. This includes QA-1.2-21 item 2 (the
  known-limit wording); its code change is verified above.
- **deferred by plan (2.1):** QA-1.2-13, unchanged.

**Status: phase 1.2 QA is not CLEAN.** QA-1.2-24 (minor) and QA-1.2-25, QA-1.2-26 and QA-1.2-27
(nits) are open.

### Round-5 resolutions

- **QA-1.2-24.** Resolution: dcf5ff7 — `onGrace` now counts a run as killed when the pipes closed while the sweep was still reporting and the sweeper had already printed `pinned <n>` with n > 0. It sets `timedOut: true` (code 1) and appends `[orphan sweep still reporting at settle: it may have ended what held the pipes]`. A sweep that has not pinned anything yet leaves the natural result in place (QA-1.2-10). `Sweeper.pinnedCount()` reads the marker. Test: the `late-sweeper` host mode uses `setSweeperExecutableForTests` with a stand-in that pins 1, kills the holder at once and reports after 2500 ms. Without the fix it failed with `{ code: 0, timedOut: false }`; with the fix it passes.
- **QA-1.2-25.** Resolution: a945e5e — the `.cmd` exit-code test's `lowPriority` `t.cmd` run now uses `timeoutMs: 60_000`. Two runs of 60 s plus 2 s stay inside the 130 s vitest timeout.
- **QA-1.2-26.** Resolution: a945e5e — both lifecycle tests now record when the run settled and then poll the holder with `waitForExit` until G4's bound (3 s after the deadline or the abort), rather than requiring it dead at resolve time. The note may be the sweep's, the grace's force-close note or the still-reporting note (`LEFTOVER_KILLED`).
- **QA-1.2-27.** Resolution: 024640e — the POSIX late kill now signals `-pgid` only while `ownsTracked(pid, trackToken)` holds, so a new run that took the recycled id (and overwrote the entry) is skipped. The residual comment is narrowed to groups that do not belong to a run of this process. Tests: a map-level test that runs on every platform replays track(old) → track(new) and checks the old run no longer owns the entry. A POSIX-only real-process test (`runIf(!isWin)`) overwrites a live run's entry, aborts, and asserts there is no group-kill note and the holder is still alive. It is **not run on this Windows host**.

Verification (Windows 11, node): `npx vitest run --maxWorkers=2 test/unit/exec.test.ts` twice, 41 passed | 2 skipped (43) both times; `npm run typecheck` clean. No fixture or stand-in processes were left afterwards.

## QA re-review (round 6)

Reviewer: heavy QA, adversarial re-review of the round-5 fixes, `git diff db7ba68..2529f85` on
`vrb/p12` (`dcf5ff7`, `a945e5e`, `024640e`, `2529f85`: `src/verify/exec.ts`,
`test/unit/exec.test.ts`, `test/fixtures/exec/host.mjs` and this file), under node and
**Bun 1.3.14**. The POSIX-only test was run on Linux under WSL.

**Setup.**
- Hosts:
  - Windows 11, node v24.21.0, bun 1.3.14.
  - WSL 2 Ubuntu (8 CPUs), node v25.9.0.
- `npx vitest run --maxWorkers=2 test/unit/exec.test.ts` was run once (node, Windows):
  **41 passed, 2 skipped** (43 in total), 40.44 s.
- `npm run typecheck` is clean (exit 0).
- The repro scripts lived in `%TEMP%\omr-qa12r6` (and `/tmp/omr-qa12r6` in WSL) and have been
  removed. Afterwards, a `Win32_Process` query on the scratch, fixture and stand-in names matched
  nothing, and so did `ps` in WSL. The worktree is unchanged.
  - `standin.exe` was a `bun build --compile` sweeper stand-in, set through
    `setSweeperExecutableForTests`. It reads its behaviour from the environment it inherits and
    logs each event with a timestamp. The modes were:
    - `late-kill`: print `pinned 1`, kill the holder when `kill` arrives, report it 2500 ms later;
    - `fast-kill`: the same, but report at once;
    - `unpinned`: print no marker for 5 s, kill nothing;
    - `pinned-nokill-late`: print `pinned 1`, kill nothing, exit 2500 ms after `kill` without
      reporting a PID;
    - `pinned-nokill-fast`: the same, but exit at once.
  - `repro.mjs` ran `runArgv(node, [tree.cjs, "early-exit", dir])` and aborted 500 ms after the
    direct child's exit, when the sweeper was armed. In the modes whose stand-in kills nothing,
    it released the holder right after the abort, so the holder ended on its own inside the
    grace. The times below are measured from the abort.
  - Mutants were built in a `git archive` copy of `2529f85` (Windows: `node_modules` linked to the
    worktree's; WSL: `npm ci` for Linux). Only the copies were edited.

**Result.**
- QA-1.2-24, -25, -26 and -27 are verified. The new POSIX-only test ran on Linux, and it
  passes. With the guard removed, it fails.
- The QA-1.2-24 rule is judged sound: count a kill only when the sweep pinned trees.
  - It never marks a run that finished before its deadline as killed.
  - It counts a slow sweep that pinned trees as a kill even when that sweep ended nothing. That
    is the fail-closed side, and it is accepted, but the header's contract now misstates it
    (QA-1.2-28).
- There are 2 new findings, both nits and both introduced by `dcf5ff7`:
  - QA-1.2-28 (documentation);
  - QA-1.2-29 (a test gap).
- The DoD (zero open findings) is **not met**.

### Round-5 findings

| Finding | Status | Evidence |
|---|---|---|
| QA-1.2-24 | verified; wording: QA-1.2-28; test gap: QA-1.2-29 | **Code.**<br>• `onGrace` (`exec.ts:280-287`) takes the new branch only when `closed && sweepPending && sweeper.pinnedCount() > 0`. It sets `killed` and pushes `[orphan sweep still reporting at settle: it may have ended what held the pipes]`.<br>• `pinnedCount` (`:600-604`) reads the first `pinned <n>` line. A partial or non-integer line counts as 0.<br>• A settle through the branch unrefs the sweep that is still in flight (`:233`). Its later report is dropped by `finish`'s `settled` check.<br>**The fix, node and bun** (`repro.mjs` with `standin.exe`):<br>• `late-kill`, 3 runs under node: the holder died at +189, +58 and +78 ms. The run settled at +2009, +2008 and +2006 ms as `{ code: 1, timedOut: true }`, with the still-reporting note as its only stderr. The stand-in reported at +2697, +2566 and +2570 ms.<br>• `late-kill`, 3 runs under bun: the same result, settled at +2013, +2017 and +2012 ms.<br>• `fast-kill`, the control: `[killed 1 process tree(s)…]` at +77 ms (node) and +103 ms (bun).<br>**The implementer's choice to leave an unpinned sweep as a natural exit.**<br>• `unpinned`, 2 runs each under node and bun: the holder ended on its own at +29 to +61 ms. The run settled at the grace (+2009 to +2015 ms) as `{ code: 0, stdout: "", stderr: "", timedOut: false }`. So the QA-1.2-10 no-op holds with the sweep still pending at the grace.<br>• The choice is correct. The real script prints the marker before it reads `kill`, and kills only after that (`:582-585`). `[Console]::Out` flushes each line. A sweep with no marker has therefore killed nothing.<br>**Can a clean run now read as killed? No.**<br>• A run whose pipes close before a kill settles at `close`, because no sweep is pending (`:348-349`).<br>• A settled run ignores the kill (`:292`), and `finish` clears the timer and the abort listener (`:224-227`).<br>• So the branch is reachable only after a deadline or abort that found the pipes still held.<br>**Can a run whose sweep ended nothing read as killed? Yes, by design.** This is QA-1.2-28.<br>• `pinned-nokill-late`: the holder ended on its own (node +78/+61 ms, bun +78/+30 ms). The stand-in exited 2500 ms later without killing or reporting anything. Every run settled at the grace as `{ code: 1, timedOut: true }` with the still-reporting note.<br>• `pinned-nokill-fast`: the same events, with the report on time. The runs settled at +96 and +90 ms (node) and +51 ms (bun) as `{ code: 0, timedOut: false }` with empty stderr.<br>• The ambiguity is the mirror image of QA-1.2-24: at the grace, "the sweep's kill closed the pipes" and "the holder ended on its own" cannot be told apart. Counting it as a kill fails closed, which is the right side for a verifier. It needs a leftover still holding the pipes at the deadline, which ends on its own within 2 s, while PowerShell takes more than 2 s to report.<br>**The test discriminates.** Mutant B disables the branch (`else if (false)`). The QA-1.2-24 test then fails with `expected { code: +0, stdout: '', …(2) } to match object { code: 1, timedOut: true }`, as the resolution says. |
| QA-1.2-25 | verified | The `.cmd` test's `t.cmd` run uses `timeoutMs: 60_000` (`exec.test.ts:725`), inside a 130 s vitest timeout (`:729`). Two runs of 60 s, each with the 2 s grace, stay under 130 s. The test passed in the gating run. |
| QA-1.2-26 | verified; the tests are not weakened | **Code.**<br>• Both tests record `settledIn`. They then poll the holder with `waitForExit` until G4's bound: `start + 3000 + 3000` (`:432`) and `abortedAt + 3000` (`:456`). They still assert `settledIn` below the same bounds, and `{ code: 1, timedOut: true }`.<br>• `LEFTOVER_KILLED` (`:419`) also accepts the force-close note and the still-reporting note.<br>**What still proves the kill.**<br>• The holder ends on its own only when released (in `finally`, after the assertions) or after 20 s (`tree.cjs`). Inside the bound, only the sweep (Windows) or the group kill (POSIX) can end it.<br>• Mutant C disables `sweep()` (`if (swept \|\| !pid \|\| true) return`). Both tests then fail, at `exec.test.ts:432` and `:456` (`expected false to be true`, the `waitForExit` line). The force-close note and `timedOut: true` alone do not let them pass.<br>• Linux: both tests pass (3005 ms and 657 ms). The group-kill note matches `LEFTOVER_KILLED`. |
| QA-1.2-27 | verified | **Code.** The late kill signals `-pid` only when `pid && !groupGone && ownsTracked(pid, trackToken)` (`exec.ts:307`). `ownsTracked` (`:458-461`) is also what `untrack` uses now.<br>**The guard never skips one of this run's own groups.**<br>• The run's own entry leaves the map in three ways, and none of them needs the late kill: (1) at `exit`, only with `groupGone` set, which the guard already excludes; (2) at settle, after which `kill` returns early; (3) in the exit hook, when opencode is exiting.<br>• An overwrite needs the same id in a new group. Linux and the BSDs do not hand out an id while a process group still uses it. So a skipped group is never this run's own.<br>**Linux (WSL).**<br>• The test file ran on a `git archive` copy with Linux dependencies (`npm ci`): **35 passed, 8 skipped** (43). The POSIX-only test "a late kill skips a process group whose entry another run now owns" passed in 2758 ms: the abort, then the 2 s grace, force-closing the streams the holder still held.<br>• Mutant D removed `ownsTracked(pid, trackToken) &&` (`sed`). The POSIX test then fails with `expected '[killed the process group left runnin…' not to match /killed the process group/`, so it discriminates. The map-level test still passes, as expected: it checks only the map.<br>• Round 5 showed with `ns_last_pid` that a real recycle overwrites the entry. The guard reads exactly that overwrite.<br>**The comment** (`:439-443`) now limits the residual to groups that are not runs of this process. That is accurate. |

### Bun compatibility (additions to round 5)

| Aspect | node v24.21.0 | bun 1.3.14 | Verdict |
|---|---|---|---|
| A pinned sweep reporting after the grace (`late-kill`) | `code 1, timedOut: true`, still-reporting note (3/3) | the same (3/3) | same |
| An unpinned sweep pending at the grace (`unpinned`) | natural `code 0`, empty stderr (2/2) | the same (2/2) | same |
| A pinned sweep that ended nothing, reporting late or on time | late: `timedOut: true`; on time: `code 0` | the same | same (QA-1.2-28 applies to both) |

The `late-sweeper` host mode wraps `spawn` and runs under node only, like `hung-sweeper`. The
table above covers Bun for QA-1.2-24 through the compiled stand-in. QA-1.2-27 is map logic in JS,
with no runtime API in the new code. It was not run under Bun on Linux.

### New findings

| ID | Severity | Where | Evidence | Fix |
|---|---|---|---|---|
| QA-1.2-28 | nit (documentation; introduced by `dcf5ff7`) | `exec.ts:21-23` (the header's G4 bullet) and `:44` (`ShellResult.timedOut`) | **The documented contract no longer matches the code.**<br>• The header says "`timedOut` is true exactly when the deadline or abort had to end something … An abort that finds nothing left running is a no-op: the natural result stands". `ShellResult.timedOut` says "True when the deadline or the abort signal ended the command".<br>• Since `dcf5ff7`, a sweep that pinned trees and is still reporting at the grace counts as a kill even when it ended nothing. The code comment (`:281-284`) and the note ("it *may* have ended") say so; the contract does not.<br>**Measured** (`pinned-nokill-late`, node and bun): the holder ended on its own at +30 to +78 ms and the sweep killed nothing, yet the result was `{ code: 1, timedOut: true }`. With the report on time, the same events gave `{ code: 0, timedOut: false }`.<br>**The behaviour is right.** See the QA-1.2-24 row: it is the fail-closed side of an ambiguity that cannot be resolved at the grace. Only the wording is wrong. A caller or the 3.2 G4 wording that relies on "exactly" would be misled. | 1. In the header bullet, replace "exactly when" with a rule that names the ambiguity. For example: "`timedOut` is true when the deadline or abort had to end something. A case that cannot be told apart counts as a kill (fail-closed): on Windows, the grace settling the run while a sweep that pinned trees is still reporting."<br>2. Make `ShellResult.timedOut` match.<br>3. 3.2's G4 wording (deferred) should carry the same sentence.<br>This is a comment-only change. |
| QA-1.2-29 | nit (test-only; a gap in the `dcf5ff7` test) | `exec.ts:280` (`sweeper.pinnedCount() > 0`); `test/unit/exec.test.ts:490-506` and `:599-621` | **The condition that keeps QA-1.2-10 a no-op has no deterministic test.**<br>• Mutant A drops `&& sweeper.pinnedCount() > 0`, so any sweep still pending counts as a kill. `-t "process lifecycle"` then gives **10 passed, 33 skipped**: no test fails.<br>• `repro.mjs unpinned` against mutant A gives `{ code: 1, timedOut: true }` with the still-reporting note at +2002 ms, for a run whose holder ended on its own at +78 ms. The code under review gives `{ code: 0, timedOut: false }`.<br>**Why the suite misses it.** The QA-1.2-10 test (`:490-506`) reaches the branch only when real PowerShell takes more than 2 s after the abort to print `pinned 0`. Idle, it reports first, and `onSwept` settles the run. So a regression would pass CI and then fail QA-1.2-10 under load, the pattern of QA-1.2-22 and QA-1.2-26. | Add the negative case beside the `late-sweeper` test. For example, a `host.mjs` mode, or an option to `late-sweeper`, whose stand-in prints no marker for longer than `KILL_GRACE_MS` and kills nothing, with the holder released right after the abort. Assert `{ code: 0, stderr: "", timedOut: false }` and that the run settled at or after the grace, which proves the branch was reached. This is a test-only change. |

### Checked, no finding

- **Late-marker ordering.** For the branch to miss a real kill, node would have to see the
  child's pipes close before the sweeper's `pinned <n>` line. The marker is written before the
  sweeper reads `kill`, so it is on the pipe before any kill. In every `late-kill` run, the
  stand-in logged the marker 8–11 ms before it read `kill`, and the result counted the kill.
- **`host.mjs` `late-sweeper`.**
  - The stand-in gets the scratch dir as `process.argv[1]` (`node -e <script> <dir>`). It kills
    through `process.kill` (TerminateProcess), not taskkill.
  - It reports 2500 ms after `kill`, which is at least 500 ms after the grace.
  - The host aborts 500 ms after the child's exit, when the stand-in is already armed.
  - In the node `late-kill` runs, the holder was dead 58–189 ms after the abort, far inside the
    2 s grace.
  - A saturated machine could still push the kill past the grace, as with the other
    lifecycle tests. That is 3.1's loaded run (deferred).
- **The QA-1.2-27 POSIX test's own bookkeeping.**
  - `finally` untracks the stand-in entry, so no entry for a live group is left behind. With
    `child = 0`, the untrack is a no-op.
  - `t.childExited()` waits until the child is reaped (the test process is its parent), plus
    300 ms, so the run has seen `exit` before the abort.
- **`trackingForTests` gains `ownsTracked`.** Its reachability is unchanged from round 5: it is
  test-only, and no production importer uses it.
- **The gating run matches the round-5 verification** (41 passed | 2 skipped). No new test is
  load-sensitive beyond what 3.1 already covers.

### Deferred by plan (not open)

- **deferred by plan (3.1):** unchanged from round 4: the Bun smoke, the loaded run and the
  coverage gate.
- **deferred by plan (3.2):** unchanged from round 4 (QA-1.2-12, the G4 wording and risk-table
  row, the QA-1.2-20 plan wording, the round-3 known limit, QA-1.2-21 item 2). QA-1.2-28 item 3
  adds one sentence to the G4 wording.
- **deferred by plan (2.1):** QA-1.2-13, unchanged.

**Status: phase 1.2 QA is NOT CLEAN.** QA-1.2-28 and QA-1.2-29 (both nits) are open.
QA-1.2-24 through QA-1.2-27 are verified.

### Round-6 resolutions

- **QA-1.2-28.** Resolution: c5b105e — comment-only change in `src/verify/exec.ts`. The header's G4 bullet no longer says "exactly when". It now says `timedOut` is true when the deadline or abort fired while something still held the run, so a kill was attempted. A case that cannot be told apart counts as a kill (fail-closed): on Windows, the grace settling the run while a sweep that pinned trees is still reporting, even if the leftover exited on its own during the grace. `ShellResult.timedOut` says the same. There is no logic change. The 3.2 G4 wording (item 3) stays deferred.
- **QA-1.2-29.** Resolution: c5b105e — new `host.mjs` mode `unpinned-sweeper` (node only). It uses `setSweeperExecutableForTests` with a stand-in that never prints `pinned`, kills nothing and lives 5 s. The host releases the holder right after the abort and also reports `settledIn`, the time in ms from the abort. New Windows test (`runIf(isWin && typeStripping)`) beside the `late-sweeper` test. It asserts `{ code: 0, stderr: "", timedOut: false }` and `settledIn >= KILL_GRACE_MS - 50`, which proves the grace was reached with the sweep pending. Mutant check: with `&& sweeper.pinnedCount() > 0` removed from `onGrace`, the test fails with `expected { code: 1, stdout: '', …(2) } to match object { code: +0, stderr: '', …(1) }`. After the source was restored, the only diff in `exec.ts` was the QA-1.2-28 comments.

Verification (Windows 11, node): `npm run typecheck` clean. `npx vitest run --maxWorkers=2 test/unit/exec.test.ts` was run 3 times on the final code:
- Run 1: 41 passed | 1 failed | 2 skipped (44). The QA-1.2-19 test (`hung-sweeper`, unchanged in behaviour) failed.
- Run 2: the same result. The error was an `EPERM` from `rmSync` of its scratch dir in `afterEach` (`exec.test.ts:14`).
- Run 3: 42 passed | 2 skipped (44).
- Run on its own, the QA-1.2-19 test passed.
- The failure is in scratch-dir cleanup. It was not investigated further, and whether it happened before this change was not verified.

No fixture or stand-in processes were left afterwards (`Win32_Process` query).

## QA re-review (round 7)

Reviewer: heavy QA, re-review of the round-6 fixes, `git diff 98d8580..2f5089d` on `vrb/p12`
(`c5b105e`, `2f5089d`: `src/verify/exec.ts`, `test/unit/exec.test.ts`,
`test/fixtures/exec/host.mjs` and this file). The review also root-causes the `EPERM` cleanup
failure of the QA-1.2-19 test that the implementer recorded above.

**Setup.**
- Host: Windows 11, 16 logical cores, node v24.21.0.
- `npm run typecheck` is clean.
- `npx vitest run --maxWorkers=2 test/unit/exec.test.ts` was run 3 times in the worktree on an idle
  machine: **42 passed, 2 skipped** (44) each time, 41.8–42.3 s.
- The repro work lived in `%TEMP%\omr-qa12r7` and has been removed. Afterwards no scratch dir
  was left in `%TEMP%`, a `Win32_Process` query on the scratch, fixture, stand-in and burner names
  matched nothing, and the worktree was unchanged.
  - **Diagnostic copy.** This was a `git archive` copy of `2f5089d`, with `node_modules` linked to
    the worktree's. Only the copy was edited. Its `afterEach` catches a failed `rmSync`, then:
    1. records `alive()` for the test's known PIDs (the host, the stand-in, and the `child`/`holder`
       from the PID files);
    2. retries `rmSync` once;
    3. runs a `Win32_Process` query for every process whose command line names the dir, and for
       those PIDs;
    4. rethrows.
  - **`cwdhold.mjs`.** (a) `rmSync` of a dir that a live node process uses as its cwd.
    (b) A holder like `tree.cjs`'s (cwd = the scratch dir, exits when a release file appears). The
    script polls `process.kill(pid, 0)` until it reports the holder dead, then calls `rmSync` at
    once. If that fails, it retries every 5 ms and records when the dir became removable.
  - **`harness.mjs`.** It replays the QA-1.2-19 test's sequence (`exec.test.ts:573-597`) outside
    vitest: start `host.mjs hung-sweeper <dir>`, wait for the host's `close`, `waitForExit(stand-in,
    3000)`, release the holder and `waitForExit(holder)`, then `rmSync(dir)`. It ran three arms,
    interleaved, 15 runs each:
    - A: the fixture as committed;
    - B: the same, but the host runs the tree with the run's `cwd` set to `%TEMP%`;
    - C: the same as A, with `rmSync(…, { maxRetries: 10, retryDelay: 50 })`.

    It also ran `late-sweeper` and `unpinned-sweeper` 3 times each. For the unpinned stand-in, it
    recorded `process.cwd()` to a probe file.
  - **Load.** Load runs used 16 normal-priority `node` busy loops, one per logical core, each ending
    itself after its set time.
  - **handle.exe.** Sysinternals Handle v5.0 is installed, but the session is not elevated. It then
    lists no File handles: with a live node process whose cwd was a scratch dir, it printed
    `No matching handles found`. So it could not name the holder. The holder was found by
    elimination and by the A/B experiment below.

**Result.**
- QA-1.2-28 and QA-1.2-29 are verified.
- The EPERM flake is a test-harness race, not a leftover process: see the next section and
  QA-1.2-30.
- The new `unpinned-sweeper` test and the `late-sweeper` test leave no stand-in running. Their
  stand-ins never sit in a test's scratch dir.
- There is 1 new finding, a nit.
- The DoD (zero open findings) is **not met**.

### Round-6 findings

| Finding | Status | Evidence |
|---|---|---|
| QA-1.2-28 | verified | **Code.** The `exec.ts` part of `98d8580..2f5089d` is comment-only: the header's G4 bullet (`exec.ts:21-27`) and the `ShellResult.timedOut` JSDoc (`:48-53`). No code line changed.<br>**Wording.** "Exactly when" is gone. The bullet says `timedOut` is true when the deadline or abort fired while something still held the run, so a kill was attempted. It names the ambiguous case that counts as a kill (fail-closed): the grace settling the run while a sweep that pinned trees is still reporting, even if the leftover exited on its own. The no-op sentence for an abort that finds nothing running is kept. `ShellResult.timedOut` says the same. This is fix items 1 and 2. Item 3 (the G4 wording) stays with 3.2. |
| QA-1.2-29 | verified | **Code.**<br>• `host.mjs unpinned-sweeper` (`:24-29`, `:43-45`, `:72`, `:109`, `:123`) starts a stand-in that prints no marker, kills nothing and lives 5 s. It releases the holder right after the abort and reports `settledIn`.<br>• The test (`exec.test.ts:623-646`) asserts `{ code: 0, stderr: "", timedOut: false }` and `settledIn >= KILL_GRACE_MS - 50`.<br>**Mutant A** (the diagnostic copy, idle). The mutant drops `&& sweeper.pinnedCount() > 0` from `onGrace` (`exec.ts:289`). `-t "process lifecycle"` then gives **1 failed \| 10 passed \| 33 skipped**. The failure is the new test, with `expected { code: 1, stdout: '', …(2) } to match object { code: +0, stderr: '', …(1) }`. In round 6 the same mutant gave 10 passed and no failure. After the source was restored, the copy's `exec.ts` had no diff.<br>**Under load** (`harness.mjs`, 16 busy loops): all 3 unpinned runs gave `{ code: 0, timedOut: false }` with `settledIn` 2002–2008 ms. So the branch is reached, and the result holds under saturation too. |

### The QA-1.2-19 `EPERM`: root cause

**Reproduced.**
- It is **load-dependent**. On an idle machine, 9 of 9 full-file runs were green: 3 in the
  worktree and 6 in the diagnostic copy.
- Under the 16 busy loops, it failed in two ways:
  - `-t "QA-1.2-19"` alone failed 1 of 8 runs;
  - a full-file run failed it in 1 of 2 runs.
- Both failures carried the implementer's error, from the `afterEach` at `exec.test.ts:14`:
  `Error: EPERM, Permission denied: \\?\C:\Users\…\Temp\omr-exec-UAIljz '\\?\C:\…\omr-exec-UAIljz'`.

**At failure time** (the diagnostic `afterEach`, both failures):
```
alive at +2 ms: host=49928:false standIn=60716:false child=34240:false holder=63404:false
immediate retry at +4 ms succeeds
Win32_Process: no process names the dir; 49928, 60716, 34240 and 63404 absent
```
The second failure looked the same: `alive at +1 ms` (all four `false`), and the retry at +3 ms
succeeded.
- No process was alive at the failure, so nothing was left running.
- The dir was released within 3–4 ms.

**What gives this error.** `cwdhold.mjs` (a): with a live node process whose cwd was the scratch
dir, `rmSync(dir, { recursive: true, force: true })` threw exactly
`EPERM, Permission denied: \\?\…` and left both the dir and its file in place. So the error is
the signature of a process that still has the dir as its current directory.

**The window.** `cwdhold.mjs` (b) called `rmSync` as soon as `process.kill(pid, 0)` reported the
cwd holder dead.
- **Idle:** 0 of 60 failed.
- **Under load:** **38 of 60** failed with `EPERM`. The dir became removable 124–233 ms later.

On Windows, `process.kill(pid, 0)` checks whether the process has an exit code yet (libuv's
signal-0 check; its source was not re-read here). So the test's `alive()` (`exec.test.ts:37-44`)
reports a process dead before the process has closed its handles, including the handle to its
current directory. Idle, that gap is too short to hit. Under CPU saturation the exiting process is
descheduled mid-teardown, and the gap grows to hundreds of ms.

**Which process.** The failing test's dir is the cwd of only two processes: the tree's direct
child and the holder. That is because the host runs the tree with `cwd: dir` (`host.mjs:112`).
- **The stand-in is not one of them.** exec.ts spawns the sweeper with no `cwd` (`exec.ts:618-621`),
  and `startHost` passes none either (`exec.test.ts:357`). So the stand-in runs in the host's cwd,
  and so does the host. The probe confirmed it: the unpinned stand-in's `process.cwd()` was the
  host's cwd, not the scratch dir.
- **The direct child is not the one either.** It exits before the abort, more than 2.5 s before
  cleanup.
- **That leaves the holder.** In `hung-sweeper` mode, the host releases it only after the result
  (`host.mjs:126`). The test then waits for the host's exit and the stand-in, and `t.release()`
  (`exec.test.ts:404-409`) returns as soon as `alive(holder)` is false. The `afterEach` then runs
  at once, inside the holder's teardown window. The harness saw the holder dead 0–315 ms after the
  host closed.

**A/B** (`harness.mjs`, under load, 15 interleaved runs per arm):

| Arm | `EPERM` | Dir removable again after |
|---|---|---|
| A: as committed (the holder's cwd is the scratch dir) | **6 / 15** | 127–451 ms |
| B: only the run's cwd moved to `%TEMP%` | 0 / 15 | — |
| C: as A, with `rmSync` `maxRetries: 10, retryDelay: 50` | 0 / 15 | — |

Arm B leaves the same files in the same dir and never fails. So the lock is the holder's current
directory, not an antivirus or indexer handle on the files. Arm C shows that Node 24's `rmSync`
retries this `EPERM`.

**Why only this test.**
- The in-process lifecycle tests run the tree with `cwd: tmpdir()` (`exec.test.ts:428`, `:445`,
  `:473`, `:493`, `:511`). So their holders, which also die just before cleanup, are not in the
  scratch dir.
- Of the three host modes, only `hung-sweeper` lets the holder live until after the result:
  - in `late-sweeper`, the stand-in kills the holder at the abort;
  - in `unpinned-sweeper`, the holder is released at the abort (`host.mjs:123`);
  - either way, the holder is gone at least 2 s before cleanup.

**Not caused by round 6.**
- The QA-1.2-29 test runs after the QA-1.2-19 test in the file, and each test removes only its
  own dirs.
- In the harness, the `late-sweeper` and `unpinned-sweeper` stand-ins were already dead when the
  host closed (3/3 each), because they die with the host's job. The tests' `killIfAlive(standIn)`
  covers any other case.
- `cwd: dir` and the release after the result are unchanged context lines in `98d8580..2f5089d`.
  Both came with the QA-1.2-19 test itself (`0ec7ec5`, `git log -S`).

**Verdict.**
- It is a cleanup race in the test harness: `alive()` reports "dead" before Windows has closed the
  process's handles.
- It is not a leftover process in `exec.ts` or the fixture: every process had exited, and the dir
  was free within 0.5 s.
- It is not an antivirus or indexer effect.

### New findings

| ID | Severity | Where | Evidence | Fix |
|---|---|---|---|---|
| QA-1.2-30 | nit (test-only; load-dependent; pre-existing since `0ec7ec5`) | `test/unit/exec.test.ts:14` (`afterEach` `rmSync` without retries), with `host.mjs:112` (`cwd: dir`), `host.mjs:126` and `exec.test.ts:404-409` | **The QA-1.2-19 test's cleanup races Windows process teardown.** It failed the implementer's round-6 gating runs 2 of 3. See the root-cause section above.<br>• The `hung-sweeper` holder has the scratch dir as its cwd and dies right before `afterEach`.<br>• `alive()` reports it dead before its cwd handle is closed, so `rmSync` hits `EPERM`.<br>**Measured under load:**<br>• replay: 6 of 15 runs failed;<br>• micro-repro: 38 of 60 failed;<br>• the dir was removable 124–451 ms later.<br>Idle: 0 failures (9 full runs, 60 micro runs).<br>**Also exposed, in principle.** The `forkingFixture` tests run their trees with `cwd: f.dir` (for example `:92`, `:101`) and clean up right after the kill. They did not fail in this review's two loaded full runs. | 1. In `afterEach`, use `rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })`. Arm C: 0 of 15 failed. This covers every test that uses a scratch dir as a cwd, and it costs time only while the dir is still held.<br>2. Optionally, have `host.mjs` run the tree with `cwd: tmpdir()`, as the in-process lifecycle tests do. The tree already gets its dir as an argument. Arm B: 0 of 15 failed.<br>3. Add a comment at `alive()`: on Windows, "dead" does not mean the process's handles are closed.<br>This is a test-only change. |

- **QA-1.2-30.** Resolution: e59297c — test-only change in `test/unit/exec.test.ts`. The `afterEach` now removes scratch dirs with `rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })` (fix 1), and a comment at `alive()` notes that on Windows "dead" does not mean the process's handles (including its cwd) are closed (fix 3). Optional fix 2 (`host.mjs` `cwd: tmpdir()`) was not applied; fix 1 covers every scratch-dir cwd. Verification: `npx vitest run --maxWorkers=2 test/unit/exec.test.ts` gave 42 passed, 2 skipped (one run), and `npm run typecheck` passed.

### Checked, no finding

- **No stand-in outlives its test.** This covers the new `unpinned-sweeper` stand-in (5 s
  lifetime) and the `late-sweeper` one. When the host exits, both are ended by the host's job.
  Their cwd is the host's, so even a live stand-in could not lock a scratch dir. After every batch
  of runs in this review, the `Win32_Process` query matched nothing.
- **The loaded full-file runs** (2 runs, 16 normal-priority busy loops). Apart from QA-1.2-30,
  three tests failed. Each failure is the documented load limit, and none occurred idle:
  - The QA-1.2-1 and QA-1.2-10 lifecycle tests failed in both runs, at their `waitForExit(holder…)`
    G4 bound (`exec.test.ts:432`, `:456`: `expected false to be true`). The sweep finished after
    3 s, which is G4 limit (c).
  - The QA-1.2-2 test failed once. Its stderr was `[output streams force-closed 2000 ms after the
    kill: the process did not exit]`, where `:524` expects "a descendant still held them".
    Under saturation, `taskkill /T /F` of the live direct child had not finished when the grace
    fired, and `exec.ts:288` names that case. The run was still bounded: the test took 4.1 s.
  - All of this belongs to 3.1's loaded run (below).

### Deferred by plan (not open)

- **deferred by plan (3.1):** unchanged from round 4: the Bun smoke, the loaded run and the
  coverage gate.
  - The loaded run should expect the lifecycle tests to miss G4's 3 s under normal-priority
    saturation (limit (c)).
  - It should also expect QA-1.2-2's note to read "the process did not exit" when `taskkill` is
    slower than the grace.
- **deferred by plan (3.2):** unchanged from round 6:
  - QA-1.2-12;
  - the G4 wording and risk-table row, including QA-1.2-28 item 3;
  - the QA-1.2-20 plan wording;
  - the round-3 known limit;
  - QA-1.2-21 item 2.
- **deferred by plan (2.1):** QA-1.2-13, unchanged.

**Status: phase 1.2 QA is NOT CLEAN.** QA-1.2-30 (nit, test-only) is open. QA-1.2-28 and
QA-1.2-29 are verified.
