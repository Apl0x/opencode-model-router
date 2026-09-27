// Child process for the multi-process slot tests. It is plain JS and loads
// slot.ts through Node's built-in type stripping (Node >= 22.18 / 24).
// argv: <slotTsPath> <jsonConfig>
// config: { dir, max, waitMs, holdMs, log, id, mode, deps }
//   mode "cycle": acquire, append enter/exit lines to `log`, hold, release.
//   mode "hang":  acquire, print "HELD" and never release (killed by the test).
//   mode "exit":  acquire, print "HELD", then let the event loop drain (unref'd heartbeat).
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [slotPath, raw] = process.argv.slice(2);
const cfg = JSON.parse(raw);
const { acquireSlot } = await import(pathToFileURL(slotPath).href);
const t = () => performance.timeOrigin + performance.now();

const s = await acquireSlot(
  { max: cfg.max, waitMs: cfg.waitMs, meta: { cwd: process.cwd(), command: `holder ${cfg.id}` } },
  { dir: cfg.dir, ...(cfg.deps ?? {}) },
);
if ("busy" in s) {
  process.stdout.write("BUSY\n");
  process.exitCode = 2;
} else if (cfg.mode === "cycle") {
  appendFileSync(cfg.log, `${cfg.id} enter ${t()}\n`);
  await new Promise((r) => setTimeout(r, cfg.holdMs));
  appendFileSync(cfg.log, `${cfg.id} exit ${t()}\n`);
  await s.release();
} else if (cfg.mode === "hang") {
  process.stdout.write("HELD\n");
  setInterval(() => {}, 1_000);
} else {
  process.stdout.write("HELD\n");
}
