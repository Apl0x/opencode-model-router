// Self-check for the e2e fixture projects (plan §3.1.1). Opt-in: RUN_VERIFY_E2E=1, because it
// installs real dependencies (npm ci, uv sync). Each fixture is materialised twice (clean and
// with the committed pre-existing failure) and its own test command is run in the temp repo.
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  e2eEnabled,
  prepareFixtureRepo,
  runFixtureTests,
  toolAvailable,
  type FixtureName,
  type FixtureRepo,
} from "./fixture-repo.js";

const ROOT = join(tmpdir(), `omr-e2e-${randomBytes(4).toString("hex")}`);
const TIMEOUT = 300_000;

const CASES: { name: FixtureName; testDir: string; pattern: RegExp; min: number }[] = [
  { name: "vitest-app", testDir: "test", pattern: /\.test\.js$/, min: 40 },
  { name: "jest-app", testDir: "test", pattern: /\.test\.js$/, min: 20 },
  { name: "pytest-app", testDir: "tests", pattern: /^test_.*\.py$/, min: 20 },
];

function countFailed(output: string): number | undefined {
  // vitest "Tests  1 failed | 125 passed", jest "Tests:       1 failed, 63 passed",
  // pytest "1 failed, 63 passed in 0.2s". Loose on purpose.
  const m = /Tests:?\s+(\d+) failed/.exec(output) ?? /=+ (\d+) failed/.exec(output);
  return m ? Number(m[1]) : undefined;
}

const suite = e2eEnabled() ? describe : describe.skip;

suite("e2e fixtures self-check", () => {
  const repos: FixtureRepo[] = [];
  const uvMissing = !toolAvailable("uv");

  afterAll(async () => {
    for (const r of repos) await r.dispose();
    await rm(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }, TIMEOUT);

  for (const c of CASES) {
    const skipPython = c.name === "pytest-app" && uvMissing && !process.env.CI;
    const test = skipPython ? it.skip : it;
    if (skipPython) console.warn(`[e2e] uv not found: skipping ${c.name} (it is required in CI)`);

    test(`${c.name}: clean repo passes`, { timeout: TIMEOUT }, async () => {
      const started = Date.now();
      const repo = await prepareFixtureRepo(c.name, { root: ROOT });
      repos.push(repo);
      console.log(`[e2e] ${c.name} prepared (copy+git+install) in ${Date.now() - started} ms`);
      expect(existsSync(repo.sentinelPath)).toBe(true);
      expect(repo.git("status", "--porcelain")).toBe("");

      const files = readdirSync(join(repo.dir, c.testDir)).filter((f) => c.pattern.test(f));
      expect(files.length).toBeGreaterThanOrEqual(c.min);

      const r = runFixtureTests(repo);
      console.log(`[e2e] ${c.name} clean run: exit ${String(r.status)} in ${r.ms} ms`);
      expect(r.status, r.stdout + r.stderr).toBe(0);
    });

    test(`${c.name}: committed pre-existing failure fails exactly one test`, { timeout: TIMEOUT }, async () => {
      const started = Date.now();
      const repo = await prepareFixtureRepo(c.name, { root: ROOT, preexisting: true });
      repos.push(repo);
      console.log(`[e2e] ${c.name} prepared with preexisting in ${Date.now() - started} ms`);
      expect(repo.git("log", "-1", "--format=%s")).toBe("preexisting failure");
      expect(repo.git("status", "--porcelain")).toBe("");

      const r = runFixtureTests(repo);
      const out = r.stdout + r.stderr;
      console.log(`[e2e] ${c.name} preexisting run: exit ${String(r.status)} in ${r.ms} ms`);
      expect(r.status, out).not.toBe(0);
      expect(countFailed(out), out).toBe(1);
    });
  }
});
