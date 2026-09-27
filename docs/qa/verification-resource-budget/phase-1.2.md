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
