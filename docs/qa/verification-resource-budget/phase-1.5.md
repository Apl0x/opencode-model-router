# Phase 1.5 — QA / spike log

Host: win32, Node **v24.21.0**, git **2.51.0.windows.1**, pwsh 7. All Spike D work ran under
`%TEMP%\omr-spikeD\` (every removal call went through a path guard that refused anything outside it);
Spike E ran under `%TEMP%\omr-spikeE\`. Both directories were deleted at the end (Spike D: junctions
unlinked first, then `git worktree prune` in each repo, then `fs.rmSync`; result `gone true`).

## Pre-flight / Spike D (junction safety) — CRITICAL

### Setup (fresh for every method × every junction creator)
- `repo`: `git init`, `.gitignore` = `node_modules/`, commits `packages/a/index.js`.
- Sentinels: `repo\node_modules\pkg\sentinel.txt` and `repo\packages\a\node_modules\x\sentinel.txt`.
- `git worktree add --detach wt`.
- Junctions `wt\node_modules` → `repo\node_modules` and `wt\packages\a\node_modules` →
  `repo\packages\a\node_modules`, created either with Node `fs.symlinkSync(target, link, 'junction')`
  ("node") or `New-Item -ItemType Junction` ("ps").

### lstat detection
| Junction created by | `lstat().isSymbolicLink()` | `isDirectory()` | `readlink` |
|---|---|---|---|
| node `symlink(..,'junction')` | **true** | false | target path |
| pwsh `New-Item -ItemType Junction` | **true** | false | target path (long-name form) |

=> code can detect links with `fs.lstat(p).isSymbolicLink()` before removing.

### Results (raw output, one line per run)
```
{"method":"1 fs.rm(junction,{recursive,force})","junctionBy":"node","rootSentinel":true,"nestedSentinel":true,"rootLinkGone":true,"wtDirGone":false,"err":""}
{"method":"1 fs.rm(junction,{recursive,force})","junctionBy":"ps","rootSentinel":true,"nestedSentinel":true,"rootLinkGone":true,"wtDirGone":false,"err":""}
{"method":"2 fs.unlink(junction)","junctionBy":"node","rootSentinel":true,"nestedSentinel":true,"rootLinkGone":true,"wtDirGone":false,"err":""}
{"method":"2 fs.unlink(junction)","junctionBy":"ps","rootSentinel":true,"nestedSentinel":true,"rootLinkGone":true,"wtDirGone":false,"err":""}
{"method":"3 fs.rmdir(junction)","junctionBy":"node","rootSentinel":true,"nestedSentinel":true,"rootLinkGone":true,"wtDirGone":false,"err":""}
{"method":"3 fs.rmdir(junction)","junctionBy":"ps","rootSentinel":true,"nestedSentinel":true,"rootLinkGone":true,"wtDirGone":false,"err":""}
{"method":"4 fs.rm(worktreeDir,{recursive,force})","junctionBy":"node","rootSentinel":true,"nestedSentinel":true,"rootLinkGone":true,"wtDirGone":true,"err":""}
{"method":"4 fs.rm(worktreeDir,{recursive,force})","junctionBy":"ps","rootSentinel":true,"nestedSentinel":true,"rootLinkGone":true,"wtDirGone":true,"err":""}
{"method":"5 git worktree remove --force (links inside)","junctionBy":"node","rootSentinel":false,"nestedSentinel":false,"rootLinkGone":true,"wtDirGone":true,"err":""}
{"method":"5 git worktree remove --force (links inside)","junctionBy":"ps","rootSentinel":false,"nestedSentinel":false,"rootLinkGone":true,"wtDirGone":true,"err":""}
{"method":"6 Remove-Item junction (pwsh)","junctionBy":"node","rootSentinel":true,"nestedSentinel":true,"rootLinkGone":true,"wtDirGone":false,"err":""}
{"method":"6 Remove-Item junction (pwsh)","junctionBy":"ps","rootSentinel":true,"nestedSentinel":true,"rootLinkGone":true,"wtDirGone":false,"err":""}
{"method":"7 fs.promises.rm(junction + sep,{recursive,force})","junctionBy":"node","rootSentinel":true,"nestedSentinel":true,"rootLinkGone":true,"wtDirGone":false,"err":""}
{"method":"7 fs.promises.rm(junction + sep,{recursive,force})","junctionBy":"ps","rootSentinel":true,"nestedSentinel":true,"rootLinkGone":true,"wtDirGone":false,"err":""}
{"method":"8 SAFE ORDER: unlink links -> git worktree remove --force -> fs.rm(wt)","junctionBy":"node","rootSentinel":true,"nestedSentinel":true,"rootLinkGone":true,"wtDirGone":true,"err":""}
{"method":"8 SAFE ORDER: unlink links -> git worktree remove --force -> fs.rm(wt)","junctionBy":"ps","rootSentinel":true,"nestedSentinel":true,"rootLinkGone":true,"wtDirGone":true,"err":""}
```
Follow-up on method 5: after `git worktree remove --force`, `repo\node_modules` and
`repo\packages\a\node_modules` **still existed but were empty** — git recursed through the junctions
and deleted the target contents (both sentinels and the `pkg`/`x` directories).

### SAFE (target intact, junction removed) — on this host
1. `fs.unlink(junction)` — **preferred** (single-entry operation, never recursive).
2. `fs.rmdir(junction)` (non-recursive).
3. `fs.rm(junction, {recursive:true, force:true})` — safe on Node 24 because rm lstat's the link; allowed only after an `lstat().isSymbolicLink()` check, prefer `unlink`.
4. `fs.promises.rm(junction + sep, {recursive:true, force:true})` — safe here, but do not rely on trailing-separator behaviour; not used in code.
5. `fs.rm(worktreeDir, {recursive:true, force:true})` with junctions inside — did not follow the junctions on Node v24.21.0. Allowed only as the last step, after links are unlinked (defence in depth).
6. `Remove-Item -LiteralPath <junction>` (pwsh 7) — safe; not used by code (no shell).

### BANNED
- **`git worktree remove --force <wt>` while any junction/symlink is still inside the worktree** —
  DELETES TARGET CONTENTS (proven, both junction creators, root and nested).
- Any recursive removal of a link path or of a directory containing links that has not first passed
  an `lstat().isSymbolicLink()` check (not observed destructive in Node 24, but not proven for other
  Node versions or for POSIX; treat as banned outside the ordered cleanup below).

### Proven safe cleanup order (method 8, both creators: sentinels survive, worktree gone)
1. For every link path we created: `lstat` → if `isSymbolicLink()` → `fs.unlink`. (Never recurse into it.)
2. `git worktree remove --force <wt>` (now link-free).
3. `fs.rm(wt, {recursive:true, force:true})` if the directory still exists; `git worktree prune`.

### POSIX directory symlinks
**Not testable on this host** (win32 only). Documented Node semantics: `fs.unlink` on a symlink
removes the link and not its target; `fs.rm` uses `lstat` and removes a symlink without following it
(it does not traverse into symlinked directories). `git worktree remove` behaviour on POSIX symlinks
is unverified; since it is proven destructive with junctions on Windows, the same order (unlink
first) is mandatory on every platform. The 1.5.3 key safety test must run on POSIX CI to confirm.

## Pre-flight / Spike E (`git stash create`)

Temp repo with committed `a.txt`, `b.txt`, `c.txt`, then: `a` staged, `b` unstaged, `c` staged then
modified again (unstaged on top), `u.txt` untracked.

- Clean tree: `git stash create` output = `[]` → **empty string**. ✅
- Dirty tree: returns a SHA (`5007266…`) whose parents are `HEAD` and the index commit.
- Before/after comparison of `git status --porcelain`, `git stash list`, `git for-each-ref`,
  `git ls-files -s` and every file's content: **identical** (`before==after: True`); stash list empty
  both times; only `refs/heads/master` in refs. ✅ No change to working tree, index or stash list.
- Stash commit tree = **working-tree state of tracked files**: `a.txt=a-staged`, `b.txt=b-unstaged`,
  `c.txt=c-staged-then-unstaged`; the index state is in `^2` (`c.txt=c-staged`). ✅ staged + unstaged.
- `ls-tree` of the commit: `a.txt b.txt c.txt` only — **untracked `u.txt` excluded**. ✅
- GC: the commit is unreferenced. `git gc --prune=now` **deleted it** (`cat-file: could not get object
  info`). Default gc prune grace (2 weeks) would keep it, but auto-gc risk is real → the reference
  should be pinned (e.g. `git worktree add` promptly, or an `refs/omr/…` ref deleted on dispose).
- `git worktree add --detach <wt> <stashSha>` works: worktree contains `a-staged`, `b-unstaged`,
  `c-staged-then-unstaged` (working-tree state), no `u.txt`, `git status --porcelain` clean. Once the
  worktree exists, its HEAD pins the commit: `git gc --prune=now` afterwards → `cat-file: commit`. ✅

## Pre-flight / Gather

`D:\git\omr-p15\src\verify\tree.ts:8-52` (verbatim):
```ts
export async function snapshotTree(cwd: string, signal: AbortSignal): Promise<TreeSnapshot | undefined> {
  let gitCwd = cwd;
  const git = (args: string[]) => new Promise<string>((ok, fail) => {
    execFile("git", ["--no-pager", ...args], {
      cwd: gitCwd, signal, timeout: 10000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    }, (error, stdout) => error ? fail(error) : ok(stdout));
  });
  try {
    const root = (await git(["rev-parse", "--show-toplevel"])).trim();
    // ls-files otherwise scopes untracked contents to a subdirectory cwd,
    // missing same-path edits in sibling packages that tests may import.
    gitCwd = root;
    const head = (await git(["rev-parse", "HEAD"])).trim();
    const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const files: ChangedFile[] = [];
    const records = status.split("\0");
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!record) continue;
      files.push({ path: resolve(root, record.slice(3)), status: record.slice(0, 2) });
      if (/[RC]/.test(record.slice(0, 2))) i++; // -z rename destination precedes source.
    }
    const hash = createHash("sha256").update(status);
    hash.update(await git(["diff", "HEAD", "--binary", "--no-ext-diff", "--no-textconv"]));
    hash.update(await git(["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv"]));
    // A submodule's dirty marker does not describe its content. Refuse rather
    // than cache a fingerprint that would excuse unmeasured changes there.
    if (/^160000 /m.test(await git(["ls-files", "--stage"]))) return undefined;
    const untracked = (await git(["ls-files", "--others", "--exclude-standard", "--full-name", "-z"]))
      .split("\0").filter(Boolean).sort();
    for (const path of untracked) {
      const absolute = resolve(root, path);
      const stat = await lstat(absolute);
      hash.update(JSON.stringify([path, stat.mode, stat.size]));
      if (stat.isSymbolicLink()) hash.update(await readlink(absolute));
      else if (stat.isFile()) hash.update(await readFile(absolute, { signal }));
      else return undefined;
    }
    if (signal.aborted) return undefined;
    return { cwd: await realpath(cwd), head, fingerprint: hash.digest("hex"), dirty: files.length > 0, files };
  } catch {
    // Not a Git checkout, unreadable file, timeout or concurrent deletion: no baseline.
    return undefined;
  }
}
```
Notes: untracked files are hashed into one aggregate sha256 (path, mode, size, then link target or
file bytes, sorted by path), with no per-file hash, so 1.5.2.a must compute its own per-file
`Map<relPath, sha256>`. Submodule refusal: tree.ts:35, any `160000` gitlink in `ls-files --stage` →
`undefined`. Non-file, non-symlink untracked entries → `undefined` (tree.ts:44).

`D:\git\omr-p15\src\verify\dispatch.ts:18-24` (verbatim):
```ts
export interface TreeSnapshot {
  cwd: string;
  head: string;
  fingerprint: string;
  dirty: boolean;
  files: ChangedFile[];
}
```

## Implementation notes (1.5.2 / 1.5.3)

Header ambiguities resolved while implementing `src/verify/reference.ts`:
- **Copy parent check (4.4).** The header says realpath(parent) must be "strictly inside dir"; a root-level
  untracked file has parent == dir, so the check is *inside-or-equal*. A failure makes the path inexact
  (`untracked-unsafe-path`) instead of aborting.
- **Untracked drift (2c/2d).** "Hash differs" for still-present untracked files is taken from the step-4
  read (modified/deleted/unreadable paths join the changed set), so each file is read once.
- **Unlinkable node_modules candidates** (no parent at the reference, target not a real dir, path already
  exists in the worktree) are listed in `unreproduced`, since they are absent from the reference.
- **Pre-existing dir.** If `<tmp>/omr-ref-<pid>-<hex>` already exists, materialize returns `unsafe-path`
  without cleanup, so it can never delete a dir it did not create.
- **Step 5 of dispose** is also guarded by `assertSafeRefDir` + lstat (dir must be gone), in addition to
  the git registration check. Registration is read from `git worktree list --porcelain`.
- **GC.** `kept` lists only omr-ref candidates (live, young, locked, ACTIVE); non-candidates are not
  reported. Orphans (no admin entry) skip the git steps: sweep, then R2 `fs.rm`. An orphan whose `.git`
  is not a regular file, or whose `gitdir:` resolves outside root's `--git-common-dir`, is left alone and
  not reported. The registered/ACTIVE checks compare both the tmp-root path and its realpath (8.3 vs long form).
- **Seam failures.** A rejected `ArgvSeam` call is treated as a failed git run (code -1), never as success.
- **capturedAt** uses `Date.now()`, because `CaptureDeps` has no `now` seam.

Tests (`test/unit/reference.test.ts`, 21 cases) use real git repos under `mkdtemp(realpath(os.tmpdir()), "omr refs ü テスト ")`
with `tmpdir` injected as a sibling `tmp ä dir`, so all paths contain spaces and non-ASCII characters. The
ArgvSeam is a test-local `execFile` helper. `afterEach` asserts that exactly one worktree remains and that
there are no `omr-ref-*` dirs in the injected tmp.

## QA findings (Phase 1.5 review, `[tier:heavy]` CAP:none)

Scope: `git diff 754296c..HEAD` (12213b6, bf7961c, 59d60b9). The phase's own test file passes (21/21, 40.95 s,
`npx vitest run --maxWorkers=2 test/unit/reference.test.ts`). All repros ran on the same host (win32, Node v24.21.0,
git 2.51.0.windows.1; effective `core.autocrlf=input`: system `true`, global `input`) under a fresh
`%TEMP%\omr-qa15`. The harness imported `src/verify/reference.ts` directly through Node type stripping and used a
production-like ArgvSeam: on abort or timeout it runs `taskkill /T /F`, the tree kill that `runArgv` (1.2) provides.
`tmpdir` was always injected in its **8.3 short form** (`C:\Users\MARQUI~1\...`). Sandbox removed afterwards (links
unlinked first; 0 reparse points left).

Severity: High = user-visible damage to the repository; Medium = a wrong verdict, a leftover in the user's repo, or
a data-deletion path that depends on a runtime contract; Low = hardening or test gap.

### QA-1.5-1 — High — an aborted capture can leave a stale `.git/index.lock` in the user's repository
- `src/verify/reference.ts:939-943,953`: `git stash create` runs with the capture budget's signal, so an abort or
  timeout tree-kills it. It takes `.git/index.lock` unconditionally to refresh the index (D2, `:121-127`). A process
  killed while holding the lock never removes it. The header's claim "An abort mid-capture leaves nothing but such
  unreferenced objects" (`:128-129`) is false.
- Repro: 20 000 tracked files made stat-dirty (`utimes`), `git stash create` tree-killed after 40…1300 ms.
  **9 of 10 runs left `.git/index.lock`**. After each, the producer's next `git add a.txt` failed with
  `fatal: Unable to create '…/.git/index.lock': File exists.` Every git write in the repo stays broken until the
  lock is removed by hand.
- The abort test (`test/unit/reference.test.ts:179-191`) aborts only after `stash create` has returned, so it never
  kills git mid-run.
- Fix: run `git stash create` against a **private index copy**. Read `.git/index` with `fs.readFile`, write the
  copy under the tmp root, and pass `env: { GIT_INDEX_FILE: <copy> }` (the ExecOptions seam has `env`); delete the
  copy afterwards. Measured: the same tree SHA as a plain `stash create` (`privateIndexSameTree: true`), and a kill
  can then only strand a lock on the copy. In addition, or as an alternative, do not pass the caller's abort signal
  to this single call (hard timeout only; the result is discarded if the caller has aborted). Add a test that kills
  `stash create` mid-run through a tree-kill seam and asserts that `.git/index.lock` is absent.
- Resolution: 0fe514d — `git stash create` runs with `GIT_INDEX_FILE` on a copy of the user's index (read with
  `fs.readFile`, written `wx` 0o600) in a scratch `omr-ref-<pid>-<hex>` dir made with `mkdir(0o700)` under the tmp
  root and removed through the section 6 pipeline, plus `-c core.splitIndex=false`. The call gets the timeout but
  not the caller's signal; an abort discards the result. Test: a slow clean filter keeps `stash create` in its
  refresh, the seam tree-kills it once the copy's `index.lock` exists; asserts no `signal` was passed, no
  `.git/index.lock`, no `index.stash.*`, a byte-identical `.git/index`, and that the next `git add` works.
  d66bf69 — follow-up found while fixing: a fresh copy has a later mtime, which disables git's racy-git check,
  so `stash create` and the drift diff missed a same-size edit made in the index's second. The copy now gets the
  original mtime (floored to ms); a deterministic test (stat-identical edit, racily clean index) failed without
  it and passes with it.

### QA-1.5-2 — Medium — capture and materialize contend for the user's `index.lock` (D2 understated)
- `:953` (`stash create`, mandatory lock) and `:1188` (drift `git diff`, which refreshes the index).
- Repro: 120 producer `git add` runs against a loop of captures (`stash create`) on a 3 000-file repo.
  **27/120 producer `git add` calls failed** (`Unable to create '…index.lock': File exists`) and 32 captures failed.
  Baseline without captures: 0/120. With the private-index variant of QA-1.5-1: **0/120 and 0 capture failures**.
- The drift `git diff --name-only … <commit> --` rewrote `.git/index` after a stat-only change
  (`indexRewritten: true`). With `git --no-optional-locks diff …` it did not (`false`). D2's "same class as
  `git status`" does not hold: status's refresh is an optional lock and is skipped when the lock is busy, whereas
  `stash create` needs the lock and fails.
- Fix: the private index from QA-1.5-1, plus `--no-optional-locks` on every read-only git call in capture,
  materialize and GC. Update D2 accordingly.
- Resolution: 0fe514d — every git call in `reference.ts` runs as `git --no-optional-locks …` (in `runGit`). Re-measured
  while fixing: on git 2.51.0.windows.1, `git --no-optional-locks diff --name-only … <commit> --` **still rewrote**
  `.git/index` after a stat-only change (porcelain diff's closing `refresh_index_quietly()` takes the lock whenever
  it is free), unlike the QA measurement. So the drift diff also runs on a private index copy, like `stash create`.
  D2 is rewritten. Test: every recorded git argv starts with `--no-optional-locks`, and `.git/index` is
  byte-identical after capture + materialize + dispose with a stat-dirty tracked file.

### QA-1.5-3 — Medium — `git worktree remove --force` is still the recursive deleter (TOCTOU after the sweep)
- `:879-890`: the sweep proves the tree link-free, then `git worktree remove --force` recursively deletes an
  **existing** dir. Git for Windows follows junctions (Spike D method 5), so any link that appears between the
  sweep and the end of git's recursion makes git delete the link **target's contents**. Only the contract "call only
  after the recheck process tree exited" stands in the way. QA-1.5-4 shows that GC can break that contract.
- Repro: a seam hook created one junction `packages/late-link → victim` right before `git worktree remove` ran.
  Result: `victim/pkg/sentinel.txt` **GONE**. On the same shape, `fs.rm(dir, {recursive, force})` left the victim
  intact (`real data`).
- Also: the sweep's containment check is lexical (`:831`). If a real dir is swapped for a junction between `lstat`
  and `readdir`, the sweep walks into the target and unlinks links in the live `node_modules` (analysis, same race
  class; not reproduced).
- Fix: reorder to sweep → `assertSafeRefDir` + `lstat` → `fs.rm(dir)` (Spike D SAFE #5) → and only when the dir is
  gone, `git worktree remove --force <dir>` to drop the admin entry. That call does no recursion (it is today's
  step 5, measured in 1.5.1). Git then never deletes a tree. Keep the sweep: `engines` is `node >=20`, and fs.rm's
  non-following of junctions is proven only on v24.21.0. Add a test that injects a junction just before the
  removal and asserts that the target survives.
- Resolution: ad0a859 — dispose order is now: recorded links → sweep → `assertSafeRefDir` + lstat real dir →
  `fs.rm(dir)` (the only recursive deleter) → only when lstat shows the dir is gone, `assertSafeRefDir` again and
  `git worktree remove --force <dir>` to drop the admin entry. If the dir survives `fs.rm` (EBUSY), git is not run
  and the dir is left for GC. The sweep also realpath-checks every directory before its readdir, which narrows the
  junction-swap window. R2/R4 and D6 updated. Test: an fs seam creates `packages/late-link → victim` right before
  `fs.rm`, and an argv seam records whether the dir existed when `worktree remove` ran (it would also plant a
  junction then); the victim sentinel survives and the dir was gone.

### QA-1.5-4 — Medium — GC can remove a live reference
- `:678`: `ACTIVE` is module-local. `:1307-1308`: `pid === ownPid` without `ACTIVE` membership counts as stale, and
  `age > 1 h` counts as stale **even when the owner is alive**.
- Repro: `reference.ts` imported twice in one process (as when the plugin is loaded from two install paths).
  Instance A materialized a reference. `gcStaleReferences` from A kept it (`kept: 1`); **from B it removed it**
  (`removed: 1`, `liveRefDirExists: false`). The node_modules sentinels survived.
- Consequences: a recheck in progress loses its tree mid-run, so a reference-side failure appears that the tree
  itself did not cause. It also reopens the QA-1.5-3 window while the owner's runner is still alive. The same
  applies across processes to a live reference older than 1 h by dir mtime.
- Fix: keep `ACTIVE` on `globalThis` (`Symbol.for("omr.reference.active")`). Treat `pid === ownPid` as stale only
  when the dir is also old. For an alive owner, do not use mtime age alone: use a heartbeat marker touched while the
  handle is in use, or the owner's process start time. 2.1 must classify "reference vanished" as `unverifiable`.
- Resolution: 1ee91ce — the in-use set lives on `globalThis` under `Symbol.for("omr.reference.active")`. A
  materialized dir's own mtime is the heartbeat: an unref'd timer (`heartbeatMs`, default 5 min) sets it to now
  until dispose stops it, so the 1 h age rule fires only after the owner stopped using the dir (PID reuse). The
  own-PID clause is gone. A dir this process created, released and failed to remove goes into a second
  process-wide set (`omr.reference.released`), which GC treats as stale at once. Tests: a second module instance
  (`vi.resetModules()`) keeps the first instance's live reference, even with the clock 10 h ahead; the heartbeat
  refreshes a backdated mtime and stops at dispose; GC removes an alive owner's dir whose heartbeat is 2 h old
  and keeps a fresh own-PID dir. The 2.1 "reference vanished → unverifiable" rule stays with 2.1.

### QA-1.5-5 — Medium — an abort during `git worktree add` leaves a permanently locked admin entry
- `git worktree add` locks the new entry with reason `initializing` until the checkout finishes. Tree-killed
  mid-checkout, the lock stays. `:886,:907` then fail, and GC keeps `locked` entries forever (`:1333`).
- Repro: a slow smudge filter (`sleep 6; cat`) with the materialize signal aborted at 2 s. Result `aborted`, dir
  removed, but the warnings read `cannot remove a locked working tree, lock reason: initializing` and
  `git worktree list --porcelain` still shows the `omr-ref-…` entry as `locked initializing`. GC with the owner dead
  and `now + 10 h`: **kept**. The user's repo keeps a registered worktree (this breaks the §148 check "no stale
  omr-ref-* worktrees").
- Fix: only for an R3-valid `omr-ref-*` entry whose lock reason is exactly `initializing`, and only when it is our
  own abandon or the owner is dead: run `git worktree unlock <dir>`, then the normal pipeline. Leave every other
  lock reason alone. Add a test with a slow smudge filter.
- Resolution: bca1f4a — the porcelain parser keeps the lock reason. Before dropping the admin entry, a lock whose
  reason is exactly `initializing` is lifted with `git worktree unlock <dir>`, but only if the caller allows it
  (materialize's own cleanup; GC when the owner is dead or the dir is in the released set). Any other reason is
  kept and warned about. Our `worktree add` runs with `LC_ALL=C` so the reason is never translated. Tests: a
  slow smudge filter, with the abort fired once `.git/worktrees/*/locked` exists → `aborted`, no omr-ref entry,
  no warnings; GC unlocks and removes a dead owner's `initializing` entry but keeps a live owner's and a dead
  owner's `on a usb stick` lock.

### QA-1.5-6 — Medium — `exact: true` while the tracked content differs from the dispatch tree
- Exactness (`:55-76`, `:1232`) covers untracked files and drift since dispatch, but not two gaps between the live
  tree and the checkout of the stash commit:
  - (a) EOL conversion on checkout. With `core.autocrlf=true` (the Git for Windows system default), live `"x\ny\n"`
    became `"x\r\ny\r\n"` at the reference. With `input` (this host), a dirty tracked file saved with CRLF
    (`"m2\r\nn2\r\n"`) became `"m2\nn2\n"`. **Both `exact: true`**. The same applies to `text`/`eol`/`filter`
    attributes.
  - (b) Index flags. With `--assume-unchanged` and `--skip-worktree` files edited locally, live `v2-local`/`w2-local`
    became `v1`/`w1` at the reference, with **`exact: true`, `inexactReasons: []`**. Neither `stash create` nor the
    drift `git diff` sees such edits.
- Any byte difference can make a test fail only at the reference. That reads as "pre-existing" and excuses a
  failure the producer introduced, which §1.5-7 forbids. The tests pin `core.autocrlf=false` (`test:102`), so they
  cannot see (a).
- Fix: (b) mark the reference inexact (`index-flags`) when `git ls-files -v` shows any lowercase tag
  (assume-unchanged) or `S` (skip-worktree). (a) At capture, record the sha256 of the live bytes of every tracked
  path that differs from HEAD, and at materialize compare them with the checked-out bytes. Then either compare
  clean files too whenever a conversion is configured (`core.autocrlf`≠false, or any `text`/`eol`/`filter`
  attribute) or mark such references inexact (`checkout-conversion`). Add tests with `core.autocrlf=true` and
  assume-unchanged.
- Resolution: a650dfb — (b) capture runs `git ls-files -v -z`; the first path tagged lowercase or `S` becomes
  `captureReasons: [{ cause: "index-flags", path }]`, which materialize copies into `inexactReasons`. (a)
  materialize adds `{ cause: "checkout-conversion", path: "" }` when `core.autocrlf` is anything but false. Capture
  also hashes the live bytes of every dirty tracked file (`git diff-tree -r --name-only <head> <commit>`, into
  `DispatchReference.tracked`), and materialize adds `checkout-conversion` for each one whose checked-out bytes
  differ, which covers `text`/`eol`/`filter` attributes on dirty files. Residual, documented under OPEN RISKS:
  an attribute-converted file that git reports as clean, with `core.autocrlf=false`. Tests: `core.autocrlf=true`
  (reference `a0\r\n`) and `input`; `*.txt text eol=crlf` with a dirty LF file; assume-unchanged +
  skip-worktree edits.

### QA-1.5-7 — Medium — `exact` ignores ignored inputs present at dispatch (`.env`, generated files) — deferred by plan (2.1)
- `:1147-1148` and `:82-86`: ignored entries only go to `unreproduced`, and `exact` stays true. The test asserts
  exactly this (`test:228-232`: `exact === true` with `.env` in `unreproduced`). A test that reads settings from an
  ignored `.env` fails at the reference with an assertion error, not a collection/setup error, so §1.5-8 does not
  catch it and the failure is excused.
- Fix: state in the header that `exact` is necessary but not sufficient for an excuse. The policy is 2.1's: a
  reference-side failure must not excuse while `unreproduced` holds anything outside a small inert allowlist
  (`coverage/`, logs, OS files). Env files and generated sources must never be on it.
- Status: deferred to 2.1 by plan; unchanged in the QA-1.5 fix round.

### QA-1.5-8 — Low — D9 hook suppression is bypassable by committed content
- `:1081`: `core.hooksPath=<dir>/.omr-no-hooks` points **inside the worktree**, so the checkout can create it.
- Repro: control first. A plain `git worktree add` ran `.git/hooks/post-checkout`; materialize correctly did not.
  But a committed `.omr-no-hooks/post-checkout` **ran during materialize**
  (`committed /c/Users/…/omr-ref-31548-1d4722dad301e0d9`). Impact is limited, since the recheck runs repository
  code anyway. Still, the header claim (`:155-157`, D9) is false, and the hook runs outside the recheck's controls
  (slot, priority, budget).
- Fix: point `core.hooksPath` at a path that is outside the worktree and never created (for example
  `<tmp root>/<ref dir name>.nohooks`). Add a test with a committed `.omr-no-hooks/post-checkout`.
- Resolution: 7dbfada — `core.hooksPath=<realpath tmp>/omr-nohooks-<16 random hex>`. The path is checked absent
  (otherwise `unsafe-path`) and never created. D9 and section 4 updated. Test: controls first, both run in this
  environment (the repository's `.git/hooks/post-checkout` on a plain `worktree add`, and the committed
  `.omr-no-hooks/post-checkout` under the former D9 path). Then materialize runs neither hook, and the hooks path
  it passed is directly under the tmp root, outside the dir, and absent.

### QA-1.5-9 — Low — test gaps in the cleanup and guard coverage
- (a) The "file held open" test (`test:292-303`) never produces EBUSY. A Node `fsp.open` handle does not block
  deletion: dispose finished in 281 ms with no warnings. A child process whose cwd is inside the reference does
  block it: `git worktree remove` failed (`Permission denied`), and **dispose resolved only after the holder
  exited** (45.5 s and 60.5 s for holders that lived 45 s and 60 s). A standalone `fs.rm` with the same options
  threw EBUSY after 10.8 s; the cause of the longer in-module wait is unverified. So the plan's "EBUSY → retried,
  then logged" path is untested, and dispose latency depends on how long the holder lives. Use a child-process cwd
  holder and assert that the warning is logged and that dispose resolves within a bound.
- (b) There are no unit tests for `assertSafeRefDir` or `isStrictlyInside` (`:635-673`, R3). Missing cases: 8.3 vs
  long form, case, UNC, filesystem root, nested dirs, dot segments, a prefix sibling (`Temp2`), `/`-separated
  input. The suite only injects a realpath'd long-form tmp (`test:96`), never `os.tmpdir()`'s 8.3 form on this
  host. (The repros above did use the 8.3 form: dirs were created in long form and GC matched git's long-form
  listing.)
- (c) The capture abort test does not kill git mid-run (see QA-1.5-1). (d) There is no D9 test (see QA-1.5-8).
- Positive: a **mutation check** confirms that the key tests catch the dangerous regressions. With dispose
  mutated to skip steps 1+2 (unlink and sweep), the KEY SAFETY sentinels (root and nested) were **GONE** and the
  extra-link target was **GONE**. With only the sweep skipped, the KEY sentinels survived but the extra-link target
  was GONE. So `test:241-258` and `test:260-272` both fail on those mutations.
- Resolution: e7acc5d — (a) the open-file test is replaced (win32) by a child process whose cwd is inside the
  reference: dispose resolves in < 20 s, warns "reference worktree left in place", leaves the admin entry (git
  never runs on the existing dir), has already removed the links, and after the holder exits, the next GC collects
  the released dir. (b) Table tests for `isStrictlyInside` and `assertSafeRefDir` with explicit platforms: case,
  trailing separator, `.`/`..`, prefix sibling (`Temp2`), other drive, `/`-separated input, UNC (root and non-root),
  filesystem roots, relative input, 8.3 vs long form, bad names, POSIX case-sensitivity. A round trip injects
  `tmpdir` in `os.tmpdir()`'s own (8.3) form through capture, materialize, GC and dispose. (c) is covered by the
  QA-1.5-1 test (0fe514d), (d) by the QA-1.5-8 test (7dbfada). The test seam is now spawn-based, like runArgv:
  env merged, tree kill, resolves on close. On win32, MSYS `sleep.exe` escapes `taskkill /T` (its Windows parent
  is a dead fork stub) and holds the stderr pipe, so the filter-based tests use `sleep 3`.

### QA-1.5-10 — Low — temp-dir exhaustion and POSIX exposure window — partly deferred by plan (2.1)
- `MAX_UNTRACKED_*` (`:580-581`) bound only the untracked copy. Every materialize checks out the full tracked tree.
  Nothing in 1.5 caps concurrent references, and GC runs only at plugin start. A dir left by failed disposes (see
  QA-1.5-5 and QA-1.5-9) waits for the next start.
- Deferred to 2.1: materialize only inside the S3 slot, and call GC before each materialize.
- In 1.5: `chmod(dir, 0o700)` runs after the checkout (`:1087`). In a shared `/tmp`, the tracked and dirty content
  sits in a umask-default (typically 0755) dir until then. Fix: `mkdir(dir, 0o700)` first, then
  `git worktree add` into the empty dir (git accepts an existing empty dir). An injected or relocated win32 TEMP
  (for example `C:\Temp`) inherits broader ACLs than `%LOCALAPPDATA%\Temp`: document it.
- Resolution (1.5 part): 28c5eae — materialize creates the dir with a non-recursive `mkdir(dir, { mode: 0o700 })`
  (plus an exact `chmod` on POSIX) before `git worktree add` checks out into it. EEXIST gives `unsafe-path` and the
  existing dir is left alone. Capture's scratch dir is made the same way. The win32 ACL caveat is documented in
  section 9. Tests: the dir exists, is empty (and 0o700 on POSIX) when `worktree add` starts; a pre-existing dir
  of the chosen name is refused and untouched. Header wording: 33633df.
- Deferred to 2.1 by plan, unchanged: materialize only inside the S3 slot, and run GC before each materialize.

### Checked with no finding
- `reference.ts` imports only `node:fs/promises`, `node:crypto`, `node:os` and `node:path` (`:422-425`), plus type-only
  imports. No argv contains `prune`, `clean`, `reset`, `checkout`, `update-ref`, `gc` or any `stash` subcommand
  other than `create`.
- R1/R2: every `unlink` is preceded by `lstat` (`:870-873`, `:832-836`). Every recursive removal (`:886`, `:897`,
  `:907`) is preceded by `assertSafeRefDir` plus a real-dir `lstat`, and runs only after a successful sweep.
  materialize never removes a dir it did not create (`:1075`).
- GC candidates need the basename pattern **and** a parent equal to a tmp root (`:1332`, `:1372`). Orphans of
  other repositories are skipped by their `gitdir:` line (`:1396`). Look-alikes and user worktrees are kept
  (`test:371-403`). A user worktree deliberately named `omr-ref-<pid>-<16hex>` directly under TEMP would be
  collected. That is accepted by the naming contract; optional hardening is to also require `detached` in the
  porcelain entry.
- Intent-to-add entries: `git stash create` fails (`Entry 'ita.js' not uptodate. Cannot merge.`), so capture
  returns `undefined`. This is a safe refusal, but S2 is unavailable while any `git add -N` entry exists.
- `core.fsmonitor=true`: dispose succeeded; the daemon only watched the main repository.
- Untracked copy: the hashed buffer is the written buffer, and `wx` never writes through a link (`:1119-1136`).
- Case-only renames under `core.ignorecase=true` are invisible to git on both sides (analysis, not reproduced; no
  exactness impact on case-insensitive filesystems).

## QA re-review (round 2)

Scope: `git diff 14460ad..facfc14` (0fe514d, ad0a859, 28c5eae, d66bf69, 1ee91ce, bca1f4a, a650dfb, 7dbfada, e7acc5d,
33633df, facfc14). Line numbers refer to `src/verify/reference.ts` at facfc14. `npx vitest run --maxWorkers=2
test/unit/reference.test.ts`: **38/38 passed**, 186.35 s. Same host as round 1 (win32, Node v24.21.0,
git 2.51.0.windows.1; system `core.autocrlf=true`, global `input`, `core.eol` unset). The repros ran under
`%TEMP%\omr-qa15r2` and imported the real `reference.ts` through Node type stripping (a second instance through a
`?copy=2` URL). `tmpdir` was always injected in its 8.3 form. The ArgvSeam was spawn-based, like runArgv: env merged
over `process.env`, `taskkill /T /F` on abort or timeout, and it resolves on `close`. Slow filters were Node scripts,
not MSYS `sleep`, so the tree kill reaches them. Nothing in the harness ran `git worktree remove` on a dir that
contained a junction. Cleanup: every link was unlinked first (0 were left, because the module had already removed
all of them), no `omr-ref-*` entry was registered in any of the 23 sandbox repos, the sandbox was deleted, and there
were no `omr-ref-*`/`omr-nohooks-*` dirs in the TEMP root. In every scenario below, the root, nested and extra-victim
sentinels read `keep me` / `real data` afterwards.

### Resolutions: verification
| Finding | Status | Evidence |
|---|---|---|
| QA-1.5-1 | **Verified** | `:1190-1199`: `stash create` gets `GIT_INDEX_FILE` and a timeout, no signal. **S6 (timeout):** a clean filter of 8 s kept `stash create` in its refresh. The call had `hasSignal: false` and was tree-killed by its timeout at 2 666 ms. Capture returned `undefined` after 3.4 s. `.git/index.lock` was absent, `.git/index` was byte-identical, the next `git add` exited 0, and no scratch dir was left. **S5 (d66bf69):** stat-identical same-size edit with a racily clean index. A control copy with a fresh mtime → `stash create` **missed** the edit (empty output). A control copy with the original mtime → `a1`. `captureReference` → `a1`. The copy's mtime (1790479358959) was not later than the original (1790479358959). The user's index mtime was unchanged. |
| QA-1.5-2 | **Verified** | **S1:** every argv starts with `--no-optional-locks`. The `GIT_INDEX_FILE` of both `stash create` and the drift `diff` lies under realpath(tmp). With a stat-dirty file, the `.git` listing (objects excluded, bytes hashed) was identical after capture and again after dispose. **S4:** a producer holds `.git/index.lock` during capture and materialize. Both succeed (exact, dirty content present), the lock file is untouched (byte-identical) and `.git` is unchanged. Implementer's note confirmed (**S11**): on a stat-dirty index, `git --no-optional-locks status` did not rewrite `.git/index`, `git --no-optional-locks diff --name-only … HEAD --` **did**, and plumbing `diff-index` did not. That fits `builtin/diff.c`'s `refresh_index_quietly()`, which never consults `GIT_OPTIONAL_LOCKS`. Acceptable, because the drift diff now runs on a copy. |
| QA-1.5-3 | **Verified** | Order at `:1095-1136`. **S7:** a holder process's cwd inside `packages` made dispose warn `fs.rm failed: EBUSY`. The links and the `.git` file were already gone, and the admin entry stayed registered. I then recreated two junctions in the leftover, one pointing at the victim and one at the real `packages/a/node_modules`. A GC while the dir was still held unlinked both in its sweep, `fs.rm` failed again and git was not run. After the holder exited, GC removed the dir and the entry. `git worktree remove` saw the dir absent (`[false]`). **S10** bounds the documented step-4 residual race (junction-free repro). A dir recreated **without** a valid `.git` gitfile → `fatal: validation failed, cannot remove working tree: '…/.git' does not exist`, and the sentinel survived. Once the original gitfile was restored, git deleted the dir. So git deletes a recreated dir only if its gitfile is back as well. |
| QA-1.5-4 | **Verified** (residual noted) | **S13:** two module instances share the Set (size 1, then 0 after dispose). GC from the second instance with `now + 10 h` kept the live dir. **S15** (owner in a child process): with `heartbeatMs: 200`, the dir backdated 2 h was kept by GC 1 s later. With a late heartbeat (1 h), GC removed the **alive** owner's live reference. That is the PID-reuse rule by design, and no data was touched. **S8:** the interval is unref'd, because an owner with an undisposed handle exited 14 ms after its last output. Residual: for an alive owner, correctness assumes the heartbeat fires within 1 h. An event-loop stall or a suspended process breaks that assumption, and so may a system sleep on a platform whose timers use a clock that pauses during suspend (not verifiable on this host). The backstop is 2.1's rule "reference vanished → unverifiable" (deferred). |
| QA-1.5-5 | **Verified** | `:1118-1130`: unlock runs only after the dir is gone and R3 passed, and only for reason === `initializing` with `unlockInitializing`. GC grants that only for a released dir or a dead owner (`:1732-1734`). S1 audit: `LC_ALL=C` is set only on `worktree add`. Its side effects are untranslated git messages, and filters inherit the C locale. The non-ASCII test paths (`ü テスト`) pass under it. Both QA-1.5-5 tests pass. |
| QA-1.5-6 | **Verified**, but the residual is larger than documented → QA-1.5-13 | (b) `ls-files -v` flags work. Under `core.fsmonitor=true`, `-v` still printed only `H` (S3), so there is no false `index-flags`. A sparse index gives `index-flags` (S17). (a) Dirty files and `core.autocrlf≠false` are covered by the tests. The clean-file gap is QA-1.5-13. |
| QA-1.5-8 | **Verified** | S1: the `core.hooksPath` parent is realpath(tmp), and the path is still absent after materialize. The test passes. |
| QA-1.5-9 | (b)(c)(d) **verified**; (a) **partly** | The tests exist and pass. However, (a) covers only a holder at depth 1, and the claimed bound fails at depth 2 (QA-1.5-11). Its `spawn`-event gate is racy (QA-1.5-14). |
| QA-1.5-10 | **Verified on win32** | Non-recursive `mkdir(dir, 0o700)` before `worktree add` (`:1415`); the scratch dir is made the same way (`:1287-1289`). The test asserts that the dir is empty when git starts. The POSIX mode (`:1433`) is not verifiable on this host. |

Private index copy, further checks (no finding):
- **Split index (S2):** the `link` extension is present. Capture gives staged/unstaged content (`a-dirty`, `b-unstaged`,
  `^2` `b-staged`) and **the same tree as a plain `git stash create`**. The only change in `.git` is the mtime of
  `sharedindex.*` (same bytes). That is git's `freshen_shared_index`: S18 shows that a plain
  `git --no-optional-locks ls-files` freshens it too. No new `sharedindex.*` is written.
- **Index v4 + untracked cache + builtin fsmonitor (S3):** version 4, `UNTR` and `FSMN` present. The reference is
  exact, `.git` is unchanged (the daemon's cookie dir excluded), and the daemon was stopped afterwards.
- **Sparse index (S17, cone, `index.sparse=true`, `sdir` extension):** capture and materialize work, the reference is
  inexact via `index-flags`, and `.git` is unchanged.
- **Copy consistency:** `lstat` runs before `readFile` (`:1291-1292`). A rewrite between the two gives newer bytes with
  an older mtime, which only widens racy re-checks (analysis).
- **Scratch cleanup:** no scratch dir was left after the normal path (S1-S4), the timeout kill and the abort (S6), or
  an error path (**S14**: `.git/index` missing → the scratch dir was created, capture returned `undefined`, the
  scratch dir was removed).
- **Abort (S6):** abort at 400 ms, `stash create` busy for 3.2 s. It was not killed (`hasSignal: false`,
  `killed: false`), and capture resolved `undefined` after 3.6 s. The abort latency is bounded by the remaining capture
  budget (≤ 15 s by default).

### New findings
| ID | Severity | Evidence | Fix |
|---|---|---|---|
| QA-1.5-11 | Medium | **Dispose and GC latency grows 6× per directory level above a held dir.** Node's JS `fs.promises.rm` retries inside every recursive child call, so the `maxRetries: 5` loops nest: T(d) ≈ 6·T(d−1) + 1.5 s. Standalone, with the module's options and a cwd holder: depth 1 → `EBUSY` after **11.1 s**, depth 2 → **66.2 s**. A flat loop (`maxRetries: 0`, 6 attempts, 100·2ⁿ ms) → **3.1 s** at both depths. Module (S16), holder cwd in `packages/a`: `dispose()` **66.3 s**, then GC while held **66.3 s**, against GC's 30 s budget, which nothing checks during `fs.rm`. Extrapolated, not run: depth 3 ≈ 6.5 min, depth 4 ≈ 39 min. QA-1.5-9a's "resolves bounded" holds only for its depth-1 holder: S7, with the test's holder depth, took 10.8 s against the test's 20 s bound. Holders include processes that escape the tree kill (the fix notes say MSYS `sleep.exe` escapes `taskkill /T`). 2.1's planned GC before each materialize would hit this more often. | Call `fs.rm(dir, { recursive: true, force: true, maxRetries: 0 })` inside the module's own flat `withRetry`, and check GC's budget between attempts. Add a test with a ready-gated holder at depth ≥ 2 that asserts dispose resolves within a few seconds. |
| QA-1.5-12 | Medium (pre-existing; not introduced by the fixes) | **A live or crashed reference is an unlocked registered worktree whose junctions lead into the real node_modules.** S8: an owner that exits without dispose (crash, closed terminal) leaves `worktree …/omr-ref-52920-…`, `detached`, with **no `locked` line**, and junctions `node_modules` and `packages\a\node_modules` → `…\repo ü\…\node_modules`. That state lasts until the next GC (which then removed it safely). The entry shows up in `git worktree list` and in IDE worktree views. `git worktree remove --force` on it empties the targets (Spike D method 5; not re-run, banned). Plain `remove` uses the same recursive deleter (analysis). Mitigation measured on a junction-free worktree (S9): `worktree add --lock --reason "omr reference: links into live node_modules"` → both `git worktree remove` and `remove --force` fail with `fatal: cannot remove a locked working tree, lock reason: … use 'remove -f -f' to override or unlock first`. The dir stays intact, and `prune --dry-run` lists nothing. | Add the worktree with `--lock --reason <OMR_LOCK_REASON>`. In step 4, once the dir is gone, unlock only that exact reason (plus `initializing`). GC treats that reason like `initializing` (released dir or dead owner). Update R4 and section 11. Unverified here: the minimum git version for `add --reason`, and whether `--lock` replaces the `initializing` reason from the start (per git's `add_worktree` source); check both, or fall back to `git worktree lock` right after `add`. |
| QA-1.5-13 | Medium (extends QA-1.5-6a) | **The documented clean-file conversion gap fires on the common `* text=auto` on win32, not only on an explicit `eol=crlf`.** S12: `.gitattributes` `* text=auto`, `core.autocrlf=false`, `core.eol` unset (native = CRLF). Live `a.txt` = `"a0\n"` and `git status` is clean. `ls-files --eol` gives live `i/lf w/lf attr/text=auto` and reference `i/lf w/crlf attr/text=auto`. The reference bytes are `"a0\r\n"`, yet `exact: true, inexactReasons: []`. LF working files under `text=auto` are typical on Windows (e.g. Prettier's default `endOfLine: lf`). My answer to the implementer's question: this gap is **not acceptable** as a silent `exact`. | At materialize, compare the `w/` column of `git ls-files --eol -z` between root and dir for paths with a non-empty `attr/`, and add `checkout-conversion` per differing path. If the budget runs out, add path `""`. Note that `git check-attr --stdin` is not available, because ExecOptions (`:590-596`) has no stdin. Update OPEN RISKS so that only `filter` remains there. |
| QA-1.5-14 | Low | **The QA-1.5-9a test gates its holder on the `spawn` event, which fires before the child has opened its cwd** (`test:507`). With the same gate, the round-2 harness once **lost** that race: the holder was in `packages/a`, dispose took 593 ms, removed the dir and gave no warning. Another time it won (~60 s). Gated on a line printed by the child, the holder blocked every time (S7, S16, the depth runs). The test's `exists(handle.dir) === true` can therefore flake. | Have the child print a line once started, and await it before disposing. |

### Resolutions (round 2)
- QA-1.5-11 — Resolution: 7f6ff3e — `fs.rm(dir, { recursive: true, force: true, maxRetries: 0 })` now runs inside the
  module's only retry loop (`withRetry`: 5 retries, 100·2ⁿ ms, about 3.1 s of backoff at any depth). `ReferenceFs.rm`
  types `maxRetries` as the literal `0`. GC passes its budget end into the cleanup context. No retry (rm, unlink,
  readdir) starts after it. Step 4 is skipped once the budget end has passed: a warning is logged, and the next GC
  drops the entry. Dispose has no deadline, because it must finish after an abort; the retry count bounds it.
  Header: section 6 (step 3 and the retry paragraph), section 11, plus a Bun item in OPEN RISKS. New win32 test with
  a READY-gated holder whose cwd is `packages/a` (depth 2). Dispose must resolve in < 10 s, warn and leave the dir.
  A GC with `timeoutMs: 1_500` while the holder still runs must finish in < 3 s with the dir in `failed` (the flat
  loop alone would sleep 3.1 s). After the release, GC removes the dir, and the sentinels are intact. QA-1.5-9a's
  bound went from 20 s to 10 s (depth 1 used to take about 11 s). The whole QA-1.5-11 test (capture, materialize,
  dispose, two GCs) took 8.5 s and 6.2 s. Not run: a mutation with the old options, which should hit the 60 s test
  timeout at depth 2.
- QA-1.5-12 — Resolution: 9a0c3a5 — materialize runs `worktree add --detach --lock --reason "<referenceLockReason(pid)>"`,
  with the reason `omr-verify-reference pid=<pid>: its node_modules links lead into the live repository, do not
  force-remove`. Checked against git's `builtin/worktree.c` (v2.51.0): `add_worktree` writes `opts->keep_locked` (our
  reason) into `locked` from the start, and writes `initializing` only without `--lock`. It unlinks the lock when the
  add fails. `remove` refuses a locked entry unless `force >= 2`. Minimum git is **2.33** (RelNotes 2.33.0: "git
  worktree add --lock learned to record why the worktree is locked with a custom message"). On this host,
  `git worktree add -h` (2.51.0) lists `--lock [--reason <string>]`. Fallback for older git: if the add fails with
  `unknown option` for `reason` or `lock` (under LC_ALL=C), the module checks that the dir is still empty, logs a
  warning and repeats the add without `--lock`, which is the pre-fix behaviour. Dispose step 4 unlocks only
  `referenceLockReason(<pid of the dir name>)` or `initializing`, and only after lstat shows the dir is gone and R3
  passed. In GC, the omr reason follows the section 11 rules of an unlocked entry, except that a missing dir of an
  alive owner is kept (that owner may be between its fs.rm and its unlock). `initializing` is unchanged (dead owner
  or released dir only). Header: section 4 step 3, section 6 step 4, R4, section 11 step 2 and the new D10. Tests:
  (1) The porcelain shows `locked <reason>`. A sandbox guard runs before any user remove: 2 links, each realpath
  inside the test's mkdtemp sandbox, each target listing exactly `sentinel.txt`. Then `git worktree remove` and
  `remove --force` (LC_ALL=C) both exit non-zero with `cannot remove a locked working tree, lock reason: <reason>`.
  The checkout, the links and the sentinels are intact. Dispose leaves no entry and no warning. (2) A user's own
  lock on our entry: dispose removes the dir, keeps the entry and warns. (3) Simulated git < 2.33: one rejected
  call, a warning, an unlocked entry, and a clean dispose. (4) GC removes a dead owner's entry and an alive owner's
  entry with a 2 h old heartbeat. It keeps a fresh alive owner's entry and an entry whose omr reason names another
  pid. (5) The QA-1.5-5 abort test now also waits for the worktree's `index.lock` (mid-checkout), and asserts that
  `locked` then holds our reason, not `initializing`. The QA-1.5-10 test's seam now takes the dir from the
  second-to-last argument. `remove --force` ran against a dir with junctions only in test (1), behind the sandbox
  guard, and git refused it. Every other `remove --force` in the tests ran on a dir that was already gone, or on a
  test-made worktree without junctions.
- QA-1.5-13 — Resolution: 9790b41 — new materialize step 7b: `git ls-files --eol -z` runs at root and at dir. The
  records are parsed at the tab (`i/%-5s w/%-5s attr/%-17s\t<path>`, confirmed on this host). A path that is listed
  on both sides, is not in `ref.tracked`, is not in the step 7 drift set, and has a different `w/` class adds
  `checkout-conversion` for that path (sorted, at most MAX_CONVERSION_REASONS = 100, then one `""`). Why the drift
  set is excluded: a file edited after capture differs by content. The normalizing diff hides exactly the
  conversion case, so any path it does not list is clean. The step is skipped when a `""` conversion reason
  (core.autocrlf) is already recorded. It runs last, with the remaining budget and only the caller's signal. A
  failing call, or one that runs out of budget, adds `""`: the reference becomes approximate instead of failing. A
  caller abort still returns `aborted`. Header: section 2e, section 4 step 7b, and OPEN RISKS, where only a
  `filter`/`ident`/`working-tree-encoding` that keeps the eol class remains. Tests: three committed variants, each
  with `git status` clean and `tracked` empty. `* text=auto` flags `.gitattributes`, `.gitignore`, `a.txt`, `b.txt`,
  `package.json` and `packages/a/index.js` on win32, and the reference's `a.txt` is `"a0\r\n"` (exact on POSIX).
  `*.txt text eol=crlf` flags `a.txt` and `b.txt`. The control `* text=auto eol=lf` is exact, with `a.txt` = `"a0\n"`.
  A failing `ls-files --eol` gives `ok: true` with only `{checkout-conversion, ""}`.
- QA-1.5-14 — Resolution: f693e13 — the test helper `holdCwd` spawns Node with the given cwd and resolves only after
  the child has printed `READY`. It rejects, and cleans up, if the child exits first. QA-1.5-9a and QA-1.5-11 use it.
- Test runs of `npx vitest run --maxWorkers=2 test/unit/reference.test.ts` (win32, Node v24.21.0, git
  2.51.0.windows.1). f693e13: 38/38, 110.88 s. 7f6ff3e: 39/39, 103.84 s. 9a0c3a5: 43/43, 88.83 s; the run before it
  had 1 failure, in the QA-1.5-10 seam's argument index, fixed in the same commit. 9790b41: 45/45 in 119.98 s, then
  two consecutive runs at 153.33 s and 106.42 s. `npm run typecheck` was clean at each commit. Afterwards there were
  no `omr-ref-*`/`omr-nohooks-*` entries in TEMP, no test sandboxes, no holder processes, and no `omr-ref` worktree
  in the list.

### Data-loss review (priority #1)
In no scenario did the module delete or change data outside its own dirs. The destructive steps checked are:
`unlink` behind `lstat` (R1); `fs.rm` only on a swept dir that passed R3 and is a real directory (`:1101-1110`); git
only on a dir that `lstat` shows is gone (`:1114-1117`, S7 `[false]`); `unlock` only for our reason on our entry.
Links recreated in a leftover are swept before any removal (S7). A heartbeat `utimes` in flight after `fs.rm` can only
fail with ENOENT, because `utimes` creates nothing. The remaining deletion path is external: QA-1.5-12.

### Deferred by plan (unchanged)
- QA-1.5-7: the excuse policy for ignored inputs (2.1 wiring).
- QA-1.5-10 (2.1 part): materialize only inside the S3 slot, and run GC before each materialize (which makes
  QA-1.5-11 matter more).
- QA-1.5-4 (2.1 part): "reference vanished → unverifiable" (the backstop for the heartbeat residual above).

## QA re-review (round 3)

Scope: `git diff 09fe057..cb02f64` (f693e13, 7f6ff3e, 9a0c3a5, 9790b41, cb02f64). Line numbers refer to
`src/verify/reference.ts` at cb02f64. `npx vitest run --maxWorkers=2 test/unit/reference.test.ts`: **45/45 passed**,
100.57 s. Host: win32, Node v24.21.0, git 2.51.0.windows.1, Bun 1.3.14; system `core.autocrlf=true`, global `input`;
Windows UI culture pt-BR, with `LANG`, `LC_ALL` and `LANGUAGE` unset. The installed Git for Windows ships no message
catalogs (`mingw64/share/locale` is absent). The repros ran under `%TEMP%\omr-qa15r3`. They imported the real
`reference.ts` (Node through type stripping, Bun natively), with repo and tmp paths that contain spaces and non-ASCII
characters, and `tmpdir` injected in its 8.3 form. The ArgvSeam called `spawn` without a shell, like `runArgv` on
origin/vrb/p12 (`src/verify/exec.ts:112-142`): env merged over `process.env`, `taskkill /T /F` on abort or timeout,
resolved on `close`. The fallback ran against a real **git 2.32.0.windows.2** (MinGit). Every junction target was a
sentinel dir inside the sandbox. `git worktree remove [--force]` ran against a reference with junctions only behind a
guard that realpath'd every link into the sandbox, as the unit test does, and git refused both. Cleanup: 0 reparse
points and 0 extra worktrees in the 17 sandbox repos, sandbox deleted with `fs.rmSync` (`gone true`), and no
`omr-ref-*` or `omr-nohooks-*` dir in TEMP.

### Resolutions: verification
| Finding | Status | Evidence |
|---|---|---|
| QA-1.5-11 | **Verified** | `:995-1007` is the only retry loop; fs.rm runs with `maxRetries: 0` (`:1238`); the GC deadline is set at `:1870` and step 4 is skipped at `:1246-1249`. A READY-gated holder at depth 1/2/3 (Node): `dispose()` took **3 137 / 3 142 / 3 170 ms** (round 2: 11.1 s at depth 1, 66.2 s at depth 2). GC with the default budget while the dir was held took 3 270 / 3 252 / 3 255 ms (6 fs.rm attempts). GC with `timeoutMs: 1_500` took **850 / 862 / 846 ms** (4 attempts; the next 800 ms sleep would cross the deadline). GC after the release removed the dir in about 300 ms. Bun: 3 140 / 3 146 / 3 154 ms, GC 3 275 / 3 268 / 3 922 ms, and 835 / 836 / 1 028 ms with the 1.5 s budget. Sentinels `keep me` in every run. Documented residual (`:493-497`): once step 4 has started, its three git calls (list, unlock, remove) each keep `CLEANUP_GIT_TIMEOUT_MS`. |
| QA-1.5-12 | **Verified** (GC edge → QA-1.5-15) | **S1** (Node and Bun): the add argv is `--detach --lock --reason <reason> <dir> <commit>` with env `{ LC_ALL: "C" }`. `.git/worktrees/<name>/locked` holds the reason plus `\n`. The porcelain line `locked <reason>` is byte-equal to `referenceLockReason(pid)`: git trims the file on read and C-quotes only control characters, `"`, `\` and non-ASCII bytes, none of which the reason contains. `remove`, `remove --force` (with and without LC_ALL) and `move` exit 128 with `cannot remove [move] a locked working tree, lock reason: …`. A second `lock` is refused, and `prune -n -v` prints nothing. The links stay links, and the sentinels read `keep me`. Dispose took 193 ms (Bun 186 ms) with no warnings: `worktree list`, then `unlock`, then `remove --force`. **Crash (S2):** an owner that exits without dispose (a Node process, and a Bun process) leaves the entry `locked <reason>`, and `git worktree list` shows `locked`. A GC from another process removed it in 307 / 377 ms, with the sentinels intact. **Source** (`builtin/worktree.c` v2.51.0): `add_worktree` writes `opts->keep_locked` into `locked` before the checkout, writes `_("initializing")` only without `--lock`, and unlinks `locked` when the add fails. `remove` and `move` refuse unless `force >= 2`. **git 2.32 (S8):** the first add exits 129 with ``error: unknown option `reason'`` and the dir still empty. The module logs one warning, the unlocked add succeeds, and the reference is exact with 2 links. Dispose is clean. An abort mid-checkout in fallback mode (3 s smudge filter) saw the lock `initializing`, returned `aborted`, and left no entry and no dir. **Locale:** not testable here, because there are no catalogs. With pt-BR UI, `LANG=pt_BR.UTF-8` or `LANGUAGE=pt_BR`, git's messages were still English. `LC_ALL=C` is passed on both add calls (recorded by the seam). |
| QA-1.5-13 | **Verified** (gap → QA-1.5-16; cost → QA-1.5-17) | **S6a:** with `*.txt text=auto` and `git status` clean, the path `dir ü/sp ace テスト.txt` is flagged under its exact name, and the reference bytes are `"u\r\n"`. **S6b:** a seam replaced the `ls-files --eol -z` output with crafted records: paths containing a tab, a newline, spaces and non-ASCII characters, a path starting with `w/`, an empty `w/`, an `attr/` with a space (`text eol=crlf`), and a record without a tab. Exactly the four differing paths were flagged, the malformed record was skipped, and equal classes were not flagged. The parser (`:1025-1034`) matches `ls-files.c`'s `i/%-5s w/%-5s attr/%-17s\t` prefix. **S6c:** 150 differing paths give 100 path reasons plus `""`. **S9c:** an abort during step 7b returned `aborted`, and cleanup left nothing. |
| QA-1.5-14 | **Verified** | `holdCwd` resolves only on the child's `READY` line. **S5:** 15/15 READY-gated holders blocked a following `fs.rm` (`EBUSY`), as did every held run in S4 (Node 3/3, Bun 3/3) and B1. The old spawn-event race did not recur in 15 spawn-gated runs (0 lost). It is timing-dependent, and the READY gate removes it by construction. |

### Bun 1.3.14 (plugin runtime) vs Node
| Check | Node v24.21.0 | Bun 1.3.14 |
|---|---|---|
| `fs.symlink(target, link, "junction")` | ok | ok |
| `lstat(junction)`: `isSymbolicLink()` / `isDirectory()` | true / false | true / false |
| `readlink` / `realpath` of a junction; `realpath` of the 8.3 tmp | target as given / long form, no `\\?\` prefix / long form | same |
| `fs.unlink(junction)` | link gone, target `keep me` | same |
| `fs.rm(junction, { recursive, force })` | link gone, target `keep me` | same |
| `fs.rm(dir, { recursive, force })` with a junction at depth 2 | dir gone, target `keep me` | same |
| One `fs.rm` attempt, cwd holder in `dir/packages/a` | `EBUSY`, syscall `rmdir`, on the held dir, 2 ms; the top-level file removed, the held subtree kept | `EBUSY`, syscall `rm`, on the top dir, 2 ms; the held dir's contents removed, the top-level file kept (different order, same code, which is in `TRANSIENT_FS_CODES`) |
| `fs.rmdir(held dir)` | `EBUSY` | `EBUSY` |
| `process.kill(pid, 0)`: own / parent / dead / System (4) / unused | ok / ok / `ESRCH` / `EPERM` / `ESRCH` | same codes (different message text) |
| `AbortSignal.any` + `timeout`, `utimes` on a dir, `setInterval().unref`, `mkdir` EEXIST, `writeFile` `wx` EEXIST, `lstat` ENOENT | as expected | same |
| Module end to end (S1): lock reason through `spawn` argv quoting, links, user remove refused, dispose | see QA-1.5-12 | identical results |
| Held dir at depth 1/2/3 (S4), partial failures (S9) | see above | identical outcomes |
| Heartbeat (B2): `heartbeatMs: 200`, dir backdated 120 min | — | mtime 63 ms old after 700 ms; the process exited with an undisposed handle (whole run 2.98 s); a Node GC then collected the leftover |

The two Bun unknowns under OPEN RISKS are answered on win32: Bun's `fs.rm` does not follow junctions, and it reports
`EBUSY` for a held dir. POSIX was not tested.

### Data-loss review (priority #1)
The paths exercised under both runtimes were: normal dispose; crash, then GC from another process; the fallback refused
on a non-empty dir (S9a); a failure after the links exist (drift diff fails, S9b); an abort in step 7b (S9c); `worktree
unlock` failing in dispose (S9d: dir gone, entry left locked, collected by the same process's next GC); `worktree list`
failing in dispose (S9e: `remove --force` on the locked entry fails harmlessly, then GC collects it); and a holder at
depth 1 to 3 (S4). In every case the sentinels read `keep me` and the user's `.git/index` was byte-identical (S9). After
the last GC, no omr entry and no dir remained. The lock is lifted only after lstat shows the dir is gone (`:1250-1267`).
Git's `add_worktree` registers `atexit(remove_junk)`, which recursively deletes the worktree dir after a failed add.
The dir holds no link at that point, because links are created after the add, so this is no exposure. Inherent residual,
not a finding: git's refusal message ends with `use 'remove -f -f' to override or unlock first`, and `-f -f` would
bypass the lock and empty the junction targets. The reason text itself says `do not force-remove`.

### New findings
| ID | Severity | Evidence | Fix |
|---|---|---|---|
| QA-1.5-15 | Low | **GC never collects a locked omr entry whose dir is missing while the PID in its name is alive (PID reuse).** `:1925`: `collect = released(keys) \|\| !isAlive(pid) \|\| (stats !== undefined && age > 1 h)`. For a missing dir and an alive PID, nothing ever becomes true, and there is no age bound (a dir that exists ages out through its heartbeat). **S3**, with the GC process's own PID standing in for a reused PID: locked omr, alive, dir missing → **kept**, both at `now` and at `now + 30 days`. Controls: unlocked, alive, dir missing → removed; locked omr, dead, dir missing → removed; locked omr, alive, dir present with a 2 h old heartbeat → removed. Ways to get there: an owner killed between its fs.rm and its unlock; a dispose whose step 4 fails (S9d/S9e) by an owner that exits before its own next GC; or a temp cleaner that deletes a crashed leftover. Because of the lock, `git worktree prune` never drops the entry either. It stays as a locked entry in the user's `git worktree list` until that unrelated process exits. There is no data risk, since the dir is gone. | Collect a missing-dir entry with the omr reason whatever the owner's liveness. The race with an alive owner between its fs.rm and its unlock is benign: both sides only unlock or remove an entry whose dir is gone, and the loser logs a warning (S9d/S9e show that path is harmless). Update section 11 step 2. Add a GC test: omr-locked entry, dir missing, `isAlive` true → removed. |
| QA-1.5-16 | Medium | **A clean file that is edited after capture skips every conversion check.** `:1780` excludes the drift set (`changed`) from step 7b, and `ref.tracked` holds only paths that were dirty at capture. The files the producer edits after dispatch, which is the usual recheck situation, are exactly the drift set. **S6d:** `.gitattributes` `a.txt text eol=crlf`, and `a.txt` = `"a0\n"` with `git status` clean at dispatch (`tracked` = {}). The producer edits `a.txt` between capture and materialize. The reference's `a.txt` is `"a0\r\n"` (`ls-files --eol` at dir: `i/lf w/crlf attr/text eol=crlf`), yet the result is **`exact: true, inexactReasons: []`**. A test at the reference that reads `a.txt` sees CRLF where the dispatch tree had LF. A failure that the reference itself causes can then excuse one the producer introduced (§1.5-7). With `* text=auto` on win32, other clean files usually flag the reference anyway. The gap is exact when the attribute matches only producer-edited files. | For a path in `changed` that is not in `ref.tracked`, add `checkout-conversion` when the reference's own `w/` class differs from its `i/` class: the checkout converted it, and the dispatch bytes are unknown. `parseEolList` must keep `i/` as well. Add a test: a clean file under `eol=crlf`, edited between capture and materialize → inexact for that path. |
| QA-1.5-17 | Low | **Step 7b reads the whole tree twice, even when no conversion is configured.** `git ls-files --eol` reads every blob and every working file. **S7**, 20 000 tracked files (~0.9 KB each): each call took **3.7-4.2 s** (plain `ls-files -z`: 69 ms). Step 7b took 7.6-7.8 s of a 20.0-22.7 s materialize, and 15 s of budget remained when it started. This was the same with **no attributes at all**, where no conversion is possible. With 2 000 files plus 200 MB of binaries: 1.9 s per call, so step 7b took 3.9 s of 6.1 s. Bigger or binary-heavy trees exhaust the 30 s budget. The step then adds `""`, so S2 never excuses in such repos. That outcome is safe, but it makes S2 useless there. | Limit the listing to paths that can convert: `git ls-files --eol -z -- ':(attr:text)' ':(attr:text=auto)' ':(attr:eol=crlf)' ':(attr:eol=lf)'` (also `crlf` if the legacy attribute should count). Measured: **95 ms** on the attribute-free 20k repo (0 records) against 4 228 ms, and the same 20 001 records on the `* text=auto` repo. Attr pathspec magic needs git >= 2.13. |

Open non-deferred findings: QA-1.5-15 (Low), QA-1.5-16 (Medium), QA-1.5-17 (Low). Phase 1.5 QA is **not** clean.

#### QA-1.5-15
Resolution: ebf49d8 — GC collects a missing-dir entry that carries our exact lock reason whatever the pid's liveness; removal lifts only our reason, then a targeted `git worktree remove --force` on the missing dir (no prune). Test: omr-locked, dir missing, `isAlive` true, clock +30 days → removed.

#### QA-1.5-16
Resolution: 5d7df0c — `parseEolList` keeps `i/`; a path in the drift set and not in `ref.tracked` adds `checkout-conversion` when the reference's `w/` differs from its `i/`. Test reproduces S6d (`a.txt text eol=crlf`, clean at capture, edited before materialize → inexact for `a.txt`).

#### QA-1.5-17
Resolution: 8e71e32 — step 7b lists `ls-files --eol -z -- ':(attr:text)' ':(attr:text=auto)' ':(attr:eol=crlf)' ':(attr:eol=lf)'`; attribute-free conversion comes only from core.autocrlf, which already adds the `""` reason and skips 7b. Existing eol tests (QA-1.5-6a, QA-1.5-13) stay green. Header updated in 5ced990.

### Checked with no finding
- `runArgv` (origin/vrb/p12 `src/verify/exec.ts:112-142`) spawns argv without a shell and merges env over
  `process.env`. The seam used here does the same, so the reason reaches git as a single argv element under Node and
  under Bun (S1).
- `ADD_LOCK_UNSUPPORTED` (`:834`) matches real git 2.32 stderr. git 2.51 prints unknown options in the same form. A
  false match would need `unknown option … reason/lock` in stderr from another cause. Even then, the dir-empty check
  aborts instead of retrying (S9a).
- `withRetry`: at most 5 retries (about 3.1 s of backoff), and the deadline is checked before each sleep.
- Step 7b's 100-path cap and its `""` fallback (S6c, and the unit test with a failing `--eol` call).

### Deferred by plan (unchanged)
- QA-1.5-7: the excuse policy for ignored inputs (2.1 wiring).
- QA-1.5-10 (2.1 part): materialize only inside the S3 slot, and run GC before each materialize.
- QA-1.5-4 (2.1 part): "reference vanished → unverifiable".
- POSIX: the 1.5.3 key safety test on POSIX CI (dir symlinks, `fs.rm`, `git worktree remove`). Not testable on this host.
- Bun smoke (3.1): the win32 answers are above. POSIX Bun and the plugin's real load path remain with 3.1.

## QA re-review (round 4)

Scope: `git diff d6f0c1e..eff85ef` (5d7df0c, ebf49d8, 8e71e32, 5ced990, eff85ef). Line numbers refer to
`src/verify/reference.ts` at eff85ef. `npx vitest run --maxWorkers=2 test/unit/reference.test.ts`: **47/47 passed**,
246.21 s. Host: win32, Node v24.21.0, Bun 1.3.14, git 2.51.0.windows.1; system `core.autocrlf=true`, global `input`.
Every sandbox repo set a repo-local `core.autocrlf=false` and left `core.eol` unset (native CRLF). The repros ran under
`%TEMP%\omr-qa15r4` and imported the real `reference.ts` (Node through type stripping, Bun natively). The control was
`git show 5d7df0c:src/verify/reference.ts`, which has the QA-1.5-16 fix but not QA-1.5-17 or QA-1.5-15. Repo paths
were `r ü …`, and `tmpdir` was `tmp ä dir`, injected in its 8.3 form. The ArgvSeam was the spawn-based seam of round 3
(no shell, env merged over `process.env`, `taskkill /T /F`, resolves on `close`). Before each capture the harness
waited 1.1 s, so no entry was racily clean. Every junction target was a sentinel dir inside the sandbox. Git never ran
on a dir that contained a link, and the harness never called `git worktree remove`. Cleanup: 47 sandbox repos with 0
`omr-ref-*` entries. The 9 junctions that were left were the ones in the users' own worktrees; they were unlinked
first (0 links left). Then the sandbox was deleted (`gone true`). Afterwards TEMP held no `omr-ref-*` or
`omr-nohooks-*` dirs, and no harness process was running.

### Resolutions: verification
| Finding | Status | Evidence |
|---|---|---|
| QA-1.5-15 | **Verified** | `:1952-1956` adds `stats === undefined` only on the omr-reason branch. `lstatOrMissing` (`:985-993`) maps only ENOENT/ENOTDIR to "missing", and every other error propagates. Owner = a separate Node process (and a separate Bun process under Bun) with a live reference whose links lead into the sentinels. **C1:** dir present, real clock → **kept**. An fs seam that throws `EACCES` on the dir's lstat → `reference GC failed {"error":"EACCES: simulated"}`, 0 removed; the dir, the links and the locked entry are intact, and the owner's later dispose is clean. **C2:** a "temp cleaner" (links unlinked first) deletes the live dir, and the owner stays alive → GC **removed 1**, and the entry is gone. The 5d7df0c control **kept** it (`registered+locked`). The owner's later dispose logs only `reference heartbeat failed … ENOENT, utime` (harmless). **C3:** GC between the owner's `fs.rm` and its step 4 → GC removes the entry, and the owner's dispose finishes with **no warnings** (`registeredEntry` → null). **C4:** GC between the owner's `unlock` and its `remove --force` → GC removes the entry. The owner warns `admin entry left registered … is not a working tree` and nothing else happens. So both race orders are benign, as the fix claims. Node and Bun gave identical outcomes. In every run, the sentinels read `keep me`, the user's worktree stayed registered and its junction still read `keep me`, and `.git/index` was byte-identical (C1). |
| QA-1.5-16 | **Verified** (precision cost → QA-1.5-19) | `:1800`. **A1** (Node and Bun): `sub/a.txt text eol=crlf`, clean at capture, edited to `"a1\n"` before materialize → reference `"a0\r\n"`, `exact: false`, `checkout-conversion:sub/a.txt`. **A3** (control, no attribute, same edit) → exact, reference `"a0\n"`. The unit test passes. |
| QA-1.5-17 | **Performance goal met, but it reopens exactness → QA-1.5-18** | The attribute sources that the pathspecs do match are all flagged under both runtimes: **B1** `* text=auto` in a nested `sub/.gitattributes`; **B2** `.git/info/attributes` (read from the common dir by the linked worktree too); **B3** `core.attributesFile`; **B4** a macro `[attr]crlfy text eol=crlf`; **B5** `eol=crlf` without `text`. Controls are exact and correct: **B6b** `crlf=input`, **B7** `binary`, **B8** `-text eol=crlf`. The limit itself is unsound (QA-1.5-18). |
| 5ced990 (header) | **Partly** → QA-1.5-20 | Section 4 step 7b (`:294-308`) and section 11 (`:514-519`) describe the fixes. Section 2e and OPEN RISKS do not. |

### New findings
| ID | Severity | Evidence | Fix |
|---|---|---|---|
| QA-1.5-18 | Medium (regression from 8e71e32) | **The attribute pathspec limit makes step 7b skip clean files whose working bytes differ from what the checkout writes.** The premise "without attributes only core.autocrlf converts" describes the reference's checkout, not the live tree. A clean file's live bytes come from its **last** checkout and the settings at that time, and `git status` stays clean on stat alone. Four clean-file cases give **`exact: true` at eff85ef** under Node and Bun, and each one is flagged by the 5d7df0c control: **B9** checked out under `core.autocrlf=true`, which is the Git for Windows system default at clone time, and refreshed; the user later sets `false`. Live `"a0\r\n"` (`i/lf w/crlf attr/`), reference `"a0\n"`. The file has no attribute, so it is never listed. **B6** legacy `*.txt crlf`: `ls-files --eol` shows `attr/text`, but `:(attr:text)` does not match the `crlf` attribute. Live `"a0\n"`, reference `"a0\r\n"`. **B10** `working-tree-encoding=UTF-16LE-BOM` added after the file was committed. Live UTF-8 `"a0\n"`, reference `FF FE 61 00 30 00 0A 00` (`w/-text`, `attr/` empty). **B11** `GIT_LITERAL_PATHSPECS=1` in the plugin's environment, which the ArgvSeam merges in: git takes `:(attr:…)` literally. `git ls-files --eol -z -- ':(attr:text)' …` then exits **0 with no output**, where `=0` or unset lists `sub/a.txt`. So the check is off silently; the control without the env var is flagged. A reference-side failure that these bytes cause could then excuse the producer's failure (§1.5-7). | Drop the pathspecs and restore the full listing on both sides (the 5d7df0c behaviour). This closes B6, B9, B10 and B11 together. For QA-1.5-17's cost, run the two listings concurrently. The existing `""` fallback already keeps a spent budget safe, as approximate, not wrong. A limit cannot be made sound. B9 has no attribute at all. Git's attr magic (`ATTR`, `-ATTR`, `ATTR=VALUE`, `!ATTR`) has no form for "any value", so it cannot select `working-tree-encoding`. Adding `crlf` plus `env: { GIT_LITERAL_PATHSPECS: "0" }` would fix only B6 and B11. Tests: B9 (checkout with `-c core.autocrlf=true`, `update-index --refresh`, then `false`), B6, and B11 (env on the seam). |
| QA-1.5-19 | Low | **The QA-1.5-16 rule also flags edited files whose dispatch bytes already matched the checkout, so on win32 a `* text=auto` repo is never exact once the producer edits a text file.** **A2** (Node, Bun, and the 5d7df0c control): `* text=auto`, files CRLF on disk and clean (`w/crlf`). The capture sees `sub/a.txt` = `"a0\r\n"`, and the producer then edits it to `"a1\r\n"`. The reference's `sub/a.txt` is `"a0\r\n"`, identical to the dispatch bytes, yet the result is `exact: false` with `checkout-conversion:sub/a.txt`. No other path is flagged. The failure is in the safe direction (`unverifiable`, never a wrong excuse), but S2 cannot excuse anything in such repos on the primary host. | Record the `w/` class at capture: one `ls-files --eol -z` at root; after QA-1.5-18 it is the same listing. For a path in `changed` and not in `ref.tracked`, compare the reference's `w/` with the capture-time `w/`, and flag only when they differ or the path has no capture-time class. If the capture budget cannot afford the listing, keep the current rule and document the false-inexact case in section 2e. |
| QA-1.5-20 | Low (docs) | **The header drifts from the code.** Section 2e (`:84-98`) still describes the clean-file check as covering "every tracked path that is neither in `tracked` nor changed". It mentions neither the attribute limit nor the QA-1.5-16 rule for changed paths. OPEN RISKS (`:629-636`) says "`text`/`eol` attributes are covered" and keeps only a filter/ident/working-tree-encoding "keeping the eol class" as residual. At eff85ef, B6, B9 and B10 contradict both. `parseEolList`'s JSDoc (`:1025-1029`) now sits directly above the `EOL_ATTR_PATHSPECS` JSDoc (`:1030`), so the function has no doc comment and the constant has two. | Update section 2e and OPEN RISKS together with QA-1.5-18 (and QA-1.5-19 if the rule changes), and move the JSDoc back onto `parseEolList`. |

### Data-loss review (priority #1)
QA-1.5-15 changes only the verdict for a registered omr-locked entry whose dir `lstat` reports as missing. A present
dir still follows the unchanged rules (C1: kept), and an lstat error fails GC closed (C1: EACCES). Git still runs only
after the lstats at `:1243` and `:1263` show the dir gone. That guard is the same as on the dead-owner path, so the
change adds no new way to reach `git worktree remove` on an existing dir. Across C1-C4 under Node and Bun, the
sentinels, the user's worktree with its junction, and the user's `.git/index` (C1, and every eol case: `indexSame
true`) were untouched. Every reference dir was gone, and no omr entry remained. The eol cases created no links and
left one worktree per repo.

Residual, analysis only (not testable on this host): a GC in another mount namespace sees a live reference as missing.
Examples are a dev container, or a second WSL distro, that shares the repository and uses the same tmp path (`/tmp`)
but has its own `/tmp`. Such a GC now always drops the entry; before this fix it did so only when the pid was not alive
in its own namespace. Git acts in the GC's namespace, where the path does not exist, so it deletes no data. The owner's
reference loses its admin entry, and the "reference vanished → unverifiable" rule (deferred to 2.1) covers that.

### Checked with no finding
- The pathspecs work for attributes from nested `.gitattributes`, `info/attributes` (also in the linked worktree),
  `core.attributesFile` and macros (B1-B4). `binary`, `-text` and `crlf=input` produce no false flags (B6b-B8).
- `GIT_LITERAL_PATHSPECS` affects no other call in the module: only step 7b passes pathspec magic.
- Bun 1.3.14 matched Node in every B, A and C case (identical flags, bytes and GC reports). Only the dispose timings
  differed, and they include the harness's own pauses.

Open non-deferred findings: QA-1.5-18 (Medium), QA-1.5-19 (Low), QA-1.5-20 (Low). Phase 1.5 QA is **not** clean.

### Deferred by plan (unchanged)
- QA-1.5-7: the excuse policy for ignored inputs (2.1 wiring).
- QA-1.5-10 (2.1 part): materialize only inside the S3 slot, and run GC before each materialize.
- QA-1.5-4 (2.1 part): "reference vanished → unverifiable". It is also the backstop for the namespace residual above.
- POSIX: the 1.5.3 key safety test on POSIX CI. Bun smoke on POSIX and on the plugin's real load path (3.1).
