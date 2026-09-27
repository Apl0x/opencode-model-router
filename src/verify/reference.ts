// src/verify/reference.ts
//
// ============================================================================
// DISPATCH REFERENCE AND EPHEMERAL REFERENCE WORKTREE (S2 infrastructure)
// Design note: task 1.5.1 of docs/plans/verification-resource-budget-plan.md.
// Implementation: task 1.5.2 (the bodies below are contract stubs until then).
// Evidence: docs/qa/verification-resource-budget/phase-1.5.md (Spikes D, E,
// gather) and the 1.5.1 measurements quoted inline ("measured in 1.5.1":
// git 2.51.0.windows.1, win32, Node v24.21.0).
// ============================================================================
//
// PURPOSE
//   At dispatch, record a cheap, git-only description of the tree the producer
//   started from. No tests run at this point. Later, and only when scoped tests
//   fail, materialize that tree in a throw-away worktree under os.tmpdir() so
//   that the failing test files can be re-run there (S2).
//   The overriding property: nothing here may delete, overwrite or change real
//   data. That covers the user's working tree, the index content, the stash
//   list, refs, other worktrees, and the real node_modules directories we link
//   to.
//   This module never imports node:child_process. Every git run goes through
//   the injected ArgvSeam (task 1.2.2 contract), which provides the timeout,
//   the abort signal and the process-tree kill. Until runArgv (1.2) is merged,
//   the 1.5.3 tests inject a local execFile-based helper defined inside the
//   test file only.
//
// ----------------------------------------------------------------------------
// 1. WHAT THE REFERENCE CONTAINS  (DispatchReference)
// ----------------------------------------------------------------------------
//   root        path.resolve(`git rev-parse --show-toplevel`) run from the
//               dispatch cwd.
//   head        `git rev-parse --verify HEAD^{commit}` at capture.
//   commit      Output of `git stash create` when it is non-empty. That is a
//               commit whose tree holds the working-tree state of every TRACKED
//               file, staged and unstaged; untracked files are excluded
//               (Spike E). When the output is empty (tracked tree clean, per
//               Spike E), commit = head.
//   untracked   Map<relPath, sha256 hex> over every untracked, NOT ignored file,
//               from `git ls-files --others --exclude-standard --full-name -z`
//               run at root. relPath uses git's form: forward slashes,
//               root-relative. The value is the sha256 of the file bytes. An
//               untracked symbolic link gets the value UNTRACKED_SYMLINK and is
//               never reproduced. This module computes the per-file hashes
//               itself: snapshotTree (tree.ts) keeps only one aggregate hash
//               over all untracked files (spike gather notes).
//   capturedAt  now() when the capture resolved.
//   Ignored content (node_modules, dist, .env, ...) is NOT part of the
//   reference. At materialize, node_modules directories are linked from the
//   live tree (section 5). Any other ignored entry is simply absent from the
//   reference worktree and is listed in `unreproduced`.
//
// ----------------------------------------------------------------------------
// 2. EXACT VS APPROXIMATE  (§1.5-7, extended by D3)
// ----------------------------------------------------------------------------
//   A materialized reference is EXACT only when all of the following hold:
//   (a) Every dispatch-time untracked file still exists in the live tree as a
//       regular file with the recorded sha256, and was written into the
//       worktree. A modified, deleted or unreadable file makes the reference
//       approximate (§1.5-7).
//   (b) No untracked symbolic link was recorded (links are never reproduced).
//   (c) No dependency drift: no DEPENDENCY_FILES entry, in any directory,
//       differs between `commit` and the live tree. node_modules is linked
//       from the LIVE tree, so it matches the reference only if the manifests
//       and lockfiles do.
//   (d) No workspace-link drift. A linked node_modules may hold a package link
//       that resolves into the live repository outside any node_modules
//       segment (npm/pnpm/yarn workspaces, e.g. node_modules/@s/a ->
//       packages/a). If that target directory contains a path that differs
//       between `commit` and the live tree, an import through the link would
//       load CURRENT code at the reference, so exact is false. Detection: for
//       each linked node_modules, readdir its top level plus one level under
//       each `@scope` directory, lstat each entry, and realpath every link.
//   Each violation adds one InexactReason; exact === (inexactReasons.length ===
//   0). An approximate reference never excuses a failure: the recheck (2.x)
//   turns a reference-side failure of an approximate reference into
//   `unverifiable` (§1.5-7).
//   "Differs between commit and the live tree" means the union of:
//     - `git diff --name-only -z --no-renames --no-ext-diff <commit> --`
//       (tracked paths; --no-renames lists both sides of a rename);
//     - untracked paths now present (`git ls-files --others --exclude-standard
//       -z`) that are missing from `untracked` or whose hash differs.
//   Exactness makes no claim about ignored content. `unreproduced` lists the
//   ignored entries that exist in the live tree but are absent from the
//   worktree (e.g. `.env`, `dist/`), so that the recheck can classify setup
//   failures (§1.5-8). An untracked file created after dispatch is not part of
//   the reference: it is never copied and does not affect exactness.
//
// ----------------------------------------------------------------------------
// 3. CAPTURE  captureReference(cwd, signal, deps) -> DispatchReference | undefined
// ----------------------------------------------------------------------------
//   Budget: deps.timeoutMs (default DEFAULT_CAPTURE_TIMEOUT_MS, which equals the
//   baselineTimeoutMs default of 15000). Each git call gets
//   timeoutMs = min(remaining budget) and the caller's signal. File reads use
//   AbortSignal.any([signal, AbortSignal.timeout(remaining)]).
//   1. `git rev-parse --show-toplevel` (cwd: the dispatch cwd) -> root. A
//      non-zero exit (outside a repository, or a bare repository) returns
//      undefined.
//   2. `git ls-files --stage` (cwd: root). Any line starting "160000 " (a
//      gitlink, i.e. a submodule) returns undefined. This is the same refusal
//      snapshotTree makes (tree.ts).
//   3. `git rev-parse --verify HEAD^{commit}` -> head. Failure (e.g. an unborn
//      branch) returns undefined.
//   4. `git stash create` -> trimmed stdout. Empty means commit = head. A 40-
//      or 64-character hex SHA becomes commit. Anything else, or a non-zero
//      exit (e.g. an unmerged index, or index.lock held), returns undefined.
//   5. `git ls-files --others --exclude-standard --full-name -z` (cwd: root).
//      For each path, in sorted order: apply the RELPATH rules (section 10),
//      then lstat. A regular file is read (with the signal) and hashed with
//      sha256; a symlink gets UNTRACKED_SYMLINK; anything else returns
//      undefined (as snapshotTree does). Exceeding MAX_UNTRACKED_FILES files or
//      MAX_UNTRACKED_BYTES bytes returns undefined. This guards against temp-
//      dir exhaustion; the usual cause is a missing node_modules ignore rule.
//   6. If the signal is aborted or the budget is spent at any point, return
//      undefined. Every error returns undefined. The function never throws.
//   Effects on the repository. Acceptance requires working tree, index,
//   stash list and refs to be unchanged; tests assert this with git status,
//   git stash list and git for-each-ref before and after:
//   - No ref is created (no pinning; see section 8 and D1).
//   - `git stash create` writes unreferenced loose objects: the stash commit,
//     its index commit, trees and blobs. `git gc` may later prune them.
//   - `git stash create` REWRITES .git/index when tracked files are stat-dirty.
//     Measured in 1.5.1: after touching a.txt and editing packages/a/index.js,
//     "index bytes changed=True ; index mtime changed=True". The index CONTENT
//     is unchanged (Spike E: `ls-files -s` identical). This is the same
//     stat-cache refresh that `git status` does, and snapshotTree already runs
//     `git status`. It holds .git/index.lock briefly, so a producer git command
//     racing it can report "index.lock exists". See D2.
//   - An abort mid-capture leaves nothing but such unreferenced objects, the
//     same as an interrupted `git stash create`.
//   Consistency: the capture is not atomic. Tracked state is taken at step 4
//   and untracked state at step 5. Under §1.5-14 the caller (2.x) discards a
//   capture that resolves after an edit was observed in an overlapping
//   directory.
//
// ----------------------------------------------------------------------------
// 4. MATERIALIZE  materialize(ref, currentTree, signal, deps) -> MaterializeResult
// ----------------------------------------------------------------------------
//   Never throws. If anything fails after step 3 creates the worktree, the
//   dispose pipeline (section 6) runs before { ok: false } is returned, so an
//   abort leaves no partial state. Budget: deps.timeoutMs (default
//   DEFAULT_MATERIALIZE_TIMEOUT_MS) and the caller's signal.
//   0. currentTree is optional. If given, currentTree.cwd must lie inside
//      ref.root; otherwise return ok:false "error" (wrong repository). It is
//      never used to decide exactness, because TreeSnapshot has no per-file
//      hashes (gather notes). Every file is re-read instead.
//   1. `git cat-file -e <commit>^{commit}` (cwd: root). If the commit is
//      missing, return ok:false "commit-missing": the unreferenced stash commit
//      was pruned (section 8).
//   2. tmp = realpath(deps.tmpdir ?? os.tmpdir()), long form. Measured in
//      1.5.1: git stores and lists worktree paths in long form with forward
//      slashes ("C:/Users/Marquinho/AppData/..."), even when TEMP is an 8.3
//      short path. dir = tmp/<refDirName(pid, 16 random hex)>. Call
//      assertSafeRefDir(dir) before anything is created. Add dir to the
//      process-local ACTIVE set, which gcStaleReferences skips.
//   3. `git -c core.hooksPath=<dir>/.omr-no-hooks -c advice.detachedHead=false
//      worktree add --detach <dir> <commit>` (cwd: root). The hooks path does
//      not exist, so post-checkout hooks (repository code) never run.
//      Clean/smudge filters such as LFS still run, within the budget. Failure
//      returns ok:false "worktree-add-failed". Once the worktree exists, its
//      HEAD pins the commit against gc (Spike E). On POSIX, chmod(dir, 0o700)
//      before the first copy (section 9).
//   4. Copy untracked files, for each [rel, hash] in ref.untracked, in sorted
//      order:
//      - rel fails the RELPATH rules -> inexact "untracked-unsafe-path".
//        hash === UNTRACKED_SYMLINK -> inexact "untracked-symlink".
//      - lstat(root/rel): ENOENT -> "untracked-deleted"; not a regular file ->
//        "untracked-not-file"; read error -> "untracked-unreadable".
//      - bytes = readFile(root/rel). sha256(bytes) !== hash ->
//        "untracked-modified".
//      - dest = dir/rel. mkdir -p the parent, then check that realpath(parent)
//        is strictly inside dir (isStrictlyInside). Write with
//        writeFile(dest, bytes, { mode: stat.mode & 0o777, flag: "wx" }).
//        The same buffer that was hashed is the one written, so the check and
//        the copy cannot disagree. "wx" never overwrites and never writes
//        through an existing link.
//   5. Discovery: `git ls-files --others --ignored --exclude-standard
//      --directory -z` (cwd: root). Measured in 1.5.1 with node_modules/,
//      .env and legacy/ ignored, the output was [.env] [legacy/]
//      [node_modules/] [packages/a/node_modules/]. The ignored parent legacy/
//      is collapsed, so its nested node_modules is not listed, and that parent
//      is absent from the worktree anyway. Entries whose last segment is
//      `node_modules` are link candidates (section 5). All other entries go to
//      `unreproduced`. Nothing ignored is ever copied.
//   6. Link each candidate (section 5), parents before children. Git's sorted
//      output already puts them in that order.
//   7. Drift checks (c) and (d) of section 2 (two git calls, cwd: root). Like
//      `git status`, porcelain `git diff` may refresh the index stat cache
//      (unverified); content is never changed.
//   8. Return { ok: true, reference: { dir, exact, inexactReasons,
//      unreproduced, links, toRefPath, dispose } }. toRefPath(p) maps an
//      absolute live path under root to the same relative path under dir, or
//      returns undefined when p is outside root. The recheck uses it for the
//      runner cwd and the failing test files.
//   Repository effects of materialize, dispose and GC: they write only the
//   admin entry .git/worktrees/<name> and the dir itself. The main index
//   content, the refs and the stash list are never touched.
//
// ----------------------------------------------------------------------------
// 5. LINK STRATEGY  (every ignored node_modules: the root and each workspace package)
// ----------------------------------------------------------------------------
//   For each candidate relPath R from discovery (step 5):
//   - src = root/R. lstat(src) must be a directory or a link. target =
//     realpath(src), and lstat(target) must be a real directory. Otherwise
//     skip R.
//   - linkPath = dir/R. Its parent must already exist in the worktree as a real
//     directory (lstat, not a link). Links never get a mkdir: a package that
//     does not exist at the reference gets no node_modules. linkPath itself
//     must not exist (lstat returns ENOENT), so a tracked node_modules is left
//     alone.
//   - Push linkPath onto `links` BEFORE creating the link. dispose lstat-checks
//     every entry, so a recorded link that was never created is harmless.
//   - win32: fs.symlink(target, linkPath, "junction"). Junctions need an
//     absolute target and no privilege, and can cross local volumes (e.g. a
//     D:\ repo and a C:\ temp dir). POSIX: fs.symlink(target, linkPath,
//     "dir"). Spike D: lstat().isSymbolicLink() is true for junctions made
//     either way, which is the basis of every removal check.
//   - Links point at LIVE, shared state. Tests at the reference that write into
//     node_modules (vite/jest caches, .cache) write into the real directory.
//     That is cache data, not source; the runner adapter may redirect caches.
//   Only node_modules is linked. Python virtualenvs are NOT linked: an editable
//   install points at the live tree's sources and would make the reference
//   silently run current code (see OPEN RISKS).
//
// ----------------------------------------------------------------------------
// 6. DISPOSE  handle.dispose() -> Promise<void>
// ----------------------------------------------------------------------------
//   Idempotent: the promise is memoised, so every call returns the first
//   call's promise. It never rejects: every failure goes to logger.warn and
//   the leftover is left for GC. Contract: call it only after the recheck's
//   process tree has exited. It does not use the caller's signal, because
//   cleanup must still run after an abort.
//   Order: Spike D method 8 (the proven-safe order), plus a sweep (D6):
//   1. Recorded links, in reverse order. Check isStrictlyInside(link, dir),
//      then lstat. ENOENT: skip. isSymbolicLink(): fs.unlink, retrying
//      transient errors. A real file or directory at that path is worktree
//      content: leave it for the later steps.
//   2. Link sweep. Walk dir with lstat, never descending into a link (the
//      worktree's `.git` is a file), and fs.unlink every link found. Tests can
//      create links, and `git worktree remove --force` follows junctions and
//      DELETES TARGET CONTENTS (Spike D, BANNED list). If a link survives step
//      1 or 2, or the walk exceeds MAX_SWEEP_ENTRIES, STOP: nothing more is
//      removed. Warn "reference worktree left in place: <reason>"; GC retries
//      later.
//   3. Run assertSafeRefDir(dir) and confirm lstat(dir) is a real directory.
//      Then `git worktree remove --force <dir>` (cwd: root, timeout
//      CLEANUP_GIT_TIMEOUT_MS). The tree is link-free at this point.
//   4. If dir still exists (e.g. EBUSY), run assertSafeRefDir(dir) again, then
//      fs.rm(dir, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES,
//      retryDelay: CLEANUP_RETRY_BASE_MS }). This is Spike D SAFE #5, allowed
//      only on a link-free tree.
//   5. If the admin entry is still registered (dir now gone), run
//      `git worktree remove --force <dir>` again. Measured in 1.5.1: on an
//      already-deleted dir it exited 0 and removed only that entry;
//      `git worktree prune -v` afterwards found nothing. `git worktree prune`
//      is never run (D5).
//   6. Remove dir from ACTIVE.
//   Transient errors (TRANSIENT_FS_CODES: EBUSY, EPERM, EACCES, ENOTEMPTY,
//   caused by Windows AV scans or open handles) are retried up to
//   CLEANUP_RETRIES times with CLEANUP_RETRY_BASE_MS * 2^n backoff, then
//   logged, and the leftover is left for GC. They are never treated as
//   success. If dir was deleted externally, every step tolerates ENOENT.
//
// ----------------------------------------------------------------------------
// 7. REMOVAL RULES  (normative; QA checks every destructive call against them)
// ----------------------------------------------------------------------------
//   R1 Every removal is preceded by an lstat check. A link is only ever removed
//      with fs.unlink, which is single-entry and never recursive.
//   R2 A recursive removal (`git worktree remove --force` or fs.rm with
//      recursive) is allowed only on a path that (i) passed assertSafeRefDir
//      immediately before, (ii) lstat shows is a real directory, not a link,
//      and (iii) the sweep proved link-free.
//   R3 assertSafeRefDir(dir, tmpRoots) accepts dir only if it is absolute,
//      has no "." or ".." segment, its basename matches REF_DIR_PATTERN
//      (omr-ref-<pid>-<16 hex>), and its parent IS one of the tmp roots:
//      resolve(tmpdir) or realpath(tmpdir), compared case-insensitively on
//      win32. It must be a direct child: never the tmp root itself, never
//      deeper, and never under a tmp root that is a filesystem root.
//   R4 Banned in this module: `git worktree remove` while links are inside,
//      `git worktree prune`, `git clean`, any `git stash` other than `create`,
//      `git reset/checkout/update-ref/gc`, fs.rm on a path that fails R2, any
//      shell, and importing child_process.
//
// ----------------------------------------------------------------------------
// 8. THE UNREFERENCED STASH COMMIT  (GC risk; D1)
// ----------------------------------------------------------------------------
//   Spike E suggested pinning the commit with a ref, but that would violate the
//   capture acceptance criterion "refs unchanged", so no ref is created.
//   Protection comes from `git gc` itself: it prunes unreachable loose objects
//   only once they are older than gc.pruneExpire (default 2 weeks), far beyond
//   pendingTtlMs (1 h). Residual risk: a manual `git gc --prune=now`, or
//   gc.pruneExpire=now combined with auto-gc, between capture and recheck
//   (Spike E: --prune=now deleted it). Materialize step 1 detects this and
//   returns ok:false "commit-missing", and the recheck reports unverifiable.
//   Once the worktree exists, its HEAD pins the commit (Spike E: "cat-file:
//   commit" after gc --prune=now).
//
// ----------------------------------------------------------------------------
// 9. SECRETS POLICY  (untracked .env and similar)
// ----------------------------------------------------------------------------
//   - Ignored files are never copied or linked; only node_modules directories
//     are linked. An ignored .env is absent from the reference, is listed by
//     path in `unreproduced`, and its contents are never read.
//   - An untracked, NOT ignored file (e.g. a .env that is not ignored) is part
//     of the dispatch state. It is copied only if it existed at dispatch and is
//     byte-identical now; otherwise exact=false. Nothing that appeared after
//     dispatch is copied.
//   - On POSIX, dir is chmod 0o700 before the first copy. On win32 the per-user
//     %TEMP% ACL applies (os.tmpdir()).
//   - Lifetime: disposed right after the recheck. Crash leftovers are removed
//     by GC once the owner is dead or after 1 h.
//   - Logs carry counts and reasons, never file contents. Paths appear only in
//     the inexactReasons and unreproduced lists returned to the caller.
//
// ----------------------------------------------------------------------------
// 10. RELPATH RULES  (applied to every git-reported path before any join)
// ----------------------------------------------------------------------------
//   Non-empty, not absolute; splitting on "/" gives no "", "." or ".." segment
//   and no ".git" segment (case-insensitive); on win32, no ":" (alternate data
//   streams) and no "\". A violation makes capture return undefined; at
//   materialize it makes the reference inexact (and the path is never used).
//
// ----------------------------------------------------------------------------
// 11. CRASH GC  gcStaleReferences(root, deps) -> GcReport
//     (called at plugin start, wired in 2.1)
// ----------------------------------------------------------------------------
//   Never throws. Budget: deps.timeoutMs (default DEFAULT_MATERIALIZE_TIMEOUT_MS).
//   1. `git worktree list --porcelain` (cwd: root). No -z flag, to support git
//      < 2.36; a path containing a newline can never pass R3. Parse the
//      `worktree <path>`, `locked` and `prunable` lines. Measured in 1.5.1: a
//      deleted worktree dir is listed with "prunable gitdir file points to
//      non-existent location".
//   2. An entry is a candidate only if its basename matches REF_DIR_PATTERN
//      and its parent is a tmp root (R3). Everything else is never touched:
//      the main worktree and every user worktree. `locked` entries are kept.
//   3. A candidate is stale if any of these holds:
//      - its owner PID (taken from the name) is dead: deps.isAlive, default
//        process.kill(pid, 0), where EPERM counts as alive;
//      - it is older than STALE_REFERENCE_AGE_MS (1 h). Age = now() -
//        lstat(dir).mtimeMs, which can only understate the age and so only
//        delays GC. This covers PID reuse;
//      - the name carries this process's PID but dir is not in ACTIVE (a
//        previous process with a reused PID);
//      - its dir is missing (prunable).
//   4. Each stale candidate goes through the section 6 pipeline with no
//      recorded links. The sweep finds and unlinks every node_modules link,
//      step 5 removes a missing-dir entry, and `git worktree prune` is never
//      run.
//   5. Orphans are tmp-root entries matching REF_DIR_PATTERN that are not
//      registered in root's list. An orphan is removed (sweep, then R2 fs.rm)
//      only if it is stale AND it either has no `.git` file or its `gitdir:`
//      line resolves inside root's .git directory. Orphans of other
//      repositories are left alone. This limits temp-dir exhaustion (D7).
//   6. The report lists removed, kept and failed dirs; failures are also
//      logged.
//
// ----------------------------------------------------------------------------
// DEVIATIONS FROM PLAN  (evidence-driven; each makes behaviour stricter or safer)
// ----------------------------------------------------------------------------
//   D1 No pinning ref for the stash commit (Spike E recommended one). The plan's
//      capture acceptance criterion forbids ref changes. See section 8.
//   D2 "Never modify the index": `git stash create` rewrites the index stat
//      cache (measured in 1.5.1); index content is unchanged (Spike E). It is
//      kept because the plan's S2 row (§1.3) names `git stash create`. The
//      effect is the same class as the `git status` that snapshotTree already
//      runs, and the acceptance commands (status, stash list, for-each-ref)
//      are unaffected.
//   D3 exact=false has more causes than §1.5-7: untracked symlinks, dependency
//      drift and workspace-link drift (section 2, b to d). These only make the
//      check stricter, and approximate still never excuses.
//   D4 materialize returns { ok: true, reference } | { ok: false, reason,
//      detail } instead of the plan's { dir, exact, dispose() }, so a verdict
//      can say why the reference is unavailable. The handle adds
//      inexactReasons, unreproduced, links and toRefPath. currentTree is
//      optional and only serves as a same-repository guard.
//   D5 `git worktree prune` is never run (plan 1.5.2.c/d, Spike D step 3). The
//      git docs say that unless a worktree is locked, prune removes its admin
//      files when its directory is missing: "If a worktree is on a portable
//      device or network share which is not always mounted, lock it to
//      prevent its administrative files from being pruned". So prune would
//      touch non-omr worktrees. Replacement: `git worktree remove --force
//      <dir>` on an already-deleted dir. Measured in 1.5.1, it exited 0 and
//      removed only that entry.
//   D6 dispose adds a full link sweep before `git worktree remove --force`.
//      Spike D proved the order for the links we create; tests may create
//      others.
//   D7 capture refuses (returns undefined) above MAX_UNTRACKED_FILES /
//      MAX_UNTRACKED_BYTES, and GC also removes this repository's stale
//      orphan omr-ref dirs. Both address temp-dir exhaustion; the plan does
//      not specify either.
//   D8 The ExecOptions/ArgvSeam seam types are declared locally and not
//      exported, because vrb/p12's types.ts is not on this branch. After the
//      merge, 2.x replaces the two local declarations with `import type {
//      ExecOptions, ArgvSeam } from "./types"`. The names and structure are
//      identical, so no call site changes. They are not exported, to avoid a
//      second exported ArgvSeam; tests can type the seam as CaptureDeps["argv"].
//   D9 Hooks are disabled for `git worktree add` (core.hooksPath points at a
//      path that does not exist).
//
// ----------------------------------------------------------------------------
// OPEN RISKS  (not solvable in this module; owners named)
// ----------------------------------------------------------------------------
//   - Python (2.x recheck): nothing is linked. `uv run pytest` at the reference
//     may build a fresh venv, costing time and network, bounded by
//     recheckTimeoutMs. An editable install in the active environment imports
//     the LIVE tree's sources. Pytest reference runs must count as approximate
//     unless the runner resolves sources from the worktree.
//   - node_modules content generated from repository files (e.g. a Prisma
//     client) reflects the live tree; check (c) only catches manifest and
//     lockfile drift.
//   - An ignored file that tests need (.env, generated code) is absent at the
//     reference. The recheck must classify the resulting failure as a setup
//     failure (§1.5-8). `unreproduced` supports that decision but cannot make
//     it.
//   - POSIX directory-symlink behaviour of `git worktree remove` is unverified
//     (Spike D ran on win32 only). The unlink-first order and the sweep apply
//     on every platform. The 1.5.3 key safety test must run on POSIX CI.
//   - On Node versions other than v24.21.0, fs.rm's non-following of junctions
//     is not proven (Spike D). R2 makes this irrelevant, since fs.rm only ever
//     runs on link-free trees.
// ============================================================================

