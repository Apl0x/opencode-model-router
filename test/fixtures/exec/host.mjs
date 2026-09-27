// A host process for test/unit/exec.test.ts: it imports src/verify/exec.ts the
// way opencode loads the plugin, then ends while work is still in flight. It
// runs under node (with type stripping: 22.18+/23.6+) and under bun.
//
//   node|bun host.mjs exit-mid-run <pidFile> <command>
//       runShell(<command>); once <pidFile> has content, print "ready" and
//       process.exit(0) with the run still in flight (QA-1.2-18).
import { existsSync, readFileSync } from "node:fs";

const [mode, ...rest] = process.argv.slice(2);
const exec = await import(new URL("../../../src/verify/exec.ts", import.meta.url).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, what) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await sleep(50);
  }
  throw new Error(`host: timed out waiting for ${what}`);
}

if (mode === "exit-mid-run") {
  const [pidFile, command] = rest;
  void exec.runShell(command, { timeoutMs: 60000 });
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "", pidFile);
  process.stdout.write("ready\n");
  process.exit(0);
} else {
  process.stderr.write(`host: unknown mode ${mode}\n`);
  process.exit(2);
}
