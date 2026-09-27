// src/verify/deterministic.ts
// Deterministic verifier: runs DoD checks using injected seams (no real fs/exec imports).
// PURE: no I/O-capable Node built-ins; all I/O goes through DeterministicDeps
// seams. ./paths is pure path math (node:path only) and keeps that contract.

import type { Check, DoD } from "./dod";
import type { Verdict, DeterministicDeps, MutexRegistry, ExecResult } from "./types";
import { scrubText } from "../guard/scrub";
import { resolveAgainst } from "./paths";
import { isAbsolute } from "node:path";
import { compareTests, observeTests } from "./baseline";

// ---------------------------------------------------------------------------
// MutexRegistry — per-key serialization via promise-chaining
// ---------------------------------------------------------------------------

export function createMutexRegistry(): MutexRegistry {
  const chains = new Map<string, Promise<unknown>>();
  return {
    runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const prev = chains.get(key) ?? Promise.resolve();
      const run = prev.then(() => fn(), () => fn());
      // Tail swallows errors so the lock never wedges; run still rejects/resolves with fn's result.
      chains.set(key, run.then(() => {}, () => {}));
      return run;
    },
  };
}

// ---------------------------------------------------------------------------
// Command validation
// ---------------------------------------------------------------------------

export const DEFAULT_ALLOWLIST = [
  "npm", "npx", "pnpm", "yarn", "bun", "node",
  "tsc", "tsx", "vitest", "jest", "eslint", "prettier", "pytest",
];

