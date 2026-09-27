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
