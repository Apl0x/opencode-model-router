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

Updated after the QA fixes (commits `25a7d4f`…`0024c3b`) and the round-2 fixes (`17fac6a`). The first
version's notes are superseded: its `.reap` time lease, its wall-clock deadline and its "future
mtime = fresh" rule are gone. So is round 1's per-process observation map.

- **API:** `acquireSlot({max, waitMs, signal, meta, onLost?}, deps?)` → `SlotHandle | {busy:true}`,
  with `SlotHandle = {release(), readonly lost}`, plus `withSlot`, which releases on success, throw
  and abort. `onLost` and `lost` are additive. `deps` injects the dir, the logger
  (`Pick<PluginLogger,"warn">`), the wall clock `now` (used only against mtimes), the monotonic
  clock `mono` (machine-wide `process.hrtime`), random, host, pid, the PID probe, the
  `unlink`/`read`/`utimes` seams and every timing constant. The defaults are the plan values:
  heartbeat 5 s, stale 30 s, backoff 250 ms → 2 s. Two additions: a corrupt-file grace of 2 s and a
  claim hold limit of 5 s. `acquireSlot` never rejects.
- **Creation:** `open(slot, "wx")` and a JSON write, then a re-read. An unreadable re-read is retried
  on the unlink schedule. The creator holds the slot only if its token is there. A slot lock still
  unreadable after the retries counts as held, because the heartbeat re-checks it within 5 s. A
  claim never counts as held that way (QA-1.4-26).
- **Shared observation (QA-1.4-21):** every look at a lock or claim is recorded in a sidecar,
  `slot-<i>.lock.seen-<sha256(file, identity, host)[:32]>`. The sidecar holds `{key, first, from,
  last}` on the machine-wide monotonic clock:
  - `key` is identity@mtime. `first` is the first sighting of that key by any process. `last` is the
    latest look. `from` is the first look after the latest gap of more than 2 heartbeats between
    two looks.
  - `span = now − first` and `witnessed = now − from`.
  - A new key, another boot, or a stamp from the future restarts the record. Another boot means the
    Linux boot id changed, or the boot instant `wall − mono` moved by more than 60 s.
  - The host is part of the name, so hosts sharing a dir never mix clocks.
  - Sidecar I/O is advisory: a failure loses evidence and delays a reclaim; it never causes one.
- **Clock:** `process.hrtime` is CLOCK_MONOTONIC on Linux and mach/CLOCK_UPTIME_RAW on macOS; both
  stop during a system suspend. On Windows it is QPC.
  - Verified on this Windows 11 host: three processes started one after another read consecutive
    values, equal to `os.uptime()` within 21 ms.
  - Microsoft documents that GetTickCount64 counts sleep, but says nothing about QPC. Modern Standby
    pauses desktop processes while every clock runs.
  - So no rule assumes that the clock stops while processes are frozen; that is why the witness is
    kept. The wall clock is compared only with mtimes.
- **Staleness:** a lock is stale if (a) it is from this host and its PID is dead, which is immediate;
  or (b) it is old **and** has been witnessed unchanged for 2 heartbeats.
  - Old means the wall age is over `staleMs`, or the span is ≥ `staleMs`.
  - A gap in the looks restarts the witness, whether everyone was frozen or nobody looked. So after a
    suspend or a Modern Standby, a live holder always gets 2 heartbeats of running time first
    (QA-1.4-1).
  - A foreign host is never judged by PID. A corrupt or empty lock uses `corruptGraceMs` for both
    the age and the witness (**deviation from the plan**, accepted in QA-1.4-14).