import * as fsp from "node:fs/promises";
import { posix as pathPosix, win32 as pathWin32 } from "node:path";
import type { ExecResult } from "./types";
import type { TreeSnapshot } from "./dispatch";
import type { PluginLogger } from "../router/logger";

// --- Seams --------------------------------------------------------------------

/** Local mirror of vrb/p12 types.ts ExecOptions (D8). Replace with the import after merge. */
interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  lowPriority?: boolean;
  env?: Record<string, string>;
}

/** Local mirror of vrb/p12 types.ts ArgvSeam (D8). Replace with the import after merge. */
interface ArgvSeam {
  (file: string, args: readonly string[], opts?: ExecOptions): Promise<ExecResult>;
}

/** The subset of fs.Stats this module reads. */
export interface ReferenceStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly size: number;
  readonly mode: number;
  readonly mtimeMs: number;
}

/**
 * Narrow fs seam. Every method is non-following or single-entry except `rm`,
 * which R2 restricts to link-free, assertSafeRefDir-approved directories.
 * `node:fs/promises` satisfies it structurally (see nodeReferenceFs).
 */
export interface ReferenceFs {
  lstat(path: string): Promise<ReferenceStats>;
  realpath(path: string): Promise<string>;
  readFile(path: string, options: { signal?: AbortSignal }): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array, options: { mode: number; flag: "wx" }): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  chmod(path: string, mode: number): Promise<void>;
  readdir(path: string): Promise<string[]>;
  symlink(target: string, path: string, type: "junction" | "dir"): Promise<void>;
  unlink(path: string): Promise<void>;
  rm(
    path: string,
    options: { recursive: true; force: true; maxRetries: number; retryDelay: number },
  ): Promise<void>;
}

