// Runner-independent comparison with opportunistic text/JSON adapters.
import type {
  ExecResult, FailureClassification, JudgeScoped, RecheckOutcome, ScopedOutcome, TestsPassJudgement,
} from "./types";
import type { RunResult } from "./runner";
import { scrubText } from "../guard/scrub";

export interface TestObservation {
  code: number;
  failures: string[];
  count?: number;
  complete: boolean;
}

/**
 * T7 u4: the stable ReferenceState "none" reasons. The store (dispatch.ts) produces all but
 * `untracked`, which is also runDeterministic's default when a gate carries no reference.
 */
export const REFERENCE_NONE = {
  failed: "the dispatch-time capture failed or timed out",
  contaminated: "an edit was observed in an overlapping directory before the capture resolved",
  untracked: "the dispatch was not tracked",
  gateBudget: "the capture had not resolved within the gate budget",
  /** The dispatch's DoD had no allowlisted testsPass check (or verify.require was "never"). */
  notRequested: "no testsPass check was declared at dispatch",
} as const;

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

/** T7 <ids>: at most 10 ids, then " (+<k> more)". */
export function formatIds(ids: readonly string[]): string {
  if (ids.length === 0) return "(none)";
  const shown = ids.slice(0, 10).join(", ");
  return ids.length > 10 ? `${shown} (+${ids.length - 10} more)` : shown;
}

const unverifiable = (reason: string, failures?: FailureClassification): TestsPassJudgement =>
  failures ? { ok: false, unverifiable: true, reason, failures } : { ok: false, unverifiable: true, reason };

/** T5.5: classify each scoped failing id against an exact recheck. */
function classify(c: RunResult, recheck: Extract<RecheckOutcome, { kind: "exact" }>): FailureClassification {
  const r = recheck.result;
  const ran = new Set(recheck.ranFiles);
  const absent = new Set(recheck.absentFiles);
  const refFailing = new Set(r?.failingIds ?? []);
  const refFileKeys = new Set((r?.failingIds ?? []).map(fileKeyOfId));
  const introduced: string[] = [];
  const preexisting: string[] = [];
  const unknown: string[] = [];
  for (const x of c.failingIds) {
    const f = fileKeyOfId(x);
    const bare = f === x.replace(/\\/g, "/");
    if (absent.has(f)) introduced.push(x);
    else if (!ran.has(f)) unknown.push(x);
    // A bare-file id (collection error now) is never pre-existing; its file ran, so it is introduced.
    else if (bare) introduced.push(x);
    else if (refFailing.has(x)) preexisting.push(x);
    else if (c.source === "report") introduced.push(x);
    else if (!refFileKeys.has(f)) introduced.push(x);
    else unknown.push(x);
  }
  return { introduced, preexisting, unknown };
}

/**
 * The verdict algebra (deterministic.ts header, T5-T7). Pure and total: a failure passes only when
 * proven pre-existing at an exact reference with a complete scoped inventory (G1), and fails only
 * when at least one id is proven introduced (G2).
 */
export const judgeScoped: JudgeScoped = (scoped: ScopedOutcome, recheck: RecheckOutcome | undefined): TestsPassJudgement => {
  switch (scoped.kind) {
    case "no-affected":
      return { ok: true, unverifiable: false, note: scoped.note };
    case "unverifiable":
      return unverifiable(`testsPass: scoping impossible (${scoped.code}): ${scoped.reason}`);
    case "slot-busy":
      return unverifiable(scoped.deadlineCut
        ? "gate budget exhausted waiting for the verification slot"
        : `verification slot busy (waited ${scoped.waitedMs}ms)`);
    case "timed-out":
      return unverifiable(`testsPass timed out after ${scoped.boundMs}ms`);
    case "aborted":
      return unverifiable(`testsPass: ${scoped.reason}`);
    case "error":
      return unverifiable(`testsPass check errored: ${scrubText(scoped.reason)}`);
    case "ran":
      break;
  }
  const c = scoped.result;
  const note = c.note ?? "no details";
  if (c.complete && !c.collectionError && c.failingIds.length === 0) {
    const runner = scoped.spec?.runner ?? "full";
    const total = c.total ?? "unknown";
    const evidence = `testsPass: affected tests passed (${runner}, ${total} tests)`;
    return c.total === 0
      ? { ok: true, unverifiable: false, evidence, note: "testsPass: no affected tests ran" }
      : { ok: true, unverifiable: false, evidence };
  }
  const observed = `; observed failures: ${formatIds(c.failingIds)}`;
  if (c.failingIds.length === 0) {
    return c.collectionError
      ? unverifiable(`testsPass: collection error without failing test files: ${note}${observed}`)
      : unverifiable(`testsPass: the scoped result is incomplete: ${note} (exit ${scoped.exitCode})`);
  }
  if (recheck === undefined) {
    return unverifiable(c.collectionError
      ? `testsPass: collection error without failing test files: ${note}${observed}`
      : `testsPass: cannot attribute failures: no failing test file identified, recheck not attempted${observed}`);
  }
  switch (recheck.kind) {
    case "approximate": {
      const causes = recheck.inexactReasons.map(r => (r.path ? `${r.cause} ${r.path}` : r.cause));
      return unverifiable(`testsPass: cannot attribute failures: the dispatch reference is approximate (${formatIds(causes)})${observed}`);
    }
    case "unusable":
      return unverifiable(recheck.cause === "no-reference"
        ? `testsPass: no reference: pre-existing failures cannot be told apart (${recheck.reason})${observed}`
        : `testsPass: cannot attribute failures: reference unusable (${recheck.cause}): ${recheck.reason}${observed}`);
    case "disabled":
      return unverifiable(`testsPass: cannot attribute failures: failureRecheck is off, pre-existing failures cannot be told apart${observed}`);
    case "timed-out":
      return unverifiable(`testsPass: cannot attribute failures: the reference rerun timed out after ${recheck.boundMs}ms${observed}`);
    case "skipped-deadline":
      return unverifiable(`testsPass: gate budget exhausted before recheck${observed}`);
    case "exact":
      break;
  }
  const failures = classify(c, recheck);
  if (failures.introduced.length > 0) {
    const reason = `testsPass: introduced failures: ${formatIds(failures.introduced)}${observed}`;
    return failures.preexisting.length > 0
      ? { ok: false, unverifiable: false, reason, note: `testsPass: also failing at the dispatch reference: ${formatIds(failures.preexisting)}`, failures }
      : { ok: false, unverifiable: false, reason, failures };
  }
  if (failures.unknown.length === 0 && c.complete && !c.collectionError) {
    return {
      ok: true, unverifiable: false, failures,
      note: `testsPass: no worse than before; pre-existing failures: ${formatIds(failures.preexisting)}; suite is NOT green (affected tests checked against the exact dispatch reference)`,
    };
  }
  if (failures.unknown.length > 0) {
    return unverifiable(`testsPass: cannot prove failures predate dispatch: ${formatIds(failures.unknown)}${observed}`, failures);
  }
  return unverifiable(`testsPass: the scoped failure inventory is incomplete (${c.note ?? "collection error"}); known failures predate dispatch, others may not${observed}`, failures);
};
