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

Updated after the QA fixes (commits `25a7d4f`…`0024c3b`). The first version's notes are superseded:
its `.reap` time lease, its wall-clock deadline and its "future mtime = fresh" rule are gone.

- **API:** `acquireSlot({max, waitMs, signal, meta, onLost?}, deps?)` → `SlotHandle | {busy:true}`,
  with `SlotHandle = {release(), readonly lost}`, plus `withSlot`, which releases on success, throw
  and abort. `onLost` and `lost` are additive. `deps` injects the dir, the logger
  (`Pick<PluginLogger,"warn">`), the wall clock `now` (used only against mtimes), the monotonic
  clock `mono` (`performance.now()`), random, host, pid, the PID probe, the `unlink`/`read`/`utimes`
  seams and every timing constant. The defaults are the plan values: heartbeat 5 s, stale 30 s,
  backoff 250 ms → 2 s. Two additions: a corrupt-file grace of 2 s and a claim hold limit of 5 s.
- **Creation:** `open(slot, "wx")` and a JSON write, then a re-read. The creator holds the slot only
  if its token is there.
- **Staleness:** a lock is stale if (a) it is from this host and its PID is dead, which is immediate;
  or (b) its mtime is older than `staleMs` **and** this process has seen the same (token, mtime)
  for ≥ 2 heartbeats of its own monotonic clock, with no gap over 2 heartbeats between two looks.
  A lock seen unchanged for `staleMs` of monotonic time is stale whatever its mtime says. A foreign
  host is never judged by PID. A corrupt or empty lock follows (b), with `corruptGraceMs` for both
  the age and the observation (**deviation from the plan**, accepted in QA-1.4-14).
- **Deletion (TOCTOU):** every delete of a file with identity K runs under the claim file
  `slot-<i>.lock.reap-<sha256(K)[:32]>` (`wx`, `{pid, hostname, token}`). K is the token, or for a
  corrupt file its mtime and size. This covers stale reaps, the owner's release and the exit hook.
  The claim holder re-reads the file before every unlink attempt and deletes it only while it is
  still K. K is never reused and only a K-claim holder deletes K's file, so there is no ABA between
  the re-read and the unlink, and no time lease.
  - A crashed claimer's claim is removed the same way, under the claim for its token. That happens
    when its owner is a dead same-host PID, or when the claim is inert: older than `staleMs` and seen
    unchanged for 2 × `claimHoldMaxMs`. The chain goes at most 3 levels deep.
  - A claimer never deletes after holding its claim for `claimHoldMaxMs` of monotonic time
    (self-fencing), and drops its own claim only within 1.5 × that time.
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
- **Fairness:** a waiter files `wait-<startedAt>-<uuid>.ticket`, refreshes it on every wake-up, and
  tries only while fewer than `max` live tickets are older than its own (FIFO for max=1). A caller
  with `waitMs=0` defers while `max` live tickets exist. Tickets are advisory: exclusion never
  depends on them.
- **Clock:** deadlines and observations use `performance.now()`. The wall clock is compared only
  with mtimes.
- **Exit:** a single `process.on("exit")` listener (registered once) follows the claim protocol
  synchronously. It takes the claim, checks the token, unlinks the lock and drops the claim. If
  another process holds the claim, it leaves the file to that process. It also removes its tickets.
- **Unwritable dir:** the verdict comes only from `mkdir`/exclusive-create codes. EACCES, EPERM,
  EBUSY and ENOENT are retried twice; EROFS, ENOTDIR and EEXIST are final. Once the probe is
  created, the dir counts as writable, and removing the probe is housekeeping. The verdict is
  memoized per dir for the process, so file and in-process holders never mix. The in-process
  fallback logs once per dir.
- **Residual risk (documented in the header):** check-then-act on a file system keeps a window of
  microseconds between the last check and the syscall. A process frozen exactly there (SIGSTOP, a
  debugger) can act late. A holder that stops heartbeating for 2 intervals while its lock looks
  older than `staleMs` is reaped (the plan's contract), and it is told so through `lost`.

## Tests (`test/unit/slot.test.ts`, 42 tests)

Each test uses an isolated `mkdtemp` dir. The multi-process fixture `test/fixtures/slot/holder.mjs`
imports a JS build of the real `slot.ts`. The build is made in `beforeAll` with vite's
`transformWithOxc`, which ships with vitest; TypeScript 7 has no `transpileModule`. The children
therefore need no type stripping. This was verified by running the file with
`NODE_OPTIONS=--no-experimental-strip-types`, which is the Node 20 condition: 42/42 passed. The
children start behind a barrier (READY, then a `go` file).

The read-only temp dir case is real. On Windows it uses `icacls <dir> /deny <user>:(OI)(CI)(W)`,
non-elevated; on POSIX it uses `chmod 0555`, skipped as root. The test points
`TEMP`/`TMP`/`TMPDIR` at the dir, uses the default slot dir, and restores the env and the ACL in
`finally`. The earlier `ENOTDIR` case stays as an extra.

Three consecutive runs (`npx vitest run --maxWorkers=2 test/unit/slot.test.ts`) passed 42/42 each
time (27.0 s, 32.1 s, 30.9 s). Afterwards no `node.exe` with `slot` in its command line remained,
and no `omr-slot-*` temp dirs were left. `npm run typecheck` is clean.

Mutation checks were run and reverted. Each broken rule failed its tests:
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