/** Production fs seam; also a compile-time proof that node:fs/promises fits ReferenceFs. */
export const nodeReferenceFs: ReferenceFs = fsp;

export interface CaptureDeps {
  argv: ArgvSeam;
  fs: ReferenceFs;
  /** Whole-operation budget in ms. capture: DEFAULT_CAPTURE_TIMEOUT_MS; materialize/GC: DEFAULT_MATERIALIZE_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface ReferenceDeps extends CaptureDeps {
  logger?: Pick<PluginLogger, "warn">;
  /** Default os.tmpdir(). The reference dir is created directly under realpath(tmpdir). */
  tmpdir?: string;
  /** Default process.pid; encoded in the dir name for crash GC. */
  pid?: number;
  /** Default Date.now. */
  now?: () => number;
  /** Default: process.kill(pid, 0) succeeds or fails with EPERM. */
  isAlive?: (pid: number) => boolean;
  /** Default process.platform. Selects junction vs dir symlink and path comparison rules. */
  platform?: NodeJS.Platform;
  /** Default randomBytes(8).toString("hex"); must match the 16-hex suffix of REF_DIR_PATTERN. */
  randomSuffix?: () => string;
}

// --- Data types ---------------------------------------------------------------

export interface DispatchReference {
  /** path.resolve(`git rev-parse --show-toplevel`) of the dispatch cwd. */
  readonly root: string;
  /** HEAD at capture time. */
  readonly head: string;
  /** `git stash create` commit, or `head` when tracked files were clean. */
  readonly commit: string;
  /** Untracked, not ignored files at dispatch: git relPath (forward slashes) -> sha256 hex, or UNTRACKED_SYMLINK. */
  readonly untracked: ReadonlyMap<string, string>;
  /** now() when the capture resolved. */
  readonly capturedAt: number;
}

