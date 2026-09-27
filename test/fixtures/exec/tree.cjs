// Process-tree shapes for test/unit/exec.test.ts (QA-1.2-1, -2, -10).
//
//   node tree.cjs <mode> <dir>
//
//   early-exit   Spawns a holder that inherits our stdout/stderr, then exits 0
//                after 300 ms. The holder stays reachable: its parent is this
//                (exited) process. On Windows it is detached so it escapes
//                libuv's kill-on-close job, like a descendant of cmd.exe, a
//                Python pool or a native launcher; on POSIX it stays in the
//                process group.
//   unreachable  A middle process spawns a detached holder that inherits the
//                pipes and exits; this process waits for it, then exits 0.
//                Nothing alive has this process as its parent any more.
//   broken-tree  Like unreachable, but this process stays alive until killed
//                (self-capped at 20 s).
//   middle       Internal: spawn the detached holder and exit.
//
// Writes <dir>/child.pid (this process), <dir>/middle.pid and <dir>/holder.pid
// (holder.pid last, so the others exist once it does). The holder exits
// when <dir>/release appears, or after 20 s, so nothing outlives a failed test.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const [mode, dir] = process.argv.slice(2);
const HOLDER =
  "const fs = require('node:fs'); const end = Date.now() + 20000;" +
  "setInterval(() => { if (fs.existsSync(process.argv[1]) || Date.now() > end) process.exit(0); }, 50);";

function spawnHolder(detached) {
  const holder = spawn(process.execPath, ["-e", HOLDER, path.join(dir, "release")], { stdio: "inherit", detached });
  fs.writeFileSync(path.join(dir, "holder.pid"), String(holder.pid));
  holder.unref();
}

if (mode === "middle") {
  fs.writeFileSync(path.join(dir, "middle.pid"), String(process.pid));
  spawnHolder(true);
  process.exit(0);
}

fs.writeFileSync(path.join(dir, "child.pid"), String(process.pid));
if (mode === "early-exit") {
  spawnHolder(process.platform === "win32");
  setTimeout(() => process.exit(0), 300);
} else if (mode === "unreachable" || mode === "broken-tree") {
  const middle = spawn(process.execPath, [__filename, "middle", dir], { stdio: "inherit" });
  if (mode === "unreachable") middle.on("exit", () => process.exit(0));
  else setTimeout(() => process.exit(0), 20000);
} else {
  process.stderr.write(`unknown mode ${mode}\n`);
  process.exit(2);
}
