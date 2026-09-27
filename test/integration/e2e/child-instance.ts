/**
 * One simulated opencode session for the Phase 3.1.2.c e2e ("two plugin instances"): a separate
 * node process that creates its own REAL plugin (own home dir; TEMP inherited from the parent, so
 * the machine-wide verification slot dir is shared) on its own prepared fixture repo, runs the
 * configured VERIFY:required dispatches concurrently, and prints one JSON summary line.
 *
 * Node cannot import this TypeScript directly, so the e2e test bundles it (with the plugin) to an
 * .mjs first. Usage: node child-instance.mjs <config.json>
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acceptance, createE2EPlugin } from "./harness";

export interface ChildEdit {
  rel: string;
  /** Replace `from` with `to`; absent -> append a neutral comment. */
  from?: string;
  to?: string;
}

export interface ChildConfig {
  tag: string;
  repoDir: string;
  home: string;
  testCommand: string;
  /** Date.now() to wait for before dispatching, so both children start together. */
  startAt: number;
  /** Producer think time before the edit. */
  produceDelayMs: number;
  edits: ChildEdit[];
}

export interface ChildDispatchSummary {
  callID: string;
  output: string;
  beforeMs: number;
  afterMs: number;
  produceStartedAt: number;
  returnedAt: number;
}

export interface ChildSummary {
  tag: string;
  pid: number;
  startedAt: number;
  finishedAt: number;
  dispatches: ChildDispatchSummary[];
}

export const SUMMARY_PREFIX = "OMR_CHILD_SUMMARY ";

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function applyEdit(repoDir: string, edit: ChildEdit, tag: string): Promise<void> {
  const p = join(repoDir, edit.rel);
  const text = await readFile(p, "utf8");
  if (edit.from === undefined || edit.to === undefined) {
    await writeFile(p, `${text}\n// neutral edit ${tag}\n`, "utf8");
    return;
  }
  if (!text.includes(edit.from)) throw new Error(`${edit.rel} does not contain ${edit.from}`);
  await writeFile(p, text.replace(edit.from, edit.to), "utf8");
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (configPath === undefined) throw new Error("usage: child-instance <config.json>");
  const cfg = JSON.parse(await readFile(configPath, "utf8")) as ChildConfig;
  const plugin = await createE2EPlugin({ directory: cfg.repoDir, home: cfg.home, verify: {} });
  try {
    const wait = cfg.startAt - Date.now();
    if (wait > 0) await sleep(wait);
    const startedAt = Date.now();
    const results = await Promise.all(
      cfg.edits.map((edit, i) => {
        const callID = `${cfg.tag}-${i + 1}`;
        return plugin
          .task({
            sessionID: `orch-${callID}`,
            callID,
            prompt: `VERIFY:required\nAdjust ${edit.rel}.\n${acceptance(cfg.testCommand)}`,
            description: `adjust ${edit.rel}`,
            produce: async () => {
              await sleep(cfg.produceDelayMs);
              await applyEdit(cfg.repoDir, edit, callID);
            },
          })
          .then(r => ({ callID, ...r }));
      }),
    );
    const summary: ChildSummary = { tag: cfg.tag, pid: process.pid, startedAt, finishedAt: Date.now(), dispatches: results };
    process.stdout.write(`${SUMMARY_PREFIX}${JSON.stringify(summary)}\n`);
  } finally {
    await plugin.dispose();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`[child-instance] failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  },
);
