/**
 * The single process layer for verification: every command runs through
 * `runShell` (a shell string) or `runArgv` (argv, no shell), which share one
 * implementation of the deadline, abort, output cap and tree kill.
 *
 * `child_process.exec` with `timeout` (or `signal`) only signals the shell it
 * spawned. Test commands are process trees — `cmd /c npm test` -> npm -> vitest
 * -> one worker per core — so killing the shell orphans everything below it,
 * and the "aborted" baseline keeps every core busy until the suite finishes on
 * its own. On a timeout or abort this kills the whole tree instead: `taskkill
 * /T` on Windows, the process group on POSIX.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants as osConstants, setPriority } from "node:os";
import type { ArgvSeam, ExecOptions, ExecSeam } from "./types";

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
  /** True when the deadline or the abort signal ended the command. */
  timedOut: boolean;
}

export interface RunOptions extends ExecOptions {
  /** Per-stream cap in characters; output past it is dropped. Default 10 MB. */
  maxBuffer?: number;
}

const isWin = process.platform === "win32";

/** Run `command` through the platform shell (`cmd.exe` / `/bin/sh`). */
export function runShell(command: string, opts: RunOptions = {}): Promise<ShellResult> {
  // POSIX low priority: `nice -n 10 /bin/sh -c <command>` is exactly what
  // `shell: true` would spawn, just prefixed, so the command string keeps its
  // shell semantics and is never re-quoted. niceness is inherited by every
  // descendant from birth, so there is no startup race on POSIX.
  if (opts.lowPriority && !isWin) return run("nice", ["-n", "10", "/bin/sh", "-c", command], false, opts);
  return run(command, [], true, opts);
}

/**
 * Spawn `file` with `args` and no shell: arguments reach the child
 * byte-for-byte. On Windows, Node refuses to spawn `.cmd`/`.bat` files without
 * a shell (EINVAL since the CVE-2024-27980 fix); that resolves as a spawn
 * error (`code: 1`) — run batch files through `runShell` instead.
 */
export function runArgv(file: string, args: readonly string[], opts: RunOptions = {}): Promise<ShellResult> {
  if (opts.lowPriority && !isWin) return run("nice", ["-n", "10", file, ...args], false, opts);
  return run(file, [...args], false, opts);
}

// Compile-time proof that both entry points satisfy the injection seams.
export const execSeam: ExecSeam = runShell;
export const argvSeam: ArgvSeam = runArgv;

function run(file: string, args: string[], shell: boolean, opts: RunOptions): Promise<ShellResult> {
  if (opts.signal?.aborted) return Promise.resolve({ code: 1, stdout: "", stderr: "", timedOut: true });
  return new Promise((resolve) => {
    const limit = opts.maxBuffer ?? 10 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let killed = false;
    let exited = false;
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: mergeEnv(opts.env),
        shell,
        windowsHide: true,
        // Its own process group on POSIX, so the whole tree can be signalled at once.
        detached: !isWin,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ code: 1, stdout: "", stderr: `exec failed: ${String(err)}`, timedOut: false });
      return;
    }
    if (opts.lowPriority && isWin && child.pid) {
      // Windows low priority (Spike A, docs/qa/verification-resource-budget/phase-1.2.md):
      // lower the direct child right after spawn; descendants inherit the class
      // when they are created. The `start /BELOWNORMAL` wrapper was rejected
      // because it loses exit codes of `.cmd` targets such as npm.cmd.
      // Startup race: anything the child spawns before this call runs at normal
      // priority. The window is the few microseconds between CreateProcess and
      // this line, before the child has even loaded its runtime, so in practice
      // no grandchild exists yet — but it is not a guarantee.
      try {
        setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
      } catch (err) {
        // The child may already have exited; the run itself is unaffected.
        stderr += `[low priority not applied: ${String(err)}]\n`;
      }
    }
    // Output past the cap is dropped rather than failing the run; the verdict
    // is parsed from the summary lines, which runners print last only when the
    // run completes, so truncation degrades to "unknown output", never a pass.
    child.stdout?.on("data", (chunk) => { if (stdout.length < limit) stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { if (stderr.length < limit) stderr += String(chunk); });

    const kill = () => {
      if (killed || settled) return;
      killed = true;
      // After the direct child exited its PID may be recycled by Windows, so a
      // `taskkill /T` on it could hit an unrelated tree. POSIX still signals
      // the group: a group id is not reused while any member is alive.
      if (exited && isWin) return;
      killTree(child);
    };
    const timer = opts.timeoutMs === undefined ? undefined : setTimeout(kill, opts.timeoutMs);
    opts.signal?.addEventListener("abort", kill, { once: true });

    const finish = (code: number | null, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", kill);
      if (error) stderr += String(error);
      resolve({ code: killed ? code || 1 : code ?? 1, stdout, stderr, timedOut: killed });
    };
    child.on("exit", () => { exited = true; });
    child.on("error", (err) => finish(1, err));
    child.on("close", (code) => finish(code));
  });
}

/**
 * Overrides merged over process.env. Windows environment names are
 * case-insensitive and Node keeps only one of two keys that differ in case
 * (the first in sort order, not the override), so an inherited key that
 * matches an override case-insensitively is dropped first.
 */
function mergeEnv(overrides: Record<string, string> | undefined): NodeJS.ProcessEnv {
  if (!overrides) return process.env;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (isWin) {
      const upper = key.toUpperCase();
      for (const existing of Object.keys(env)) if (existing.toUpperCase() === upper) delete env[existing];
    }
    env[key] = value;
  }
  return env;
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    child.kill("SIGKILL");
    return;
  }
  if (isWin) {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, (err) => {
      // taskkill fails when the tree already exited; the direct kill is then a no-op.
      if (err) child.kill();
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // No group (already reaped or never detached): fall back to the direct child.
    child.kill("SIGKILL");
  }
}
