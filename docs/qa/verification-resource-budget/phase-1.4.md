# Phase 1.4 — Machine-wide verification slot (S3)

## Pre-flight

Environment: Windows 11 (10.0.22631), NTFS, Node v24.21.0, 16 cores. Spike scripts in
`%TEMP%\omr-spike14` (`race.cjs`, `run-race.cjs`, `kill0.cjs`); not committed.

### Spike 1 — `fs.open(path, "wx")` atomicity (NTFS)

Two Node processes, 100 rounds; both spin until a shared wall-clock instant per round, then
`openSync("rN.lock", "wx")`. Two full runs:

| run | A wins | B wins | rounds with exactly one winner | rounds with 0 or 2 winners |
|---|---|---|---|---|
| 1 | 70 | 30 | 100/100 | 0 |
| 2 | 15 | 85 | 100/100 | 0 |

The split of wins shows real contention; there was never a double winner, and every loser got
`EEXIST`. **Confirmed on NTFS.** ext4: not testable locally (no Linux host in this dispatch).
`O_CREAT|O_EXCL` is POSIX-atomic on local filesystems, and the multi-process tests will cover it
on the Linux CI run.

### Spike 2 — `process.kill(pid, 0)` (Windows)

| target | result |
|---|---|
| own process | no throw (alive) |
| live child | no throw (alive) |
| same child after SIGKILL + exit | `ESRCH` (dead) |
| PID 4 (System) | `EPERM` (alive, not ours) |
| lsass | `EPERM` |
| unused PID 999999 | `ESRCH` |

**Confirmed on Windows:** dead → `ESRCH`, alive → no throw, alive but protected → `EPERM`.
`slot.ts` treats anything except `ESRCH` as alive. POSIX: not testable locally (no POSIX host). The
documented `kill(2)` semantics are the same (`ESRCH`/`EPERM`).

## Implementation notes (`src/verify/slot.ts`)

- `acquireSlot({max, waitMs, signal, meta}, deps?)` → `SlotHandle | {busy:true}`, plus `withSlot`,
  which releases on success, throw and abort. `deps` injects dir, logger (`Pick<PluginLogger,"warn">`,
  the `src/router/logger.ts` seam), clock, random, host, pid, PID probe, unlink and all timing
  constants. The defaults are the plan values: heartbeat 5 s, stale 30 s, backoff 250 ms → 2 s.
- **TOCTOU:** every delete of a slot file (a stale reap or the owner's release) runs under a per-slot
  `slot-<i>.lock.reap` lock (`wx`). Under that lock the file is re-read, and it is deleted only if the
  token (and the staleness) is unchanged. Only deleters remove slot files, and they are serialized,
  so the file cannot change identity between the re-read and the unlink. A crashed reaper's
  reap lock is reclaimed by age (10 s).
- **Unlink:** `EBUSY`/`EPERM`/`EACCES` are retried with exponential backoff (6 retries). A persistent
  failure logs a warning and leaves the file (the slot is not reported as freed).
- **Corrupt/empty lock:** stale only after a 2 s write grace (**deviation from the plan**). A creator
  writes JSON right after the exclusive create, so an empty file younger than the grace may be a
  lock being written. Reaping it immediately could produce two winners.
- **Clock:** an mtime in the future counts as fresh (never reclaims a live holder). Same-host
  crashes are still caught by the PID probe.
- **Exit:** a single `process.on("exit")` listener (registered once) synchronously unlinks the files
  this process holds, after a token check.
- **Unwritable dir:** `mkdir` plus a probe file. On failure it uses an in-process semaphore with the
  same API, and logs once per dir.

## Tests (`test/unit/slot.test.ts`, 19 tests)

Isolated `mkdtemp` dir per test. The multi-process fixture is `test/fixtures/slot/holder.mjs`, which
loads `slot.ts` via Node type stripping. **Deviation:** the unwritable temp dir is simulated by a
slot dir under a regular file (`ENOTDIR`), not a read-only `TEMP`. Windows directory ACLs cannot
be made read-only portably without admin rights.

Three scoped runs (`npx vitest run --maxWorkers=2 test/unit/slot.test.ts`): 19/19 passed each time
(7.68 s, 8.54 s, 8.50 s). No `holder.mjs` or `omr-slot` node processes remained afterwards.
`npm run typecheck` is clean.
