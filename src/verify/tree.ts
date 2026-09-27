// Impure, bounded Git fingerprint adapter. Never interpolates paths into a shell.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { ABSENT_DIGEST, FILE_DIGEST_PREFIX, LINK_DIGEST_PREFIX, type TreeSnapshot, type ChangedFile } from "./dispatch";

/**
 * QA-2.1-2: above this many paths to digest, a snapshot's per-file digests are "unavailable".
 * QA-2.1-14: the change set then widens to every dispatch-listed path (delta), so this bounds the
 * gate's reads, not attribution.
 */
export const MAX_DIGEST_FILES = 500;
/** QA-2.1-2: above this many bytes of regular files to digest, per-file digests are "unavailable". */
export const MAX_DIGEST_BYTES = 64 * 1024 * 1024;

export interface SnapshotOptions {
  /**
   * The absolute paths to digest. Default: the snapshot's own listed (dirty or untracked) paths,
   * as at dispatch. A gate passes the dispatch snapshot's paths.
   */
  digestPaths?: readonly string[];
  /** Default MAX_DIGEST_FILES. */
  maxDigestFiles?: number;
  /** Default MAX_DIGEST_BYTES. */
  maxDigestBytes?: number;
}

function errorCode(err: unknown): unknown {
  return err && typeof err === "object" && "code" in err ? (err as { code: unknown }).code : undefined;
}

/**
 * QA-2.1-2: one content identity per path, bounded by count and bytes (sizes are summed from lstat
 * before anything is read). Reads only files, spawns nothing, and honours `signal`. Anything it
 * cannot prove (a directory, an unreadable path, the bounds) makes the whole map "unavailable".
 */
async function digestPaths(
  paths: readonly string[],
  signal: AbortSignal,
  maxFiles: number,
  maxBytes: number,
): Promise<ReadonlyMap<string, string> | "unavailable"> {
  if (paths.length > maxFiles) return "unavailable";
  try {
    const kinds: [string, "absent" | "link" | "file"][] = [];
    let bytes = 0;
    for (const path of paths) {
      let stat;
      try {
        stat = await lstat(path);
      } catch (err) {
        const code = errorCode(err);
        if (code !== "ENOENT" && code !== "ENOTDIR") return "unavailable";
        kinds.push([path, "absent"]);
        continue;
      }
      if (stat.isSymbolicLink()) {
        kinds.push([path, "link"]);
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > maxBytes) return "unavailable";
        kinds.push([path, "file"]);
      } else {
        return "unavailable"; // A directory (nested repository) has no content identity here.
      }
    }
    const digests = new Map<string, string>();
    for (const [path, kind] of kinds) {
      if (signal.aborted) return "unavailable";
      if (kind === "absent") digests.set(path, ABSENT_DIGEST);
      else if (kind === "link") digests.set(path, LINK_DIGEST_PREFIX + await readlink(path));
      else digests.set(path, FILE_DIGEST_PREFIX + createHash("sha256").update(await readFile(path, { signal })).digest("hex"));
    }
    return digests;
  } catch {
    // Deleted or replaced between lstat and read, unreadable, or aborted: no per-file proof.
    return "unavailable";
  }
}

export async function snapshotTree(cwd: string, signal: AbortSignal, options: SnapshotOptions = {}): Promise<TreeSnapshot | undefined> {
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
      const file: ChangedFile = { path: resolve(root, record.slice(3)), status: record.slice(0, 2) };
      // -z emits a rename/copy as `XY dest\0source\0`; keep the source.
      if (/[RC]/.test(file.status)) {
        const source = records[++i];
        if (source) file.previousPath = resolve(root, source);
      }
      files.push(file);
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
    const digests = await digestPaths(
      options.digestPaths ?? files.map(f => f.path),
      signal,
      options.maxDigestFiles ?? MAX_DIGEST_FILES,
      options.maxDigestBytes ?? MAX_DIGEST_BYTES,
    );
    if (signal.aborted) return undefined;
    return { cwd: await realpath(cwd), root: await realpath(root), head, fingerprint: hash.digest("hex"), dirty: files.length > 0, files, digests };
  } catch {
    // Not a Git checkout, unreadable file, timeout or concurrent deletion: no baseline.
    return undefined;
  }
}
