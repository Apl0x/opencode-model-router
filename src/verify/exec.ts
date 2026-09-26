/**
 * Run a shell command with a deadline that actually ends the work.
 *
 * `child_process.exec` with `timeout` (or `signal`) only signals the shell it
 * spawned. Test commands are process trees — `cmd /c npm test` -> npm -> vitest
 * -> one worker per core — so killing the shell orphans everything below it,
 * and the "aborted" baseline keeps every core busy until the suite finishes on
 * its own. On a timeout or abort this kills the whole tree instead: `taskkill
 * /T` on Windows, the process group on POSIX.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
  /** True when the deadline or the abort signal ended the command. */
  timedOut: boolean;
}

export function runShell(
  command: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; maxBuffer?: number },
): Promise<ShellResult> {
  if (opts.signal?.aborted) return Promise.resolve({ code: 1, stdout: "", stderr: "", timedOut: true });
  return new Promise((resolve) => {
    const limit = opts.maxBuffer ?? 10 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(command, {
        cwd: opts.cwd,
        shell: true,
        windowsHide: true,
        // Its own process group on POSIX, so the whole tree can be signalled at once.
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ code: 1, stdout: "", stderr: `exec failed: ${String(err)}`, timedOut: false });
      return;
    }
    // Output past the cap is dropped rather than failing the run; the verdict
    // is parsed from the summary lines, which runners print last only when the
    // run completes, so truncation degrades to "unknown output", never a pass.
    child.stdout?.on("data", (chunk) => { if (stdout.length < limit) stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { if (stderr.length < limit) stderr += String(chunk); });

    const kill = () => {
      if (killed || settled) return;
      killed = true;
      killTree(child);
    };
    const timer = setTimeout(kill, opts.timeoutMs);
    opts.signal?.addEventListener("abort", kill, { once: true });

    const finish = (code: number | null, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", kill);
      if (error) stderr += String(error);
      resolve({ code: killed ? code || 1 : code ?? 1, stdout, stderr, timedOut: killed });
    };
    child.on("error", (err) => finish(1, err));
    child.on("close", (code) => finish(code));
  });
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    child.kill("SIGKILL");
    return;
  }
  if (process.platform === "win32") {
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
