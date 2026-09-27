// Materialises one of the e2e fixture projects (test/fixtures/projects/*) into a throwaway git
// repository with its dependencies installed (plan §3.1.1). Plain node APIs only: every child
// process is spawned with an argv array and no shell; the only cmd.exe use is the Windows npm
// fallback, whose arguments are constants.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type FixtureName = "vitest-app" | "jest-app" | "pytest-app";

export interface FixtureRepo {
  dir: string;
  name: FixtureName;
  /** The command the router is asked to verify with ("npm test" or "uv run pytest"). */
  testCommand: string;
  write(rel: string, content: string): Promise<void>;
  remove(rel: string): Promise<void>;
  git(...args: string[]): string;
  commit(msg: string): string;
  head(): string;
  sentinelPath: string;
  dispose(): Promise<void>;
}

const FIXTURES_DIR = fileURLToPath(new URL("../../fixtures/projects/", import.meta.url));

interface FixtureSpec {
  testCommand: string;
  kind: "node" | "python";
  /** Pre-existing failure: source under extra/ and destination in the collected test dir. */
  extraFrom: string;
  extraTo: string;
}

const SPECS: Record<FixtureName, FixtureSpec> = {
  "vitest-app": {
    testCommand: "npm test",
    kind: "node",
    extraFrom: "extra/preexisting.test.js",
    extraTo: "test/preexisting.test.js",
  },
  "jest-app": {
    testCommand: "npm test",
    kind: "node",
    extraFrom: "extra/preexisting.test.js",
    extraTo: "test/preexisting.test.js",
  },
  "pytest-app": {
    testCommand: "uv run pytest",
    kind: "python",
    extraFrom: "extra/test_preexisting.py",
    extraTo: "tests/test_preexisting.py",
  },
};

export function e2eEnabled(): boolean {
  return process.env.RUN_VERIFY_E2E === "1";
}

/** How to launch npm without a shell: node + npm-cli.js, else `cmd.exe /d /s /c npm` on Windows. */
export function npmInvocation(): { command: string; prefix: string[] } {
  if (process.platform !== "win32") return { command: "npm", prefix: [] };
  const cli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(cli)) return { command: process.execPath, prefix: [cli] };
  return { command: process.env.ComSpec ?? "cmd.exe", prefix: ["/d", "/s", "/c", "npm"] };
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Runs a command (argv array, no shell) and captures its output. */
export function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 300_000,
  env: NodeJS.ProcessEnv = process.env,
): RunResult {
  const start = Date.now();
  const r = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  const err = r.error ? `\n${String(r.error)}` : "";
  return { status: r.status, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + err, ms: Date.now() - start };
}

export function runNpm(args: string[], cwd: string, timeoutMs?: number): RunResult {
  const { command, prefix } = npmInvocation();
  return run(command, [...prefix, ...args], cwd, timeoutMs);
}

/** Runs a fixture's own test command in `dir` (no shell). */
export function runFixtureTests(repo: Pick<FixtureRepo, "dir" | "testCommand">, timeoutMs?: number): RunResult {
  const [head, ...rest] = repo.testCommand.split(" ");
  if (head === "npm") return runNpm(rest, repo.dir, timeoutMs);
  return run(head, rest, repo.dir, timeoutMs);
}

export function toolAvailable(tool: "uv" | "npm" | "git"): boolean {
  const r = tool === "npm" ? runNpm(["--version"], process.cwd(), 30_000) : run(tool, ["--version"], process.cwd(), 30_000);
  return r.status === 0;
}

function must(r: RunResult, what: string): RunResult {
  if (r.status !== 0) {
    throw new Error(`${what} failed (exit ${String(r.status)})\n${r.stdout}\n${r.stderr}`);
  }
  return r;
}

export async function prepareFixtureRepo(
  name: FixtureName,
  opts: { root: string; preexisting?: boolean },
): Promise<FixtureRepo> {
  const spec = SPECS[name];
  const src = join(FIXTURES_DIR, name);
  const dir = join(opts.root, `${name}-${randomBytes(4).toString("hex")}`);
  await mkdir(opts.root, { recursive: true });
  await cp(src, dir, {
    recursive: true,
    filter: (p) => {
      const b = basename(p);
      return b !== "node_modules" && b !== ".venv" && b !== "__pycache__" && b !== ".pytest_cache";
    },
  });

  const git = (...args: string[]): string => must(run("git", args, dir, 60_000), `git ${args.join(" ")}`).stdout.trim();
  const head = (): string => git("rev-parse", "HEAD");
  const commit = (msg: string): string => {
    git("add", "-A");
    git("commit", "-q", "--no-verify", "-m", msg);
    return head();
  };

  git("init", "-q");
  git("config", "core.autocrlf", "false");
  git("config", "user.name", "omr e2e");
  git("config", "user.email", "omr-e2e@example.invalid");
  git("config", "commit.gpgsign", "false");
  commit("fixture");

  let sentinelPath: string;
  if (spec.kind === "node") {
    const args = ["ci", "--prefer-offline", "--no-audit", "--no-fund"];
    const cache = process.env.OMR_E2E_NPM_CACHE;
    if (cache) args.push("--cache", cache);
    must(runNpm(args, dir), `npm ${args.join(" ")} (${name})`);
    sentinelPath = join(dir, "node_modules", ".omr-e2e-sentinel");
  } else {
    must(run("uv", ["sync"], dir), `uv sync (${name})`);
    sentinelPath = join(dir, ".venv", ".omr-e2e-sentinel");
  }
  await writeFile(sentinelPath, "omr e2e sentinel\n", "utf8");

  const write = async (rel: string, content: string): Promise<void> => {
    const p = join(dir, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, "utf8");
  };
  const remove = async (rel: string): Promise<void> => {
    await rm(join(dir, rel), { recursive: true, force: true });
  };

  if (opts.preexisting) {
    await cp(join(dir, spec.extraFrom), join(dir, spec.extraTo));
    commit("preexisting failure");
  }

  const dispose = async (): Promise<void> => {
    // Phase 1.5 safety rule: never recurse through a node_modules junction/symlink into its target.
    const nm = join(dir, "node_modules");
    const st = await lstat(nm).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return undefined;
      throw e;
    });
    if (st?.isSymbolicLink()) await unlink(nm);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };

  return { dir, name, testCommand: spec.testCommand, write, remove, git, commit, head, sentinelPath, dispose };
}
