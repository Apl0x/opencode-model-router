/**
 * Deterministic risk signal for deferred delegations (plan §1.5-17, Phase 1.6.2).
 *
 * Pure and synchronous: no process, no fs, no network. The caller runs the static planner
 * (`planStaticScoping`) and passes its result in as `scopingPlan`.
 *
 * Fixed table (evaluated in this order; the level is the maximum of every matching row, then the
 * adjustment rows apply once):
 *
 * | #  | Condition                                                         | Level / effect         |
 * |----|-------------------------------------------------------------------|------------------------|
 * | 1  | no changed files                                                  | low, stop              |
 * | 2  | every changed file is documentation (docs/**, *.md, *.mdx, *.rst, *.txt) | low, stop       |
 * | 3  | 1–5 changed files                                                 | low                    |
 * | 4  | 6–15 changed files                                                | medium                 |
 * | 5  | 16 or more changed files                                          | high                   |
 * | 6  | a test file was deleted                                           | high                   |
 * | 7  | a test file was modified (added, changed or renamed)              | medium                 |
 * | 8  | a non-test file was deleted or any file was renamed               | medium                 |
 * | 9  | config / lock / CI file changed (package.json, lockfiles, tsconfig*.json, vitest|jest.config.*, conftest.py, pyproject.toml, .github/**) | medium |
 * | 10 | scoping impossible (Unverifiable, S6)                             | medium                 |
 * | 11 | producer tier "fast"                                              | medium                 |
 * | 12 | no reference captured                                             | +1 step (max high)     |
 *
 * Rows 1–2 short-circuit: nothing else is evaluated. A `NoAffected` scoping plan adds the
 * informational reason REASONS.noAffected without changing the level. Reasons are stable strings
 * (they are shown to the orchestrator) and appear in table order.
 */
import type { ChangedPath, StaticScoping } from "./runner";

export type RiskLevel = "low" | "medium" | "high";
export type ProducerTier = "fast" | "medium" | "heavy" | (string & {});

export interface RiskInput {
  readonly changedFiles: readonly ChangedPath[];
  /** Whether a reference (baseline) exists for this delegation. Only presence matters. */
  readonly reference: boolean;
  readonly producerTier: ProducerTier;
  readonly scopingPlan: StaticScoping;
}

export interface RiskAssessment {
  readonly level: RiskLevel;
  readonly reasons: string[];
}

export const SMALL_CHANGE_MAX = 5;
export const MEDIUM_CHANGE_MAX = 15;

export const REASONS = {
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
} as const;

const ORDER: readonly RiskLevel[] = ["low", "medium", "high"];

function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

function base(p: string): string {
  const n = norm(p);
  return n.slice(n.lastIndexOf("/") + 1);
}

export function isDocPath(p: string): boolean {
  const n = norm(p);
  return /(^|\/)docs\//i.test(n) || /\.(md|mdx|rst|txt)$/i.test(n);
}

export function isTestPath(p: string): boolean {
  const n = norm(p);
  const b = base(n);
  return (
    /(^|\/)(test|tests|__tests__)\//.test(n) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(b) ||
    /^test_.*\.py$/.test(b) ||
    /_test\.py$/.test(b)
  );
}

export function isConfigPath(p: string): boolean {
  const n = norm(p);
  const b = base(n);
  return (
    /(^|\/)\.github\//.test(n) ||
    b === "package.json" ||
    b === "package-lock.json" ||
    b === "npm-shrinkwrap.json" ||
    b === "yarn.lock" ||
    b === "pnpm-lock.yaml" ||
    b === "bun.lockb" ||
    b === "bun.lock" ||
    b === "poetry.lock" ||
    b === "uv.lock" ||
    b === "Pipfile.lock" ||
    /^tsconfig.*\.json$/.test(b) ||
    /^(vitest|jest)\.config\./.test(b) ||
    b === "conftest.py" ||
    b === "pyproject.toml"
  );
}

function isDeleted(f: ChangedPath): boolean {
  return f.status !== undefined && /^d/i.test(f.status.trim());
}

function isRenamed(f: ChangedPath): boolean {
  return f.previousPath !== undefined || (f.status !== undefined && /^r/i.test(f.status.trim()));
}

export function assessRisk(input: RiskInput): RiskAssessment {
  const { changedFiles, reference, producerTier, scopingPlan } = input;

  if (changedFiles.length === 0) return { level: "low", reasons: [REASONS.empty] };
  if (changedFiles.every((f) => isDocPath(f.path) && (f.previousPath === undefined || isDocPath(f.previousPath)))) {
    return { level: "low", reasons: [REASONS.docsOnly] };
  }

  let idx = 0;
  const reasons: string[] = [];
  const hit = (level: RiskLevel, reason: string): void => {
    idx = Math.max(idx, ORDER.indexOf(level));
    reasons.push(reason);
  };

  const n = changedFiles.length;
  if (n <= SMALL_CHANGE_MAX) hit("low", REASONS.small);
  else if (n <= MEDIUM_CHANGE_MAX) hit("medium", REASONS.mediumCount);
  else hit("high", REASONS.largeCount);

  const touchesTest = (f: ChangedPath): boolean =>
    isTestPath(f.path) || (f.previousPath !== undefined && isTestPath(f.previousPath));

  if (changedFiles.some((f) => isDeleted(f) && touchesTest(f))) hit("high", REASONS.testDeleted);
  else if (changedFiles.some(touchesTest)) hit("medium", REASONS.testModified);

  if (changedFiles.some((f) => (isDeleted(f) && !touchesTest(f)) || isRenamed(f))) {
    hit("medium", REASONS.deletedOrRenamed);
  }
  if (changedFiles.some((f) => isConfigPath(f.path) || (f.previousPath !== undefined && isConfigPath(f.previousPath)))) {
    hit("medium", REASONS.configChanged);
  }

  if ("unverifiable" in scopingPlan && scopingPlan.unverifiable === true) hit("medium", REASONS.unverifiable);
  else if ("noAffected" in scopingPlan && scopingPlan.noAffected === true) reasons.push(REASONS.noAffected);

  if (producerTier === "fast") hit("medium", REASONS.fastTier);

  if (!reference) {
    idx = Math.min(idx + 1, ORDER.length - 1);
    reasons.push(REASONS.noReference);
  }

  return { level: ORDER[idx] ?? "high", reasons };
}
