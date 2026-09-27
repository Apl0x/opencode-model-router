/**
 * Self-check of the e2e helpers (sampler + real-plugin harness). Gated: it spawns real processes
 * and drives the real plugin, so it runs only with RUN_VERIFY_E2E=1.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptance, createE2EPlugin } from "./harness";
import { descendantsOf, startSampler, type Snapshot } from "./sampler";

const enabled = process.env.RUN_VERIFY_E2E === "1";
const suite = enabled ? describe : describe.skip;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

suite("e2e harness self-check", () => {
  let repo = "";
  let home = "";

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "omr-e2e-repo-"));
    home = mkdtempSync(join(tmpdir(), "omr-e2e-home-"));
    git(repo, "init", "-q");
    git(repo, "config", "core.autocrlf", "false");
    git(repo, "config", "user.email", "e2e@example.invalid");
    git(repo, "config", "user.name", "e2e");
    writeFileSync(join(repo, "README.md"), "fixture\n", "utf-8");
    git(repo, "add", "README.md");
    git(repo, "commit", "-q", "-m", "init");
  });

  afterAll(() => {
    for (const dir of [repo, home]) if (dir !== "") rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("defers a real task dispatch, lists it for the orchestrator, and samples the machine", async () => {
    const sampler = startSampler({ intervalMs: 100 });
    const plugin = await createE2EPlugin({ directory: repo, home });
    let snapshots: Snapshot[] = [];
    try {
      const res = await plugin.task({
        sessionID: "orch1",
        callID: "c1",
        prompt: `Add a file.\n${acceptance()}`,
        description: "add a file",
        produce: async () => {
          writeFileSync(join(repo, "added.ts"), "export const added = 1;\n", "utf-8");
        },
      });
      // The output ends with the router footer: only `[router]` lines after the task result, the
      // first of them the deferred line `[router] unverified · vrf_<24 hex> · risk <level>`.
      const tail = res.output.slice(res.output.lastIndexOf("</task_result>") + "</task_result>".length).trim().split("\n");
      expect(tail.every(line => line.startsWith("[router] ")), res.output).toBe(true);
      const handle = /^\[router\] unverified \u00b7 (vrf_[0-9a-f]{24}) \u00b7 risk \S+/.exec(tail[0])?.[1];
      expect(handle, res.output).toBeDefined();
      const system = await plugin.systemPrompt("orch1");
      expect(system.some(s => s.includes(handle as string))).toBe(true);
      console.log(`[self-check] task beforeMs=${res.beforeMs.toFixed(1)} afterMs=${res.afterMs.toFixed(1)} handle=${handle}`);
      // Keep sampling long enough for a stable interval estimate.
      await new Promise(resolve => setTimeout(resolve, 2500));
    } finally {
      await plugin.dispose();
      snapshots = await sampler.stop();
    }

    expect(snapshots.length).toBeGreaterThanOrEqual(5);
    const self = snapshots.filter(s => s.procs.some(p => p.pid === process.pid));
    expect(self.length).toBeGreaterThanOrEqual(5);
    // The sampler itself is a child of this process; excluding it leaves it out.
    const withSampler = descendantsOf(self[self.length - 1], process.pid, []);
    expect(withSampler.some(p => p.pid === sampler.pid)).toBe(true);
    expect(descendantsOf(self[self.length - 1], process.pid, [sampler.pid]).some(p => p.pid === sampler.pid)).toBe(false);

    const gaps = snapshots.slice(1).map((s, i) => s.t - snapshots[i].t).sort((a, b) => a - b);
    console.log(
      `[self-check] snapshots=${snapshots.length} procs/snapshot~${snapshots[0].procs.length} ` +
        `interval median=${percentile(gaps, 50)}ms p95=${percentile(gaps, 95)}ms min=${gaps[0]}ms max=${gaps[gaps.length - 1]}ms`,
    );
  }, 60_000);
});