export type InexactCause =
  | "untracked-deleted"
  | "untracked-modified"
  | "untracked-not-file"
  | "untracked-unreadable"
  | "untracked-symlink"
  | "untracked-unsafe-path"
  | "dependency-drift"
  | "workspace-link-drift";

export interface InexactReason {
  readonly cause: InexactCause;
  /** Root-relative git path (forward slashes) the cause refers to. */
  readonly path: string;
}

export interface MaterializedReference {
  /** Absolute worktree dir: <realpath(tmpdir)>/omr-ref-<pid>-<16 hex>. */
  readonly dir: string;
  /** True only if inexactReasons is empty (section 2). Approximate never excuses (§1.5-7). */
  readonly exact: boolean;
  readonly inexactReasons: readonly InexactReason[];
  /** Ignored live-tree entries (git relPath, dirs end in "/") absent from dir; node_modules excluded. */
  readonly unreproduced: readonly string[];
  /** Absolute paths of the node_modules links created inside dir. */
  readonly links: readonly string[];
  /** Maps an absolute live path under ref.root to the same relative path under dir; undefined outside root. */
  toRefPath(livePath: string): string | undefined;
  /** Section 6. Idempotent, never rejects; call only after the recheck process tree has exited. */
  dispose(): Promise<void>;
}

