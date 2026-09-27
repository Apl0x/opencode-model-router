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

## Spike B (POSIX nice)

Handled by a separate agent. Implementation prepends `nice -n 10` to argv (`runArgv`) and runs
`nice -n 10 /bin/sh -c <command>` for `runShell` — the same `/bin/sh -c` that `shell: true`
spawns, so shell semantics are unchanged and the command is never re-quoted.

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
