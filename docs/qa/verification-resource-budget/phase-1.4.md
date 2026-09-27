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

Updated after the QA fixes (commits `25a7d4f`…`0024c3b`), the round-2 fixes (`17fac6a`) and the
round-3 fixes (`a4034ec`). The first
version's notes are superseded: its `.reap` time lease, its wall-clock deadline and its "future
mtime = fresh" rule are gone. So is round 1's per-process observation map.

- **API:** `acquireSlot({max, waitMs, signal, meta, onLost?}, deps?)` → `SlotHandle | {busy:true}`,
  with `SlotHandle = {release(), readonly lost}`, plus `withSlot`, which releases on success, throw
  and abort. `onLost` and `lost` are additive. `deps` injects the dir, the logger
  (`Pick<PluginLogger,"warn">`), the wall clock `now` (used against mtimes and to tell clock
  origins apart), the machine clock `mono` (`process.hrtime`, anchored to `os.uptime()` where it
  counts from the process start, QA-1.4-27), random, host, pid, the PID probe, the
  `unlink`/`read`/`utimes` seams and every timing constant. The defaults are the plan values:
  heartbeat 5 s, stale 30 s, backoff 250 ms → 2 s. Two additions: a corrupt-file grace of 2 s and a
  claim hold limit of 5 s. `acquireSlot` never rejects.
- **Creation:** `open(slot, "wx")` and a JSON write, then a re-read. An unreadable re-read is retried
  on the unlink schedule. The creator holds the slot only if its token is there. A slot lock still
  unreadable after the retries counts as held, because the heartbeat re-checks it within 5 s. A
  claim never counts as held that way (QA-1.4-26).
