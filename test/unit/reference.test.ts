import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureReference,
  gcStaleReferences,
  materialize,
  nodeReferenceFs,
  type CaptureDeps,
  type DispatchReference,
  type MaterializedReference,
  type ReferenceDeps,
} from "../../src/verify/reference";

const isWin = process.platform === "win32";
const linkType = isWin ? "junction" : "dir";

type SeamOptions = Parameters<CaptureDeps["argv"]>[2];

/** Kill a process and all its descendants (what runArgv (1.2) does on abort or timeout). */
function treeKill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (isWin) {
      execFile("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true }, () => resolve());
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      // ESRCH: the group already exited, nothing left to kill.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    resolve();
  });
}

// Test-only ArgvSeam, production-like: env merged over process.env, and a tree kill on
// abort or timeout; resolves only after the process has exited (reference.ts never
// imports child_process).
const argv: CaptureDeps["argv"] = (file, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(file, [...args], {
      cwd: opts?.cwd,
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
      windowsHide: true,
      detached: !isWin,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => void (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => void (stderr += chunk));
    const kill = () => {
      if (killed || child.pid === undefined || child.exitCode !== null) return;
      killed = true;
      void treeKill(child.pid);
    };
    const timer = opts?.timeoutMs ? setTimeout(kill, opts.timeoutMs) : undefined;
    opts?.signal?.addEventListener("abort", kill, { once: true });
    if (opts?.signal?.aborted) kill();
    const done = (code: number) => {
      clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", kill);
      resolve({ code, stdout, stderr, timedOut: killed });
    };
    child.on("error", (error) => {
      stderr += String(error);
      done(-1);
    });
    child.on("close", (code) => done(code ?? 1));
  });

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await argv("git", args, { cwd, timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

let base: string;
let repo: string;
let tmp: string;
let warnings: string[];

async function exists(path: string): Promise<boolean> {
  try {
    await fsp.lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function repoState(cwd: string) {
  return {
    status: await git(cwd, "status", "--porcelain"),
    stash: await git(cwd, "stash", "list"),
    refs: await git(cwd, "for-each-ref"),
    index: await git(cwd, "ls-files", "-s"),
  };
}

async function worktreeCount(cwd: string): Promise<number> {
  return (await git(cwd, "worktree", "list", "--porcelain")).split(/\r?\n/).filter((l) => l.startsWith("worktree ")).length;
}

async function refDirsIn(dir: string): Promise<string[]> {
  return (await fsp.readdir(dir)).filter((name) => name.startsWith("omr-ref-"));
}

function deps(over: Partial<ReferenceDeps> = {}): ReferenceDeps {
  return { argv, fs: nodeReferenceFs, tmpdir: tmp, logger: { warn: (m) => void warnings.push(m) }, ...over };
}

function captureDeps(over: Partial<CaptureDeps> = {}): CaptureDeps {
  return { argv, fs: nodeReferenceFs, tmpdir: tmp, ...over };
}

async function capture(signal = new AbortController().signal): Promise<DispatchReference> {
  const ref = await captureReference(repo, signal, captureDeps());
  if (!ref) throw new Error("capture returned undefined");
  return ref;
}

async function mat(ref: DispatchReference, over: Partial<ReferenceDeps> = {}): Promise<MaterializedReference> {
  const result = await materialize(ref, undefined, new AbortController().signal, deps(over));
  if (!result.ok) throw new Error(`materialize failed: ${result.reason} ${result.detail}`);
  return result.reference;
}

beforeEach(async () => {
  warnings = [];
  base = await fsp.mkdtemp(join(await fsp.realpath(tmpdir()), "omr refs ü テスト "));
  repo = join(base, "repo ü dir");
  tmp = join(base, "tmp ä dir");
  await fsp.mkdir(repo);
  await fsp.mkdir(tmp);
  await git(repo, "init", "-q");
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) {
    await git(repo, "config", k, v);
  }
  await fsp.mkdir(join(repo, "packages", "a"), { recursive: true });
  await fsp.writeFile(join(repo, "a.txt"), "a0\n");
  await fsp.writeFile(join(repo, "b.txt"), "b0\n");
  await fsp.writeFile(join(repo, "package.json"), '{"name":"root"}\n');
  await fsp.writeFile(join(repo, "packages", "a", "index.js"), "module.exports = 0;\n");
  await fsp.writeFile(join(repo, ".gitignore"), "node_modules/\n.env\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "init");
  for (const nm of [join(repo, "node_modules"), join(repo, "packages", "a", "node_modules")]) {
    await fsp.mkdir(nm);
    await fsp.writeFile(join(nm, "sentinel.txt"), "keep me");
  }
});

afterEach(async () => {
  try {
    expect(await worktreeCount(repo)).toBe(1);
    expect(await refDirsIn(tmp)).toEqual([]);
  } finally {
    await fsp.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

describe("captureReference", { timeout: 60_000 }, () => {
  it("clean tree -> commit is HEAD", async () => {
    const ref = await capture();
    const head = (await git(repo, "rev-parse", "HEAD")).trim();
    expect(ref.head).toBe(head);
    expect(ref.commit).toBe(head);
    expect(ref.untracked.size).toBe(0);
    expect(ref.root.toLowerCase()).toBe(repo.toLowerCase());
  });

  it("dirty tracked -> stash commit holds the dirty content; repo state unchanged", async () => {
    await fsp.writeFile(join(repo, "a.txt"), "a-dirty\n");
    const before = await repoState(repo);
    const ref = await capture();
    expect(await repoState(repo)).toEqual(before);
    expect(ref.commit).not.toBe(ref.head);
    expect(await git(repo, "show", `${ref.commit}:a.txt`)).toBe("a-dirty\n");
  });

  it("staged + unstaged mixed; stash list, refs and index content unchanged", async () => {
    await fsp.writeFile(join(repo, "a.txt"), "a-staged\n");
    await git(repo, "add", "a.txt");
    await fsp.writeFile(join(repo, "b.txt"), "b-unstaged\n");
    const before = await repoState(repo);
    const ref = await capture();
    expect(await repoState(repo)).toEqual(before);
    expect(await git(repo, "show", `${ref.commit}:a.txt`)).toBe("a-staged\n");
    expect(await git(repo, "show", `${ref.commit}:b.txt`)).toBe("b-unstaged\n");
    expect(before.stash).toBe("");
  });

  it("records untracked files by sha256, excludes ignored ones", async () => {
    await fsp.writeFile(join(repo, "u.txt"), "u");
    await fsp.writeFile(join(repo, ".env"), "SECRET=1");
    const ref = await capture();
    expect([...ref.untracked.keys()]).toEqual(["u.txt"]);
    expect(ref.untracked.get("u.txt")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("submodules -> undefined", async () => {
    const head = (await git(repo, "rev-parse", "HEAD")).trim();
    await git(repo, "update-index", "--add", "--cacheinfo", `160000,${head},sub`);
    expect(await captureReference(repo, new AbortController().signal, captureDeps())).toBeUndefined();
  });

  it("outside a git repo -> undefined", async () => {
    const outside = join(base, "not a repo");
    await fsp.mkdir(outside);
    expect(await captureReference(outside, new AbortController().signal, captureDeps())).toBeUndefined();
  });

  it("abort mid-capture -> undefined, no partial state", async () => {
    await fsp.writeFile(join(repo, "a.txt"), "a-dirty\n");
    const before = await repoState(repo);
    const controller = new AbortController();
    const aborting: CaptureDeps["argv"] = async (file, args, opts) => {
      const result = await argv(file, args, opts);
      if (args.includes("stash")) controller.abort();
      return result;
    };
    expect(await captureReference(repo, controller.signal, captureDeps({ argv: aborting }))).toBeUndefined();
    expect(await captureReference(repo, AbortSignal.abort(), captureDeps())).toBeUndefined();
    expect(await repoState(repo)).toEqual(before);
  });

  it("QA-1.5-1: a tree kill of `git stash create` while it holds the index lock leaves the user's index untouched", async () => {
    // A slow clean filter keeps stash create inside its stat refresh, which holds the
    // index lock, so the kill below lands while the lock is held.
    await fsp.writeFile(join(repo, ".gitattributes"), "slow.txt filter=slow\n");
    await fsp.writeFile(join(repo, "slow.txt"), "slow\n");
    await git(repo, "add", ".gitattributes", "slow.txt");
    await git(repo, "commit", "-q", "-m", "slow");
    // Short: on win32 the MSYS `sleep` escapes `taskkill /T` (its parent is a fork stub)
    // and holds git's stderr pipe until it exits, so the seam resolves only after it.
    await git(repo, "config", "filter.slow.clean", "sleep 3; cat");
    const past = new Date(Date.now() - 60_000);
    await fsp.utimes(join(repo, "slow.txt"), past, past); // stat-dirty, same size: the refresh re-cleans it
    const userIndex = join(repo, ".git", "index");
    const indexBefore = await fsp.readFile(userIndex);
    const controller = new AbortController();
    let stashOpts: SeamOptions;
    let lockSeen = false;
    const killing: CaptureDeps["argv"] = async (file, args, opts) => {
      if (!args.includes("stash")) return argv(file, args, opts);
      stashOpts = opts;
      const kill = new AbortController();
      const running = argv(file, args, { ...opts, signal: kill.signal });
      const lock = `${opts?.env?.GIT_INDEX_FILE ?? userIndex}.lock`;
      lockSeen = await waitFor(() => exists(lock), 15_000);
      controller.abort(); // the caller gives up...
      kill.abort(); // ...and git is tree-killed while it holds the lock, as a timeout would do
      return running;
    };
    const started = Date.now();
    expect(await captureReference(repo, controller.signal, captureDeps({ argv: killing }))).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(lockSeen).toBe(true);
    expect(stashOpts?.signal).toBeUndefined();
    const privateIndex = stashOpts?.env?.GIT_INDEX_FILE ?? "";
    expect(privateIndex.toLowerCase().startsWith(tmp.toLowerCase())).toBe(true);
    expect(await exists(`${userIndex}.lock`)).toBe(false);
    expect(Buffer.compare(await fsp.readFile(userIndex), indexBefore)).toBe(0);
    expect((await fsp.readdir(join(repo, ".git"))).filter((name) => name.startsWith("index.stash."))).toEqual([]);
    // The producer's next index write still works.
    await git(repo, "config", "--unset", "filter.slow.clean");
    await git(repo, "add", "slow.txt");
  });

  it("private index keeps racy-git detection: stat-identical same-size edits are captured and seen as drift", async () => {
    const userIndex = join(repo, ".git", "index");
    // Make an edit only a content check can see: same size, same mtime as the index entry,
    // and the index file no newer than that mtime (racily clean). Git re-reads such an
    // entry only while the index file is not newer; a fresh copy of the index would be.
    const statIdenticalEdit = async (rel: string, content: string) => {
      const file = join(repo, rel);
      const { mtime } = await fsp.stat(file);
      await fsp.writeFile(file, content);
      await fsp.utimes(file, mtime, mtime);
      await fsp.utimes(userIndex, mtime, mtime);
      await new Promise((resolve) => setTimeout(resolve, 1100)); // any copy made now is in a later second
    };
    await statIdenticalEdit("a.txt", "a1\n");
    const ref = await capture();
    expect(ref.commit).not.toBe(ref.head);
    expect(await git(repo, "show", `${ref.commit}:a.txt`)).toBe("a1\n");
    await statIdenticalEdit("package.json", '{"name":"toor"}\n');
    const handle = await mat(ref);
    try {
      expect(handle.inexactReasons).toContainEqual({ cause: "dependency-drift", path: "package.json" });
    } finally {
      await handle.dispose();
    }
  });

  it("QA-1.5-2: every git call carries --no-optional-locks; capture and materialize never write the user's index", async () => {
    await fsp.writeFile(join(repo, "a.txt"), "a-dirty\n");
    const past = new Date(Date.now() - 60_000);
    await fsp.utimes(join(repo, "b.txt"), past, past); // stat-only change: a refresh would rewrite the index
    const userIndex = join(repo, ".git", "index");
    const indexBefore = await fsp.readFile(userIndex);
    const calls: string[][] = [];
    const recording: CaptureDeps["argv"] = (file, args, opts) => {
      calls.push([...args]);
      return argv(file, args, opts);
    };
    const ref = await captureReference(repo, new AbortController().signal, captureDeps({ argv: recording }));
    expect(ref).toBeDefined();
    if (!ref) return;
    expect(await git(repo, "show", `${ref.commit}:a.txt`)).toBe("a-dirty\n");
    const handle = await mat(ref, { argv: recording });
    await handle.dispose();
    expect(calls.length).toBeGreaterThan(5);
    for (const args of calls) expect(args[0]).toBe("--no-optional-locks");
    expect(Buffer.compare(await fsp.readFile(userIndex), indexBefore)).toBe(0);
  });
});

describe("materialize / dispose", { timeout: 60_000 }, () => {
  it("untracked: unchanged copied exactly; modified/deleted -> inexact; new after dispatch not copied", async () => {
    await fsp.writeFile(join(repo, "keep.txt"), "keep");
    await fsp.writeFile(join(repo, "mod.txt"), "mod0");
    await fsp.writeFile(join(repo, "del.txt"), "del");
    const ref = await capture();
    await fsp.writeFile(join(repo, "mod.txt"), "mod1");
    await fsp.rm(join(repo, "del.txt"));
    await fsp.writeFile(join(repo, "new.txt"), "new");
    const handle = await mat(ref);
    try {
      expect(await fsp.readFile(join(handle.dir, "keep.txt"), "utf8")).toBe("keep");
      expect(await exists(join(handle.dir, "mod.txt"))).toBe(false);
      expect(await exists(join(handle.dir, "new.txt"))).toBe(false);
      expect(handle.exact).toBe(false);
      expect(handle.inexactReasons).toEqual(
        expect.arrayContaining([
          { cause: "untracked-modified", path: "mod.txt" },
          { cause: "untracked-deleted", path: "del.txt" },
        ]),
      );
      expect(handle.inexactReasons.some((r) => r.path === "new.txt")).toBe(false);
    } finally {
      await handle.dispose();
    }
  });

  it("new untracked after dispatch does not affect exactness; dirty tracked content is checked out", async () => {
    await fsp.writeFile(join(repo, "a.txt"), "a-dirty\n");
    await fsp.writeFile(join(repo, ".env"), "SECRET=1");
    const ref = await capture();
    await fsp.writeFile(join(repo, "later.txt"), "later");
    const handle = await mat(ref);
    try {
      expect(handle.exact).toBe(true);
      expect(await exists(join(handle.dir, "later.txt"))).toBe(false);
      expect(await fsp.readFile(join(handle.dir, "a.txt"), "utf8")).toBe("a-dirty\n");
      expect(handle.unreproduced).toContain(".env");
      expect(await exists(join(handle.dir, ".env"))).toBe(false);
      expect(handle.dir.startsWith(tmp)).toBe(true);
      expect(handle.toRefPath(join(repo, "packages", "a"))).toBe(join(handle.dir, "packages", "a"));
      expect(handle.toRefPath(join(base, "elsewhere"))).toBeUndefined();
    } finally {
      await handle.dispose();
    }
  });

  it("KEY SAFETY: node_modules linked; dispose leaves the real node_modules and sentinels intact", async () => {
    const ref = await capture();
    const handle = await mat(ref);
    expect(handle.links.map((l) => l.slice(handle.dir.length + 1).replaceAll("\\", "/")).sort()).toEqual([
      "node_modules",
      "packages/a/node_modules",
    ]);
    for (const link of handle.links) {
      expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await fsp.readFile(join(link, "sentinel.txt"), "utf8")).toBe("keep me");
    }
    await handle.dispose();
    expect(await exists(handle.dir)).toBe(false);
    for (const nm of [join(repo, "node_modules"), join(repo, "packages", "a", "node_modules")]) {
      expect((await fsp.lstat(nm)).isDirectory()).toBe(true);
      expect(await fsp.readFile(join(nm, "sentinel.txt"), "utf8")).toBe("keep me");
    }
  });

  it("dispose with extra links created inside the worktree leaves their targets intact", async () => {
    const outside = join(base, "outside target");
    await fsp.mkdir(outside);
    await fsp.writeFile(join(outside, "sentinel.txt"), "outside");
    const handle = await mat(await capture());
    await fsp.symlink(outside, join(handle.dir, "extra-link"), linkType);
    await fsp.symlink(join(repo, "node_modules"), join(handle.dir, "packages", "a", "deep-link"), linkType);
    await handle.dispose();
    expect(await exists(handle.dir)).toBe(false);
    expect(await fsp.readFile(join(outside, "sentinel.txt"), "utf8")).toBe("outside");
    expect(await fsp.readFile(join(repo, "node_modules", "sentinel.txt"), "utf8")).toBe("keep me");
    expect(await fsp.readFile(join(repo, "packages", "a", "node_modules", "sentinel.txt"), "utf8")).toBe("keep me");
  });

  it("QA-1.5-3: a link created after the sweep never costs its target; git runs only once the dir is gone", async () => {
    const victim = join(base, "victim");
    await fsp.mkdir(join(victim, "pkg"), { recursive: true });
    await fsp.writeFile(join(victim, "pkg", "sentinel.txt"), "real data");
    let refDir = "";
    let dirAtGitRemove: boolean | undefined;
    const lateLinkFs: ReferenceDeps["fs"] = {
      ...nodeReferenceFs,
      rm: async (path, options) => {
        // The race: a junction appears between the sweep and the recursive removal.
        if (await exists(join(path, ".git"))) await fsp.symlink(victim, join(path, "packages", "late-link"), linkType);
        return nodeReferenceFs.rm(path, options);
      },
    };
    const watching: CaptureDeps["argv"] = async (file, args, opts) => {
      if (refDir && args.includes("worktree") && args.includes("remove")) {
        dirAtGitRemove = await exists(refDir);
        if (dirAtGitRemove) await fsp.symlink(victim, join(refDir, "late-link-2"), linkType);
      }
      return argv(file, args, opts);
    };
    const handle = await mat(await capture(), { fs: lateLinkFs, argv: watching });
    refDir = handle.dir;
    await handle.dispose();
    expect(await exists(handle.dir)).toBe(false);
    expect(dirAtGitRemove).toBe(false);
    expect(await fsp.readFile(join(victim, "pkg", "sentinel.txt"), "utf8")).toBe("real data");
    expect(await fsp.readFile(join(repo, "node_modules", "sentinel.txt"), "utf8")).toBe("keep me");
    expect(await fsp.readFile(join(repo, "packages", "a", "node_modules", "sentinel.txt"), "utf8")).toBe("keep me");
  });

  it("QA-1.5-10: the dir exists, empty and private (0o700 on POSIX), before git checks out into it", async () => {
    let seen: { isDir: boolean; entries: string[]; mode: number } | undefined;
    const checking: CaptureDeps["argv"] = async (file, args, opts) => {
      if (args.includes("worktree") && args.includes("add")) {
        const target = args[args.indexOf("--detach") + 1];
        const stats = await fsp.lstat(target);
        seen = { isDir: stats.isDirectory(), entries: await fsp.readdir(target), mode: stats.mode & 0o777 };
      }
      return argv(file, args, opts);
    };
    const handle = await mat(await capture(), { argv: checking });
    try {
      expect(seen).toMatchObject({ isDir: true, entries: [] });
      if (!isWin) {
        expect(seen?.mode).toBe(0o700);
        expect((await fsp.lstat(handle.dir)).mode & 0o777).toBe(0o700);
      }
      expect(await fsp.readFile(join(handle.dir, "a.txt"), "utf8")).toBe("a0\n");
    } finally {
      await handle.dispose();
    }
  });

  it("an existing dir with the chosen name is refused and left alone", async () => {
    const suffix = "0123456789abcdef";
    const existing = join(tmp, `omr-ref-${process.pid}-${suffix}`);
    await fsp.mkdir(existing);
    await fsp.writeFile(join(existing, "foreign.txt"), "not ours");
    const result = await materialize(await capture(), undefined, new AbortController().signal, deps({ randomSuffix: () => suffix }));
    expect(result).toMatchObject({ ok: false, reason: "unsafe-path" });
    expect(await fsp.readFile(join(existing, "foreign.txt"), "utf8")).toBe("not ours");
    await fsp.rm(existing, { recursive: true });
  });

  it("dispose twice returns the same promise and never rejects", async () => {
    const handle = await mat(await capture());
    const first = handle.dispose();
    expect(handle.dispose()).toBe(first);
    await first;
    await handle.dispose();
    expect(await exists(handle.dir)).toBe(false);
  });

  it("dispose after the dir was deleted externally drops the admin entry", async () => {
    const handle = await mat(await capture());
    for (const link of handle.links) await fsp.unlink(link);
    await fsp.rm(handle.dir, { recursive: true, force: true });
    await handle.dispose();
    expect(await worktreeCount(repo)).toBe(1);
    expect(await fsp.readFile(join(repo, "node_modules", "sentinel.txt"), "utf8")).toBe("keep me");
  });

  it.runIf(isWin)("dispose while a file is held open never throws; GC cleans up after close", async () => {
    const handle = await mat(await capture());
    const open = await fsp.open(join(handle.dir, "a.txt"), "r");
    try {
      await expect(handle.dispose()).resolves.toBeUndefined();
    } finally {
      await open.close();
    }
    await gcStaleReferences(repo, deps());
    expect(await exists(handle.dir)).toBe(false);
    expect(await fsp.readFile(join(repo, "node_modules", "sentinel.txt"), "utf8")).toBe("keep me");
  });

  it("dependency drift -> inexact with reason", async () => {
    const ref = await capture();
    await fsp.writeFile(join(repo, "package.json"), '{"name":"root","dependencies":{"x":"1"}}\n');
    const handle = await mat(ref);
    try {
      expect(handle.exact).toBe(false);
      expect(handle.inexactReasons).toContainEqual({ cause: "dependency-drift", path: "package.json" });
    } finally {
      await handle.dispose();
    }
  });

  it("workspace-link drift -> inexact with reason", async () => {
    await fsp.mkdir(join(repo, "node_modules", "@s"));
    await fsp.symlink(join(repo, "packages", "a"), join(repo, "node_modules", "@s", "a"), linkType);
    const ref = await capture();
    await fsp.writeFile(join(repo, "packages", "a", "index.js"), "module.exports = 1;\n");
    const handle = await mat(ref);
    try {
      expect(handle.inexactReasons).toContainEqual({ cause: "workspace-link-drift", path: "packages/a" });
    } finally {
      await handle.dispose();
    }
    expect(await fsp.readFile(join(repo, "packages", "a", "index.js"), "utf8")).toBe("module.exports = 1;\n");
  });

  it("commit-missing -> ok:false", async () => {
    const ref = await capture();
    const result = await materialize({ ...ref, commit: "0".repeat(40) }, undefined, new AbortController().signal, deps());
    expect(result).toMatchObject({ ok: false, reason: "commit-missing" });
  });

  it("unsafe dir name -> refused before anything is created", async () => {
    const ref = await capture();
    const result = await materialize(ref, undefined, new AbortController().signal, deps({ randomSuffix: () => "NOT-HEX" }));
    expect(result).toMatchObject({ ok: false, reason: "unsafe-path" });
  });

  it("unsafe untracked relPath -> inexact, nothing written outside", async () => {
    const ref = await capture();
    const evil: DispatchReference = { ...ref, untracked: new Map([["../evil.txt", "0".repeat(64)]]) };
    const handle = await mat(evil);
    try {
      expect(handle.inexactReasons).toEqual([{ cause: "untracked-unsafe-path", path: "../evil.txt" }]);
      expect(await exists(join(tmp, "evil.txt"))).toBe(false);
    } finally {
      await handle.dispose();
    }
  });

  it("abort mid-materialize -> ok:false aborted, no partial state", async () => {
    const ref = await capture();
    const controller = new AbortController();
    const aborting: CaptureDeps["argv"] = async (file, args, opts) => {
      const result = await argv(file, args, opts);
      if (args.includes("worktree") && args.includes("add")) controller.abort();
      return result;
    };
    const result = await materialize(ref, undefined, controller.signal, deps({ argv: aborting }));
    expect(result).toMatchObject({ ok: false, reason: "aborted" });
    expect(await refDirsIn(tmp)).toEqual([]);
    expect(await worktreeCount(repo)).toBe(1);
  });
});

describe("gcStaleReferences", { timeout: 60_000 }, () => {
  it("removes dead-owner worktrees and orphans; keeps live owners, user worktrees and look-alikes", async () => {
    const DEAD = 111111;
    const LIVE = 222222;
    const dead = join(tmp, `omr-ref-${DEAD}-0123456789abcdef`);
    const live = join(tmp, `omr-ref-${LIVE}-0123456789abcdef`);
    const lookalike = join(tmp, "omr-refX");
    const userWt = join(base, "user worktree");
    const orphan = join(tmp, `omr-ref-${DEAD}-fedcba9876543210`);
    for (const wt of [dead, live, lookalike, userWt]) await git(repo, "worktree", "add", "-q", "--detach", wt, "HEAD");
    await fsp.symlink(join(repo, "node_modules"), join(dead, "node_modules"), linkType);
    await fsp.mkdir(orphan);
    await fsp.writeFile(join(orphan, "junk.txt"), "junk");
    await fsp.symlink(join(repo, "packages", "a", "node_modules"), join(orphan, "node_modules"), linkType);
    const plainLookalike = join(tmp, "omr-refX-plain");
    await fsp.mkdir(plainLookalike);

    const report = await gcStaleReferences(repo, deps({ isAlive: (pid) => pid === LIVE }));
    expect(report.removed.map((d) => d.toLowerCase()).sort()).toEqual([dead, orphan].map((d) => d.toLowerCase()).sort());
    expect(report.kept.map((d) => d.toLowerCase())).toEqual([live.toLowerCase()]);
    expect(report.failed).toEqual([]);
    expect(await exists(dead)).toBe(false);
    expect(await exists(orphan)).toBe(false);
    for (const kept of [live, lookalike, userWt, plainLookalike]) expect(await exists(kept)).toBe(true);
    expect(await fsp.readFile(join(repo, "node_modules", "sentinel.txt"), "utf8")).toBe("keep me");
    expect(await fsp.readFile(join(repo, "packages", "a", "node_modules", "sentinel.txt"), "utf8")).toBe("keep me");
    const list = await git(repo, "worktree", "list", "--porcelain");
    expect(list).toContain("omr-refX");
    expect(list).toContain("user worktree");

    // Test cleanup of the kept worktrees (not the module under test).
    for (const wt of [live, lookalike, userWt]) await git(repo, "worktree", "remove", "--force", wt);
    await fsp.rm(plainLookalike, { recursive: true });
  });
});
