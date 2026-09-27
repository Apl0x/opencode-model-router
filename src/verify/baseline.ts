// Runner-independent comparison with opportunistic text/JSON adapters.
import type { ExecResult } from "./types";

export interface TestObservation {
  code: number;
  failures: string[];
  count?: number;
  complete: boolean;
}

export interface TestBaseline {
  observation: TestObservation;
  dirty: boolean;
}

export function observeTests(result: ExecResult): TestObservation {
  const text = (result.stdout + "\n" + result.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  const failures = new Set<string>();
  let count: number | undefined;
  // Counts are only test counts, never file/suite counts. Unknown formats remain
  // useful at the exit-code floor; they must not throw or invent identities.
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const summary = /^(?:Tests:|Tests\s|=+\s|\d+\s+(?:passing|passed))/.test(trimmed)
      || /^\d+\s+(?:failed|failing)\b/.test(trimmed);
    const n = summary ? /\b(\d+)\s+(?:failed|failing)\b/.exec(trimmed) : null;
    if (n) count = Math.max(count ?? 0, Number(n[1]));
    const id = /^FAILED\s+(\S+)(?:\s+-|$)/.exec(trimmed)?.[1]
      ?? /^FAIL\s+(.+\s+>\s+.+)$/.exec(trimmed)?.[1]
      ?? /^--- FAIL:\s+(.+?)\s+\([\d.]+s\)$/.exec(trimmed)?.[1];
    if (id) failures.add(id);
  }
  // Jest's JSON reporter (also used by compatible runners). Only complete
  // assertion inventories count as identity evidence, not suite-level FAILs.
  try {
    const json: unknown = JSON.parse(result.stdout);
    if (json && typeof json === "object" && "testResults" in json && Array.isArray(json.testResults)) {
      for (const suite of json.testResults) {
        if (!suite || typeof suite !== "object" || !Array.isArray(suite.assertionResults)) continue;
        for (const test of suite.assertionResults) {
          if (test?.status === "failed" && typeof test.fullName === "string") {
            failures.add(`${String(suite.name ?? "")} > ${test.fullName}`);
          }
        }
      }
      if ("numFailedTests" in json && typeof json.numFailedTests === "number") count = json.numFailedTests;
    }
  } catch {
    // Not a JSON reporter; the text observations above still apply.
  }
  return {
    code: result.code, failures: [...failures].sort(), count,
    complete: result.code === 0 || (count !== undefined && count > 0 && count === failures.size),
  };
}

/**
 * The id-space file key of a RunResult id (deterministic.ts header, T5): the part before the first
 * " > ", else before the first "::", else the whole (bare-file) id; "/" separators.
 */
export function fileKeyOfId(id: string): string {
  const vitest = id.indexOf(" > ");
  const pytest = id.indexOf("::");
  const file = vitest >= 0 ? id.slice(0, vitest) : pytest >= 0 ? id.slice(0, pytest) : id;
  return file.replace(/\\/g, "/");
}

export function compareTests(after: TestObservation, baseline?: TestBaseline): {
  ok: boolean; unverifiable?: boolean; reason?: string; evidence?: string; note?: string;
} {
  const observed = `observed failures: ${after.failures.join(", ") || "(identities unavailable)"}; count=${after.count ?? "unknown"}; exit=${after.code}`;
  const unavailable = (why: string) => ({ ok: false, unverifiable: true, reason: `testsPass: ${why}; ${observed}` });
  if (!baseline) return unavailable("no usable dispatch-time baseline");
  const before = baseline.observation;
  if (after.code === 0) return { ok: true, evidence: "testsPass: suite is green (exit 0)" };
  const added = after.failures.filter(id => !before.failures.includes(id));
  if (before.code === 0 || (before.complete && added.length > 0) ||
      (before.count !== undefined && after.count !== undefined && after.count > before.count)) {
    const named = before.code === 0 || before.complete ? added : [];
    return { ok: false, reason: `testsPass: introduced failures: ${named.join(", ") || `failure count ${before.count ?? 0} -> ${after.count ?? "unknown"}, exit ${after.code}`}` };
  }
  if (before.complete && after.complete && added.length === 0) {
    const note = `testsPass: no worse than before; pre-existing failures: ${after.failures.join(", ")}; suite is NOT green; baseline tree was ${baseline.dirty ? "dirty" : "clean"}`;
    return { ok: true, evidence: note, note };
  }
  // Equal counts or equal non-zero exits cannot prove that the identities are
  // unchanged. Under-excuse rather than silently replace an old failure by a new one.
  return unavailable(`baseline exit=${before.code}, count=${before.count ?? "unknown"}; cannot prove failures predate dispatch`);
}
