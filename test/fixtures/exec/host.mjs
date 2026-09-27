// A host process for test/unit/exec.test.ts: it imports src/verify/exec.ts the
// way opencode loads the plugin, then ends while work is still in flight. It
// runs under node (with type stripping: 22.18+/23.6+) and under bun.
//
//   node|bun host.mjs exit-mid-run <pidFile> <command>
//       runShell(<command>); once <pidFile> has content, print "ready" and
//       process.exit(0) with the run still in flight (QA-1.2-18).
//
//   node|bun host.mjs hung-sweeper <dir> [<sweeper executable>]
//       runArgv(node, [tree.cjs, "early-exit", <dir>]) with a sweeper that
//       hangs, aborted once the direct child exited, so the kill grace settles
//       the run with the sweep still in flight. Then release the holder, print
//       {"result": ..., "sweeper": <stand-in pid or null>} and return: the host
//       exits once nothing keeps its event loop alive (QA-1.2-19). Without an
//       executable, `spawn` is wrapped (node only) to start a node stand-in that
//       ignores its arguments and stdin and lives 60 s in place of PowerShell.
//
// Node targets run on $OMR_NODE when set, else process.execPath (under bun
// that is bun.exe, not node).
import childProcess from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [mode, ...rest] = process.argv.slice(2);
const node = process.env.OMR_NODE || process.execPath;
const HUNG = "omr-hung-sweeper";
/** hung-sweeper: the stand-in started in place of PowerShell. */
let standIn;
if (mode === "hung-sweeper" && !rest[1]) {
  const realSpawn = childProcess.spawn;
  childProcess.spawn = (file, args, options) => {
    if (file !== HUNG) return realSpawn(file, args, options);
    standIn = realSpawn(node, ["-e", "setTimeout(() => {}, 60000)"], options);
    return standIn;
  };
  // Before exec.ts is imported, so its `spawn` binding is the wrapper.
  syncBuiltinESMExports();
}
const exec = await import(new URL("../../../src/verify/exec.ts", import.meta.url).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, what) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await sleep(50);
  }
  throw new Error(`host: timed out waiting for ${what}`);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

const hasContent = (file) => existsSync(file) && readFileSync(file, "utf8") !== "";

if (mode === "exit-mid-run") {
  const [pidFile, command] = rest;
  void exec.runShell(command, { timeoutMs: 60000 });
  await waitFor(() => hasContent(pidFile), pidFile);
  process.stdout.write("ready\n");
  process.exit(0);
} else if (mode === "hung-sweeper") {
  const [dir, sweeper] = rest;
  exec.setSweeperExecutableForTests(sweeper || HUNG);
  const controller = new AbortController();
  const tree = fileURLToPath(new URL("./tree.cjs", import.meta.url));
  const pending = exec.runArgv(node, [tree, "early-exit", dir], { cwd: dir, timeoutMs: 60000, signal: controller.signal });
  // Abort once the direct child exited and the sweeper was armed, so the kill
  // is the sweep's (tree.cjs writes holder.pid last).
  const childFile = join(dir, "child.pid");
  await waitFor(() => hasContent(join(dir, "holder.pid")), "holder.pid");
  const child = Number(readFileSync(childFile, "utf8"));
  await waitFor(() => !alive(child), "the direct child to exit");
  await sleep(500);
  controller.abort();
  const result = await pending;
  writeFileSync(join(dir, "release"), "");
  process.stdout.write(`${JSON.stringify({ result, sweeper: standIn?.pid ?? null })}\n`);
} else {
  process.stderr.write(`host: unknown mode ${mode}\n`);
  process.exit(2);
}