- **Shared observation (QA-1.4-21, per clock origin since QA-1.4-27):** every look at a lock or
  claim is recorded in a sidecar, `slot-<i>.lock.seen-<sha256(file, identity, host)[:32]>`. The
  sidecar holds the file's `key` and one view per clock origin, `{boot, bootAt, slack, first, from,
  last}`:
  - `key` is identity@mtime; a new key drops every view.
  - A look's origin is its boot (the Linux boot id) and its boot instant `bootAt = wall − mono`,
    read together. It uses the view of its boot whose `bootAt` is within its slack of its own, or
    starts one, and compares its `mono` with that view's stamps only. The slack is 1 s (the
    uptime's resolution budget), or a fifth of the heartbeat when that is shorter (tests).
  - Within one view two stamps disagree by at most the look's slack plus the largest slack of the
    view's writers (2 s in production). Every `mono` threshold adds that, so no margin shrinks:
    staleness needs a span ≥ `staleMs` + 2 s (or the wall age) and a witness ≥ 2 heartbeats + 2 s;
    a claim is inert at span ≥ `staleMs` + 2 s and witness ≥ 2 × `claimHoldMaxMs` + 2 s.
  - `first` is the view's first sighting of the key. `last` is its latest look. `from` is the first
    look after the latest gap between two looks of more than 2 heartbeats minus this look's slack
    and the view's (8 s in production: 2 × 5 s − 2 × 1 s). `span = now − first`
    and `witnessed = now − from`. A stamp from the future (another boot's clock) restarts the view.
  - At most 4 views are kept; the oldest goes first.
  - The host is part of the name, so hosts sharing a dir never mix clocks.
  - Sidecar I/O is advisory: a failure loses evidence and delays a reclaim; it never causes one.
- **Clock (QA-1.4-27):** `mono` must be one counter for every process of the boot. `os.uptime()`
  is: GetTickCount64 on Windows (15.6 ms steps), CLOCK_BOOTTIME on Linux, wall − boot time on
  macOS; some runtimes round it to whole seconds. `process.hrtime` is on Node (QPC,
  CLOCK_MONOTONIC, mach time), but not on Bun, which counts from the process start.
  - Verified on this Windows 11 host: Node 24 and Bun 1.3.14 read the same `wall − os.uptime()`
    within 15 ms (1790419230699…714 ms), and `os.uptime()` has 15.6 ms steps on both. Node's
    `wall − hrtime` is the same in every process and within 25 ms of it; a fresh Bun process reads
    `hrtime` ≈ 0.4 s.
  - So each process, at its first use, takes `hrtime` as is when it reads within 2 s of the uptime.
    Otherwise it anchors `hrtime` to the uptime: `mono = hrtime + max(uptime − hrtime)` over its
    reads, with the uptime read first so that each sample is a lower bound. That never goes back,
    is as fine as `hrtime` within the process, and agrees with the other processes within the
    uptime's resolution. After a suspend that the uptime counts and `hrtime` does not (Linux,
    macOS), it jumps ahead with the uptime.
  - Microsoft documents that GetTickCount64 counts sleep, but says nothing about QPC. Modern Standby
    pauses desktop processes while every clock runs.
  - So no rule assumes that the clock stops while processes are frozen; that is why the witness is
    kept. The wall clock is compared with mtimes, and it tells clock origins apart.
  - Not verified here: Bun on Linux and macOS (no host). If its uptime counts whole seconds, the
    processes still share a view whenever their anchors agree within 1 s; otherwise they get
    separate views, which only costs sharing.
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
    than 2 heartbeats minus both slacks (8 s in production) apart. If the looks are further apart, the reclaim falls to the next caller
    that waits, or lives, for 2 heartbeats.
- **Residual (QA-1.4-21, accepted; documented in the header):** looks more than 8 s apart (2 heartbeats
  minus both slacks) cannot tell a dead holder from a frozen machine. So a lock whose owner is not provably dead (a
  reused PID, another host, a hung holder) is reclaimed only by a caller that waits, or stays alive,
  for 2 heartbeats after its look (10 s plus the 2 s slack), or by callers that look often enough
  together. Until then every caller is told busy. A same-host holder with a dead PID is still
  reclaimed at once by any caller. The Phase 2.x callers are opencode plugin processes, alive for a
  whole session, so their watches do it. Phase 1.1/2.1 should state this next to `slotWaitMs`.
- **Own leftovers (QA-1.4-28, QA-1.4-29):** a slot lock that a call created before an unexpected
  error is removed under its claim (own-token check) before the busy result. If that fails too,
  the process remembers it: its next look at the slot reaps it at once, and so does the exit hook.
  A claim that the process created but could not confirm is remembered by token; the process drops
  it at its next readable look, within the claim-drop fence (1.5 × `claimHoldMaxMs`), and at exit.
  After the fence it is left to the inert rule.
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

## Tests (`test/unit/slot.test.ts`, 60 tests)

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

Round 3 added 9 tests (`a4034ec`):
- QA-1.4-27, in-process instances with injected `mono` seams:
  - b1: a live holder (production heartbeat); observers Y and O whose clocks are 8 s apart see a
    +31 s wall step. Y looks at 0.2 s and 3.0 s, O at 4.4 s. On one record O would count 12.2 s
    (a 9.4 s gap, so no restart), more than 2 heartbeats plus the 2 s slack. O is busy, the holder
    keeps its token and is not lost, and the sidecar holds 2 views.
  - b3, twice: two observers whose clocks are 8 s apart, or read 0 at their own start 1.5 s apart
    (like Bun's `hrtime`), alternate `waitMs: 0` calls every 200 ms against a hung lock. Each
    reclaims on its own view, exactly one holds it, and 6 more calls are busy.
  - The clock builder: a Node-like `hrtime` is taken as is. Two Bun-like ones (8 s apart), with a
    whole-second uptime, never go back, never read ahead of the machine time, stay within 1 s of
    each other, and within 7 ms (one step) once a tick has been seen.
  - Three fresh Bun-like processes (anchored clocks) share one view; two raw per-process clocks add
    one view each.
- QA-1.4-28: an EMFILE on the creator's re-read gives busy with one warning, and no lock or claim is
  left; the next call holds. With the undo's re-read failing too, the lock stays, and this
  process's next call reaps it at once and holds.
- QA-1.4-29: a scanner holds the claim reads for 600 ms from `release()`. The lock and the claim are
  gone within 4 s (0.8 s measured), and the next caller holds.
- QA-1.4-31: `waitMs` NaN and Infinity each make one attempt and return busy.
- QA-1.4-30: the observers that confirm by watching use a 500 ms heartbeat (5 × `backoffMaxMs`):
  the corrupt-lock tests, the release after a stale reclaim, and 5 similar ones (the live unrelated
  PID, the foreign host, the future mtime, and both claim-inert tests).
- The QA-1.4-26 test now waits past the claim-drop fence (150 ms there) before the inert part, since
  the owner would otherwise drop its own claim (QA-1.4-29).

Round 3 checks:
- **Runs:** three consecutive scoped runs passed 60/60 in 57.6 s, 56.5 s and 56.8 s. Under load (14
  `node -e "for(;;){}"` processes, killed afterwards) the run passed 60/60 in 68.2 s. `npm run
  typecheck` is clean.
- **Mutation checks**, each run on its tests and reverted:
  - views matched without the origin (`bootAt`): 4 tests fail (b1, both b3, the views test);
  - `hrtime` always taken as is: 2 tests fail;
  - no removal of the stray lock: the QA-1.4-28 test fails;
  - no drop of the unconfirmed claim: the QA-1.4-29 test fails;
  - no `waitMs` clamp: both QA-1.4-31 tests fail.
- **Multi-process runs on Bun and Node:** `test/fixtures/slot/runtime-repro.mjs <slot.ts>` runs the
  QA's b1, b2 and b3 with real child processes on the runtime that runs it, with the production
  clocks and constants (about 2 minutes). It is not part of vitest.

  | runtime, code | b1 (O at 4.4 s after a beat) | b2 (fresh `waitMs: 0` processes, 3 s apart) | b3 (two watchers started 30 s apart) |
  |---|---|---|---|
  | Bun 1.3.14, `a4034ec` | origins 8.1 s apart; O busy, H not lost | 0.1–9.1 s busy, 12.1 s held | reclaimed after 15.1 s |
  | Bun 1.3.14, `a4ce821` (before) | origins 8.5 s apart; **O held, H lost** | 8/8 busy up to 21.4 s | reclaimed after 30.3 s |
  | Node v24.21.0, `a4034ec` | origins 0 ms apart; O busy, H not lost | 0.2–12.2 s busy, 15.2 s held | reclaimed after 15.1 s |

  On Node, b2 takes one more 3 s step than in round 3 (12.2 s), because the witness now needs the
  2 s slack too. Afterwards no `omr-slot-*` or `omr-repro-*` dir and no `node.exe` or `bun.exe`
  child or busy loop was left.

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

## QA re-review (round 3)

Reviewer: adversarial QA, `[tier:heavy]` (CAP:none).

- **Scope:** `git diff 0637a49..5f3c4a2` (`17fac6a`, `5f3c4a2`), checked against plan "#### Phase 1.4"
  and the round-2 findings. Line numbers refer to `src/verify/slot.ts` at `5f3c4a2`.
- **Environment:** Windows 11, NTFS, 16 cores, Node v24.21.0, Bun 1.3.14, opencode 1.18.32. No
  Node 20 binary and no POSIX host were available this round.
- **Repros:** `%TEMP%\omr-qa14r3\` held `hrtime.mjs` and `r3.mjs`, plus the `child.mjs` and
  `build-check.mjs` that `r3.mjs` writes. The dir was deleted after the review.
  - They load the real `src/verify/slot.ts`: Node 24 through type stripping, Bun natively.
  - In-process module instances (`?a`, `?b`, …) stand for processes; child processes run on Node or
    Bun.
  - Seams used: `unlink` (to freeze a call), `read` (to inject EMFILE or EBUSY) and `now` (a wall
    step). `mono` and every constant are the production defaults.
- **Cleanup:** afterwards no `node.exe` or `bun.exe` running `child.mjs`, `holder.mjs`, `qa14r3` or a
  busy loop was left, and no `qa14r3-*` or `omr-slot-*` dir.

**Test runs** (`npx vitest run --maxWorkers=2 test/unit/slot.test.ts`):

| run | result | duration |
|---|---|---|
| Node v24.21.0 | 51/51 | 42.0 s |
| Node v24.21.0 under load: 14 `node -e "for(;;){}"` processes | 47/51 (QA-1.4-30) | 88.9 s |

Other agents may have been running tests on this machine at the same time.

**Summary (round 3):**
- QA-1.4-20, -22, -24, -25 and -26 are verified.
- QA-1.4-21 is verified on Node. It does not hold on Bun, the runtime that opencode loads plugins
  in (QA-1.4-27).
- QA-1.4-23 is verified on Node 24 only.
- New findings: 0 critical, 1 major, 2 minor and 1 nit (QA-1.4-27…30), plus 1 deferred by plan
  (QA-1.4-31).

### Verification of QA-1.4-20…26

| finding | status | evidence |
|---|---|---|
| QA-1.4-20 | verified (on Node) | `claimInert` uses only the observation (`:513-520`). `unlinkWhile` re-checks the deadline after the re-read (`:576`), right before `cfg.unlink` (`:579`). The fence starts before the create (`:621`). The round-2 `fence.mjs` replay: A is frozen 12 s inside its unlink, and B sees a +31 s wall step and waits 14 s → `{"a":"held","b":"busy","bDoneMs":14010,"aFrozenMs":12011,"bLost":0}`. Round 2 had two holders after 10.3 s. |
| QA-1.4-21 | verified on Node; **not on Bun** | Node, `b2` (fresh `waitMs: 0` processes 3 s apart, live-PID lock 60 s old): `0.2s busy, 3.2s busy, 6.1s busy, 9.2s busy, 12.2s held`. Node, `b3` (two long-lived processes started 30 s apart, one `waitMs: 0` call each): reclaimed by the watches after 10.2 s. On Bun, both stay busy (QA-1.4-27). |
| QA-1.4-22 | verified | `d22`: the dir is removed before `waitMs: 0`, before `waitMs: 500` and before `withSlot` → `held`, `held`, `{"value":7}`, with no warning. An EMFILE resolves busy with one warning, but leaves a lock behind (QA-1.4-28). |
| QA-1.4-23 | verified on Node 24 | vite is resolved from vitest (`node_modules\vite\dist\node\index.js`), and `transformWithOxc` builds `slot.ts` (45 607 bytes). `transformWithEsbuild` is also exported. Not re-run on Node 20: no Node 20 binary here. `stripTypeScriptTypes` does not exist there, so vite is the only branch on Node 20. |
| QA-1.4-24 | verified | `t24`: a fresh ticket of a crashed waiter whose PID is live, and the slot is free. Waiter → `{"waiter":"held","waitedMs":10267,"crashedTicketLeft":false,"filesLeft":[]}` (round 2: 30.6 s). The refresh timer is unref'd (`:1312-1313`) and cleared before the drop (`:1362-1363`). |
| QA-1.4-25 | verified (reading and test) | `collectOne` (`:920-947`) matches only probe, sidecar, legacy and claim names (`:902-907`), so it never touches a slot lock or a ticket. Claims are removed only under the protocol, with the key re-checked, when orphaned or empty. A wall step of more than 1 h puts only orphaned and empty claims at risk. An empty claim still being written changes its key before the unlink, and its creator holds it only after reading its token back. The test passes in both runs. |
| QA-1.4-26 | verified | Claims use `trustUnreadable = false` (`:624`), slot locks use `true` (`:1114`). Side effect: QA-1.4-29. |

### Answers to the round-3 focus questions

- **Two holders.** On Node, no new path was found. On Bun, observers whose processes started a few
  seconds apart mix clocks (QA-1.4-27).
- **Unbounded lockout.**
  - On Node, only the documented QA-1.4-21 residual remains; the judgement is below.
  - On Bun, two long-lived processes that watch the same lock never confirm it (QA-1.4-27).
- **Rejection.**
  - `acquireSlot` wraps the probe and the wait loop (`:1377-1394`). The EMFILE run resolved busy,
    and `withSlot` returned `{value: 7}`.
  - The background promises all catch: the watch (`:1155`), the heartbeat (`:1233`), the deferred
    release (`release` never rejects) and the ticket refresh (`:1018-1023`).
  - The repro run finished with no unhandled rejection.
- **Timers.**
  - A `waitMs: 0` call that started a watch let its process exit 17 ms (Node) and 21 ms (Bun) after
    the result.
  - A process that acquired and then went idle exited after 16 ms (Node) and 26 ms (Bun). Its exit
    hook removed the lock on both runtimes.
- **Watch lifetime.**
  - It lasts at most `staleMs + 2 × (heartbeatMs + claimHoldMaxMs)` = 50 s (`:1151`), and stops once
    the lock is gone, fresh or changed (`:1141-1145`).
  - It ignores the caller's `signal`. That is harmless: it only reaps a stale lock and never
    acquires.
  - A pass in flight holds ref'd fs requests and retry sleeps, 3.15 s at most (analysis).
- **Sidecar across reboot, host and clock.**
  - On Node, `process.hrtime` is host-wide on Windows. Two children 3 s apart printed the same
    `wall − hrtime` (1790419230677 ms), and it equals `os.uptime()` within 32 ms.
  - A reboot restarts hrtime, so an older stamp fails `at >= last − 2 heartbeats`. A wall step of
    more than 60 s moves `bootAt`. The host is part of the name. All of these only restart a record,
    which delays a reclaim.
  - On Bun, hrtime is per process (QA-1.4-27).
  - The Linux boot id and the POSIX clocks could not be tested here.
- **Tickets, housekeeping, Node 20 build:** see QA-1.4-24, -25 and -23.
- **Flakiness:** see QA-1.4-30.

### QA-1.4-21 residual: judgement

- **The residual:** the implementer kept the 2-heartbeat gap rule and added the watch. The case left
  open is short-lived processes that each look once, more than 10 s apart.
- **The plan:** the goal is "recovers from crashes and never deadlocks". 1.4.1.c(b) makes a lock
  stale when its heartbeat is older than 30 s.
- **Crashed holders:** a same-host holder with a dead PID is still reclaimed at once, by any caller.
- **Other locks** (a reused PID, a hung holder, another host) are reclaimed by any caller that waits,
  or lives, for 2 heartbeats after its look.
  - `b3_node` shows it with two `waitMs: 0` callers: 10.2 s.
  - The watch never keeps a process alive (see Timers).
- **2.x callers** are opencode plugin processes, which live for a whole session, far longer than
  10 s.
- **Verdict:**
  - On Node, the residual is acceptable against Phase 1.4. Phase 1.1/2.1 should state it next to
    `slotWaitMs`.
  - On Bun, it is not acceptable until QA-1.4-27 is fixed: fresh processes never share evidence
    there, and two long-lived watchers block each other.
- **Resolution:** `a4034ec`. The residual is documented in the `slot.ts` header ("Residual") and in
  the implementation notes above: callers must wait, or stay alive, for 2 heartbeats (plus the 2 s
  slack) to reclaim a lock whose owner is not provably dead; 2.x callers are long-lived. With
  QA-1.4-27 fixed, Bun behaves like Node (b2 at 12.1 s, b3 after 15.1 s).

### New findings

| ID | severity | finding | evidence | fix |
|---|---|---|---|---|
| QA-1.4-27 | major | On Bun, the runtime of opencode plugins, `process.hrtime` is per process. The shared observations mix clocks: a live holder is reaped (two holders), and two watchers never reclaim a lock. | `b1_bun`: `"O":"R held 19"` and `"hGotLost":true` (Node: busy). `b2_bun`: 6/6 busy. `b3_bun`: not reclaimed after 56 s (Node: 10.2 s). | Never compare `mono` stamps from different clock origins. Keep one sub-record per origin. Test with offset `mono` seams. |
| QA-1.4-28 | minor | An unexpected error after the exclusive create orphans a lock that carries the caller's live PID. The slot is blocked for about 30 s, for the caller too. | `emfile`: busy with 1 warning. The orphan holds this process's PID; this process's next call is busy; the next waiter waits 30.5 s. | Remove the file under its claim before the error propagates. |
| QA-1.4-29 | nit | An unconfirmed claim on the owner's own release blocks the slot for about 36 s. | `u26`: `release()` resolves at 6.4 s with the lock still there; the waiter gets the slot after 36.3 s. | Recognise this process's own unconfirmed claim by its token and drop it. |
| QA-1.4-30 | minor | 4 tests fail under CPU load: the `fast()` gap rule (200 ms) is tighter than one wake-up plus one attempt. | 47/51 with 14 busy loops, against 51/51 unloaded. | Give those observers a heartbeat of at least 5 × `backoffMaxMs`. |

### QA-1.4-27 — major — On Bun, `process.hrtime` is per process: shared observations mix clocks, a live holder is reaped (two holders), and two watchers never reclaim

- **Where:**
  - `slot.ts:219-222`: `machineMonoMs` reads `process.hrtime`.
  - The header, `:13-18`, says every process of the host reads the same value.
  - `observe` (`:461-473`) compares its own `at` with the `first`, `from` and `last` stamps that
    other processes wrote. `BOOT_SLACK_MS` is 60 s (`:213`).
  - `claimInert` (`:513-520`) uses the same records.
- **Runtime evidence:**
  - `rg -a "Bun v1\.[0-9]+\.[0-9]+"` on `scoop\apps\opencode\current\opencode.exe` (opencode 1.18.32)
    finds `Bun v1.3.14`: opencode is a Bun single-file executable.
  - The package's `main` is `./src/index.ts`, TypeScript source loaded by the host runtime.
  - The tests cannot see this, because vitest and `holder.mjs` run on Node.
- **Clock evidence:**
  - Five fresh Bun processes read `process.hrtime` = `performance.now()` = `Bun.nanoseconds()` = 30
    to 86 ms at start. An earlier sample read 66 462 ms and 5 524 ms; either way, it is not the
    host's clock.
  - `wall − hrtime` differs between Bun processes by their spawn gap: 8 019 ms for 8 s, 30 583 ms for
    30 s. Node gives 0 and −1 ms.
- **Two holders (`b1`, proven).**
  - Setup: H is a live holder with the production heartbeat. Observers O and Y see a +31 s wall step
    (the P1b case: an NTP step or a VM resume). O started 8 s before Y. Y looks 0.3 s and 2.3 s
    after one of H's heartbeats, and O looks at 3.3 s.
  - Bun: `{"clockOriginDeltaMs":8019,"Y":["R busy 23","R busy 2"],"O":"R held 19","oCalledMsAfterHeartbeat":3315,"lockOwnerAfterO":"qa O","hGotLost":true}`
  - Node: `{"clockOriginDeltaMs":0,"O":"R busy 12","lockOwnerAfterO":"qa H","hGotLost":false}`
  - Why: O's clock runs 8 s ahead of Y's. When O reads Y's record, the gap is 1 s + 8 s ≤ 10 s, so
    `from` is kept, and it counts 3 s + 8 s ≥ 10 s as witnessed. So O reaps a lock that H heartbeated
    3.3 s earlier. This re-opens QA-1.4-1 whenever the observers' start times differ by about 5 to
    10 s.
- **No reclaim (proven).**
  - `b2_bun`: six fresh `waitMs: 0` processes, 3 s apart, stay busy for 15.5 s. Each one's `at` is
    about 0.1 s on its own clock, so the record never grows.
  - `b3_bun`: two long-lived processes started 30.6 s apart each call once, and then their watches
    keep looking. The planted lock is still there after 56 s; Node reclaims it after 10.2 s.
  - Why: each look by one process resets the other's witness. Either the gap rule fires (the older
    clock is ahead) or the future-stamp rule does (the younger clock is behind). More than 60 s
    apart, `bootAt` restarts the record on every look.
- **Claims (analysis, not run):** an observer whose clock is Δ ahead sees a claim's span inflated by
  Δ, up to 60 s. So the 25 s claimer-freeze margin of QA-1.4-20 shrinks by Δ.
- **Fix:**
  - Never compare `mono` stamps taken on different clocks. For example, keep one sub-record per
    clock origin in the sidecar: `origins[round(wall − mono)] = {first, from, last}`. A caller uses
    only its own origin's entry. Then:
    - Node processes of one boot share an origin and keep the QA-1.4-21 sharing;
    - each Bun process gets the round-1 per-process semantics plus the watch, with no clobbering;
    - a wall step starts a new origin, which is a conservative restart.
  - Correct the header.
  - Add an in-process test with two module instances whose `mono` seams are 8 s apart; it
    reproduces `b1` today.
  - Consider a Bun leg for the multi-process tests.
- **Resolution:** `a4034ec`. Both parts of the proposal are in.
  - **Views per origin:** the sidecar keeps one view per clock origin (boot id, and `bootAt = wall −
    mono` read together, matched within a 1 s slack). A look compares its `mono` only with its own
    view's stamps. Every `mono` threshold adds the view's worst disagreement (the two slacks, 2 s),
    so no margin shrinks, including the claim margins of QA-1.4-20. A wall step now starts a new
    view instead of mixing for up to 60 s (`BOOT_SLACK_MS` is gone).
  - **One machine clock on every runtime:** the default `mono` takes `hrtime` as is where it reads
    within 2 s of `os.uptime()` (Node). Otherwise (Bun) it anchors `hrtime` to the uptime, which Node
    and Bun read alike within 15 ms here, with 15.6 ms steps. So Bun processes share one view again,
    and the QA-1.4-21 sharing holds on Bun too.
  - **Header:** the clock and observation paragraphs are rewritten; they no longer claim that
    `hrtime` is the same in every process.
  - **Tests:** b1 with clocks 8 s apart, b3 with clocks 8 s apart and with per-process-origin clocks,
    the clock builder, and one view shared by Bun-like processes. Mutation: matching views without
    the origin fails 4 of them.
  - **Bun, real processes** (`runtime-repro.mjs`): b1 no longer has two holders (before the fix, on
    the same run: O held, H lost). b2 reclaims at 12.1 s (before: 8/8 busy), and b3 reclaims after
    15.1 s (before: 30.3 s). The table is under "Round 3 checks".

### QA-1.4-28 — minor — An unexpected error after the exclusive create orphans a lock with the caller's live PID

- **Where:**
  - `createOwned` (`:531-551`): after `open(wx)` and the write, the re-read goes through `readLock`,
    which rethrows non-transient codes (`:359`).
  - The error travels up through `:1114` and `acquireFile` to `acquireSlot`, which turns it into
    busy (`:1390-1394`).
  - The file never enters `held`, so neither the heartbeat nor the exit hook covers it.
- **Evidence (`emfile`, proven):** an EMFILE on the first read of `slot-0.lock`, which is
  `createOwned`'s re-read.
  `{"first":"busy","warns":["verification slot: file-system error, reporting busy"],"orphan":{"exists":true,"pidIsThisProcess":true},"sameProcessNextCall":"busy","nextWaiter":"held","nextWaiterWaitedMs":30539}`
  - The PID is live, so the lock waits for the age rule.
  - A failed write (ENOSPC, EIO) leaves an empty file instead, stale after `corruptGraceMs`
    (analysis).
- **Fix:** once `open(wx)` has succeeded, a failure in the write, the close or the re-read must
  remove the file before the error propagates. The token is known, so this can be a best-effort
  `removeUnderClaim` with the own-token check. Test: the seam above gives busy, and the next caller
  then holds at once.
- **Resolution:** `a4034ec`, as proposed. Once `open(wx)` has succeeded, a failure in the write, the
  close or the re-read runs a stray handler before the error propagates.
  - **Slot lock:** removed under its claim, with the own-token check. If that removal fails too,
    the process remembers the lock: its next look at that slot finds it stale at once (like a dead
    PID) and reaps it, and the exit hook removes it too.
  - **Claim:** remembered as an unconfirmed claim (QA-1.4-29).
  - **Empty file:** a write that failed leaves an empty file, which the corrupt grace reclaims, as
    the finding's analysis says.
  - **Test:** an EMFILE on the creator's re-read gives busy with one warning; no lock or claim is
    left, and the next call holds. With the undo's re-read failing too, this process's next call
    reaps the lock at once and holds. It fails by mutation.

### QA-1.4-29 — nit — An unconfirmed claim on the owner's own release blocks the slot for about 36 s

- **Where:** `:548` (an unconfirmed claim is not held); `:643` and `:653` (the release then finds a
  live-PID claim that is not inert); `deleteOwn` (`:1241-1251`).
- **Evidence (`u26`, proven):** reads of `.reap-*` fail with EBUSY for 4 s from `release()`. A waiter
  has `waitMs: 90 000`.
  `{"releaseResolvedMs":6402,"lockAfterRelease":"qa14r3","waiter":"held","waiterWaitedMs":36258,"warns":["verification slot: release incomplete, retrying in the background"]}`
  - The claim holds the releaser's own token, but the release does not recognise it. It waits for
    the inert rule while the deferred release keeps heartbeating the lock.
  - This is bounded, and it needs a scanner to hold a brand-new file for more than 3.15 s.
- **Fix:** remember the tokens of this process's unconfirmed claims. A later readable look that shows
  one of them proves the claim is ours: drop it through `unlinkWhile` with the token check.
- **Resolution:** `a4034ec`, as proposed. The process keeps its unconfirmed claims (path, token and
  drop deadline; at most 64).
  - **Drop:** `reclaimClaim` checks them before the inert rule. A readable look that shows our token
    drops the claim through `unlinkWhile` with the token check. The deadline is the one for a held
    claim's drop, 1.5 × `claimHoldMaxMs` from just before the create, so the QA-1.4-20 margins are
    unchanged.
  - **Forgotten:** once another token is there, or once the deadline has passed. After that the claim
    is left to the inert rule.
  - **Exit:** the hook removes the remembered claims by token, like held ones.
  - **Test:** the u26 case, scaled: a scanner holds the claim reads for 600 ms from `release()`. The
    lock and the claim are gone within 4 s (the test takes 0.8 s), and the next caller holds. It fails
    by mutation. The QA-1.4-26 test now waits past the drop deadline before its inert part.

### QA-1.4-30 — minor — Four tests fail under CPU load: the `fast()` gap rule is tighter than one wake-up plus one attempt

- **Where:**
  - `slot.test.ts:302-310`: an empty, corrupt or wrong-shape lock is stale.
  - `slot.test.ts:449-459`: release after a stale reclaim.
  - `fast()` (`:81-83`): `heartbeatMs` 100 and `backoffMaxMs` 100.
- **Evidence:** 47/51 with 14 busy-loop processes (88.9 s). All 4 failures are "expected a slot, got
  busy" at the waiting call (`:308` three times, `:454`). Unloaded: 51/51 (42.0 s). In round 2 the
  previous code passed 42/42 under the same load.
- **Mechanism (analysis):**
  - The witness restarts after a gap of more than 2 heartbeats, 200 ms here.
  - The looks come one wake-up (≤ 100 ms) plus one attempt apart. An attempt is about 8 round trips
    on the libuv pool: readdir, the ticket refresh, create, read, and the new sidecar read and write.
  - Under load the looks drift more than 200 ms apart, so the confirmation never completes and the
    wait ends busy.
  - With the production values the margin is 10 s against at most 2 s, so the product is not
    affected.
- **Fix:** in these tests, give the observer a heartbeat of at least 5 × `backoffMaxMs`, as
  QA-1.4-13 did elsewhere. For example, use `heartbeatMs: 500` with scaled waits, or raise the
  default heartbeat in `fast()`.
- **Resolution:** `a4034ec`, as proposed. `WATCHER_HEARTBEAT_MS = 500` (5 × `backoffMaxMs`) is used by
  the 4 failing tests and by 5 others that confirm by watching the same way: the live unrelated PID,
  the foreign host, the future mtime, and both claim-inert tests. Their waits are raised where
  needed. `fast()` keeps 100 ms, because the ticket-TTL tests depend on it.
  - **Under load** (14 `node -e "for(;;){}"` processes, killed afterwards): 60/60 in 68.2 s.
  - **Unloaded:** 60/60 three times (57.6 s, 56.5 s, 56.8 s).

### Deferred by plan

- QA-1.4-18 and QA-1.4-19: unchanged.
- **QA-1.4-31 — deferred by plan (Phase 1.1 schema, Phase 2.1 wiring) — non-finite `waitMs`:**
  - With `NaN`, the deadline is `NaN` (`:1304`), so `remaining <= 0` is never true, and the delay is
    `NaN`, which runs as 1 ms (`:1347`).
  - The call then polls until it gets a slot or its signal fires: 68 wake-ups in 1 s, against 4 for
    `waitMs: 1000`.
  - Phase 1.1 validates `slotWaitMs` as an integer ≥ 0.
  - **Resolution:** `a4034ec`, a defensive clamp. `acquireSlot` treats a non-finite `waitMs` (NaN,
    ±Infinity) as 0, and a negative one as 0, as before. Both paths, the file slots and the
    in-process fallback, get the clamped value. Test: NaN and Infinity each make one attempt and
    return busy, with no ticket; both fail by mutation. Phase 1.1 still validates the setting.

## QA re-review (round 4)

Reviewer: adversarial QA, `[tier:heavy]` (CAP:none).

- **Scope:** `git diff a4ce821..e35200c` (`a4034ec`, `e35200c`), checked against the round-3
  findings. Line numbers refer to `src/verify/slot.ts` at `e35200c`.
- **Environment:** Windows 11, NTFS, 16 cores, Node v24.21.0, Bun 1.3.14. No POSIX host and no
  Node 20 binary were available.
- **Repros:** `%TEMP%\omr-qa14r4\` held `clock.mjs`, `stress.mjs` and `exitfence.mjs`. The dir was
  deleted after the review.
  - They load the real `src/verify/slot.ts`: Node 24 through type stripping, Bun natively.
  - `clock.mjs` and `stress.mjs` run real Bun and Node processes with the production clocks and
    constants.
  - `exitfence.mjs` uses module instances (`?a`, `?r`, `?p`) as processes. The `read` and `unlink`
    seams fix the interleaving.
- **Cleanup:** afterwards no `omr-qa14r4*` or `omr-slot-*` dir was left, and no `node.exe` or
  `bun.exe` running a repro, `holder.mjs` or a busy loop. One `omr-repro-*` dir that predates this
  review (01:19) belongs to another run and was left alone.

**Test runs** (`npx vitest run --maxWorkers=2 test/unit/slot.test.ts`):

| run | result | duration |
|---|---|---|
| Node v24.21.0 | 60/60 | 56.6 s |
| under load: 14 `node -e "for(;;){}"` processes, killed afterwards | **57/60** (QA-1.4-33) | 93.5 s |
| under load again, to capture the failures | 60/60 | 75.0 s |
| under load, only the 3 failed tests (`-t`, 5 tests matched) | 5/5 | 13.0 s |

Other agents may have been running tests on this machine at the same time.

**Committed repro** (`test/fixtures/slot/runtime-repro.mjs src/verify/slot.ts`, at `e35200c`):

| runtime | b1 (O at 4.4 s after a beat) | b2 (fresh `waitMs: 0` processes, 3 s apart) | b3 (two watchers started 30 s apart) |
|---|---|---|---|
| `bun` 1.3.14 | origins 8 090 ms apart; Y busy twice, O busy at 4 429 ms; H not lost | 0.1–12.1 s busy, 15.1 s held | reclaimed after 15.2 s |
| `node` v24.21.0 | origins 1 ms apart; O busy at 4 417 ms; H not lost | 0.2–9.2 s busy, 12.2 s held | reclaimed after 20.1 s |

- **Bun b2:** at 12.1 s the witness is 12.0 s, which is the threshold (2 heartbeats plus the 2 s
  pad), so a hold at 12.1 s (round 3) or at 15.1 s (here) are both expected.
- **Node b3:** one watch step later than round 3 (15.1 s). The same case was re-run 3 times with a
  sidecar monitor (`stress.mjs b3x node 3`, two processes calling at the same instant): reclaimed
  after 15.1 s, 15.1 s and 15.0 s, and no view restarted. A torn sidecar read (see the focus
  answers) accounts for one lost step. It only delays.

**Summary (round 4):**
- QA-1.4-27, -28, -29 and -31 are verified.
- QA-1.4-30 is verified for its tests, but 3 other tests failed in one of two loaded runs
  (QA-1.4-33).
- New findings: 0 critical, 0 major, 1 minor and 2 nits (QA-1.4-32…34).
- QA-1.4-32 is a two-holder path (theoretical, proven with seams). The exit-hook addition of the
  QA-1.4-29 fix introduced it.

### Verification of QA-1.4-27…31

| finding | status | evidence |
|---|---|---|
| QA-1.4-27 | verified (Windows: Bun and Node) | **Repro:** the committed repro above shows no two holders in b1 on either runtime, and b2 and b3 reclaim on both. **Clock** (`clock.mjs`, 3 Bun and 3 Node processes started 1.2 s apart):<br>• Bun is anchored: `hrtime` reads 367–449 ms at start. Node takes it as is: `uptime − hrtime` is −28…−35 ms.<br>• The final `bootAt` values are 20.9 ms apart, within the 1 s slack.<br>• 52.5 M reads over 2 s each: 0 decreases.<br>• `os.uptime()` steps 15 or 16 ms on both runtimes.<br>• The largest step of an anchored clock is 14.4 ms (the offset catching up one uptime tick).<br>**Stress** (`stress.mjs`): 4 Bun and 4 Node observers write into one view (at most 1 view per record). |
| QA-1.4-28 | verified | **Code:** `createOwned` runs `stray` before it rethrows (`:654-657`). `dropStray` (`:838-846`) removes the file under the claim of its own token, and only while the file still holds that token. The token is unique and is re-read before every unlink, so another process's lock can never be deleted. `isStray` (`:829-835`) makes only this process's own token stale at once. The entry is forgotten on another token (`:833`) or when the file is missing (`:1292`). At exit, `releaseOneSync` takes and drops the claim in one synchronous call.<br>**Test:** passes in every run.<br>**Side note:** if the stray's claim is this process's own unconfirmed claim, the exit hook's `wx` gets EEXIST and leaves the stray (`:875`). That lock then carries a dead PID, so same-host callers reap it at once. |
| QA-1.4-29 | verified; the exit addition is QA-1.4-32 | `dropUnconfirmed` (`:690-702`) drops only its own token (`unlinkWhile` with the token check) and only until `dropBy`. The map holds at most 64 entries and forgets an entry on another token or past the fence. The test passes. The exit hook (`:908-916`) drops the remembered claims **without** the fence. |
| QA-1.4-30 | verified for its tests; see QA-1.4-33 | The 4 tests, plus the 5 others on `WATCHER_HEARTBEAT_MS`, passed in both loaded runs. |
| QA-1.4-31 | verified | `:1554` clamps NaN and ±Infinity to 0 before both paths. The NaN and Infinity tests pass. Phase 1.1 still validates the setting (deferred). |

### Answers to the round-4 focus questions

- **Sidecar growth.**
  - A record keeps at most 4 views (`:568`), about 100 bytes each.
  - There is one sidecar per target, identity and host. The owner's release and every reap delete
    it (`:786-787`). An observer that writes after that delete leaves an orphan, and housekeeping
    collects it after 1 h.
  - In the stress run (13 090 calls) there was at most 1 sidecar with at most 1 view. No file was
    left after the processes exited.
  - A stale origin goes as the oldest view once 4 exist, or with the key. Either way only evidence
    is lost.
  - More than 4 live origins at once would thrash the views and stop the sharing. No such case was
    seen: Bun and Node share one origin within 21 ms.
- **Concurrent read-modify-write on the sidecar.** `observe` reads, computes, then writes with
  `writeFile` (truncate, then write), without a lock.
  - Lost updates and torn reads do happen: the parent sampled 5 torn reads in 370 during the stress.
    A torn read parses as nothing and restarts the view. A lost update drops looks.
  - Neither can move `first` or `from` back, so neither can cause an early reap:
    - a writer extends a view only with its own `at`;
    - a new key drops every view;
    - a stale write carries a `last` no later than its writer's `at`, so any later look more than 2
      heartbeats after that restarts the witness.
  - **Premature-reap stress** (`stress.mjs`):
    - Setup: a live Bun holder with the production heartbeat. 8 observers (4 Bun, 4 Node) see a
      +31 s wall step, so the lock always looks old, and call with `waitMs: 0` in a loop for 40 s.
    - Output: `{"hLost":false,"lockStillH":true,"heartbeats":9,"observerCalls":13090,"observerHeld":0,"sidecarFilesMax":1,"viewsPerRecordMax":1,"parentTornReads":"5/370","filesAfterExit":[]}`.
  - The cost is liveness: a restart delays a reclaim by one watch step (Node b3 above).
- **`machineClockFrom`.**
  - Within a process it never goes back, by construction (`hrtime` never decreases, and the offset
    only rises) and over 52.5 M reads.
  - Across processes the clocks are not meant to agree exactly: origins are compared within 1 s.
  - A Bun process whose first use comes within 2 s of boot would take its per-process `hrtime` as
    is. It then gets a view of its own, which only costs sharing.
  - Linux and macOS, and a runtime whose uptime counts whole seconds: not verified (no host).
- **The 2 s pad.** It is correct for the span and the witness: every writer of a view is within its
  own slack of the view's `bootAt`, so any two are within `errMs` of each other. The gap rule is not
  padded (QA-1.4-34).
- **Stray cleanup.** It cannot delete another process's lock (QA-1.4-28 above).
- **Unconfirmed-claim memory.** It is bounded (64 entries) and drops by token only. While the
  process runs, it never deletes another claim. The exit hook is the exception (QA-1.4-32).
- **Exit-hook additions.** Strays are safe: the claim protocol runs within one synchronous call.
  Unconfirmed claims are not: see QA-1.4-32.
- **Non-finite `waitMs`.** See QA-1.4-31 above. `max` is still not clamped against NaN:
  `Math.max(1, Math.floor(NaN))` is NaN, so every call is busy (QA-1.4-19, deferred).
- **Invariants:**
  - At most `max` holders: this held in every run, except under the QA-1.4-32 interleaving.
  - No unbounded lockout for long-lived callers: b3 reclaims after 15–20 s on both runtimes, and a
    watch lasts up to 50 s.
  - `acquireSlot` never rejects: no new path throws out of it (`dropStray` catches), and no repro
    printed an unhandled rejection.
  - Timers: the round-3 fixes add none.

### New findings

| ID | severity | finding | evidence | fix |
|---|---|---|---|---|
| QA-1.4-32 | nit (theoretical) | The exit hook drops this process's unconfirmed claims past their drop fence. A reaper that has judged such a claim inert can then delete a third reaper's new claim: two claimers, then two holders. | `exitfence.mjs` exit: `"bothInsideClaimT":true,"twoHolders":true,"rLost":true`. Control, same interleaving without the exit: one holder. | At exit, drop an unconfirmed claim only within its `dropBy`. |
| QA-1.4-33 | minor | 3 more tests fail under CPU load (the QA-1.4-30 class). | Loaded run 1: 57/60. The ticket test fails at `:917`; the other two messages were not captured. Loaded run 2: 60/60. | Ticket test: heartbeat 500 ms. Explicit timeouts on the 5 s waits. |
| QA-1.4-34 | nit | The gap rule compares stamps of different writers without the 2 s pad, contrary to "every `mono` threshold adds that". | Analysis. No early reap is reachable, because a stale verdict also needs an old lock. | Restart at `at − last > maxGap − errMs`, or correct the header. |

### QA-1.4-32 — nit (theoretical) — The exit hook drops unconfirmed claims past their drop fence: two claimers, then two holders

- **Where:**
  - `releaseAllSync` (`:908-916`) unlinks every remembered unconfirmed claim that still holds its
    token, without checking `dropBy`.
  - The header (`:103-106`) and the notes say the process drops such a claim "at its next readable
    look within those 7.5 s, and at exit".
  - An entry lives until the next readable look at that claim path, 64 newer entries or the exit
    (`:673-702`), so it can be minutes old at exit.
- **Why it matters:**
  - Deletion safety rests on one rule: only a claim's owner removes it, and only within 7.5 s.
    After at least 30 s others may remove it as inert, under a claim of its own.
  - An exit-time delete after that races with an inert-reclaimer R, between R's re-read and R's
    unlink.
  - If a third reaper P creates a new claim in that window, R deletes it. R and P are then both
    inside the claim for the same victim, and "only a K-claim holder deletes K's file" no longer
    holds.
- **Evidence (proven with seams, `exitfence.mjs`):**
  - Setup: A reaps a dead-PID lock T. A scanner (A's `read` seam: EBUSY on `.reap-*`) keeps A from
    confirming its claim, so A remembers it.
  - After A's drop fence (300 ms here), R judges the claim inert and issues its unlink.
  - At that moment A's exit hook runs. P, another reaper of T, takes the claim that is now free,
    re-reads T and issues its unlink. P's unlink is let through last.
  - Output: `{"claimAfterAExit":null,"pFirst":"inside","rResult":"held","lockAfterR":"d291d911-…","pResult":"held","lockAfterP":"9ea4f511-…","rLost":true,"twoHolders":true,"bothInsideClaimT":true}`.
    R also warned "verification slot lost: another process reclaimed it while it was held".
  - Control, the same interleaving without A's exit:
    `{"pFirst":"busy","rResult":"held","pResult":"busy","rLost":false,"twoHolders":false}`.
- **Likelihood:** every one of these is needed:
  - an unconfirmed claim: a scanner holds a new claim for more than 3.15 s, or its re-read hits an
    EMFILE;
  - no readable look at it by its owner for at least 30 s;
  - the owner exits inside another process's re-read → unlink window;
  - a third reaper acts inside the same window.

  So it is a nit (theoretical), like QA-1.4-26, even though the consequence is the critical one.
- **Fix:**
  - At exit, remove an unconfirmed claim only while `mono() <= dropBy`: keep the `mono` function
    with the entry. Otherwise leave the claim to the inert rule.
  - Optionally, drop the unconfirmed claims that are within their fence before the strays are
    released. Then a stray whose claim is this process's own is not skipped (`:875`).
  - Test: remember a claim, pass its fence, run `releaseAllSlotsSync()`, and assert that the claim
    is still there.

Resolution: f3fc392 — the exit hook drops an unconfirmed claim only while `mono() <= dropBy` (the entry keeps its `mono`); past the fence the claim is left to the inert rule. Test: "the exit hook drops this process's unconfirmed claim only within its drop fence" (both sides, via the `mono` seam).

### QA-1.4-33 — minor — Three more tests fail under CPU load

- **Where:**
  - `slot.test.ts:909-927`: a live older ticket defers a non-waiting caller. `fast()` has a 100 ms
    heartbeat, so the ticket TTL is 200 ms.
  - `:645-661`: a live claimer's claim is inert only after `staleMs`.
  - `:686-706`: an unconfirmed claim (QA-1.4-26).
- **Evidence:**
  - Loaded run 1: 57/60 in 93.5 s, with exactly these 3 failing. The ticket test failed at `:917`:
    `AssertionError: expected { release: [Function release], …(1) } to deeply equal { busy: true }`.
    The caller held although a live ticket was ahead of it.
  - Loaded run 2: 60/60 in 75.0 s. The 3 tests alone under load: pass. Unloaded: 60/60.
- **Mechanism:**
  - Ticket test (analysis): the live ticket is written with a fresh mtime just before the call. If
    more than 200 ms pass between that write and the ticket scan (the call's first dir probe comes
    first), the ticket counts as dead and the caller does not defer.
  - Claim tests (not verified): the filter of run 1 did not capture their messages. Each ends with
    a `waitMs: 5_000` acquire inside vitest's default 5 s test timeout, since no `testTimeout` is
    configured.
  - In `:645` the first look uses production deps (1 s slack). The fast observer joins that view,
    so its pad is 1.1 s and it needs a span of at least 2.1 s.
- **Fix:**
  - Ticket test: a 500 ms heartbeat (TTL 1 s), with `setAge(live, 1_500)`.
  - Tests that wait 5 s: explicit timeouts (for example 20 s).
  - In `:645`: give the first two looks fast deps, or allow for the 1.1 s pad in the timings.

Resolution: f3fc392 — the ticket test uses a 500 ms heartbeat (TTL 1 s, `staleMs` 5 s) and `setAge(live, 1_500)`; every test that can wait 5 s or more has a 20 s timeout; `:645` uses one set of fast deps for all its looks. Slot tests: 61/61 twice, and 61/61 under 14 busy-loop processes.

### QA-1.4-34 — nit — The gap rule is not padded by the view's slack

- **Where:**
  - `observe` (`:564`) restarts `from` when `at − old.last > maxGap`. `old.last` can be another
    writer's stamp, up to `errMs` (2 s) off.
  - The header (`:44-46`) says "every `mono` threshold below adds that, so it never shortens a
    margin", and the notes say "Every `mono` threshold adds that, so no margin shrinks".
- **Effect:** a gap in the looks of up to 2 heartbeats plus 2 s (12 s) can go unseen, so the
  witness does not restart after such a freeze.
- **Reachability (analysis):** no early reap of a running holder was found.
  - A stale verdict also needs the lock to be old: a wall age over 30 s, or a span of at least
    32 s.
  - A holder that heartbeated before a freeze of 12 s or less is not old.
  - A freeze long enough to make it old (over 25 s) shows as a gap even with the 2 s skew.

  So the sentence is inaccurate, but the margins hold.
- **Fix:** restart when `at − old.last > maxGap − errMs`, which is conservative. Otherwise, correct
  the sentence so that it leaves out the gap rule, and give the argument above.

Resolution: f3fc392 — padded: `observe` restarts `from` when `at − old.last > maxGap − (slack + old.slack)`, so the header holds as written. The existing tests pass.

### Deferred by plan (round 4)

- **QA-1.4-18** (Phase 2.1 / 2.2), nested acquisition: unchanged.
- **QA-1.4-19** (Phase 1.1 schema, Phase 2.1 wiring), non-finite `max`: unchanged. NaN makes every
  call busy.
- **QA-1.4-31** (Phase 1.1): the clamp is in the code; validating `slotWaitMs` stays with Phase 1.1.
- **QA-1.4-21 residual** (Phase 1.1 / 2.1): state it next to `slotWaitMs`.

**Open, not deferred:** QA-1.4-32, -33 and -34. Phase 1.4 QA is **not** clean.

## QA re-review (round 5)

Reviewer: adversarial QA, `[tier:heavy]` (CAP:none).

- **Scope:** `git diff fc8b09d..a8c76e7` (`f3fc392`, `a8c76e7`), checked against the round-4
  findings. Line numbers refer to `src/verify/slot.ts` and `test/unit/slot.test.ts` at `a8c76e7`.
- **Environment:** Windows 11, NTFS, 16 logical CPUs, Node v24.21.0, Bun 1.3.14. No POSIX host and
  no Node 20 binary were available.
- **Repros:** `%TEMP%\omr-qa14r5\` held `claimhold.mjs`, `watchleak.mjs` and three scratch copies of
  the slot sources and tests. The dir was deleted after the review.
  - **Copies:** A is `a8c76e7`. B has the gap rule unpadded (`at − old.last > maxGap`, `:564`). C has
    no exit fence (the `.filter` at `:912` removed). Each copy linked the worktree's
    `node_modules` through a junction; the junctions were removed before the dir was deleted.
  - **Scripts:** they load the real `src/verify/slot.ts` through Node type stripping.
- **Cleanup:** afterwards no `omr-qa14r5` or `omr-slot-*` dir was left, and no `node.exe` or
  `bun.exe` running a busy loop, a repro, `holder.mjs` or vitest. Every busy loop was killed by PID
  (0 alive after each loaded run). The `omr-repro-omueof` dir (01:19) predates this review (see
  round 4) and was left alone.

**Test runs** (`npx vitest run --maxWorkers=2 test/unit/slot.test.ts`):

| run | result | duration |
|---|---|---|
| Node v24.21.0, unloaded | 61/61 | 56.3 s |
| under load 1: 14 `node -e "for(;;){}"` processes, killed afterwards | **50/61** (see below) | 238.6 s |
| under load 2, same setup | **59/61** (QA-1.4-35) | 112.5 s |

- **Load 1 is not comparable to round 4.** Before the loops started, other sessions were already
  using about 8 of the 16 logical CPUs (per-process CPU sampled over 3 s: a `node` 1.6 cores, three
  opencode `bun` 1.4 + 0.5 + 0.5, Edge about 4). The run took 238.6 s, against 75–93 s for round 4's
  loaded runs. Its 11 failures:
  - **Fixed timing budgets:**
    - `:1012`: 504 ms against < 200 ms;
    - `:1072`: the first attempt outlasted the 300 ms wait;
    - `:1162` and `:1203`: vitest's default 5 s timeout.

    These pass in load 2 and in round 4's loaded runs, and no scaling of the gap or the claims can
    help them.
  - **`:310` wrong shape:** the default 5 s timeout (QA-1.4-36).
  - **The two claim tests `:660` and `:705`:** QA-1.4-35.
  - **Confirm by watching:**
    - `:277`, `:439` (b3, per-process clocks) and `:528` (heartbeat 200 ms) ended busy.
    - `:484` held where busy was expected: its three anchored calls took more than 1.2 s, so the
      shared view confirmed, as it should.

    All four pass in load 2 and in every A/B round below.
- **Load 2:** only the two claim tests failed (QA-1.4-35). The ticket test (QA-1.4-33) passed in
  both loaded runs.

Other agents were running on this machine at the same time.

**A/B under the same load:** the 14 gap-sensitive tests (`-t` on the watch, claim and observation
tests). A and B ran at the same time, with 14 busy loops.

| round | A (`a8c76e7`) | B (gap unpadded) |
|---|---|---|
| 1 | 12/14: `:662` (a claim left behind), `:705` busy | 13/14: `:662` (a claim left behind) |
| 2 | 14/14 (35.3 s) | 14/14 (33.5 s) |

No failure is specific to the padded gap rule. The failures in both copies are the claim tests
(QA-1.4-35).

**Mutations** (the scratch copies):

| mutation | result |
|---|---|
| C: no exit fence (`:912`) | The QA-1.4-32 test fails: `AssertionError: expected false to be true` (the past-the-fence side). A passes it. |
| B: gap rule unpadded (`:564`) | 61/61 unloaded (57.8 s). No test depends on the padded, or a negative, allowed gap; no test pins QA-1.4-34 either. |

**Committed repro** (`test/fixtures/slot/runtime-repro.mjs src/verify/slot.ts`, at `a8c76e7`,
production clocks and constants; Bun and Node ran at the same time, with no busy loops):

| runtime | b1 | b2 (fresh `waitMs: 0` processes, 3 s apart) | b3 (two watchers started 30 s apart) |
|---|---|---|---|
| `bun` 1.3.14 | origins 8 226 ms apart; Y busy twice, O busy 4 747 ms after a beat; H not lost | 0.5–9.3 s busy, 13.1 s held | reclaimed after 15.2 s |
| `node` v24.21.0 | origins 1 ms apart; O busy 4 567 ms after a beat; H not lost | 0.3–9.3 s busy, 12.4 s held | reclaimed after 15.2 s |

These are the same as round 4, with the padded gap: b3 within 3 watch steps on both runtimes
(round 4: 15.2 s on Bun, 20.1 s on Node), and no two holders.

**Summary (round 5):**
- QA-1.4-32 and QA-1.4-34 are verified.
- QA-1.4-33 is verified for the ticket test and for `:645`'s view slack. Two gaps remain:
  - the two claim tests still fail under load, from a cause the round-4 finding did not identify
    (QA-1.4-35);
  - one 5 s test has no explicit timeout (QA-1.4-36).
- **The implementer's side effect** (a negative allowed gap): it cannot happen with the production
  constants, it is safe where it can happen, and no test depends on it. The analysis is below.
- New findings: 0 critical, 0 major, 1 minor and 3 nits (QA-1.4-35…38). None is a product
  defect: QA-1.4-35, -36 and -38 are test issues, and QA-1.4-37 is documentation.

### Verification of QA-1.4-32…34

| finding | status | evidence |
|---|---|---|
| QA-1.4-32 | verified | **Code:** the entry keeps the clock its `dropBy` is on (`:672`, `:684`). The exit hook keeps an unconfirmed claim only while `u.mono() <= u.dropBy` (`:912`), the same fence as `dropUnconfirmed` (`:695`, `:700`). The check and the unlinks run in one synchronous loop (at most `activeClaims` plus 64 entries), so the check-to-unlink window is milliseconds against the 22.5 s margin. A claim past its fence keeps the dead PID of the exited process, so same-host reapers clear it at once (`ownerDead`, `:589-591`).<br>**Test:** `:887-908` covers both sides and fails with mutation C.<br>**Side note:** its first iteration leaves a background watch running (QA-1.4-38). |
| QA-1.4-33 | partly verified | **Ticket test** (`:934-954`): a 500 ms heartbeat and `setAge(live, 1_500)`; it passed in both loaded runs.<br>**`:645`:** one set of deps (`:653`). Without it, the first look's 1 s slack would make the observer's allowed gap 1 000 − 1 100 < 0.<br>**Timeouts:** 20 s added, except the `it.each` at `:310-319` (QA-1.4-36).<br>**Still failing:** the two claim tests, in 4 of 5 loaded runs of the `a8c76e7` code (load 1, load 2, A/B round 1, the instrumented run; A/B round 2 passed). Instrumenting found the cause (QA-1.4-35). |
| QA-1.4-34 | verified | **Code:** `:564` restarts `from` when `at − old.last > maxGap − (slack + old.slack)`. With the production constants every look's slack is `min(1 s, heartbeat / 5)` = 1 s, so the allowed gap is 10 − 2 = 8 s for every look.<br>**Tests:** mutation B passes 61/61, so no test pins the padding. The resolution claims none, and for a nit that is acceptable.<br>**Documentation:** the texts still say 2 heartbeats (QA-1.4-37). |

### The side effect: a negative allowed gap

- **When it is negative.**
  - The allowed gap is `2 × heartbeat − slack − view.slack`, with `slack = min(1 000, heartbeat /
    5)` (`:533-535`).
  - `view.slack` is the largest slack of the view's writers (`:564`), so at most 1 000 ms.
  - So the gap is negative only when `view.slack > 1.8 × heartbeat`: a look whose heartbeat is under
    556 ms, in a view that a 1 s-slack writer shares.
- **Production.**
  - The heartbeat is fixed at 5 s (`SLOT_DEFAULTS`, `:229-238`). The plan exposes only `slotWaitMs`
    (plan `:259`).
  - So every production look has an allowed gap of 8 s, and the negative case cannot happen.
  - Only this code writes sidecars. A torn or interleaved write leaves trailing bytes and does not
    parse, so a view cannot get a foreign `slack`.
- **Where it can happen, it is safe.**
  - Every look restarts `from`, so `witnessed` stays 0 and nothing is confirmed by observation. A
    dead same-host PID and this process's strays are still reaped at once.
  - `from` can then move back to an `at` below `old.last`, but that `at` is a real look within
    1.8 heartbeats of the latest one, so it adds no false continuity.
  - What it costs is liveness, and only for locks whose owner is not provably dead.
- **Tests.**
  - Only `:252` → `:254` puts two heartbeats in one view: a `fast()` look first, then a production
    look. The production look's allowed gap is 10 000 − 1 000 − 20 = 8 980 ms, and the lock is
    reclaimed by its dead PID anyway.
  - Mutation B (no padding at all) passes 61/61. So no test depends on the negative case.
- **Version skew (note, not a finding).**
  - A sidecar's name carries no version, so a later version with a shorter heartbeat or a larger
    slack would share views.
  - Its looks could get an allowed gap of 0 or less. That is safe, but it would delay reclaims of
    locks whose owner is not provably dead.
  - Whoever changes these constants should version the sidecar name.
- **Liveness cost in production.**
  - The watch looks every 5 s plus one pass (`:1330-1349`). The margin to the allowed gap drops from
    5 s to 3 s.
  - A pass or a timer delay longer than 3 s costs one watch step, and a watch lasts 50 s. b3
    reclaims after 15.2 s on both runtimes.
  - The wait loop looks at least every 2 s.

### Answers to the round-5 focus questions

- **Two holders.** No new path.
  - The padding only adds restarts, and the exit fence only removes deletes.
  - The committed repro's b1 has no two holders on either runtime.
- **Deadlocks.** No new wait, lock or await.
- **Unbounded lockouts.**
  - None with the production constants: the allowed gap is 8 s for every look, against a 5 s watch
    and waits of at most 2 s. b2 and b3 reclaim on both runtimes.
  - A claim that the exit hook now keeps (past its fence) carries a dead PID, so same-host reapers
    clear it at once.
- **Rejections.**
  - `acquireSlot` is unchanged.
  - The exit hook calls `u.mono()` outside its `try` (`:912`). The production clock cannot throw;
    only a throwing test seam would skip the rest of the hook.
- **Timers.** The production code adds none. The new test leaves one running (QA-1.4-38).

### New findings

| ID | severity | finding | evidence | fix |
|---|---|---|---|---|
| QA-1.4-35 | minor | The two claim tests still fail under CPU load: with `claimHoldMaxMs: 100` a claimed delete must finish within 100 ms and drop its claim within 150 ms, less than one claimed delete takes in a loaded worker. The own claims left behind then block the next attempts. | Load 2: 59/61, only `:660` and `:705`. A/B round 1: they fail in A and in B. Instrumented: both log "claim held too long, delete abandoned" and leave claims with the worker's live PID. | Raise `claimHoldMaxMs` in these two tests (for example 1 s, drop fence 1.5 s) and scale `:702`. |
| QA-1.4-36 | nit | The `it.each` at `:310-319` waits up to 5 s under vitest's default 5 s timeout (no `testTimeout` is configured), although the QA-1.4-33 resolution says every such test has 20 s. | Load 1: `Error: Test timed out in 5000ms.` (`:310`, wrong shape). | Pass `20_000` to the `it.each`. |
| QA-1.4-37 | nit | The texts still say that a gap of more than 2 heartbeats restarts the witness. With the padding it is 2 heartbeats minus both slacks: 8 s in production, and 1.6 s, 800 ms and 320 ms in the tests. | `slot.ts:47`, `:80`, `:525`. Notes `:72`, `:113`, `:115`. Test comments `:499` (says 2 s, is 1.6 s) and `:521` (says 400 ms, is 320 ms). | Correct the texts. The QA-1.4-21 residual that Phase 1.1/2.1 will state is 8 s, not 10 s. |
| QA-1.4-38 | nit | The QA-1.4-32 test leaves a background watch running. In the first iteration the seam clock is 1e6 ms behind, so the watch never reaches its `until`. It polls every 100 ms and re-creates the claim until `afterAll` removes the dir. | `watchleak.mjs`, the same steps: `{"first":"busy","claimAfterExitHook":false,"lockReadsIn3sAfter":20,"claimRecreatedByWatch":true,"lockReadsAfterClockPastUntil":0}`. | After the assertion, move the seam clock past the watch's end in both iterations (for example `shift = 1_000_000`). |

### QA-1.4-35 — minor — The two claim tests still fail under CPU load: `claimHoldMaxMs: 100` is shorter than one claimed delete

- **Where:**
  - `slot.test.ts:645-663` (a live claimer's claim) and `:688-708` (an unconfirmed claim). Both
    use `claimHoldMaxMs: 100` (`:653`, `:697`).
  - `unlinkWhile` gives up after the deadline (`:715-720`, `:725`). The target's deadline is
    `since + claimHoldMaxMs` (`:782`), and the claim's own drop is `since + 1.5 × claimHoldMaxMs`
    (`:787`).
- **Evidence:**
  - Load 2: 59/61, with only these two failing. Both ended busy (`:660`, `:705`).
  - A/B round 1: `:662` failed in A and in B, and `:705` in A. At `:662` the slot was held but a
    claim was left: `expected [ Array(1) ] to deeply equal []`.
  - **Instrumented run** (copy A, a warning logger on both tests, 14 busy loops): both failed.
    - `:660`: `QA busy; warns=["verification slot: claim held too long, delete abandoned"]`. Left
      behind: our meta-claim (`"pid":59896` = the worker, `"victim":"live-claimer"`) and the live
      claimer's claim.
    - `:705`: the same warning. Left behind: our meta-claim (its victim is our own claim's token)
      and our own claim on `slot-0.lock` (`"victim":"dead-holder"`), both with the worker's live
      PID.
  - **A fresh process** with the same deps and a dead-PID lock (`claimhold.mjs`) held in 7–16 ms
    unloaded and 6–64 ms loaded, with no warning. So it takes the loaded vitest worker to exceed
    100 ms; that worker also runs the background watches of earlier tests (analysis).
- **Mechanism:**
  - A claimed delete is about 10 file-system calls: create, write, close, re-read the claim, re-read
    the target, unlink, then the drop's re-read and unlink.
  - Under load that takes more than 100 ms, so the target's delete is abandoned. It takes more than
    150 ms too, so the claim's own drop is abandoned as well.
  - The claims left behind carry the live PID. Each blocks the next attempt until it is inert (span
    1.2 s, witnessed 0.4 s). The next reap of it faces the same 100 ms, so the 5 s wait runs out.
  - The round-4 finding blamed the view slack in `:645` (fixed) and did not identify this cause.
- **Production (analysis):**
  - With `claimHoldMaxMs` 5 s, the same abandon needs one claimed delete to take more than 5 s.
  - A claim left behind then blocks until it is inert (32 s span, 12 s witnessed), or at once once
    its owner is dead.
  - That is a bounded delay, not a lockout, and exclusion is unaffected.
- **Fix:**
  - In both tests use `claimHoldMaxMs: 1_000` (drop fence 1.5 s), or at least 500 ms.
  - In `:688`, sleep past the owner's drop fence (1.5 s instead of 200 ms at `:702`).
  - The inert rule then needs `witnessed ≥ 2.2 s`, which fits the 5 s waits. The `≥ 950 ms`
    lower bounds still hold.
  - `:665` exceeds its 100 ms on purpose and the new exit test does not depend on timing: leave
    both.

Resolution: 3ebc8a1 — both claim tests use `claimHoldMaxMs: 1_000`; the drop-fence sleep is 1.7 s (past 1.5 × 1 s) and the second test waits up to 10 s. Each still proves the same thing. 62/62 unloaded (61.7 s) and under 14 busy loops (84.3 s).

### QA-1.4-36 — nit — One 5 s wait still runs under vitest's default 5 s timeout

- **Where:** `slot.test.ts:310-319`, the `it.each` for an empty, corrupt or wrong-shape lock.
  - It waits up to 5 s (`:317`), and the `it.each` has no timeout argument.
  - `vitest.config.ts` sets no `testTimeout`, so the default is 5 s.
  - The QA-1.4-33 resolution says "every test that can wait 5 s or more has a 20 s timeout".
- **Evidence:** load 1, `Error: Test timed out in 5000ms.` for "a wrong shape lock file is stale".
- **Fix:** pass `20_000` as the `it.each` timeout.

Resolution: 3ebc8a1 — the `it.each` gets 20 s. A grep for waits of 5 s or more found two more tests without a timeout (the QA-1.4-29 release test with its `waitUntil` of 4 s, and the test before it with a default 5 s `waitUntil`); both get 20 s.

### QA-1.4-37 — nit — The gap rule is described as 2 heartbeats; the padded rule restarts sooner

- **Where:**
  - `slot.ts:47-48`: "the first look after the latest gap of more than 2 heartbeats".
  - `:77-78`: "less than 2 heartbeats apart".
  - `:80`: "looks further apart than 2 heartbeats".
  - `:525`: the `witnessed` doc comment.
  - Notes `:72`, `:113`, `:115`.
  - Test comments `:499` ("less than 2 heartbeats (2 s) apart"; the limit is 1.6 s) and `:521` ("a
    gap over 400 ms"; it is 320 ms).
- **Effect:**
  - Since `f3fc392` the witness restarts after a gap of more than `2 × heartbeat − (slack +
    view.slack)`. That is 8 s in production, not 10 s.
  - So the QA-1.4-21 residual (short-lived processes that each look once) starts at looks 8 s apart.
  - The test margins shrank with it: `:528` has 120 ms between its 200 ms watch and the 320 ms limit
    (it was 200 ms). It failed only in load 1.
- **Fix:**
  - Correct these texts.
  - When Phase 1.1/2.1 documents the residual next to `slotWaitMs` (deferred), use 8 s.
  - Optionally, move `:516-532` to `WATCHER_HEARTBEAT_MS` with calls 1.2 s or more apart, as
    QA-1.4-30 did for the others.

Resolution: 3ebc8a1 — `slot.ts`, the notes and the test comments now state the limit as 2 heartbeats minus both looks' slacks: 2 × 5 s − 2 × 1 s = 8 s in production, 1.6 s and 320 ms in the tests. The residual is 8 s.

### QA-1.4-38 — nit — The QA-1.4-32 test leaves a background watch running for the rest of the file

- **Where:**
  - `slot.test.ts:887-908`: the `waitMs: 0` call ends busy with the reap contended (the scanner
    seam), so `watchAged` (`:1330-1349`) starts a watch on the seam clock.
  - Its `until` is 1.4 s ahead on that clock (`:1333`).
  - The first iteration then sets `shift = -1_000_000` and never moves it back.
- **Evidence** (`watchleak.mjs`, the same steps in a fresh Node process):
  - After the exit hook the claim is gone. The watch then read the lock 20 times in the next 3 s
    and re-created the claim.
  - Once the seam clock passed `until` it stopped (0 reads in the next second).
  - In vitest it runs until `afterAll` removes the dir. It holds no process open (the timer is
    unref'd), but it is a 10 Hz loop for the rest of the file.
- **Fix:** after `expect(existsSync(claim)).toBe(past)`, set `shift = 1_000_000` in both iterations.

Resolution: 3ebc8a1 — after its assertion each iteration moves the seam clock past the watch's end, lets one poll see it, and asserts no further lock reads over the next 400 ms. Also: a new test pins QA-1.4-34 (looks 700 ms apart are reclaimed; 900 ms apart, inside 2 heartbeats of 500 ms but past the padded 800 ms, stay busy). Reverting the padding fails it.

### Deferred by plan (round 5)

- **QA-1.4-18** (Phase 2.1 / 2.2), nested acquisition: unchanged.
- **QA-1.4-19** (Phase 1.1 schema, Phase 2.1 wiring), non-finite `max`: unchanged.
- **QA-1.4-31** (Phase 1.1): the clamp is in the code; validating `slotWaitMs` stays with Phase 1.1.
- **QA-1.4-21 residual** (Phase 1.1 / 2.1): state it next to `slotWaitMs`, with looks 8 s apart
  (QA-1.4-37).

**Open, not deferred:** QA-1.4-35 (minor), and QA-1.4-36, -37 and -38 (nits). Phase 1.4 QA is
**not** clean.

## QA re-review (round 6)

Reviewer: adversarial QA, `[tier:heavy]` (CAP:none).

- **Scope:** `git diff cf10f7b..d9362a2` (`3ebc8a1`, `d9362a2`). It was checked against the round-5
  findings (QA-1.4-35…38) and searched for defects the diff introduces. Product code cleared in
  rounds 1–5 was not re-audited. Line numbers refer to `src/verify/slot.ts` and
  `test/unit/slot.test.ts` at `d9362a2`.
- **`slot.ts` changes only comments.**
  - All 11 changed lines in `git diff -U0` are comment lines.
  - The two versions were transpiled with oxc (`rolldown/experimental`) and their comments
    stripped. The results are byte-identical (32 455 bytes each).
- **Environment:** Windows 11 Pro, NTFS, 16 logical CPUs, Node v24.21.0, vitest 4.1.11. Other
  agents' sessions ran on this machine the whole time: their `node` and `bun` processes, and temp
  dirs they created during the review.
- **Repros:** `%TEMP%\omr-qa14r6\` held scratch copies of the package. Each linked the worktree's
  `node_modules` through a junction.
  - **A** is `d9362a2`.
  - **AI** is A with logging added. The QA-1.4-34 test logs the real-time gaps between its looks,
    and the two claim tests log their warnings, all to a file.
  - **F** is A with the QA-1.4-34 test's seam clocks frozen: `now: () => wall0 + shift` and
    `mono: () => mono0 + shift`.
  - **Mutations of `slot.ts`:**
    - B: the gap is unpadded (`:565`, `> maxGap`).
    - S: the gap is padded by one slack only (`> maxGap − slack`).
    - W: the watch ignores `until` (`:1343`, `if (again) schedule()`).
    - C: there is no exit fence (the `.filter` at `:913` is removed).
    - FB and FS are F with B and with S.
- **Cleanup:**
  - The junctions were removed before the dir was deleted, and the worktree's `node_modules` was
    checked intact.
  - Every busy loop was killed by PID; none was alive after any loaded run.
  - Afterwards there was no `omr-qa14r6` dir, and no `node.exe` running a busy loop or a vitest from
    this review.
  - The two `omr-slot-*` dirs in `%TEMP%` (03:11) predate this review and were left alone.
  - The worktree is clean.

**Test runs** (`npx vitest run --maxWorkers=2 test/unit/slot.test.ts`):

| run | result | duration |
|---|---|---|
| unloaded | 62/62 | 84.4 s |
| load 1: 14 `node -e "for(;;){}"` processes, killed afterwards | **54/62** (see below) | 201.8 s |
| load 2, same setup | 62/62 | 99.8 s |
| load 3, same setup, copy AI (logging only) | 62/62 | 86.0 s |
| load 4: 28 busy loops (2 × the protocol), copy AI, a diagnostic run | **58/62** (see below) | 153.0 s |

- **Load 1 was heavier than the protocol load.**
  - A vitest run from another worktree (`D:\git\wt\idx-874-linkage`) was running seconds before
    load 1 started; it was gone before load 2.
  - CPU was at 13–18 % before the loops started, against 10–13 % before load 2.
  - The run took 201.8 s, against 99.8 s for load 2, like round 5's load 1 (238.6 s).
  - One `waitMs: 0` call took 366 ms (`:1050`).
- **Load 1's 8 failures.** Only the tail of the output was kept, so three messages are missing.
  - **Fixed timing budgets:**
    - `:1050`: 366 ms against < 200 ms.
    - `:1064`: 315 ms against < 100 ms.
  - **Confirm by watching, messages not captured:** the hard-kill waiter (20.3 s), the live
    unrelated PID (5.0 s) and b3 (10.4 s).
  - **The two claim tests:** `:645` (6.0 s), and `:689`, still busy after its 10 s wait (`:707`).
  - **The new QA-1.4-34 test:** `["BUSY","BUSY","BUSY","BUSY","BUSY","BUSY","BUSY","BUSY"]: expected
    'BUSY' to be 'HELD'` (`:943`, the 700 ms side). This is QA-1.4-39.
- **Load 4 (28 loops):** 4 failures. Three are in tests this diff does not touch:
  - `:300`, the foreign-host test: busy.
  - `:488`: `SyntaxError: Unexpected end of JSON input` in `viewsIn` (`:381`). This is likely a torn
    read of a sidecar that is being rewritten; not investigated, because the test is unchanged.
  - `:1014`, the ticket test: `expected 1 to be +0`. Copy AI reported it as `:1018`, because its
    logging adds 4 lines above it.

  The fourth is `:661`, busy at the end of its 5 s wait (see QA-1.4-35 below). The QA-1.4-34 test
  and `:689` passed.
- **The QA-1.4-34 test's real-time gaps** (copy AI): this is the seam gap between the last look at
  one step and the first look at the next, minus the step.
  - 7 ms unloaded, 9–14 ms in load 3, and 2 ms in load 4.
  - So CPU load alone leaves the 100 ms margin wide, but load 1's calls of 300 ms or more did not.
- **The QA-1.4-34 test alone** (`-t`): A and F ran at the same time under 14 busy loops, for 8
  rounds. A passed 8/8 and F passed 8/8.

**Mutations** (one test each, `-t`, unloaded):

| copy | QA-1.4-34 test (`:920`) | QA-1.4-32/-38 test (`:889`) |
|---|---|---|
| A (`d9362a2`) | passes | passes |
| B: gap unpadded | fails: `["BUSY","BUSY","HELD"]: expected false to be true` (the 900 ms side) | — |
| S: one slack (an 800 → 900 ms limit) | **passes** | — |
| F: frozen seam clocks | passes | — |
| FB | fails, like B | — |
| FS | fails: `["BUSY","BUSY","HELD"]` | — |
| W: the watch ignores `until` | — | fails: `expected 4 to be +0` (`:915`) |
| C: no exit fence | — | fails: `expected false to be true` (`:909`), as in round 5 |

**Summary (round 6):**
- `slot.ts` is unchanged apart from comments.
- QA-1.4-35, -36 and -38 are verified.
- QA-1.4-37 is verified for the numbers. One phrase and one test comment are imprecise (QA-1.4-40).
- The new QA-1.4-34 test pins the padding: B fails it. Its 700 ms side has 100 ms of real time per
  step, and it failed in load 1 (QA-1.4-39).
- No test change weakens what a test proves.
- New findings: 0 critical, 0 major, 0 minor and 2 nits (QA-1.4-39, -40). Neither is a product
  defect.

### Verification of QA-1.4-35…38

| finding | status | evidence |
|---|---|---|
| QA-1.4-35 | verified | **Code:** `:654` and `:699` use `claimHoldMaxMs: 1_000`, so the target's deadline is 1 s and the drop fence 1.5 s. `:704` sleeps 1.7 s, past the fence, and `:707` waits up to 10 s.<br>**Runs:** both tests pass in loads 2 and 3. In load 4 (2 × the load), neither test logged "claim held too long, delete abandoned", so the QA-1.4-35 mechanism is gone. There `:689` passed and `:661` ended busy, like the unchanged gap-rule tests of that run (see the observations below).<br>**What they prove:** `:658`, `:662` and `:701-702` assert what they did before. The inert rule now needs a witness of 2 × 1 s + 0.2 s = 2.2 s (`:612`, `:614`). So `:662`'s ≥ 950 ms and `:708`'s ≥ 900 ms still separate "left to the inert rule" from "dropped at once", with more room. The longer wait at `:707` weakens nothing, because the test has no upper bound. |
| QA-1.4-36 | verified | **Fix:** the `it.each` gets 20 s (`:319`), and so do `:818` and `:837`.<br>**Scan:** among the tests without a timeout, one more can wait 5 s: `:551-574`. Its `waitUntil` (default 5 s, `:560`) waits for two ticks of a 30 ms heartbeat. That 5 s is a failure bound, so a 20 s timeout would not change the outcome. |
| QA-1.4-37 | verified (the numbers) | **Limits:** each look's slack is `min(1 s, heartbeat / 5)` (`:534-536`). So the limit is 2 × 5 s − 2 × 1 s = 8 s in production. In the tests it is 2 × 1 s − 2 × 200 ms = 1.6 s (`:499`), 2 × 200 ms − 2 × 40 ms = 320 ms (`:521`) and 2 × 500 ms − 2 × 100 ms = 800 ms (`:921`).<br>**Residual:** stated as 8 s (`slot.ts:81`, notes `:116`).<br>**Wording:** "both looks' slacks" is imprecise, and the comment at `:708` is stale (QA-1.4-40). |
| QA-1.4-38 | verified | **Fix:** `:910-915` moves the seam clock past the watch's `until` (`:1334`). The next pass (100 ms heartbeat) reads once and stops (`:1343`).<br>**Mutations:** with W (the watch ignores `until`), `:915` fails with 4 reads, so the assertion is not vacuous. `:909` still runs first, and C still fails it.<br>**Cleanup:** `:916` removes the claim that the last pass re-creates in the first iteration.<br>**Runs:** it passed in all five full-file runs. |

### The new QA-1.4-34 test (`:920-946`)

- **What it pins.**
  - `heartbeatMs` is 500 ms, so `maxGap` is 1 s and each look's slack 100 ms: the limit is 800 ms.
    Looks 700 ms apart must be reclaimed. Looks 900 ms apart, inside 2 heartbeats, must stay busy.
  - Mutation B (no padding) fails it, as the resolution says.
  - Mutation S (one slack, a 900 ms limit) passes it. The seam clocks add real time to the shift, so
    every 900 ms step becomes a gap of 900 ms plus a few ms, which is over S's limit too. With frozen
    clocks (F) the gap is exactly 900 ms, and FS fails.
  - Every look has the same slack, so the test cannot tell the view's slack from this look's. That
    is acceptable: in production every slack is the same.
- **Background watch.**
  - On the 900 ms side, the third and later looks are `aged`, so a watch starts (`:1331`). Its
    `until` is 12 s ahead on the seam clock, because the default `claimHoldMaxMs` is 5 s.
  - `:938` moves the clock past `until`. The watch's first pass comes 500 ms after it started,
    possibly after the test returns. It reads once and stops. That is harmless.
- **Load:** see QA-1.4-39.

### Answers to the usual questions

- **Two holders, deadlocks, unbounded lockouts, rejections:** none new. The product code is
  unchanged apart from comments.
- **Timers:**
  - The QA-1.4-32 test no longer leaves a 10 Hz watch running (QA-1.4-38).
  - The new test's watch makes at most one pass after the test.

### New findings

| ID | severity | finding | evidence | fix |
|---|---|---|---|---|
| QA-1.4-39 | nit | The QA-1.4-34 test's 700 ms side leaves 100 ms of real time per step. Its seam clocks are `Date.now()` and `performance.now()` plus the shift (`:927`), so each gap is the step plus the real time between two looks. That real time is the rest of one call and the start of the next, which is several file-system calls. When it passes 100 ms, the look restarts the witness. The peer watcher tests have about 700 ms for a wake-up plus an attempt. | Load 1: `["BUSY" × 8]: expected 'BUSY' to be 'HELD'` (`:943`). In the same run one `waitMs: 0` call took 366 ms (`:1050`). The real time per step measured 2–14 ms in the other runs. | Freeze real time in the seam clocks, so the gaps are exactly 700 and 900 ms. Copy F passes unloaded and 8/8 under 14 busy loops, and it still fails with B (and with S). |
| QA-1.4-40 | nit | "2 heartbeats minus both looks' slacks" says the previous look's slack is used. The code uses the view's slack, the largest of its writers' slacks (`:565`), as `:44-45` and the test comment at `:652` say. In production every slack is 1 s, so the 8 s stands. Also, `:708`'s comment says the claim is inert after `staleMs` (1 s); with `claimHoldMaxMs` at 1 s, the term that decides is the 2.2 s witness. | `slot.ts:47-48`, `:77-78` and `:526`. Notes `:72`. Test `:708`. | Say "minus this look's slack and the view's", or "minus both slacks" as notes `:114` and `:117` do. Correct `:708`'s comment. |

### QA-1.4-39 — nit — The new QA-1.4-34 test's 700 ms side has 100 ms of real time per step

- **Where:** `slot.test.ts:920-946`. The deps at `:927` are `now: () => Date.now() + shift` and
  `mono: () => performance.now() + shift`. The 700 ms side is at `:942-943`.
- **Mechanism:**
  - A look's `at` is `cfg.mono()`, taken just before its read (`:1295-1296`).
  - Between the last look at step i and the first at step i + 1, the shift grows by the step, and
    the real clock grows by the time the rest of call i and the start of call i + 1 take. That is
    the sidecar read and write, the return, and the next call's exclusive create.
  - The limit is 800 ms (`:565`). So at 700 ms, each step that takes more than 100 ms of real time
    restarts `from`.
  - The side is held only after two good steps in a row (a witness of at least 1.2 s, `:604`).
    Restarts at least every other step keep all 8 looks busy.
  - The 900 ms side cannot fail this way: real time only lengthens its gaps.
- **Evidence:**
  - Load 1: `["BUSY","BUSY","BUSY","BUSY","BUSY","BUSY","BUSY","BUSY"]: expected 'BUSY' to be
    'HELD'`. In the same run `:1050` measured a `waitMs: 0` call at 366 ms.
  - Copy AI measured the real time per step at 7 ms unloaded, 9–14 ms under 14 busy loops, and 2 ms
    under 28. So only I/O-heavy contention like load 1's pushes it past 100 ms.
  - Alone, under 14 busy loops, A passed 8/8.
- **Effect:** a flaky test under heavy load, nothing else. It is avoidable: the step does not need
  real time.
- **Fix:**
  - After `writeLock`, take `const wall0 = Date.now()` and `const mono0 = performance.now()`. Then
    use `now: () => wall0 + shift` and `mono: () => mono0 + shift`.
  - The gaps are then exactly 700 and 900 ms, whatever the load, and the watch's `until` still
    moves with the shift.
  - Copy F did exactly this. It passed unloaded and 8/8 under 14 busy loops (in parallel with A),
    and it still fails with B. It also fails with S, so it pins the two-slack padding more tightly
    than A does.
  - The alternative is a smaller step on the 700 ms side (400–500 ms, a 300–400 ms margin), which
    pins less.

### QA-1.4-40 — nit — "Both looks' slacks" is the view's slack in the code; one test comment is stale

- **Where:**
  - "minus both looks' slacks": `slot.ts:47-48`, `:77-78`, `:526` and notes `:72`.
  - `slot.test.ts:708`: `// inert after staleMs (1 s) from its first readable sighting`.
