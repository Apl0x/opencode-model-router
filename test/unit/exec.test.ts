import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runArgv, runShell } from "../../src/verify/exec";

// Real processes, no mocks: the defect this guards against only exists in how
// the OS tears a process tree down, which a fake child_process cannot model.
const node = `"${process.execPath}"`;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A shell -> node -> grandchild node chain, like `cmd /c npm test` -> vitest -> workers. */
function forkingFixture() {
  const dir = mkdtempSync(join(tmpdir(), "omr-exec-"));
  dirs.push(dir);
  const script = join(dir, "fork.cjs");
  const pidFile = join(dir, "grandchild.pid");
  writeFileSync(script, [
    "const { spawn } = require('node:child_process');",
    "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "require('node:fs').writeFileSync(process.argv[2], String(g.pid));",
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  return { command: `${node} "${script}" "${pidFile}"`, script, pidFile, dir, grandchild: () => Number(readFileSync(pidFile, "utf8")) };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForExit(pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (!alive(pid)) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

describe("runShell", () => {
  it("returns exit code and output of a command that finishes", async () => {
    const r = await runShell(`${node} -e "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"`, { cwd: tmpdir(), timeoutMs: 20000 });
    expect(r).toEqual({ code: 3, stdout: "out", stderr: "err", timedOut: false });
  });

  it("kills the whole process tree on timeout, not just the shell", async () => {
    const f = forkingFixture();
    const r = await runShell(f.command, { cwd: f.dir, timeoutMs: 1500 });
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
    expect(await waitForExit(f.grandchild())).toBe(true);
  }, 20000);

  it("kills the whole process tree on abort", async () => {
    const f = forkingFixture();
    const controller = new AbortController();
    const pending = runShell(f.command, { cwd: f.dir, timeoutMs: 20000, signal: controller.signal });
    setTimeout(() => controller.abort(), 1500);
    const r = await pending;
    expect(r.timedOut).toBe(true);
    expect(await waitForExit(f.grandchild())).toBe(true);
  }, 20000);

  it("never starts a command whose signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await runShell(`${node} -e "process.stdout.write('ran')"`, { cwd: tmpdir(), timeoutMs: 20000, signal: controller.signal });
    expect(r.timedOut).toBe(true);
    expect(r.stdout).toBe("");
  });
});

const isWin = process.platform === "win32";

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "omr-exec-"));
  dirs.push(dir);
  return dir;
}

