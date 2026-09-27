// Child process for the multi-process slot tests. Plain JS. It loads a JS build
// of src/verify/slot.ts that the test compiles in beforeAll, so it runs on every
// supported Node version (no type stripping needed).
// argv: <slotModulePath> <jsonConfig>
// config: { dir, max, waitMs, holdMs, log, id, mode, deps, go, stop }
//   Prints "READY" once the module is loaded. With `go`, it then waits for that
//   file to exist (a start barrier, so that all children contend at once).
//   mode "cycle": acquire, append enter/exit lines to `log`, hold `holdMs`, release.
//   mode "loop":  like "cycle", repeated until the file `stop` exists.
//   mode "hang":  acquire, print "HELD" and never release (killed by the test).
//   mode "exit":  acquire, print "HELD", then let the event loop drain (unref'd heartbeat).
import { appendFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [slotPath, raw] = process.argv.slice(2);
const cfg = JSON.parse(raw);
const { acquireSlot } = await import(pathToFileURL(slotPath).href);
const t = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deps = { dir: cfg.dir, ...(cfg.deps ?? {}) };
const meta = { cwd: process.cwd(), command: `holder ${cfg.id}` };
const acquire = () => acquireSlot({ max: cfg.max, waitMs: cfg.waitMs, meta }, deps);

process.stdout.write("READY\n");
if (cfg.go) while (!existsSync(cfg.go)) await sleep(5);

async function cycle(n) {
  const s = await acquire();
  if ("busy" in s) return false;
  appendFileSync(cfg.log, `${cfg.id}#${n} enter ${t()}\n`);
  await sleep(cfg.holdMs);
  appendFileSync(cfg.log, `${cfg.id}#${n} exit ${t()}\n`);
  await s.release();
  return true;
}

if (cfg.mode === "cycle" || cfg.mode === "loop") {
  let n = 0;
  do {
    if (!(await cycle(n++))) {
      process.stdout.write("BUSY\n");
      process.exitCode = 2;
      break;
    }
  } while (cfg.mode === "loop" && !existsSync(cfg.stop));
  process.stdout.write(`DONE ${n}\n`);
} else {
  const s = await acquire();
  if ("busy" in s) {
    process.stdout.write("BUSY\n");
    process.exitCode = 2;
  } else {
    process.stdout.write("HELD\n");
    if (cfg.mode === "hang") setInterval(() => {}, 1_000);
  }
}