- **Effect:**
  - The gap rule subtracts this look's slack plus `old.slack`, the largest slack of the view's
    writers (`:565`). The previous look's slack is not used. The header says so three lines earlier
    (`:44-45`: "the look's and the largest of the view's writers'"), and so does the test comment at
    `:652`.
  - The two differ only in views whose writers have different heartbeats: tests, or the version
    skew noted in round 5. In production every slack is 1 s, so the 8 s is right.
  - At `:708`, the claim's inert rule needs a span ≥ 1.2 s and a witness ≥ 2 × `claimHoldMaxMs` +
    0.2 s = 2.2 s (`:612`, `:614`). Since `3ebc8a1`, the witness is the term that decides, not
    `staleMs`. The assertion (≥ 900 ms) is still valid.
- **Fix:**
  - Say "minus this look's slack and the view's", or "minus both slacks" as notes `:114` and `:117`
    do.
  - Correct `:708`'s comment. Optionally raise its bound to about 2 s.
  - Optionally rewrap `slot.ts:48`: at 139 characters, it is the longest line in the header.

### Observations (not findings)

- **`:661` under 2 × the load.**
  - QA-1.4-35's fix raised the witness this test's claim needs from 0.4 s to 2.2 s. Its wait stayed
    at 5 s; `:707` got 10 s.
  - Round 5 recommended exactly this, and the test passes the protocol load (loads 2 and 3).
  - It ended busy in load 4 without the abandon warning, and in load 1.
  - If the tests should also pass at 2 × the load, give `:661` a 10 s wait too.
- **Unchanged tests fail beyond the protocol load:** `:300`, `:488` (`:381`) and `:1014` in load 4,
  and load 1's timing budgets and watch tests. They are outside this review's scope.

### Deferred by plan (round 6)

- **QA-1.4-18** (Phase 2.1 / 2.2), nested acquisition: unchanged.
- **QA-1.4-19** (Phase 1.1 schema, Phase 2.1 wiring), non-finite `max`: unchanged.
- **QA-1.4-31** (Phase 1.1): the clamp is in the code; validating `slotWaitMs` stays with Phase 1.1.
- **QA-1.4-21 residual** (Phase 1.1 / 2.1): state it next to `slotWaitMs`, with looks 8 s apart.

**Open, not deferred:** QA-1.4-39 and QA-1.4-40 (nits, neither a product defect). Phase 1.4 QA is
**not** clean.
