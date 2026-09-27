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

### QA-1.5-7 — Medium — `exact` ignores ignored inputs present at dispatch (`.env`, generated files) — deferred by plan (2.1)
- `:1147-1148` and `:82-86`: ignored entries only go to `unreproduced`, and `exact` stays true. The test asserts
  exactly this (`test:228-232`: `exact === true` with `.env` in `unreproduced`). A test that reads settings from an
  ignored `.env` fails at the reference with an assertion error, not a collection/setup error, so §1.5-8 does not
  catch it and the failure is excused.
- Fix: state in the header that `exact` is necessary but not sufficient for an excuse. The policy is 2.1's: a
  reference-side failure must not excuse while `unreproduced` holds anything outside a small inert allowlist
  (`coverage/`, logs, OS files). Env files and generated sources must never be on it.

### QA-1.5-8 — Low — D9 hook suppression is bypassable by committed content
- `:1081`: `core.hooksPath=<dir>/.omr-no-hooks` points **inside the worktree**, so the checkout can create it.
- Repro: control first. A plain `git worktree add` ran `.git/hooks/post-checkout`; materialize correctly did not.
  But a committed `.omr-no-hooks/post-checkout` **ran during materialize**
  (`committed /c/Users/…/omr-ref-31548-1d4722dad301e0d9`). Impact is limited, since the recheck runs repository
  code anyway. Still, the header claim (`:155-157`, D9) is false, and the hook runs outside the recheck's controls
  (slot, priority, budget).
- Fix: point `core.hooksPath` at a path that is outside the worktree and never created (for example
  `<tmp root>/<ref dir name>.nohooks`). Add a test with a committed `.omr-no-hooks/post-checkout`.

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

### QA-1.5-10 — Low — temp-dir exhaustion and POSIX exposure window — partly deferred by plan (2.1)
- `MAX_UNTRACKED_*` (`:580-581`) bound only the untracked copy. Every materialize checks out the full tracked tree.
  Nothing in 1.5 caps concurrent references, and GC runs only at plugin start. A dir left by failed disposes (see
  QA-1.5-5 and QA-1.5-9) waits for the next start.
- Deferred to 2.1: materialize only inside the S3 slot, and call GC before each materialize.
- In 1.5: `chmod(dir, 0o700)` runs after the checkout (`:1087`). In a shared `/tmp`, the tracked and dirty content
  sits in a umask-default (typically 0755) dir until then. Fix: `mkdir(dir, 0o700)` first, then
  `git worktree add` into the empty dir (git accepts an existing empty dir). An injected or relocated win32 TEMP
  (for example `C:\Temp`) inherits broader ACLs than `%LOCALAPPDATA%\Temp`: document it.

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