// Any shell-chaining / redirection / substitution metacharacter.
// eslint-disable-next-line no-useless-escape
export const FORBIDDEN_SHELL = /[;&|`$><\n]|\$\(|&&|\|\|/;

// Interpreters that can execute arbitrary inline code via a flag. An allowlisted
// interpreter must not be turned into an arbitrary-code runner (e.g. `node -e ...`).
const INTERPRETERS = new Set([
  "node", "deno", "bun", "tsx", "ts-node", "python", "python3", "ruby", "perl",
]);
// Inline-eval / inline-print flags: -e, -c, -p, --eval, --print (with optional =value).
const EVAL_FLAG_RE = /^-(e|c|p)$|^--(eval|print)(=|$)/i;

export function isCommandAllowed(command: string, allowlist: string[]): boolean {
  const trimmed = command.trim();
  if (!trimmed || FORBIDDEN_SHELL.test(command)) return false;
  const tokens = trimmed.split(/\s+/);
  const firstToken = tokens[0];
  const parts = firstToken.split(/[/\\]/);
  const basename = parts[parts.length - 1];
  // `uv` is never allowlisted as such: only `uv run pytest ...` passes, and only when pytest is
  // allowed. This runs before the generic check so a user allowlist containing "uv" cannot widen it.
  if (basename.replace(/\.(exe|cmd|bat)$/i, "") === "uv") {
    return allowlist.includes("pytest") && tokens[1] === "run" && tokens[2] === "pytest";
  }
  if (!allowlist.includes(basename)) return false;
  // Strip a Windows executable suffix before the interpreter check.
  const interpreterBase = basename.replace(/\.(exe|cmd|bat)$/i, "");
  if (INTERPRETERS.has(interpreterBase)) {
    for (const t of tokens.slice(1)) {
      if (EVAL_FLAG_RE.test(t)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Shape check (exported for unit testing)
// ---------------------------------------------------------------------------

export function shapeMismatch(
  schemaVal: unknown,
  targetVal: unknown,
  path = "",
): string | null {
  if (schemaVal !== null && typeof schemaVal === "object" && !Array.isArray(schemaVal)) {
    // schema is a plain object
    if (targetVal === null || typeof targetVal !== "object" || Array.isArray(targetVal)) {
      return `${path || "<root>"}: expected object`;
    }
    const schemaObj = schemaVal as Record<string, unknown>;
    const targetObj = targetVal as Record<string, unknown>;
    for (const k of Object.keys(schemaObj)) {
      if (!(k in targetObj)) return `${path}${k}: missing`;
      const nested = shapeMismatch(schemaObj[k], targetObj[k], `${path}${k}.`);
      if (nested !== null) return nested;
    }
    return null;
  } else if (Array.isArray(schemaVal)) {
    if (!Array.isArray(targetVal)) return `${path || "<root>"}: expected array`;
    return null; // presence of array suffices; elements/length not checked
  } else {
    // primitive
    if (typeof schemaVal !== typeof targetVal) {
      return `${path || "<root>"}: expected ${typeof schemaVal}, got ${typeof targetVal}`;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal runner result
// ---------------------------------------------------------------------------

interface CheckResult {
  ok: boolean;
  note?: string;
  unverifiable?: boolean;
  reason?: string;
  evidence?: string;
}

// ---------------------------------------------------------------------------
// Per-kind runners
// ---------------------------------------------------------------------------

async function runFileExists(check: Check, deps: DeterministicDeps): Promise<CheckResult> {
  try {
    if (!check.path) return { ok: false, reason: "fileExists check missing 'path'" };
    if (!deps.cwd && !isAbsolute(check.path)) return { ok: false, unverifiable: true, reason: `fileExists path cannot be resolved without a declared working directory: ${check.path}` };
    const resolved = resolveAgainst(deps.cwd, check.path);
    const ok = await deps.fs.fileExists(resolved);
    if (ok) return { ok: true, evidence: `exists: ${check.path}` };
    // An absolute check path ignores deps.cwd entirely, so claiming the file
    // was missing "in <cwd>" would name a directory the check never looked in.
    return isAbsolute(check.path)
      ? { ok: false, reason: `file not found: ${resolved}` }
      : { ok: false, reason: `file not found in ${deps.cwd}: ${check.path}` };
  } catch (err) {
    return { ok: false, reason: `fileExists check errored: ${scrubText(String(err))}` };
  }
}

async function runRun(
  check: Check,
  deps: DeterministicDeps,
  allowlist: string[],
  timeoutMs: number,
): Promise<CheckResult> {
  try {
    if (!check.command) return { ok: false, reason: "run check missing 'command'" };
    if (!isCommandAllowed(check.command, allowlist)) {
      return { ok: false, unverifiable: true, reason: `command not allowlisted: ${check.command}` };
    }
    const r: ExecResult = await deps.exec(check.command, { cwd: deps.cwd, timeoutMs });
    if (r.timedOut) {
      return { ok: false, reason: `run timed out after ${timeoutMs}ms: ${check.command}` };
    }
    const out = r.stdout + "\n" + r.stderr;
    if (check.expect !== undefined && !out.includes(check.expect)) {
      return {
        ok: false,
        reason: `expected substring not found: "${check.expect}"`,
        evidence: out.slice(0, 2000),
      };
    }
    const ok = r.code === 0;
    if (!ok) {
      return {
        ok: false,
        reason: `command exited ${r.code}: ${check.command}`,
        evidence: out.slice(0, 2000),
      };
    }
    return { ok: true, evidence: `exit 0: ${check.command}` };
  } catch (err) {
    return { ok: false, reason: `run check errored: ${scrubText(String(err))}` };
  }
}

export function resolveRepoCommand(
  check: Check,
  kind: "testsPass" | "buildPasses" | "lintClean",
  defaults: DeterministicDeps["defaults"],
): string {
  if (check.command) return check.command;
  if (kind === "testsPass") return defaults?.testCommand ?? "npm test";
  if (kind === "buildPasses") return defaults?.buildCommand ?? "npm run build";
  return defaults?.lintCommand ?? "npm run lint";
}

async function runCommandCheck(
  check: Check,
  kind: "testsPass" | "buildPasses" | "lintClean",
  deps: DeterministicDeps,
  allowlist: string[],
  timeoutMs: number,
): Promise<CheckResult> {
  let command = resolveRepoCommand(check, kind, deps.defaults);
  if (kind === "buildPasses" && !check.command && !deps.defaults?.buildCommand) {
    try {
      const packagePath = resolveAgainst(deps.cwd, "package.json");
      let hasBuild = false;
      if (await deps.fs.fileExists(packagePath)) {
        const pkg: unknown = JSON.parse(await deps.fs.readFile(packagePath));
        if (pkg && typeof pkg === "object" && "scripts" in pkg) {
          const scripts = pkg.scripts;
          hasBuild = !!(scripts && typeof scripts === "object" && "build" in scripts && typeof scripts.build === "string" && scripts.build.trim());
        }
      }
      if (hasBuild) command = "npm run build";
      else if (await deps.fs.fileExists(resolveAgainst(deps.cwd, "tsconfig.json"))) command = "npx tsc --noEmit";
      else return { ok: false, unverifiable: true, reason: "buildPasses: no build script or root tsconfig.json" };
    } catch (err) {
      return { ok: false, unverifiable: true, reason: `buildPasses probe failed: ${scrubText(String(err))}` };
    }
  }

  const fn = async (): Promise<CheckResult> => {
    try {
      if (!isCommandAllowed(command, allowlist)) {
        return { ok: false, unverifiable: true, reason: `command not allowlisted: ${command}` };
      }
      const baseline = kind === "testsPass" ? await deps.testBaseline?.(command) : undefined;
      const r: ExecResult = await deps.exec(command, { cwd: deps.cwd, timeoutMs });
      if (r.timedOut) {
        if (kind === "testsPass") {
          const observed = compareTests(observeTests(r));
          return { ...observed, reason: `${kind} timed out after ${timeoutMs}ms: ${command}; ${observed.reason}` };
        }
        return { ok: false, reason: `${kind} timed out after ${timeoutMs}ms: ${command}` };
      }
      if (kind === "testsPass") return compareTests(observeTests(r), baseline);
      const out = r.stdout + "\n" + r.stderr;
      const ok = r.code === 0;
      if (!ok) {
        return {
          ok: false,
          reason: `command exited ${r.code}: ${command}`,
          evidence: out.slice(0, 2000),
        };
      }
      return { ok: true, evidence: `exit 0: ${command}` };
    } catch (err) {
      return { ok: false, ...(kind === "testsPass" ? { unverifiable: true } : {}), reason: `${kind} check errored: ${scrubText(String(err))}` };
    }
  };

  if (deps.mutex) {
    return deps.mutex.runExclusive(deps.cwd, fn);
  }
  return fn();
}

async function runSchemaMatch(check: Check, deps: DeterministicDeps): Promise<CheckResult> {
  try {
    if (!check.path || !check.schema) {
      return { ok: false, reason: "schemaMatch requires 'path' and 'schema'" };
    }
    if (!deps.cwd && (!isAbsolute(check.path) || (!check.schema.trim().startsWith("{") && !isAbsolute(check.schema)))) {
      return { ok: false, unverifiable: true, reason: "schemaMatch path cannot be resolved without a declared working directory" };
    }

    const targetRaw = await deps.fs.readFile(resolveAgainst(deps.cwd, check.path));
    let targetVal: unknown;
    try {
      targetVal = JSON.parse(targetRaw);
    } catch {
      return { ok: false, reason: `target is not valid JSON: ${check.path}` };
    }

    let schemaVal: unknown;
    if (check.schema.trim().startsWith("{")) {
      try {
        schemaVal = JSON.parse(check.schema);
      } catch {
        return { ok: false, reason: "schema is not valid JSON" };
      }
    } else {
      const schemaRaw = await deps.fs.readFile(resolveAgainst(deps.cwd, check.schema));
      try {
        schemaVal = JSON.parse(schemaRaw);
      } catch {
        return { ok: false, reason: "schema is not valid JSON" };
      }
    }

    const mismatch = shapeMismatch(schemaVal, targetVal);
    if (mismatch !== null) {
      return { ok: false, reason: `schema mismatch at ${mismatch}`, evidence: mismatch };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `schemaMatch check errored: ${scrubText(String(err))}` };
  }
}

// ---------------------------------------------------------------------------
// runDeterministic
// ---------------------------------------------------------------------------

export async function runDeterministic(dod: DoD, deps: DeterministicDeps): Promise<Verdict> {
  const checks = dod.checks ?? [];

  if (checks.length === 0) {
    return {
      pass: false,
      method: "none",
      skipped: true,
      reasons: ["no deterministic checks to run"],
    };
  }

  const timeoutMs = deps.timeoutMs ?? 120000;
  const allowlist = deps.allowlist ?? DEFAULT_ALLOWLIST;
  const results: CheckResult[] = [];

  // Sequential for deterministic mutex semantics and stable evidence order.
  for (const check of checks) {
    let result: CheckResult;

    switch (check.kind) {
      case "fileExists":
        result = await runFileExists(check, deps);
        break;
      case "run":
        result = await runRun(check, deps, allowlist, timeoutMs);
        break;
      case "testsPass":
      case "buildPasses":
      case "lintClean":
        result = await runCommandCheck(check, check.kind, deps, allowlist, timeoutMs);
        break;
      case "schemaMatch":
        result = await runSchemaMatch(check, deps);
        break;
      default: {
        // Defensive: TypeScript proves this is unreachable; guards runtime extensions.
        const exhaustive: never = check.kind;
        result = { ok: false, reason: `unknown check kind: ${exhaustive}` };
        break;
      }
    }

    results.push(result);
    if (!result.ok && !result.unverifiable) {
      deps.onFailure?.(scrubText(result.reason ?? "check failed"));
    }
  }

  const allPass = results.every(r => r.ok);
  const failed = results.some(r => !r.ok && !r.unverifiable);
  const caveats = results.filter(r => r.unverifiable).map(r => scrubText(r.reason ?? "check unavailable"));
  const notes = results.flatMap(r => r.note ? [scrubText(r.note)] : []);

  const reasons: string[] = allPass
    ? [`all ${checks.length} deterministic checks passed`]
    : results
        .filter(r => !r.ok)
        .map(r => scrubText(r.reason ?? "check failed"));

  const evidenceParts = results.map(r => r.evidence ?? "").filter(e => e.length > 0);
  const rawEvidence = evidenceParts.length > 0 ? evidenceParts.join("\n---\n") : undefined;
  const evidence = rawEvidence !== undefined ? scrubText(rawEvidence) : undefined;

  return {
    pass: allPass,
    outcome: failed ? "fail" : allPass ? "pass" : "unverifiable",
    ...(caveats.length ? { caveats } : {}),
    ...(notes.length ? { notes } : {}),
    method: "deterministic",
    reasons,
    ...(evidence !== undefined ? { evidence } : {}),
  };
}