- **Watch (QA-1.4-21):** a call that gives up at its deadline while a lock is old but not yet
  witnessed long enough keeps looking at it in the background.
  - It looks every heartbeat, on an unref'd timer, for at most `staleMs + 2 × (heartbeatMs +
    claimHoldMaxMs)`, and stops once the lock is reaped or changes.
  - So a process that calls with `waitMs: 0` once a minute still reclaims a lock whose owner is not
    provably dead.
  - Short-lived processes that each look once succeed through the sidecar when their looks are less
    than 2 heartbeats apart. If the looks are further apart, the reclaim falls to the next caller
    that waits, or lives, for 2 heartbeats.
- **Deletion (TOCTOU):** every delete of a file with identity K runs under the claim file
  `slot-<i>.lock.reap-<sha256(K)[:32]>` (`wx`, `{pid, hostname, token, target, victim: K}`). K is
  the token, or for a corrupt file its mtime and size. This covers stale reaps, the owner's release
  and the exit hook. The claim holder re-reads the file before every unlink attempt and deletes it
  only while it is still K. K is never reused and only a K-claim holder deletes K's file, so there
  is no ABA between the re-read and the unlink, and no time lease.
  - A crashed claimer's claim is removed the same way, under the claim for its token. That happens
    when its owner is a dead same-host PID, or when the claim is inert: span ≥ `staleMs` **and**
    witnessed ≥ 2 × `claimHoldMaxMs`. The wall age plays no part (QA-1.4-20). The chain goes at
    most 3 levels deep.
  - A claimer deletes its target only within `claimHoldMaxMs` (5 s) of monotonic time. That time is
    counted from just before it creates the claim, and it is checked again after the re-read, right
    before each unlink. The claimer drops its own claim only within 1.5 × that (7.5 s).
- **Unlink:** `EBUSY`/`EPERM`/`EACCES` are retried with exponential backoff (6 retries, 50 ms × 2ⁱ).
  A persistent failure is logged and never reported as success.
- **Release:** it never rejects and never caches a failure. An unreadable lock (a scanner) is
  retried on the unlink schedule; it is never taken for "missing". If the delete is not confirmed,
  the file stays ours: the heartbeat keeps running and the exit hook still covers it. The delete is
  retried on an unref'd timer every heartbeat, up to `staleMs / heartbeatMs` times, with one
  warning. Then the file is left to stale detection with a second warning. A release first waits
  for any heartbeat tick in flight, and a tick checks the phase before `utimes`.
- **Loss:** when the heartbeat finds the lock gone or holding another token, `lost` becomes true,
  `onLost` runs and one warning is logged, once.
- **Fairness:** a waiter files `wait-<startedAt>-<uuid>.ticket`, refreshes it every heartbeat
  (unref'd timer) and on every wake-up, and tries only while fewer than `max` live tickets are older
  than its own (FIFO for max=1). A caller with `waitMs=0` defers while `max` live tickets exist.
  - A ticket is dead if its PID is dead on this host.
  - A ticket is also dead once it has gone 2 heartbeats without a refresh, whatever its PID: by its
    mtime, or seen unchanged that long by this process (QA-1.4-24).
  - A live waiter misjudged dead re-creates its ticket under its old name.
  - Tickets are advisory: exclusion never depends on them.
- **Housekeeping (QA-1.4-25):** at most every 10 min per dir, the ticket scan's directory listing
  also removes orphaned files older than 1 h:
  - probes, sidecars, and the legacy `.reap` and `.reap.dead-*` files, by path;
  - claims whose target no longer holds their victim, or that are corrupt, under the claim protocol.
  A claim without `target`/`victim` is left alone.
- **Exit:** a single `process.on("exit")` listener (registered once) follows the claim protocol
  synchronously. It takes the claim, checks the token, unlinks the lock and drops the claim. If
  another process holds the claim, it leaves the file to that process. It also removes its tickets.
- **Unwritable dir:** the verdict comes only from `mkdir`/exclusive-create codes. EACCES, EPERM,
  EBUSY and ENOENT are retried twice; EROFS, ENOTDIR and EEXIST are final. Once the probe is
  created, the dir counts as writable, and removing the probe is housekeeping. The verdict is
  memoized per dir, so file and in-process holders never mix. The in-process fallback logs once per
  dir.
- **File-system errors (QA-1.4-22):**
  - An ENOENT at use time re-creates the dir once and retries. This covers the slot and claim
    creates and the tickets. A failed `mkdir` drops the verdict.
  - Any other unexpected error resolves `{busy:true}` and drops the verdict. Examples: EMFILE,
    ENOSPC, EIO, or a probe error outside the verdict codes. One warning is logged per dir and code.
  - No slot is ever granted without its lock file, so exclusion holds. The next call probes again,
    and a dir that has become unwritable degrades as above.
- **Residual risk (documented in the header):** check-then-act on a file system keeps a window
  between the last check and the syscall. For a claimer, that window is the target unlink, or the
  drop of its own claim. That claimer acts on a claim judged inert only if it freezes there for:
  - more than 25 s for the target unlink (`staleMs` − `claimHoldMaxMs`);
  - more than 22.5 s for the drop (`staleMs` − 1.5 × `claimHoldMaxMs`).

  When all processes are frozen together, the witness also gives the claimer 10 s of running time
  after the thaw. The remaining risk is a single process frozen in that window (SIGSTOP, a debugger)
  for longer.

  A holder that stops heartbeating for 2 intervals while its lock looks old is reaped (the plan's
  contract), and it is told so through `lost`.

## Tests (`test/unit/slot.test.ts`, 51 tests)

Each test uses an isolated `mkdtemp` dir. The multi-process fixture `test/fixtures/slot/holder.mjs`
imports a JS build of the real `slot.ts`, made in `beforeAll`. TypeScript 7 has no
`transpileModule`. The build tries these in order (QA-1.4-23):
1. vite, resolved from vitest's own location, so no direct devDependency is needed and a strict
   pnpm layout works: `transformWithOxc` on vite 8, else `transformWithEsbuild` on vite 6 and 7;
2. Node's `module.stripTypeScriptTypes`, on Node 22.13 and later.

The children therefore need no type stripping. This was verified in round 1 with
`NODE_OPTIONS=--no-experimental-strip-types`, the Node 20 condition. The children start behind a
barrier (READY, then a `go` file).

Round 2 added 9 tests:
- QA-1.4-21:
  - Five fresh processes with `waitMs: 0`, 900 ms apart, against a hung live-PID lock: the first
    three are busy, and the fourth or fifth takes the lock once it has been unchanged for `staleMs`.
  - One process calling with `waitMs: 0` every 600 ms (more than 2 heartbeats) reclaims the lock
    through the background watch.
  - A simulated 60 s freeze, with the wall clock and `mono` both moved on, does not let the next
    look reap; the lock must be witnessed for 2 heartbeats again.
- QA-1.4-20:
  - A claim that looks 60 s old is inert only after `staleMs` of observation.
  - A re-read that outlasts `claimHoldMaxMs` stops the unlink.
- QA-1.4-26: an unconfirmed claim deletes nothing, and the inert rule clears it later.
- QA-1.4-22:
  - The dir is removed between calls, on the no-wait, ticket and `withSlot` paths.
  - An EIO is reported as busy with one warning.
  - When a file stands where the dir was, the call returns busy, and the next call falls back to
    the in-process semaphore.
- QA-1.4-24:
  - A ticket 300 ms old (TTL 200 ms) is dead although its PID is live.
  - A waiter whose attempts take 1 s keeps its ticket alive through the heartbeat.
- QA-1.4-25: files are planted with an age of 2 h; the orphans go, and the young or still-guarding
  files stay.

Round 2 checks:
- **Runs:** three consecutive scoped runs (`npx vitest run --maxWorkers=2 test/unit/slot.test.ts`)
  on Node v24.21.0 each passed 51/51 in 45.1 s, 43.0 s and 42.6 s. `npm run typecheck` is clean.
- **Cleanup:** afterwards no `omr-slot-*` dir and no `node.exe` running `holder.mjs`, `slot.mjs` or
  vitest was left. The 16 stale dirs from 22:26 were deleted before the first run.
- **Mutation checks:** each was run on the matching test and reverted, and each failed its test.
  The mutations were:
  - the watch disabled;
  - the gap rule removed;
  - the pre-unlink deadline re-check removed;
  - unconfirmed claims trusted;
  - the ticket heartbeat removed;
  - the claim wall-age shortcut restored;
  - the ticket TTL set back to `staleMs`;
  - the ENOENT re-creation removed;
  - the housekeeping removed.

The read-only temp dir case is real. On Windows it uses `icacls <dir> /deny <user>:(OI)(CI)(W)`,
non-elevated; on POSIX it uses `chmod 0555`, skipped as root. The test points
`TEMP`/`TMP`/`TMPDIR` at the dir, uses the default slot dir, and restores the env and the ACL in
`finally`. The earlier `ENOTDIR` case stays as an extra.

Round 1: three consecutive runs (`npx vitest run --maxWorkers=2 test/unit/slot.test.ts`) passed
42/42 each time (27.0 s, 32.1 s, 30.9 s). Afterwards no `node.exe` with `slot` in its command line
remained, and no `omr-slot-*` temp dirs were left. `npm run typecheck` is clean.

Round 1 mutation checks were run and reverted. Each broken rule failed its tests:
- Drop the observation requirement (QA-1.4-1): 5 tests fail.
- Reclaim claims by age only (QA-1.4-2): 2 tests fail.
- Bypass the ticket gate (QA-1.4-9): 2 tests fail. The waiter starves ("expected a slot, got busy").
- Keep the heartbeat running after release (QA-1.4-10): 1 test fails.
- Restore the old downward jitter (QA-1.4-16): 1 test fails.

## QA findings

Reviewer: adversarial QA, `[tier:heavy]` (CAP:none). Scope: `git diff 754296c..HEAD` (649dcf6, 1c7d62b,
2703d43), checked against plan "#### Phase 1.4" and §1.3/§1.4/§1.5. Environment: Windows 11, NTFS,
Node v24.21.0. Baseline: `npx vitest run --maxWorkers=2 test/unit/slot.test.ts` → 19/19 passed (7.69 s).

The races below were proved with throw-away scripts in `%TEMP%\opencode\qa14\` (not committed).
Each script imports the real `src/verify/slot.ts` through Node type stripping. It uses only the public
`deps` seams (`unlink`, `now`) to fix the order of events, plus `utimes` to age a file. Unless a
finding says otherwise, every timing constant is the production default from `SLOT_DEFAULTS`.

**Summary:** 0 critical, 5 major, 8 minor, 4 nit, 2 deferred by plan.

**Confirmed conformant:** API shape `acquireSlot({max, waitMs, signal, meta})` → `{release()} | {busy:true}`
(`deps` is an additive second parameter). Lock path `<tmpdir>/opencode-model-router/verify-slots/slot-<i>.lock`.
JSON fields `{pid, hostname, token, startedAt, cwd, command}` with a `randomUUID` token per
acquisition. `rg "child_process|console\." src/verify/slot.ts` → no matches. The exit hook is
registered once, runs synchronously and checks the token. The in-process fallback logs once per dir.
The slot-file unlink retries EBUSY/EPERM and never treats a persistent failure as success (test at
`slot.test.ts:197-221`). An abort while waiting leaks no ref'd timer. The heartbeat is unref'd
(`slot.test.ts:117-123`).

### QA-1.4-1 — major — A live holder is reaped after a suspend/resume or a forward clock step of ≥ 30 s (two holders)

- **Where:** `src/verify/slot.ts:187-193` (`isStale` checks `age > staleMs` before the PID probe);
  header claim at `slot.ts:25-28` ("never makes a live holder look stale").
- **Evidence (P1):** holder A acquires with the defaults (5 s heartbeat). Its file's mtime is then set
  31 s back, which is what the file looks like right after a laptop resumes from a 31 s sleep, before
  A's next heartbeat tick. A waiter B with default deps is then called with `waitMs:0`.
  Output: `{"aHeld":true,"bHeld":true,"holderPidAlive":true}`. Variant P1b: B's clock is stepped
  +31 s (`now: () => Date.now()+31_000`), with no file ageing. Output: `{"aHeld":true,"bHeld":true}`.
  After resume, a waiter's backoff timer (≤ 2 s) usually fires before the holder's heartbeat (≤ 5 s).
  The same happens after an NTP step or a VM resume.
- **Impact:** two verification runs in parallel, which is exactly what S3 exists to prevent. A never
  learns that it lost the slot (QA-1.4-7).
- **Fix:** confirm age-based staleness with a second observation. Keep a per-process
  `Map<path, {token, mtimeMs, firstSeenMono}>` on `performance.now()`. Reap only when the same
  `(token, mtimeMs)` pair has stayed unchanged for at least `2 × heartbeatMs` of the observer's
  monotonic time. The same-host dead-PID fast path stays immediate. The plan says "reclaimed after
  30 s", so a later reclaim still conforms. Correct the header comment. Add a test: a live holder
  whose file was aged 31 s is not reaped by a waiter within `2 × heartbeatMs`, and an aged dead lock
  is reaped after the confirmation.
- **Resolution:** `d2bdeef`. `lockStale` has two paths:
  - Same host and dead PID: immediate, as before.
  - Otherwise: the wall age must be over `staleMs`, **and** a per-process `observations` map
    (path → key `token@mtime`, first/last on `performance.now()`) must show the same key for
    ≥ 2 × `heartbeatMs`, with no gap over 2 × `heartbeatMs` between two looks. After a resume, the
    gap restarts the observation, and the holder's first heartbeat changes the key. The wait loop
    wakes at least once per heartbeat so the observation stays unbroken.

  The header is corrected. New tests:
  - P1 and P1b with the production defaults (aged file / +31 s clock) → busy.
  - A live holder against a waiting observer with an aged file and with a stepped clock → keeps the
    slot.
  - An aged foreign lock → busy on one look, reaped after ≥ 2 heartbeats.

### QA-1.4-2 — major — The `.reap` lock is an unfenced time lease: two reapers can be inside it, giving two holders

- **Where:** `slot.ts:234-249` (`withReapLock`), `slot.ts:238-241` (reclaim = `stat` → age check →
  `unlinkRetry(reapPath)`, with no content or token compare), `slot.ts:198-213` (`unlinkRetry`
  re-issues a path-based unlink after each back-off without re-verifying the token), and
  `slot.ts:16-21` (header claim "the file cannot change identity between the re-read and the unlink").
- **Answers to the dispatch questions:**
  - **Reclaim race:** yes. The reclaim is a TOCTOU of its own. A reclaimer that stat'ed the crashed
    reaper's file can delete the fresh reap lock that another reaper took a moment later.
  - **Lease expiry:** the lease expires by age (10 s) even while its owner is alive and inside the
    critical section. A stall of more than 10 s or a forward clock step lets a second reaper in. The
    reap file is never heartbeated and carries no PID.
  - **Deadlock:** none. Every path gives up (`undefined` / `busy`).
  - **Crashed reaper:** its reap file blocks every reap *and* every release of that slot for 10 s.
    `release()` gives up after 20 tries (≈1 s) and leaves its slot file to stale detection
    (`slot.ts:415-424`), which takes 30 s because the heartbeat has already been stopped.
- **Evidence (P2): production constants, only three perturbations.** The perturbations are a crashed
  reaper's leftover `.reap` aged 11 s, one `EPERM` on a reclaim unlink, and one `EBUSY` on a
  stale-slot unlink. Interleaving:
  1. `slot-0.lock` = dead-PID lock `T`; `slot-0.lock.reap` = leftover `X`, 11 s old.
  2. R3: `open(reap,"wx")` → EEXIST; `stat(X)` → age 11 s > 10 s; `unlink(reap)` → EPERM
     (delete-pending / scanner); sleeps 50 ms.
  3. R2: same path; `unlink(X)` succeeds; returns busy.
  4. R4: `open(reap,"wx")` succeeds (reap `Y`); re-reads `T` (stale); `unlink(slot)` → EBUSY; sleeps.
  5. R3 retry: `unlink(reap)` deletes **R4's live `Y`**; returns busy.
  6. R5: takes reap `Z`; re-reads `T`; unlinks `T`; drops `Z`; creates `slot-0.lock` = `U`. **R5 holds.**
  7. R4 retry: `unlink(slot)` deletes **R5's live `U`**. R4's `finally` finds no reap file and skips.
     R4 creates its own lock. **R4 holds.**

  Output: `{"r2Busy":true,"r3Busy":true,"r5Held":true,"r4Held":true,"r5TokenStillOnDisk":false}`.
- **Evidence (P3): lease expiry under a live reaper.** A is inside the reap lock and its stale-slot
  unlink is held by an EBUSY retry. B's clock is stepped +10.5 s, with the default `reapStaleMs`.
  B1 reclaims A's live reap lock and returns busy. B2 takes the reap lock, reaps the dead lock and
  creates its own. A's retry then deletes B2's file and A creates its own.
  Output: `{"b1Busy":true,"b2Held":true,"aHeld":true}`.
- **Fix:**
  1. Write `{pid, hostname, token}` into the reap file. Reclaim it only when its owner is provably
     dead (same host and `!isPidAlive`). Never reclaim by age while the owner is a live same-host
     process. For a foreign host, use age > `staleMs` plus the observed-unchanged rule of QA-1.4-1.
  2. Reclaim by `rename(reap, reap+".dead-"+uuid)`, then check that the renamed content is the dead
     owner's. Do not use a bare `stat` → `unlink`.
  3. Before *every* unlink attempt, including each retry: re-read the slot file's token, and confirm
     that the reap file still holds our token.
  4. Add holder-side loss detection (QA-1.4-7).
  5. Correct the header and QA notes.
  6. Add the multi-process concurrent-reaper test of QA-1.4-11.
- **Resolution:** `d2bdeef`. This is a redesign rather than a PID-owned `.reap` lock, and it is
  strictly better: there is no single reap lock, no time lease and no rename/restore step.
  - Every delete of a file with identity K runs under the claim
    `slot-<i>.lock.reap-<sha256(K)[:32]>`. The claim is `wx` and holds `{pid, hostname, token}`.
  - The claim holder re-reads the target before **every** unlink attempt, retries included, and
    deletes only while the key is unchanged.
  - K is unique and only a K-claim holder deletes K's file, so the P2 interleaving cannot happen.
    R3 could not delete R4's reap file, because there is none to share. R4's retry re-reads and
    finds R5's token, so it stops.
  - A rename-then-verify reclaim was rejected. When a stale file was already replaced, it moves a
    live file, and its restore (`link`) can fail with EEXIST: two holders again.
  - Crashed claimers: a claim is removed under the claim for *its* token (chained, depth ≤ 3).
    That happens only when its owner is a dead same-host PID, or when the claim is inert: older
    than `staleMs` and seen unchanged for 2 × `claimHoldMaxMs`.
  - The inert rule replaces "never by age" (QA fix 1). A PID reused after a crash would otherwise
    lock the slot forever. It is safe because a live claimer self-fences: it never deletes after
    `claimHoldMaxMs` of its own monotonic time, and it drops its own claim within 1.5 × that time.
  - Owner releases and the exit hook use the same claims. Loss detection is in QA-1.4-7, and the
    header and QA notes are corrected.

  Tests:
  - A dead reaper's claim is cleared at once.
  - A live claimer's claim survives one look and a +10.5 s clock. It is removed only once inert.
  - P3 replay: a reaper held in EBUSY retries inside its claim keeps it against a stepped waiter.
  - The multi-process tests of QA-1.4-11.

### QA-1.4-3 — major — A transient antivirus EPERM on the probe unlink silently switches to the in-process semaphore (exclusion lost); EBUSY rejects

- **Where:** `slot.ts:350-363` (`dirWritable`: `await unlink(probe)` runs inside the same `try` as
  `mkdir`/`open`); `slot.ts:117` (`UNWRITABLE` contains `EPERM`, `ENOENT`, `EEXIST`);
  `slot.ts:441-447` (the decision is made again on every call and is not sticky).
- **Evidence (P6):** process-level holder A holds `slot-0.lock`. Then `fs/promises.unlink` is made to
  throw `EPERM` once for `.probe-*` (via `syncBuiltinESMExports`), and B calls `acquireSlot` with the
  same dir. The same is repeated with `EBUSY`.
  Output: `{"fileHolderA":true,"degradedB_held":true,"warns":["verification slot: temp dir unwritable, using an in-process semaphore"],"ebusyAcquire":"rejected EBUSY","leakedProbeFiles":2}`.
  A writable dir is judged unwritable. B runs concurrently with A's machine-wide slot. The warning
  is wrong, and it is logged only once per dir, so later occurrences are silent. `EBUSY` breaks the
  "never rejects for contention" contract (`slot.ts:431-435`), and the probe files leak. This is the
  plan's Windows antivirus focus: "EBUSY/EPERM on unlink must be retried, not treated as success".
  Here EPERM is treated as a verdict.
- **Fix:**
  1. Once `open(probe, "wx")` succeeds, the dir is writable. Remove the probe with `unlinkRetry`
     and ignore a residual failure (log it).
  2. Judge "unwritable" only from `mkdir`/`open` codes (`EACCES`, `EPERM`, `EROFS`, `ENOTDIR`).
     Retry `ENOENT` once, since the dir may have been removed concurrently.
  3. Cache the verdict per dir for the process, or at least never mix file and local holders for
     the same dir.
- **Resolution:** `4d627ed`. `probeDir` judges the dir only from `mkdir`/`open(probe,"wx")` codes:
  - EACCES, EPERM, EBUSY and ENOENT are retried twice (50/100 ms); EROFS, ENOTDIR and EEXIST are
    final.
  - Once the probe exists, the dir is writable. The probe is removed with the retrying unlink, and
    a residual failure is logged only.
  - The verdict is memoized per dir for the process. An unexpected error is not cached.

  Test (P6 replay) against a real holder process: a transient EPERM or EBUSY on the probe delete
  → busy (exclusion kept), no warning, no leaked probe. The probe runs once per dir.

### QA-1.4-4 — major — A sharing violation on the `.reap` file makes `release()`, `acquireSlot()` and `withSlot()` reject; the rejection is cached and the reap file leaks

- **Where:** `slot.ts:246` (the `finally` rejects on any `readFile` error except ENOENT);
  `slot.ts:239` (the busy path rejects on any `stat` error except ENOENT); `slot.ts:411` (`releasing ??=`
  caches a rejected promise); `slot.ts:486-490` (`withSlot`'s `finally` replaces `fn`'s result).
- **Evidence (P4):** a scanner-style share-mode-0 handle (`O_RDONLY | 0x10000000`, libuv
  `UV_FS_O_EXLOCK`; it gives `readFile`/`unlink` → EBUSY, checked separately) is opened on the reap
  file while the owner is inside the critical section.
  Output: `{"release1":"rejected EBUSY","release2":"rejected EBUSY","slotLeft":false,"reapLeft":true}`,
  and `withSlot(..., async () => 42)` → `rejected EBUSY`.
  The slot was freed, but the caller sees an error on every later `release()`. The leftover reap
  file then blocks reaps and releases of the slot for 10 s. `readLock` (`slot.ts:181-182`) already
  knows that scanners cause these codes, but the reap-file I/O does not.
- **Fix:** treat `EBUSY`/`EPERM`/`EACCES` on reap-file `stat`/`readFile` as retryable, with the
  unlink schedule. With the PID-owned reap lock of QA-1.4-2, the owner can unlink its own reap file
  through `unlinkRetry` without reading it. `release()` must never reject: catch, warn, and leave the
  slot to stale detection. Do not cache a rejection. `withSlot` must not let a release failure mask
  `fn`'s value or error.
- **Resolution:** `d2bdeef`.
  - All lock and claim reads go through `readLock`, which reports EBUSY/EPERM/EACCES as
    `unreadable`. Unreadable is retried on the unlink schedule and is never a verdict.
  - The claim is dropped with a token re-check under the same retries. A crashed claimer no
    longer blocks the slot for 10 s: its claim is removed by the PID rule.
  - `release()` catches everything, and so never rejects. It shares only an in-flight attempt, so a
    failure is not cached, and a later call starts a new attempt.
  - An unconfirmed delete is deferred and retried in the background, with warnings.
  - `withSlot` returns `fn`'s value or rethrows its error, because `release()` cannot reject.

  Tests:
  - EIO on unlink, or on every read → release resolves, twice.
  - `withSlot(() => 42)` → `{value: 42}`, and `fn`'s throw is preserved.
  - Transient EBUSY reads of the lock and the claim → deleted with no warnings.

### QA-1.4-5 — major — The multi-process tests cannot run on the Node 20 legs of CI

- **Where:** `test/fixtures/slot/holder.mjs:1-2,13` ("loads slot.ts through Node's built-in type
  stripping (Node >= 22.18 / 24)"); `.github/workflows/test.yml:18-19` (matrix `node: [20, 22, 24]`
  × `[ubuntu-latest, windows-latest]`); `package.json` `"engines": {"node": ">=20"}`.
- **Evidence:** `node --no-experimental-strip-types holder.mjs slot.ts '{…}'` (Node 20 behaves this
  way) → `ERR_UNKNOWN_FILE_EXTENSION`, and the child exits non-zero. On Node 20 the four
  child-process tests (`max=1`, `max=2`, crashed holder, unref exit) fail on both OSes: `codes`
  ≠ `[0,…]`, and `h.line` is `"EXIT …"` instead of `"HELD"`.
- **Fix:** give the child plain JS. In `beforeAll`, transpile `slot.ts` into the test's temp dir with
  a transformer already in the dev tree (the installed vite's `transformWithEsbuild`/`transformWithOxc`),
  and pass that path to `holder.mjs`. Alternatively, dropping Node 20 from `engines` and the matrix
  is a maintainer decision. Last resort: `it.skipIf(!process.features.typescript)` with a visible
  reason. This keeps the Node 20 legs green, but it loses the plan-mandated multi-process coverage
  there.
- **Resolution:** `25a7d4f`. `beforeAll` compiles the real `src/verify/slot.ts` to
  `<tmp>/slot.mjs` with the installed vite's `transformWithOxc`. The repo's TypeScript is 7.0.2,
  whose package exposes no `transpileModule` (checked). `holder.mjs` imports that build.
  With `NODE_OPTIONS=--no-experimental-strip-types`, the Node 20 condition, the full file passes
  (42/42).

### QA-1.4-6 — minor — `release()` silently abandons its own lock when a scanner blocks the read; the slot is unusable for 30 s

- **Where:** `slot.ts:418` (`cur.kind !== "ok"` → "reclaimed: not ours any more"); `slot.ts:182`
  (EBUSY on read → `corrupt`); `slot.ts:412-413` (heartbeat stopped and the `held` entry removed
  first); `slot.ts:424` (after the reap lock is busy 20×, it gives up with the same outcome).
- **Evidence (P5):** a share-mode-0 handle is held on `slot-0.lock` during `release()` and closed
  afterwards. Output: `{"slotLeft":true,"ownTokenStillOnDisk":true,"warnings":[],"nextAcquirerBusy":true}`.
  The release resolves and logs nothing, and the next acquirer is busy until the file ages past
  `staleMs` (same host, live PID). The heartbeat tick (`slot.ts:371`) also skips silently on this
  state.
- **Fix:** separate "unreadable" from "missing" and from "another token". Retry unreadable reads on
  the unlink schedule. If deletion cannot be confirmed, keep the `held` entry and the heartbeat, and
  retry the delete on an unref'd timer rather than abandoning the file. Warn when a release gives up.
- **Resolution:** `d2bdeef`.
  - `LockState` has four kinds: `missing`, `unreadable{code}`, `ok` and `corrupt`.
  - Under the claim, the release retries unreadable reads on the unlink schedule, and only
    `missing` or another token settles it.
  - If the delete is not confirmed, the handle goes to `deferred`. The heartbeat and the `held`
    entry (exit hook) stay, and the delete is retried on an unref'd timer every heartbeat, up to
    `staleMs / heartbeatMs` times.
  - It warns "release incomplete, retrying in the background" and, at the end, "release gave up,
    slot left to stale detection".
  - The heartbeat skips an unreadable tick instead of treating it as lost.

  Test: a persistently unreadable lock → release resolves, the file stays and is still held, with a
  warning. Once readable, the background retry deletes it, and the next acquirer gets the slot.

### QA-1.4-7 — minor — A holder never notices that it lost the slot

- **Where:** `slot.ts:367-378`. The heartbeat returns silently when the lock is missing or holds
  another token. A `utimes` failure (for example a persistent antivirus EPERM) only warns every
  5 s and is never retried. After 30 s the live holder is reaped.
- **Evidence:** in P1, P2 and P3 the losing holder keeps running with no signal. By design its
  `release()` then deletes nothing, which is correct but invisible.
- **Fix:** the first time the heartbeat sees the file missing or holding another token, warn once
  ("verification slot lost") and set `handle.lost = true` (additive) or call an `onLost` callback,
  so that Phase 2.x can record the over-commit. Retry `utimes` on the unlink schedule.
- **Resolution:** `d05d95e`. The first time the heartbeat finds the lock gone (or `utimes` gets
  ENOENT), or finds another token, the handle reacts once:
  - it sets `handle.lost = true` (a readonly getter, additive);
  - it calls `opts.onLost()` (additive; a throw is caught and logged);
  - it logs one warning, "verification slot lost…";
  - it stops the heartbeat.

  The same observation during a pending release only completes that release. `utimes` is retried
  on the unlink schedule (`d2bdeef`). Tests cover the taken-over and the deleted cases: `lost`,
  exactly one `onLost` call and one warning, and a later `release()` leaves the path alone.

### QA-1.4-8 — minor — Clock step backward: long (but not permanent) lockouts; the wait deadline uses the wall clock

- **Where:** `slot.ts:189` (a future mtime gives a negative age, so the lock counts as fresh);
  `slot.ts:240` (`.reap` reclaim is by age only, with no PID fallback); `slot.ts:448,459`
  (`deadline` is based on `Date.now`).
- **Answer to "forward then back = permanent lockout?":** no. The lockout lasts as long as the
  backward correction: minutes to hours, for example a dual-boot local-time/UTC step or a first-boot
  RTC error. It affects (a) crashed locks that cannot be judged by PID (foreign host, or a recycled
  live PID) whose mtime is in the future, and (b) any leftover `.reap` whose mtime is in the future.
  (b) is the worse case: no reap and no release of that slot can take the reap lock. Releases give
  up (QA-1.4-2), and their files pile up as held until the clock catches up. With `max=1` every
  verification is `busy` for the whole correction. A backward step during a wait also extends it
  beyond `waitMs`, and a forward step cuts it short.
- **Fix:** the observed-unchanged rule on the monotonic clock (QA-1.4-1) also covers future mtimes.
  Give the reap file PID-based reclaim (QA-1.4-2). Compute `deadline`/`remaining` from
  `performance.now()`, and keep `now` only for mtime comparisons.
- **Resolution:** `d2bdeef`.
  - Deadlines, observations and claim fencing use `deps.mono` (default `performance.now()`); `now`
    is only compared with mtimes.
  - A lock or claim seen unchanged for `staleMs` of monotonic time is stale whatever its mtime says,
    so a future mtime no longer locks anyone out for the length of the correction.
  - There is no `.reap` age lease any more. A claim is reclaimed by PID, or once inert on the
    monotonic clock.

  Tests:
  - A foreign lock with an mtime 1 h in the future is reclaimed after `staleMs` of observation.
  - A wall clock stepped +1 h or −1 h during a 600 ms wait neither cuts it short nor extends it.

### QA-1.4-9 — minor — Starvation: no fairness or hand-off between processes

- **Where:** `slot.ts:449-475`. Each waiter polls independently, with delays of 0.5–1.0 × up to
  2 s. A releasing process can re-acquire within milliseconds, for example in a batch loop, an S2
  recheck, or back-to-back `router_verify` calls.
- **Evidence (analysis):** with `max=1` and a process that re-acquires straight after each release,
  a foreign waiter wins only if its poll lands in the gap of a few milliseconds between two holds.
  It can lose every poll until `slotWaitMs` (60 s) and return `unverifiable` "verification slot
  busy". Waits are bounded, so this is starvation, not deadlock.
- **Fix:** add waiter tickets (`waiters/<startedAt>-<pid>-<uuid>`), heartbeated and judged stale by
  the slot rules. An acquirer defers to any older live ticket (FIFO), or at least a releaser that
  re-acquires within `backoffMaxMs` yields when an older ticket exists. Test: child A cycles
  acquire/release in a loop, and child B, waiting 5 s, must get the slot.
- **Resolution:** `65df39a`. FIFO waiter tickets:
  - A caller with `waitMs > 0` writes `wait-<startedAt:15>-<uuid>.ticket` (`{pid, hostname,
    token}`) and refreshes its mtime on every wake-up.
  - It tries the slots only while fewer than `max` live tickets sort before its own: strict FIFO
    for max=1, and for max>1 the `max` oldest waiters compete. A `waitMs=0` caller defers while
    `max` live tickets exist, so a releaser that re-acquires at once queues behind the waiters.
  - A ticket is dead if its PID is dead (same host), if it is older than `staleMs`, or if it has
    been seen unchanged for `staleMs` of monotonic time. Dead tickets are deleted; the names are
    unique, so there is no ABA.
  - Tickets only order the attempts: any ticket I/O failure lets the caller try (one warning per
    dir). They are removed in `finally` and by the exit hook.
  - Caveat: the ordering uses the wall-clock start time, so a backward clock step can let newer
    waiters jump ahead until the clock catches up. Waits stay bounded by `waitMs`.

  Tests:
  - A child cycling acquire/release in a tight loop against an in-process waiter with production
    backoff: the waiter gets the slot in < 5 s, with no overlap. With the gate disabled it starved.
  - A live older ticket defers a `waitMs=0` caller even with a free slot, but not with `max=2`.
    Aged and dead-PID tickets are ignored and removed.

### QA-1.4-10 — minor — The "stops the heartbeat" test is vacuous

- **Where:** `test/unit/slot.test.ts:170-182`. The test plants a lock with `token: "someone"`, but
  the heartbeat (`slot.ts:371`) never touches a file with a different token, even when it is still
  running.
- **Evidence (P7, mutation):** a copy of `slot.ts` with `clearInterval(hb);` removed runs the test's
  exact check. Output: `{"mode":"mutant","testAssertion_fileGone":true,"testAssertion_mtimeUnchanged":true,"sameTokenFileTouchedAfterRelease":true}`.
  The original gives `sameTokenFileTouchedAfterRelease:false`, so the regression passes the current
  test. (`getActiveResourcesInfo()` does not list unref'd timers, so it cannot be used here either.)
- **Fix:** after `release()`, rewrite the file with the released handle's **own** token and an old
  mtime, wait for more than 3 heartbeats, and assert that the mtime is unchanged. Alternatively,
  count heartbeat ticks through a seam.
- **Resolution:** `0024c3b`. Both proposed fixes are in the test.
  - It counts `utimes` calls through the new `deps.utimes` seam, and first checks that the
    heartbeat does run.
  - After `release()`, it writes the released handle's **own** lock back with a 10 s old mtime,
    waits 250 ms (8 heartbeats of 30 ms), and asserts that the mtime and the call count are
    unchanged.
  - Mutation check: with the heartbeat left running after release (phase guard and
    `clearInterval` removed), the test fails.

### QA-1.4-11 — minor — The multi-process tests never exercise concurrent reaping

- **Where:** `slot.test.ts:89-124`. The `cycle` runs never meet a stale lock, so `compareAndDelete`
  and the `.reap` paths only ever run single-process and sequentially. The crash test's only waiter
  starts *after* the kill (`slot.test.ts:110-113`), and the plan asks for the slot to be "reclaimed
  by the next waiter", meaning one that is already waiting.
- **Fix:**
  1. Plant a dead-PID lock, start 6 `cycle` children at once, and assert `maxOverlap ≤ 1`, 6/6 exit
     code 0.
  2. Run the same test with a leftover `.reap` aged more than `reapStaleMs`.
  3. In the crash test, start the waiter first and kill the holder while the waiter is in backoff.
- **Resolution:** `d2bdeef` (1, 2) and `25a7d4f` (3).
  1. A dead-PID lock is planted, and 6 `cycle` children start behind a barrier → 6/6 exit 0,
     `maxOverlap ≤ 1`, and no claim file is left.
  2. The same, plus a crashed reaper's claim for the planted token (dead PID, 11 s old) and the
     legacy `slot-0.lock.reap` and `.reap.dead-0` files, which the new protocol ignores → the claim
     chain clears the dead claim, with the same assertions.
  3. The crash test starts its waiter first, with production backoff, and kills the holder 700 ms
     later, during backoff → the slot is acquired < 3 s after the kill.

### QA-1.4-12 — minor — Deviation (2), the unwritable dir: the justification is inaccurate and the default-dir path is untested

- **Where:** `phase-1.4.md` "Tests" (claims that Windows ACLs "cannot be made read-only portably
  without admin rights"); `slot.test.ts:279-301` (injects `deps.dir`).
- **Evidence:** a non-elevated shell (`elevated=False`) ran `icacls <dir> /deny <user>:(OI)(CI)(W)`.
  Afterwards Node `mkdirSync` → `EPERM` and `openSync(...,"wx")` → `EPERM`, and
  `icacls /remove:d` restored the dir. On POSIX, `chmod 0o555` does the same when the process is not
  root. The plan asks to "point `TMPDIR`/`TEMP` at a read-only dir", which also exercises
  `defaultSlotDir()`. The ENOTDIR-under-a-file test never reaches that code.
- **Verdict:** the deviation is acceptable as an *extra* case, not as a replacement.
- **Fix:** add a test that makes a dir read-only (`icacls` deny on Windows, `chmod 0o555` on POSIX,
  skipped as root), points `process.env.TEMP`/`TMPDIR` at it, and calls `acquireSlot` without
  `deps.dir`. It must assert the fallback and exactly one log line, and restore the ACL and env in
  `finally`.
- **Resolution:** `4d627ed`. The new test runs on Windows with `icacls <dir> /deny
  <USERDOMAIN\USERNAME>:(OI)(CI)(W)` (non-elevated) and on POSIX with `chmod 0o555` (skipped as
  root).
  - It sets `TEMP`/`TMP`/`TMPDIR` and asserts that `os.tmpdir()` is the read-only dir.
  - It calls `acquireSlot` without `deps.dir`, so `defaultSlotDir()` is exercised.
  - It asserts the fallback semantics, exactly one "in-process" log line, and that nothing was
    created.
  - It restores the env and the ACL (`icacls /remove:d`, `chmod 0755`) in `finally`.

  The notes above now describe this. The ENOTDIR case is kept as an extra. After the runs, no
  `omr-slot-*` dir was left, so the ACL was restored and the dir removed.

### QA-1.4-13 — minor — Flakiness risks on a loaded 2-worker CI runner

- **Where and why:**
  - `slot.test.ts:102` asserts `maxOverlap === 2` for `max=2`. It relies on the start-up jitter of
    six children (Node start plus type stripping, ~0.2–0.4 s each on Windows) overlapping a 120 ms
    hold. If they serialise, the test fails although exclusion is correct.
  - `slot.test.ts:135-142`: a heartbeat of 80 ms against a 400 ms stale threshold, in one process.
    An event-loop stall of ≥ 320 ms lets the waiter reap the live holder (the QA-1.4-1 mechanism).
  - `slot.test.ts:38-41`: Windows reuses PIDs quickly, so `deadPid()` can name a live process.
- **Fix:**
  - Add a start barrier: children wait for a "go" file, or for a shared start timestamp passed in
    the config. Hold ≥ 500 ms in the `max=2` case.
  - For the long hold, use a heartbeat of 100 ms, `staleMs` 2 000 and a wait of 6 000 ms (still 3×).
  - Make `deadPid()` loop until `!isPidAlive(pid)`.
- **Resolution:** `25a7d4f`.
  - Children print READY and wait for a `go` file, which the test writes once all are ready.
  - `max=2` holds 500 ms (max=1 holds 150 ms).
  - The long hold uses heartbeat 100 ms, `staleMs` 2 000 and a 6 000 ms wait.
  - `deadPid()` is async and loops until `!isPidAlive(pid)`.
  - Later tests that race a heartbeat use an observer heartbeat 5× the holder's (`d2bdeef`), so
    the holder would need a ~1 s stall to be misjudged.

### QA-1.4-14 — nit — Deviation (1), corrupt/empty lock stale only after 2 s: accepted

The plan says that a corrupt or empty lock "is treated as stale". The grace protects a lock that is
still being written between `open("wx")` and `writeFile` (`slot.ts:216-231`), so the deviation is
justified. Residual risk: a creator stalled for more than 2 s in that window is reaped, and its
later `writeFile` goes to an orphaned (POSIX) or delete-pending handle, which gives two holders.
Optional fix, which also removes the need for the grace: publish atomically. Write
`slot-<i>.lock.<uuid>.tmp` in full, then `fs.link(tmp, slot)` (EEXIST means the slot is taken), then
unlink the tmp file. An empty or corrupt slot file can then only come from external damage.
- **Resolution:** `d2bdeef`. The deviation is kept (`open(wx)` is the pre-flighted primitive; hard
  links are not pre-flighted and fail on FAT and some shares). The residual risk is closed another
  way: `createOwned` re-reads the lock after writing it and holds the slot only if its own token is
  there, so a creator reaped while empty learns that it lost.

  Reaping a corrupt file now also needs the observed-unchanged rule, keyed on (mtime, size), for
  `corruptGraceMs`. Its claim is keyed the same way, so a file that is being written changes key
  and cannot be reaped.

### QA-1.4-15 — nit — Deviation (3), no busy-wait at 1/10 timing: accepted

The back-off is scale-invariant, so the wake-up count at 25→200 ms over 1 s equals the count at
250→2 000 ms over 10 s. The assertion 2 < wakes < 20 is sound. Gap: the production constants are
never checked, so a regression in `SLOT_DEFAULTS` (for example `backoffMinMs: 2`) passes.
**Fix:** assert the `SLOT_DEFAULTS` values, or run one wait with the default back-off under
`vi.useFakeTimers()`.
- **Resolution:** `0024c3b`. A test asserts `SLOT_DEFAULTS` ⊇ `{heartbeatMs: 5000, staleMs: 30000,
  backoffMinMs: 250, backoffMaxMs: 2000}`.

### QA-1.4-16 — nit — The jitter goes below the plan's 250 ms floor

`slot.ts:462`: `base × (0.5 + random × 0.5)`, so the first wait is 125–250 ms. Plan 1.4.1.d says
"250 ms → 2 s". **Fix:** use `min(backoffMaxMs, base × (1 + random × 0.5))`, or full jitter in
`[backoffMinMs, base]`.
- **Resolution:** `0024c3b`. The new exported `nextBackoffMs(k, r, min, max)` returns
  `min(max, base × (1 + r/2))`. The wait loop cuts only the final wait, to the deadline.

  Tests:
  - Every attempt 0–11 × r ∈ {0, …, 0.999999} stays in [250, 2000]. Exact values: 250, 375, 500
    and 2000.
  - With `random = 0`, the loop's first wake-up is ≥ `backoffMinMs`.
  - The old formula fails this test (mutation check).

### QA-1.4-17 — nit — In-flight heartbeat tick after release; the exit hook bypasses the reap lock

- A tick that has already passed its token check (`slot.ts:370-373`) can still call `utimes` after
  `release()` has deleted the file. It then refreshes the *next* owner's file once, or logs a
  spurious "heartbeat failed" (ENOENT).
- `releaseAllSync` (`slot.ts:275-288`) deletes outside the reap lock. That only matters for a holder
  that is already stale while alive (QA-1.4-1).
- **Fix:** add a `released` flag that the tick checks before `utimes`. Keep the exit-time delete
  token-checked, as it is now.
- **Resolution:** `d2bdeef`.
  - The handle has a phase (`held` / `releasing` / `deferred` / `done`). `release()` sets it before
    doing anything else, awaits any tick in flight, and the tick re-checks the phase immediately
    before each `utimes` attempt.
  - `releaseAllSync` follows the claim protocol. It creates the claim synchronously, checks the
    token, unlinks the lock and drops the claim. If our own async release holds the claim, it
    proceeds under that claim. If another process holds it, it leaves the file to that process.

  Tests:
  - A tick blocked inside its read while `release()` starts → 0 `utimes` calls afterwards.
  - The exit hook deletes its own lock, and leaves one whose token a live reaper has claimed, with
    no exit failures.

### QA-1.4-18 — deferred by plan (Phase 2.1 / 2.2) — Nested acquisition in one process

A process that holds a slot and calls `acquireSlot` again with `max=1` (for example around the S2
recheck) waits for its own slot until `waitMs` and then gets `busy`. There is no re-entrancy
detection. Every wait is bounded by `waitMs`/`signal` (§1.5-13), so this is a timeout, not a
deadlock. Two processes that each hold one slot and wait for another (`max=2`) also only time out.
The pipeline (Phase 2.1) and the batching coordinator (Phase 2.2) must acquire once per gate or
batch and hold the slot across the recheck (plan 1.4.1.b), never acquire a nested slot.

### QA-1.4-19 — deferred by plan (Phase 1.1 schema, Phase 2.1 wiring) — Non-finite `max`

`slot.ts:439`: `Math.max(1, Math.floor(NaN))` is `NaN`, so the acquire loop never runs and every
call returns `busy` after `waitMs`. `maxConcurrentVerifications` is validated as an "integer ≥ 1"
by the configuration surface (Phase 1.1), and Phase 2.1 passes the validated value.

## QA re-review (round 2)

Reviewer: adversarial QA, `[tier:heavy]` (CAP:none).

- **Scope:** `git diff c44c377..HEAD`, i.e. `d2bdeef`, `4d627ed`, `25a7d4f`, `d05d95e`, `65df39a`,
  `0024c3b` and the docs commit `3eea511`. Checked against plan "#### Phase 1.4" and the round-1
  findings. Line numbers below refer to `src/verify/slot.ts` at `3eea511`.
- **Environment:** Windows 11, NTFS, 16 cores, Node v24.21.0. A real Node v20.20.2 was also used,
  from the `node-win-x64@20` npm package. There is no Linux host.

The repro scripts are in `%TEMP%\opencode\qa14r2\` and are not committed: `fence.mjs`,
`liveness.mjs`, `dirgone.mjs`, `ticketblock.mjs`, `pidreuse.mjs` and `burn.mjs`.
- Each script imports the real `src/verify/slot.ts` through Node 24 type stripping.
- Two module instances (`slot.ts?a`, `slot.ts?b`) stand for two processes: each has its own
  observation map, claim table and exit hook.
- The scripts use only the public `deps` seams: `unlink` to freeze one call, `now` for a
  wall-clock step and `mono` to advance the monotonic clock. Every other constant is the
  production `SLOT_DEFAULTS` value.
- After the runs, no `node.exe` with `qa14r2`, `holder.mjs` or `burn.mjs` in its command line was
  left, and no `qa14r2-*` dir.

**Test runs** (`npx vitest run --maxWorkers=2 test/unit/slot.test.ts`):

| run | result | duration |
|---|---|---|
| Node v24.21.0 | 42/42 | 28.3 s |
| Node v20.20.2 (vitest, its workers and the spawned children all on Node 20) | 42/42 | 28.0 s |
| Node v24.21.0 under load: 14 CPU-spinning threads (`burn.mjs 14 75`) | 42/42 | 28.2 s |

Note: 16 `omr-slot-*` dirs were already in `%TEMP%`, dated 22:26:29–22:26:45, before this review's
first run (22:28:38). The last one holds a `slot-0.lock` and a ticket, so it comes from an
interrupted run whose `afterAll` never ran. None of the three runs above left a dir. The old dirs
were left in place.

**Summary (round 2):** QA-1.4-1…17 are all verified. New findings: 0 critical, 1 major, 2 minor
and 4 nit (QA-1.4-20…26).

### Verification of QA-1.4-1…17

- **QA-1.4-1 — verified.**
  - `lockStale`/`observedStale` (`:315-323`) reap by age only when the age is over `staleMs`
    **and** the same `token@mtime` has been seen for ≥ 2 heartbeats of monotonic time, with no
    gap over 2 heartbeats (`observe`, `:296-307`).
  - P1 and P1b with the production defaults → busy (`slot.test.ts:279-287`).
  - Side effect: QA-1.4-21.
- **QA-1.4-2 — verified.**
  - Claims are per identity (`:361-363`), and the target is re-read before every unlink attempt,
    retries included (`unlinkWhile`, `:371-398`).
  - A claim is reclaimed only for a dead same-host PID or once inert (`:325-328`, `:433-442`).
  - P2 step 5 cannot recur. There is no shared reap file, and a claim reclaim re-reads
    `identity@mtime`, so it returns `changed` for a fresh claim.
  - P2 step 7 cannot recur either: R4's retry re-reads the file and finds R5's token.
  - The P3 replay passes (`slot.test.ts:441-457`).
  - Residual: the self-fencing is a check, not a fence (QA-1.4-20).
- **QA-1.4-3 — verified.** `probeDir` (`:632-650`) judges only `mkdir`/`open(wx)` codes, and the
  verdict is memoized (`:611-623`). The P6 replay passes (`slot.test.ts:751-773`). A side effect of
  the memo is QA-1.4-22.
- **QA-1.4-4 — verified.**
  - `readLock` maps EBUSY/EPERM/EACCES to `unreadable` (`:260-272`).
  - `runAttempt` catches everything (`:866-871`), and `release` shares only the in-flight attempt
    (`:885-891`).
  - `withSlot` keeps `fn`'s value and error (`:968-984`).
  - `slot.test.ts:484-527` pass.
- **QA-1.4-5 — verified on a real Node 20.** The Node v20.20.2 run passes 42/42 (table above). The
  children are spawned with `process.execPath`, so they run on Node 20 too. The Ubuntu legs cannot
  run here. Caveat: the build relies on a transitive `vite` (QA-1.4-23).
- **QA-1.4-6 — verified.** `LockState` has four kinds (`:162-166`). A deferred release keeps the
  heartbeat and the `held` entry (`:873-883`). `slot.test.ts:529-547` passes.
- **QA-1.4-7 — verified.** See `notOurs` (`:801-812`). It was also seen live in `fence.mjs`: the
  victim got `lost: true` and exactly one `onLost` call within one heartbeat.
- **QA-1.4-8 — verified.**
  - The deadline and the remaining time come from `cfg.mono()` (`:928`, `:944`).
  - A lock seen unchanged for `staleMs` is stale whatever its mtime says (`:317`).
  - `slot.test.ts:302-327` pass.
- **QA-1.4-9 — verified.**
  - The tickets (`:652-751`) gate the wait loop (`:934`).
  - The fairness test passes in all three runs, and `ticketblock.mjs` leaves no ticket behind.
  - Residuals: the wall-clock order (declared) and QA-1.4-24.
- **QA-1.4-10 — verified by reading; the mutation run was not repeated.**
  - The test counts `utimes` calls through the seam and puts the released handle's *own* lock back,
    aged (`slot.test.ts:331-354`).
  - A heartbeat still running would pass its token check (`:817`) and call `utimes`, so
    `touches === count` would fail.
- **QA-1.4-11 — verified.** Both tests pass in all runs:
  - `slot.test.ts:459-475`: 6 children against a planted dead lock, with and without a crashed
    claimer's claim and the legacy files.
  - `:206-219`: the waiter starts first, and the holder is killed during its backoff.
- **QA-1.4-12 — verified.** `slot.test.ts:776-808` passes non-elevated on Windows in all runs. The
  POSIX `chmod 0555` branch was not run here.
- **QA-1.4-13 — verified.**
  - The barrier is in place (`holder.mjs:24-25`, `slot.test.ts:149-155`), with holds of 150 and
    500 ms.
  - The long hold uses 100 ms / 2 000 ms / 6 000 ms, and `deadPid()` loops.
  - Suspected new flake, measured with `pidreuse.mjs`: could one of the 6 children spawned right
    after `deadPid()` reuse the planted "dead" PID? In 0/60 trials, and the PID was not alive again
    100 ms later in 0/60. Not a finding.
  - The file passes under 14-thread CPU load.
- **QA-1.4-14 — verified.** `createOwned` re-reads the file (`:338-354`). A corrupt file's
  `(mtime,size)` identity is used for its claim (`:275-277`) and for its observation (`:321`,
  `:326`). Caveat: an unreadable re-read counts as owned (QA-1.4-26).
- **QA-1.4-15 — verified.** `slot.test.ts:703-705`.
- **QA-1.4-16 — verified.** `nextBackoffMs` (`:906-909`); `slot.test.ts:707-724`.
- **QA-1.4-17 — verified.**
  - The tick re-checks the phase before each `utimes` (`:819`), and release awaits the tick
    (`:865`).
  - The exit hook takes the claim (`:470-495`).
  - `slot.test.ts:549-597` pass.

### Answers to the round-2 focus questions

- **Two claimers.** A claim is created with `open(claim,"wx")`, a write and a re-read (`:338-354`),
  so one claimer wins. The loser's `reclaimClaim` sees a live owner and an unconfirmed observation,
  and returns `contended` (`:427`). Six real processes against a planted dead lock exercise this
  (`slot.test.ts:459-464`). It is sound except under the timing conditions of QA-1.4-20.
- **Crashed claimer.**
  - Same host and dead PID: the claim is cleared on the first look, one level up
    (`slot.test.ts:416-423`).
  - Reused PID or foreign host: the inert rule applies. The wall age must be over 30 s, and the
    claim must be seen unchanged for ≥ 10 s.
  - The chain stops at depth 3 (`:358`, `:427`), so the recursion is bounded.
- **"A live reaper never deletes after holding its claim 5 s".** This is a timing assumption. The
  deadline is checked at the top of each iteration (`:374`). A whole `readLock` (open, fstat, read,
  close on the libuv pool) and a queued `unlink` follow it. Two holders are proven in QA-1.4-20.
- **Ticket FIFO.**
  - A crashed same-host waiter (dead PID) is removed on the next scan.
  - A crashed waiter whose PID is live (reused) or foreign blocks the queue until its ticket is
    older than `staleMs`: 30.6 s measured, with the slot free (QA-1.4-24).
  - Tickets are removed in `finally`, by the exit hook, and as dead by later scans. No ticket file
    leaked in any run.
  - Wall-clock ordering: a backward step lets newer waiters jump ahead. This is declared, and
    bounded by `waitMs`.
  - A waiter whose ticket was deleted as dead re-creates it under its old name, so it keeps its
    place.
- **Observed-stale liveness for a process with no history.** The process must be one of the `max`
  oldest waiters. It then reclaims a crashed foreign or reused-PID lock at about
  max(first look + 2 × `heartbeatMs`, last heartbeat + `staleMs`), plus up to one wake-up (≤ 2 s).
  - Measured: 10.4 s for a 60 s-old lock (`liveness.mjs`).
  - It **never** reclaims if its wait is shorter than 10 s and its calls are more than 10 s apart
    (QA-1.4-21).
- **lost/onLost.** Verified. Detection takes at most one heartbeat (5 s). A loss found while a
  release is pending only completes that release, with no `lost`; that is by design.
- **Exit hook.** It follows the claim protocol. On EEXIST it leaves the file to the other claimer,
  and failures are counted in `exitReleaseFailures`.
- **Retries are bounded.** There is no unbounded loop:
  - `unlinkWhile`: ≤ `unlinkRetries` and the claim deadline.
  - `unlinkRetry`, the heartbeat `utimes`, and `deleteOwn` on `contended`: ≤ 6 each.
  - Deferred release retries: ≤ `staleMs/heartbeatMs` = 6.
  - Probe: 3 tries. `tryAcquireOnce`: 3 per slot.
  - Claim chain: depth ≤ 3, with 2 rounds each.
- **No busy wait; timers.**
  - Every wait sleeps ≥ `backoffMinMs` except the last, which is cut to the deadline (`:948`).
    `slot.test.ts:692-701` passes.
  - The heartbeat (`:847`) and the deferred-release timer (`:882`) are unref'd.
  - The wait timer (`:954`) and the in-process wait timer (`:582`) are ref'd on purpose, because
    the caller awaits them. Retry sleeps are ref'd but bounded (≤ 3.15 s).
- **Test realism.** A run takes about 28 s, stable across Node 24, Node 20 and CPU load. The
  compiled child works on Node 20 (verified). `vite` is not a direct devDependency (QA-1.4-23).

### QA-1.4-20 — minor — The claim self-fencing is a check, not a fence: a frozen reaper deletes a newer holder's lock (two holders); the documented window is not "microseconds"

- **Where:**
  - `slot.ts:371-398` (`unlinkWhile`): the deadline is checked at `:374`, then comes `readLock`
    at `:378`, then `cfg.unlink` at `:384`.
  - `slot.ts:325-328`: a claim is inert when the wall age is over `staleMs` (or the span is
    ≥ `staleMs`) and the span is ≥ 2 × `claimHoldMaxMs`.
  - Header `slot.ts:39-41`: "so the second rule never removes the claim of a claimer that still
    acts".
  - This report's implementation notes: "a window of microseconds".
- **Evidence (`fence.mjs`, proven):**
  1. `slot-0.lock` holds a dead same-host lock `T`.
  2. Reaper A (instance `?a`, `waitMs:0`) takes the claim `C_T`, passes its deadline check and the
     re-read, and is frozen inside `unlink(slot-0.lock)` through the seam.
  3. Reaper B (instance `?b`, production defaults, `waitMs 60 000`) sees a claim owned by a live
     PID. Once the claim is inert, B removes it under a meta-claim, takes `C_T`, deletes `T` and
     creates its own lock `U`.
  4. A is released. Its unlink deletes `U`, it returns `removed`, and it creates its own lock.

  The same interleaving was run twice:
  - B's wall clock stepped +31 s (an NTP step or a VM resume makes the claim look old):
    `{"step":31000,"aHeld":true,"bHeld":true,"bHeldAfterMs":10323,"aFrozenMs":10337,"bFileDeletedByA":true,"bLost":true,"bOnLostCalls":1,"warnsA":["verification slot: claim held too long, delete abandoned"]}`
  - No clock step:
    `{"step":0,"aHeld":true,"bHeld":true,"bHeldAfterMs":30567,"aFrozenMs":30575,"bFileDeletedByA":true,"bLost":true,"bOnLostCalls":1,…}`

  What this shows:
  - The deadline stops only the *next* attempt. A logs "claim held too long" for its claim drop
    after its target delete has already gone through.
  - Without a clock step, the needed freeze is about 30 s, about as rare as the holder-side
    contract.
  - After a forward step of ≥ 25 s, a freeze of about 10 s is enough. The wall-age term is then
    met at once, and only 2 × `claimHoldMaxMs` of observation remains.
  - The claim-drop phase (`:424`) has a smaller margin under a step (analysis, not run). It may act
    until 1.5 × `claimHoldMaxMs` (7.5 s), and the claim is judged inert at 10 s. So a 2.5 s freeze
    between its token re-read and its unlink deletes a successor's claim. An ABA then still needs a
    third claimer.
  - The victim learns of the loss within one heartbeat (`lost`, `onLost`), so the over-commit is
    detected, not silent.
- **Fix:**
  1. For claims, drop the wall-age shortcut: a claim is inert once seen unchanged for ≥ `staleMs`
     of monotonic time. Claims are never refreshed, so the wall age only adds exposure to clock
     steps. The freeze needed is then ≥ 25 s under any clock behaviour.
  2. In `unlinkWhile`, re-check the deadline after `readLock`, just before `cfg.unlink`. The window
     then shrinks to one queued syscall instead of five.
  3. Correct the header (`:39-41`) and the implementation note. The rule assumes no freeze longer
     than (inert confirmation − `claimHoldMaxMs`) between the check and the syscall; state the
     numbers.
- **Resolution:** `17fac6a`.
  1. `claimInert` judges a claim only by the shared observation: span ≥ `staleMs` and witnessed ≥
     2 × `claimHoldMaxMs`. The wall age plays no part.
  2. `unlinkWhile` re-checks the deadline after the re-read, right before `cfg.unlink`. The fence
     also starts earlier: its start time is taken before `open(claim, "wx")`, since other processes
     can see the claim from then on. After the claimer's last check, the claim needs ≥ 25 s more to
     turn inert; the claimer's own drop has ≥ 22.5 s.
  3. The header and the implementation note state these bounds (25 s for the target, 22.5 s for the
     drop), plus the 10 s of witnessed running time after a machine-wide freeze. "Microseconds" is
     gone.

  Tests:
  - "inert only once seen unchanged for staleMs": a claim that looks 60 s old is removed after
    ≥ 950 ms (`staleMs` 1 s). Before the fix this took about 200 ms.
  - "re-checked after the re-read": 0 unlinks, and the "claim held too long" warning.

  Both tests fail by mutation.

### QA-1.4-21 — major — Regression from the QA-1.4-1 fix: with `slotWaitMs` < 10 s, a lock that is not provably dead is never reclaimed

- **Where:**
  - `slot.ts:296-307`: the observation map is per process and restarts after a gap of 2
    heartbeats.
  - `slot.ts:320-323`: staleness by age needs ≥ 2 × `heartbeatMs` of the observer's own continuous
    observation.
  - The plan's configuration table: `slotWaitMs` is an "integer ≥ 0", and `slotWaitMs: 0` is valid
    and means "no wait" (plan lines 259 and 537).
  - Plan 1.4.1.c(b), and the goal "recovers from crashes and never deadlocks".
- **Evidence (`liveness.mjs`, production defaults, proven):** `slot-0.lock` names a live, unrelated
  same-host PID (a crashed holder whose PID was reused). Its heartbeat is 60 s old.
  `{"freshProcessesWaitMs0":["busy","busy","busy","busy","busy"],"oneProcessWaitMs0Every11s":["busy","busy","busy","busy","busy","busy"],"oneProcessWaitMs0Every4s":["busy","busy","busy","held"],"freshWaitMs8000":{"result":"busy","ms":8003},"freshWaitMs30000":{"result":"held","ms":10430}}`
  - Five fresh processes with `waitMs:0` stay busy, and so does one process calling every 11 s.
    Neither ever reclaims the lock.
  - Only a caller that looks at the lock for 10 s, with no 10 s gap, reclaims it. The round-1 code
    reclaimed it on one look.
  - The same holds for a foreign-host lock, and for a live same-host holder that stopped
    heartbeating, such as a hung opencode process or one suspended with `Ctrl+Z`.
  - With `slotWaitMs: 0`, or under about 10 s, every verification is `unverifiable` until that PID
    exits. The lockout is unbounded.
- **Fix:** make the observation outlive the call and the process.
  - Record the first sighting of `token@mtime` in a sidecar created with `wx`, for example
    `slot-<i>.lock.seen-<hash(token@mtime)>`. It holds `{firstHr, lastHr}` on the host-wide
    monotonic clock `process.hrtime.bigint()`: `CLOCK_MONOTONIC` on Linux, `mach_absolute_time` on
    macOS, QPC on Windows.
  - Each observer updates `lastHr`, and the same gap rule applies. Any process on the host can then
    confirm staleness with one look once the sidecar spans ≥ 2 heartbeats.
  - Keep the same-host dead-PID fast path. Delete the sidecar together with the lock; it is keyed by
    the lock identity, so a leftover is inert.
  - Whether QPC advances during a Windows sleep was not verified here. The gap rule on `lastHr`
    covers both cases.
  - Add a test: fresh processes with `waitMs:0`, ≥ 10 s apart, reclaim an aged live-PID lock.
  - Weaker alternative if the sidecar is rejected: Phase 1.1 documents that a `slotWaitMs` under
    about 12 s cannot reclaim a lock whose owner is not provably dead, and warns about it.
- **Resolution:** `17fac6a`. The sidecar is implemented as proposed, with these details.
  - **Name and contents:** `slot-<i>.lock.seen-<sha256(file, identity, host)[:32]>` holds `{key,
    boot, bootAt, first, from, last}`. `first` is never reset by a gap; only `from` (the witness
    start) is.
  - **Staleness:** a lock is stale when (wall age > `staleMs` or span ≥ `staleMs`) and witnessed ≥
    2 heartbeats.
  - **Clock:** `process.hrtime`. It was verified to be system-wide on this Windows host.
    - On Linux and macOS it stops during a suspend.
    - Whether QPC counts a Windows sleep is undocumented, and Modern Standby freezes processes while
      every clock runs.
    - So the gap rule stays, and dropping it would re-open QA-1.4-1 (proved by mutation).
  - **Reboot and host guard:** the Linux boot id, a boot instant `wall − mono` that moved by more
    than 60 s, or a stamp from the future restarts the record. The host is part of the name.
  - **Background watch:** the gap rule alone cannot let a caller whose looks are more than 2
    heartbeats apart reclaim a lock. So a call that gives up on an aged lock keeps watching it in
    the background (unref'd timer, every heartbeat, bounded).
  - **Sidecar deletion:** the sidecar is deleted with the lock, and leftovers are collected by
    QA-1.4-25.

  The dead-PID fast path is kept. Residual: short-lived processes that each look once, more than
  2 heartbeats apart, still cannot reclaim; the next caller that waits or lives 2 heartbeats does.
  This is documented in the header.

  Tests (each fails by mutation):
  - five fresh `waitMs: 0` processes;
  - one process every 600 ms (> 2 heartbeats), through the watch;
  - a simulated 60 s freeze that must be re-witnessed.

### QA-1.4-22 — minor — The "writable" memo never re-creates the slot dir: once a temp cleaner removes it, every acquire in that process rejects with ENOENT

- **Where:**
  - `slot.ts:611-623`: the verdict is memoized for the life of the process.
  - `slot.ts:632-650`: `mkdir` runs only in the probe.
  - `slot.ts:341-345`: `createOwned` rethrows every error except EEXIST and the transient codes.
  - `slot.ts:916-965`: nothing catches around `tryAcquireOnce`.
- **Evidence (`dirgone.mjs`, proven):** acquire and release in `<tmp>/…/verify-slots`, then
  `rmSync(dir)`.
  `{"first":"held","afterRemoval_waitMs0":"rejected ENOENT","afterRemoval_waitMs500":"rejected ENOENT","afterRemoval_withSlot":"rejected ENOENT","stillRejectsLater":"rejected ENOENT","dirRecreated":false,"warns":["verification slot: waiter ticket I/O failed, fairness is best effort"]}`
  - The only log line is the ticket warning, which is misleading.
  - Before `4d627ed`, every call ran `mkdir(recursive)`.
  - Temp cleaners remove idle entries: systemd-tmpfiles age rules for `/tmp`, macOS `dirhelper`,
    Windows Disk Cleanup and Storage Sense. Which of them removes an empty dir was not verified
    here.
  - A long-lived process such as `opencode serve` would then never verify again.
- **Fix:**
  - On ENOENT from `open(slot|claim|ticket, "wx")` or `readdir`, run `mkdir(dir, {recursive:true})`
    once and retry the attempt. If that `mkdir` fails, drop the memo entry so that the next call
    probes again.
  - Decide what `acquireSlot` does with other unexpected fs errors (EMFILE, ENOSPC, EIO): return
    `busy` with one warning, or document that it can reject. Today the doc says only "never rejects
    for contention".
  - Add a test: the dir is removed between two acquires, and the second one holds.
- **Resolution:** `17fac6a`.
  - **ENOENT at use time:** an ENOENT from the slot create re-creates the dir once
    (`mkdir(recursive)`) and repeats the attempt. The ticket create does the same.
  - **Other paths:** a claim create that hits ENOENT reports `gone`, because the target left with
    the dir. `readdir` treats ENOENT and ENOTDIR as "no tickets", with no misleading warning.
  - **mkdir failure:** the dir verdict is dropped, so the next call probes again. A dir that has
    become unwritable then degrades to the in-process semaphore, as documented.
  - **Decision for EMFILE, ENOSPC, EIO and other unexpected errors,** including probe errors
    outside the verdict codes: `acquireSlot` resolves `{busy:true}`, drops the verdict, and logs
    "file-system error, reporting busy" once per dir and code. It never rejects, and it never
    grants a slot without its lock file.

  Tests (the first fails by mutation):
  - The dir is removed before the no-wait, ticket and `withSlot` paths; each call holds, with no
    warning.
  - EIO → busy, with 1 warning over 2 calls.
  - A file where the dir was → busy, then the in-process fallback on the next call.

### QA-1.4-23 — nit — The test's JS build relies on a transitive `vite`, and some allowed versions lack `transformWithOxc`

- **Where:** `test/unit/slot.test.ts:33-39` (`await import("vite")`, then `transformWithOxc`);
  `package.json` devDependencies, which have no `vite`.
- **Evidence:**
  - `npm ls vite` gives only `vitest@4.1.11 → vite@8.2.2`, and vitest 4.1.11 declares
    `"vite": "^6.0.0 || ^7.0.0 || ^8.0.0"`.
  - In the packed `vite@6.4.3` and `vite@7.3.6`, `dist/node/index.d.ts` has no `transformWithOxc`
    (0 matches). 8.2.2 exports it.
  - If a dedupe or an override resolves vite 6 or 7, `beforeAll` throws and all 42 tests fail. A
    strict pnpm install would not resolve `vite` at all.
  - Today the lockfile pins 8.2.2, so CI is not affected.
- **Fix:** add `"vite": "^8.2.2"` to devDependencies, or fall back to `transformWithEsbuild` when
  `transformWithOxc` is missing.
- **Resolution:** `17fac6a`, without touching `package.json`, which is owned by phases 3.1 and 3.3.
  - **vite from vitest:** the test resolves vite from vitest's own location:
    `createRequire(require.resolve("vitest/package.json")).resolve("vite")`. vitest always depends
    on vite, so this works without a direct devDependency and under a strict pnpm layout.
  - **Transform:** it uses `transformWithOxc` (vite 8), else `transformWithEsbuild` (vite 6 and 7).
  - **Last resort:** Node's `module.stripTypeScriptTypes` (Node 22.13+). On Node 24 it prints an
    ExperimentalWarning, which is why it comes last.

  Verified here on vite 8.2.2. The vite 6/7 branch was not run. A direct `vite` devDependency can
  still be added in 3.1 if wanted.

### QA-1.4-24 — nit — A crashed waiter whose PID is live (reused) or foreign holds the FIFO head for `staleMs` while the slot is free

- **Where:** `slot.ts:705-713` (`ticketLive`: a ticket is live while its age ≤ `staleMs`);
  `slot.ts:720-751`.
- **Evidence (`ticketblock.mjs`, production defaults, proven):** a fresh ticket names a live,
  unrelated PID. The slot is free. A waiter with `waitMs 45 000` starts, and a `waitMs:0` caller
  runs every 5 s.
  `{"slotWasFree":true,"waiter":"held","waitedMs":30623,"waitMs0CallersMeanwhile":["busy","busy","busy","busy","busy","busy"],"ticketsLeft":[]}`
  This is bounded and heals itself, but for 30 s nothing verifies although nothing runs. A live
  waiter refreshes its ticket on every wake-up: at least every `backoffMaxMs` (2 s), plus one
  `tryAcquireOnce`.
- **Fix (optional):** give tickets a TTL of 2 × `heartbeatMs` (10 s) instead of `staleMs`. A live
  waiter misjudged by that TTL only re-creates its ticket, under its old name, at its next wake-up.
  That is a fairness blip with no effect on exclusion.
- **Resolution:** `17fac6a`. A ticket is refreshed every heartbeat by an unref'd timer while the
  wait lasts, and on every wake-up. A long attempt therefore never lets it lapse. The timer and the
  wake-ups share one refresh in flight, and the timer is cleared before the ticket is dropped, so
  nothing re-creates a dropped ticket.
  - **Dead tickets:** a ticket is dead when its PID is dead on this host. It is also dead once it
    has gone 2 × `heartbeatMs` (10 s) without a refresh, whatever its PID says (PIDs are reused).
    Staleness is judged by its mtime, or by this process seeing it unchanged that long.
  - **Misjudged waiters:** a misjudged live waiter re-creates its ticket under its old name.

  Tests (each fails by mutation):
  - A ticket 300 ms old (TTL 200 ms, `staleMs` 1 s) with a live PID is deleted.
  - A waiter whose attempts take 1 s keeps its ticket through 8 probes by other callers: 0 deletes.

### QA-1.4-25 — nit — Orphaned claim, meta-claim, legacy and probe files are never collected

- **Where:**
  - The only `readdir` is in `eligible` (`slot.ts:723`), and it looks only at `wait-*.ticket`
    names (`:659`, `:729`).
  - Claims are visited only through `removeUnderClaim`, for a known identity (`:412`).
- **Evidence (analysis):** these files stay in the slot dir for good:
  - the claim of a claimer that crashes after its target is gone (after `unlinkWhile` returned,
    before the drop at `:424`), and likewise a meta-claimer's claim;
  - a probe whose delete failed (`:644`);
  - the legacy `slot-<i>.lock.reap` and `.reap.dead-*` files, which the protocol ignores
    (`slot.test.ts:471-472`).

  They cost only bytes, with no effect on exclusion or liveness.
- **Fix:** during the `eligible` pass, collect `*.reap-*` files through `reclaimClaim` (under the
  meta-claim, with the key re-checked) once they are inert and more than 1 h old. Delete
  `.probe-*` files older than 1 h by path; their names are unique. Or document the leak.
- **Resolution:** `17fac6a`. At most every 10 min per dir and process, the ticket scan's `readdir`
  also collects files older than 1 h (wall mtime).
  - **By path:** `.probe-*` (unique names), `.seen-*` sidecars and the legacy `.reap` and
    `.reap.dead-*` files. Sidecars are advisory: a lost sidecar only restarts an observation.
  - **Claims:** removed under the claim protocol, with the key re-checked, in two cases:
    - the claim's recorded `target` no longer holds its `victim`. Identities are never reused, so
      such a claim guards nothing, whether its owner is alive or not;
    - the claim is empty or corrupt. With QA-1.4-26, nobody ever held it.
  - **Left alone:** claims without `target`/`victim`, claims whose victim is still there (the
    reaping path handles those), and anything younger than 1 h.

  Test: planted 2 h-old orphans are removed; the young and still-guarding files stay, with no
  warning. It fails by mutation.

### QA-1.4-26 — nit (theoretical) — `createOwned` counts an unreadable re-read as ownership, and nothing re-verifies a claim

- **Where:** `slot.ts:352-353`; claims are created through `createOwned` at `:416`.
- **Evidence (analysis, not run):** for a slot lock, the heartbeat re-reads the token within 5 s
  and reports a loss (QA-1.4-7). A claim is never re-read by its holder before the drop. The
  sequence:
  1. Claimer R1 is frozen for ≥ 2 s between `open(claim,"wx")` and its write.
  2. The empty claim is reaped as corrupt after 2 s of observation (`:326`), and R2 takes the claim.
  3. R1 resumes, writes into its orphaned handle, and re-reads while a scanner holds R2's claim.
     The re-read gets EBUSY, which counts as `unreadable`.
  4. Both believe they hold the claim, and the claim's ABA protection is gone.

  This needs a freeze and a scanner hit at the same instant.
- **Fix:** in `createOwned`, retry an unreadable re-read on the unlink schedule. For claims, hold
  only on an `ok` read with our own token; a claim that cannot be confirmed is left to the inert
  rule.
- **Resolution:** `17fac6a`, as proposed. `createOwned` retries an unreadable re-read on the unlink
  schedule.
  - **Claims:** a claim is held only on an `ok` re-read that shows its own token. An unconfirmed
    claim is never used and is left to the inert rule. Once its owner exits, it is cleared at once,
    because the owner's PID is dead.
  - **Slot locks:** a lock still unreadable after the retries counts as held, as before, because the
    heartbeat re-reads the token within one interval.
  - **Test:** EBUSY on every claim read. The dead lock survives, and our claim is left. Once reads
    work, the claim is cleared only after `staleMs` of observation. It fails by mutation.