export type MaterializeFailure =
  | "aborted"
  | "commit-missing"
  | "worktree-add-failed"
  | "unsafe-path"
  | "error";

export type MaterializeResult =
  | { readonly ok: true; readonly reference: MaterializedReference }
  | { readonly ok: false; readonly reason: MaterializeFailure; readonly detail: string };

export interface GcReport {
  readonly removed: readonly string[];
  readonly kept: readonly string[];
  readonly failed: readonly string[];
}

// --- Constants ----------------------------------------------------------------

export const REF_DIR_PREFIX = "omr-ref-";
/** omr-ref-<owner pid>-<16 lowercase hex>. Anything else is never removed. */
export const REF_DIR_PATTERN = /^omr-ref-(\d{1,10})-([0-9a-f]{16})$/;
export const STALE_REFERENCE_AGE_MS = 60 * 60 * 1000;
/** Equals the baselineTimeoutMs default (§1.4); callers pass the configured value. */
export const DEFAULT_CAPTURE_TIMEOUT_MS = 15_000;
export const DEFAULT_MATERIALIZE_TIMEOUT_MS = 30_000;
export const CLEANUP_GIT_TIMEOUT_MS = 15_000;
export const CLEANUP_RETRIES = 5;
export const CLEANUP_RETRY_BASE_MS = 100;
export const TRANSIENT_FS_CODES: ReadonlySet<string> = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);
export const MAX_UNTRACKED_FILES = 5_000;
export const MAX_UNTRACKED_BYTES = 64 * 1024 * 1024;
export const MAX_SWEEP_ENTRIES = 500_000;
/** Marker value for an untracked symbolic link (not a sha256, so it never matches a file hash). */
export const UNTRACKED_SYMLINK = "symlink";
/** Basenames whose drift between commit and the live tree makes a linked node_modules stale (section 2c). */
export const DEPENDENCY_FILES: ReadonlySet<string> = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".pnpmfile.cjs",
  "yarn.lock",
  ".yarnrc.yml",
  "bun.lock",
  "bun.lockb",
  ".npmrc",
]);

