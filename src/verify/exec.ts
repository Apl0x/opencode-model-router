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
  /**
   * Deadline in ms. Callers must bound every run with `timeoutMs` or `signal`;
   * when both are absent the run gets DEFAULT_TIMEOUT_MS (120 s, the same
   * default as `DeterministicDeps.timeoutMs`). `Infinity` explicitly means no
   * deadline, `NaN` counts as absent, values <= 0 expire at once, and values
   * above the 2^31-1 ms timer limit (~24.8 days) are clamped to it.
   */
  timeoutMs?: number;
  /**
   * Per-stream cap in characters (UTF-16 code units). Output past it is
   * dropped and a `[stdout truncated at <n> chars]` line is appended to stderr.
   * Default 10 MB.
   */
  maxBuffer?: number;
}

export const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

const isWin = process.platform === "win32";

/** Run `command` through the platform shell (`cmd.exe` / `/bin/sh`). */
export function runShell(command: string, opts: RunOptions = {}): Promise<ShellResult> {
  // POSIX low priority: `nice -n 10 -- /bin/sh -c <command>` is exactly what
  // `shell: true` would spawn, just prefixed, so the command string keeps its
  // shell semantics and is never re-quoted. niceness is inherited by every
  // descendant from birth, so there is no startup race on POSIX.
  if (opts.lowPriority && !isWin) return run("nice", ["-n", "10", "--", "/bin/sh", "-c", command], false, opts);
  return run(command, [], true, opts);
}

/**
 * Spawn `file` with `args` and no shell: arguments reach the child
 * byte-for-byte. On Windows, Node refuses to spawn `.cmd`/`.bat` files without
 * a shell (EINVAL since the CVE-2024-27980 fix); that resolves as a spawn
 * error (`code: 1`) — run batch files through `runShell` instead.
 */
export function runArgv(file: string, args: readonly string[], opts: RunOptions = {}): Promise<ShellResult> {
  // `--` keeps a target whose name starts with "-" from being read as a nice option.
  if (opts.lowPriority && !isWin) return run("nice", ["-n", "10", "--", file, ...args], false, opts, file);
  return run(file, [...args], false, opts);
}

// Compile-time proof that both entry points satisfy the injection seams.
export const execSeam: ExecSeam = runShell;
export const argvSeam: ArgvSeam = runArgv;

/**
 * @param niceTarget set when `file` is `nice` wrapping this argv target: nice
 *   reports a target it cannot exec as exit 127/126 instead of a spawn error.
 */
function run(file: string, args: string[], shell: boolean, opts: RunOptions, niceTarget?: string): Promise<ShellResult> {
  if (opts.signal?.aborted) return Promise.resolve({ code: 1, stdout: "", stderr: "", timedOut: true });
  const deadline = deadlineOf(opts);
  return new Promise((resolve) => {
    const limit = opts.maxBuffer === undefined || Number.isNaN(opts.maxBuffer) ? DEFAULT_MAX_BUFFER : Math.max(0, opts.maxBuffer);
    const out = capture(limit);
    const err = capture(limit);
    const notes: string[] = [];
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
    } catch (e) {
      resolve({ code: 1, stdout: "", stderr: `exec failed: ${String(e)}`, timedOut: false });
      return;
    }
    const pid = child.pid;
    if (!isWin && pid) trackGroup(pid);
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
      } catch (e) {
        // The child may already have exited; the run itself is unaffected.
        notes.push(`[low priority not applied: ${String(e)}]`);
      }
    }
    // A StringDecoder per stream, so a multi-byte character split across two
    // chunks is not turned into U+FFFD.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    // Output past the cap is dropped rather than failing the run; the verdict
    // is parsed from the summary lines, which runners print last only when the
    // run completes, so truncation degrades to "unknown output", never a pass.
    child.stdout?.on("data", (s: string) => out.push(s));
    child.stderr?.on("data", (s: string) => err.push(s));

    const kill = () => {
      if (killed || settled) return;
      killed = true;
      // After the direct child exited its PID may be recycled by Windows, so a
      // `taskkill /T` on it could hit an unrelated tree. POSIX still signals
      // the group: a group id is not reused while any member is alive.
      if (exited && isWin) return;
      killTree(child);
    };
    const timer = deadline === undefined ? undefined : setTimeout(kill, deadline);
    opts.signal?.addEventListener("abort", kill, { once: true });

    const finish = (code: number | null, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", kill);
      if (!isWin && pid) untrackGroup(pid);
      let finalCode = killed ? code || 1 : code ?? 1;
      let stderr = err.text;
      if (niceTarget && !killed && (code === 126 || code === 127) && stderr.startsWith("nice:")) {
        // The same contract as a direct spawn: code 1 and the errno in stderr.
        stderr = `exec failed: spawn ${niceTarget} ${code === 127 ? "ENOENT" : "EACCES"} (${stderr.trim()})`;
        finalCode = 1;
      }
      if (error) stderr += String(error);
      if (out.truncated) notes.push(`[stdout truncated at ${limit} chars]`);
      if (err.truncated) notes.push(`[stderr truncated at ${limit} chars]`);
      for (const note of notes) stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}${note}\n`;
      resolve({ code: finalCode, stdout: out.text, stderr, timedOut: killed });
    };
    child.on("exit", () => { exited = true; });
    child.on("error", (err) => finish(1, err));
    child.on("close", (code) => finish(code));
  });
}

/** The timer to arm, or undefined for none. */
function deadlineOf(opts: RunOptions): number | undefined {
  const t = opts.timeoutMs;
  if (t === undefined || Number.isNaN(t)) return opts.signal ? undefined : DEFAULT_TIMEOUT_MS;
  if (t === Infinity) return undefined;
  // setTimeout treats anything above 2^31-1 as 1 ms, which would kill at once.
  return Math.min(Math.max(t, 0), MAX_TIMER_MS);
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

interface Capture {
  text: string;
  truncated: boolean;
  push(s: string): void;
}

function capture(limit: number): Capture {
  const c: Capture = {
    text: "",
    truncated: false,
    push(s) {
      if (c.truncated) return;
      const room = limit - c.text.length;
      if (s.length <= room) {
        c.text += s;
        return;
      }
      let cut = Math.max(room, 0);
      // Do not keep half of a surrogate pair.
      const last = s.charCodeAt(cut - 1);
      if (cut > 0 && last >= 0xd800 && last <= 0xdbff) cut--;
      c.text += s.slice(0, cut);
      c.truncated = true;
    },
  };
  return c;
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
  // No group (already reaped or never detached): fall back to the direct child.
  if (!signalGroup(pid, "SIGKILL")) child.kill("SIGKILL");
}

// POSIX: detached children lead their own process group and session, so a
// terminal hang-up or Ctrl-C that ends opencode never reaches them. Groups of
// runs still in flight are killed when opencode exits. Death by an unhandled
// signal (the host's SIGTERM/SIGHUP policy) skips `exit` hooks and remains
// opencode's concern. On Windows, non-detached children sit in libuv's
// kill-on-close job instead.
const liveGroups = new Set<number>();
let exitHookInstalled = false;

function trackGroup(pgid: number): void {
  liveGroups.add(pgid);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", killTrackedProcessGroups);
}

function untrackGroup(pgid: number): void {
  liveGroups.delete(pgid);
}

/** The `exit` hook: synchronous, as `exit` listeners must be. */
function killTrackedProcessGroups(): void {
  for (const pgid of liveGroups) signalGroup(pgid, "SIGKILL");
  liveGroups.clear();
}

function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}
