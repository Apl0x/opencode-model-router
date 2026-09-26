import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShell } from "../../src/verify/exec";

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
  return { command: `${node} "${script}" "${pidFile}"`, dir, grandchild: () => Number(readFileSync(pidFile, "utf8")) };
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