// --- Path guards (normative, R3; implemented now so 1.5.2 cannot weaken them) --

export class UnsafeReferencePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeReferencePathError";
  }
}

function pathFor(platform: NodeJS.Platform) {
  return platform === "win32" ? pathWin32 : pathPosix;
}

function comparable(path: string, platform: NodeJS.Platform): string {
  const resolved = pathFor(platform).resolve(path);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function refDirName(pid: number, suffix: string): string {
  const name = `${REF_DIR_PREFIX}${pid}-${suffix}`;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !REF_DIR_PATTERN.test(name)) {
    throw new UnsafeReferencePathError(`invalid reference dir name: ${name}`);
  }
  return name;
}

export function parseRefDirName(name: string): { pid: number; suffix: string } | undefined {
  const match = REF_DIR_PATTERN.exec(name);
  if (!match) return undefined;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return { pid, suffix: match[2] };
}

/** True when child is strictly below parent (never equal). Both must be absolute. */
export function isStrictlyInside(
  child: string,
  parent: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const p = pathFor(platform);
  if (!p.isAbsolute(child) || !p.isAbsolute(parent)) return false;
  const rel = p.relative(comparable(parent, platform), comparable(child, platform));
  if (rel === "" || p.isAbsolute(rel)) return false;
  return rel.split(p.sep)[0] !== "..";
}