/** OS scheduling priority of a live process: Windows base priority (normal = 8) or POSIX niceness. */
function priorityOf(pid: number): number {
  if (isWin) {
    return Number(execFileSync("pwsh", ["-NoProfile", "-c", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").Priority`], { timeout: 30000 }).toString().trim());
  }
  return Number(execFileSync("ps", ["-o", "ni=", "-p", String(pid)]).toString().trim());
}

async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      readFileSync(path, "utf8");
      return;
    } catch {
      await new Promise(r => setTimeout(r, 50));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

describe("runArgv", () => {
  it("kills the whole process tree on timeout", async () => {
    const f = forkingFixture();
    const r = await runArgv(process.execPath, [f.script, f.pidFile], { cwd: f.dir, timeoutMs: 1500 });
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
    expect(await waitForExit(f.grandchild())).toBe(true);
  }, 20000);

  it("kills the whole process tree on abort", async () => {
    const f = forkingFixture();
    const controller = new AbortController();
    const pending = runArgv(process.execPath, [f.script, f.pidFile], { cwd: f.dir, timeoutMs: 20000, signal: controller.signal });
    setTimeout(() => controller.abort(), 1500);
    const r = await pending;
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
    expect(await waitForExit(f.grandchild())).toBe(true);
  }, 20000);

  it("passes argv byte-for-byte, with no shell interpretation", async () => {
    const dir = scratch();
    const echo = join(dir, "echo args.cjs");
    writeFileSync(echo, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    const args = ["path with spaces", "\"double\" 'single'", "a&b|c>d", "$(whoami) `id`", "%PATH%", "ünïcödé ✓ 日本", "", "trailing\\"];
    const r = await runArgv(process.execPath, [echo, ...args], { cwd: dir, timeoutMs: 20000 });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(args);
  }, 20000);

  it("merges env over process.env instead of replacing it", async () => {
    const r = await runArgv(process.execPath, ["-e", "process.stdout.write(JSON.stringify({ x: process.env.OMR_EXEC_X, path: Boolean(process.env.PATH || process.env.Path) }))"], {
      cwd: tmpdir(), timeoutMs: 20000, env: { OMR_EXEC_X: "yes" },
    });
    expect(JSON.parse(r.stdout)).toEqual({ x: "yes", path: true });
  }, 20000);

  it("truncates output over maxBuffer without hanging", async () => {
    const r = await runArgv(process.execPath, ["-e", "process.stdout.write('x'.repeat(5 * 1024 * 1024))"], { cwd: tmpdir(), timeoutMs: 20000, maxBuffer: 1000 });
    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.stdout.length).toBeGreaterThan(0);
    expect(r.stdout.length).toBeLessThan(5 * 1024 * 1024);
  }, 20000);

  it("resolves a spawn error as code 1 with the error in stderr, never rejecting", async () => {
    const r = await runArgv("omr-no-such-executable-xyz", ["a"], { cwd: tmpdir(), timeoutMs: 20000 });
    expect(r.code).toBe(1);
    expect(r.timedOut).toBe(false);
    expect(r.stderr).toMatch(/ENOENT/);
  });

  it.runIf(isWin)("refuses a .cmd target without a shell (Node EINVAL) as a spawn error; use runShell for batch files", async () => {
    const dir = scratch();
    const cmd = join(dir, "t.cmd");
    writeFileSync(cmd, "@exit /b 3\r\n");
    const r = await runArgv(cmd, [], { cwd: dir, timeoutMs: 20000 });
    expect(r).toMatchObject({ code: 1, timedOut: false });
    expect(r.stderr).toMatch(/EINVAL/);
  });

  it("never starts when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await runArgv(process.execPath, ["-e", "process.stdout.write('ran')"], { cwd: tmpdir(), timeoutMs: 20000, signal: controller.signal });
    expect(r).toEqual({ code: 1, stdout: "", stderr: "", timedOut: true });
  });

  it("treats an abort after natural exit as a no-op and leaves no listener behind", async () => {
    const controller = new AbortController();
    const r = await runArgv(process.execPath, ["-e", "process.exit(0)"], { cwd: tmpdir(), timeoutMs: 20000, signal: controller.signal });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    controller.abort();
    expect(r).toEqual({ code: 0, stdout: "", stderr: "", timedOut: false });
  }, 20000);

  it("does not leak abort listeners across many runs sharing one signal", async () => {
    const controller = new AbortController();
    const warnings: Error[] = [];
    const onWarning = (w: Error) => warnings.push(w);
    process.on("warning", onWarning);
    try {
      for (let batch = 0; batch < 3; batch++) {
        await Promise.all(Array.from({ length: 8 }, () => runArgv(process.execPath, ["-e", ""], { cwd: tmpdir(), timeoutMs: 20000, signal: controller.signal })));
      }
      await runArgv("omr-no-such-executable-xyz", [], { signal: controller.signal });
    } finally {
      process.off("warning", onWarning);
    }
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(warnings.filter(w => w.name === "MaxListenersExceededWarning")).toEqual([]);
  }, 60000);
});

describe("lowPriority", () => {
  // Windows: BELOW_NORMAL base priority is 6 (normal 8). POSIX: `nice -n 10`.
  const lowered = (p: number) => (isWin ? p <= 6 : p >= 10);

  it("runs grandchildren of runArgv below normal priority", async () => {
    const f = forkingFixture();
    const controller = new AbortController();
    const pending = runArgv(process.execPath, [f.script, f.pidFile], { cwd: f.dir, timeoutMs: 30000, lowPriority: true, signal: controller.signal });
    try {
      await waitForFile(f.pidFile);
      expect(lowered(priorityOf(f.grandchild()))).toBe(true);
    } finally {
      controller.abort();
      await pending;
    }
    expect(await waitForExit(f.grandchild())).toBe(true);
  }, 60000);

  it("runs grandchildren of runShell below normal priority", async () => {
    const f = forkingFixture();
    const controller = new AbortController();
    const pending = runShell(f.command, { cwd: f.dir, timeoutMs: 30000, lowPriority: true, signal: controller.signal });
    try {
      await waitForFile(f.pidFile);
      expect(lowered(priorityOf(f.grandchild()))).toBe(true);
    } finally {
      controller.abort();
      await pending;
    }
    expect(await waitForExit(f.grandchild())).toBe(true);
  }, 60000);

  it.each([0, 3])("keeps exit code %i through the priority wrapper", async (code) => {
    const script = `process.exit(${code})`;
    expect((await runArgv(process.execPath, ["-e", script], { cwd: tmpdir(), timeoutMs: 20000, lowPriority: true })).code).toBe(code);
    expect((await runShell(`${node} -e "${script}"`, { cwd: tmpdir(), timeoutMs: 20000, lowPriority: true })).code).toBe(code);
  }, 20000);

  it.runIf(isWin)("keeps the exit code of a .cmd target run through runShell (Windows-only: .cmd is a Windows batch file)", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "t.cmd"), `@echo off\r\n${node} -e "process.exit(3)"\r\nexit /b %ERRORLEVEL%\r\n`);
    const r = await runShell(`"${join(dir, "t.cmd")}"`, { cwd: dir, timeoutMs: 20000, lowPriority: true });
    expect(r.code).toBe(3);
    const ok = await runShell("npm.cmd --version", { cwd: dir, timeoutMs: 60000, lowPriority: true });
    expect(ok.code).toBe(0);
  }, 60000);
});
