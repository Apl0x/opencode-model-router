import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { assessRisk, REASONS, MEDIUM_CHANGE_MAX, SMALL_CHANGE_MAX, type RiskInput } from "../../src/verify/risk";
import type { ChangedPath, StaticScoping } from "../../src/verify/runner";

const scopable: StaticScoping = { scopable: true, runner: "vitest", pendingSearches: 0, notes: [] };
const noAffected: StaticScoping = { noAffected: true, note: "none" };
const unverifiable: StaticScoping = { unverifiable: true, reason: "x", code: "no-git-root" };

function files(n: number, prefix = "src/f"): ChangedPath[] {
  return Array.from({ length: n }, (_, i) => ({ path: `${prefix}${i}.ts`, status: "M" }));
}

function run(over: Partial<RiskInput>): ReturnType<typeof assessRisk> {
  return assessRisk({ changedFiles: files(1), reference: true, producerTier: "medium", scopingPlan: scopable, ...over });
}

describe("assessRisk", () => {
  it("row 1: empty change set is low with the exact reason", () => {
    expect(run({ changedFiles: [], reference: false })).toEqual({ level: "low", reasons: ["no changes attributed"] });
  });

  it("row 2: docs-only is low", () => {
    const r = run({ changedFiles: [{ path: "docs/a.md" }, { path: "README.md" }, { path: "docs\\x\\y.png" }] });
    expect(r).toEqual({ level: "low", reasons: [REASONS.docsOnly] });
  });

  it("rows 3-5: file-count boundaries", () => {
    expect(run({ changedFiles: files(1) })).toEqual({ level: "low", reasons: [REASONS.small] });
    expect(run({ changedFiles: files(SMALL_CHANGE_MAX) }).level).toBe("low");
    expect(run({ changedFiles: files(SMALL_CHANGE_MAX + 1) })).toEqual({ level: "medium", reasons: [REASONS.mediumCount] });
    expect(run({ changedFiles: files(MEDIUM_CHANGE_MAX) }).level).toBe("medium");
    expect(run({ changedFiles: files(MEDIUM_CHANGE_MAX + 1) })).toEqual({ level: "high", reasons: [REASONS.largeCount] });
    expect([SMALL_CHANGE_MAX, MEDIUM_CHANGE_MAX]).toEqual([5, 15]);
  });

  it("row 6: a deleted test file is high", () => {
    for (const path of ["test/unit/a.test.ts", "src/a.spec.tsx", "pkg/test_x.py", "pkg/x_test.py", "src/__tests__/a.js"]) {
      const r = run({ changedFiles: [{ path, status: "D" }] });
      expect(r.level).toBe("high");
      expect(r.reasons).toContain(REASONS.testDeleted);
    }
    expect(run({ changedFiles: [{ path: "test/a.test.ts", status: "deleted" }] }).level).toBe("high");
  });

  it("row 7: a modified test file is medium", () => {
    expect(run({ changedFiles: [{ path: "test/unit/a.test.ts", status: "M" }] })).toEqual({
      level: "medium",
      reasons: [REASONS.small, REASONS.testModified],
    });
  });

  it("row 8: non-test deletion or rename is medium", () => {
    expect(run({ changedFiles: [{ path: "src/a.ts", status: "D" }] })).toEqual({
      level: "medium",
      reasons: [REASONS.small, REASONS.deletedOrRenamed],
    });
    expect(run({ changedFiles: [{ path: "src/b.ts", previousPath: "src/a.ts" }] }).reasons).toContain(REASONS.deletedOrRenamed);
    expect(run({ changedFiles: [{ path: "src/b.ts", status: "R100" }] }).level).toBe("medium");
  });

  it("row 9: config, lock or CI change is at least medium", () => {
    for (const path of [
      "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "tsconfig.build.json",
      "vitest.config.ts", "jest.config.js", "conftest.py", "pyproject.toml", ".github/workflows/ci.yml",
      ".github/CODEOWNERS",
    ]) {
      const r = run({ changedFiles: [{ path, status: "M" }] });
      expect(ORDER(r.level)).toBeGreaterThanOrEqual(1);
      expect(r.reasons).toContain(REASONS.configChanged);
    }
  });

  it("row 10: scoping impossible adds a reason and is medium", () => {
    expect(run({ scopingPlan: unverifiable })).toEqual({ level: "medium", reasons: [REASONS.small, REASONS.unverifiable] });
  });

  it("NoAffected adds an informational reason only", () => {
    expect(run({ scopingPlan: noAffected })).toEqual({ level: "low", reasons: [REASONS.small, REASONS.noAffected] });
  });

  it("row 11: fast tier is medium; other tiers do not raise", () => {
    expect(run({ producerTier: "fast" })).toEqual({ level: "medium", reasons: [REASONS.small, REASONS.fastTier] });
    expect(run({ producerTier: "heavy" }).level).toBe("low");
  });

  it("row 12: no reference raises one step, capped at high", () => {
    expect(run({ reference: false })).toEqual({ level: "medium", reasons: [REASONS.small, REASONS.noReference] });
    expect(run({ reference: false, changedFiles: files(6) }).level).toBe("high");
    expect(run({ reference: false, changedFiles: files(16) })).toEqual({
      level: "high",
      reasons: [REASONS.largeCount, REASONS.noReference],
    });
  });

  it("a destructive change is never low", () => {
    const r = run({ changedFiles: [...files(1), { path: "test/a.test.ts", status: "D" }, { path: ".github/x.yml" }] });
    expect(r.level).toBe("high");
  });

  it("reasons are stable strings", () => {
    expect(REASONS).toEqual({
      empty: "no changes attributed",
      docsOnly: "documentation-only change",
      small: "1-5 files changed",
      mediumCount: "6-15 files changed",
      largeCount: "16 or more files changed",
      testDeleted: "a test file was deleted",
      testModified: "a test file was modified",
      deletedOrRenamed: "files were deleted or renamed",
      configChanged: "config, lock or CI files changed",
      unverifiable: "scoping impossible (S6): the change cannot be verified by scoped tests",
      noAffected: "no affected tests found by static scoping",
      fastTier: "produced by the fast tier",
      noReference: "no reference captured: risk raised one step",
    });
  });

  it("risk.ts imports nothing with side effects", () => {
    const src = readFileSync(new URL("../../src/verify/risk.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/child_process|from "(node:)?fs|http|net"/);
    expect(src.match(/^import .*$/gm)).toEqual(['import type { ChangedPath, StaticScoping } from "./runner";']);
  });
});

function ORDER(l: string): number {
  return ["low", "medium", "high"].indexOf(l);
}