/**
 * R3 hard guard, called immediately before every destructive operation on a
 * reference dir (`git worktree remove --force`, recursive fs.rm). Pure: callers
 * additionally lstat the dir and require a real directory (R2).
 */
export function assertSafeRefDir(
  dir: string,
  tmpRoots: readonly string[],
  platform: NodeJS.Platform = process.platform,
): void {
  const p = pathFor(platform);
  const fail = (why: string): never => {
    throw new UnsafeReferencePathError(`refusing reference dir ${JSON.stringify(dir)}: ${why}`);
  };
  if (typeof dir !== "string" || dir.length === 0 || !p.isAbsolute(dir)) fail("not absolute");
  if (dir.split(/[\\/]+/).some((segment) => segment === "." || segment === "..")) fail("dot segment");
  const resolved = p.resolve(dir);
  if (!parseRefDirName(p.basename(resolved))) fail("name does not match omr-ref-<pid>-<16 hex>");
  const parent = comparable(p.dirname(resolved), platform);
  const underTmpRoot = tmpRoots.some((root) => {
    if (!p.isAbsolute(root)) return false;
    const candidate = comparable(root, platform);
    if (p.parse(candidate).root === candidate) return false; // a filesystem root is never a tmp root
    return candidate === parent;
  });
  if (!underTmpRoot) fail("parent is not a temp root");
}

// --- Operations (contract stubs; implemented in 1.5.2) ------------------------

/** Section 3. Never throws; undefined = no reference (not a repo, submodules, abort, timeout, caps, error). */
export async function captureReference(
  cwd: string,
  signal: AbortSignal,
  deps: CaptureDeps,
): Promise<DispatchReference | undefined> {
  throw new Error("not implemented: captureReference (task 1.5.2.a)");
}

/** Section 4. Never throws; on failure nothing is left behind (the dispose pipeline has run). */
export async function materialize(
  ref: DispatchReference,
  currentTree: TreeSnapshot | undefined,
  signal: AbortSignal,
  deps: ReferenceDeps,
): Promise<MaterializeResult> {
  throw new Error("not implemented: materialize (task 1.5.2.b/c)");
}

/** Section 11. Never throws; touches only stale omr-ref-* dirs directly under a tmp root. */
export async function gcStaleReferences(root: string, deps: ReferenceDeps): Promise<GcReport> {
  throw new Error("not implemented: gcStaleReferences (task 1.5.2.d)");
}
