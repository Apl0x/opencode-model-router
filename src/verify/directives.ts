/**
 * Per-dispatch verification directives (plan §1.5-15, Phase 1.6.1).
 *
 *   VERIFY:required | VERIFY:deferred   case-insensitive value; anything else is
 *                                       ignored with a log line; absent → defaultVerify
 *   VERIFY_WAIT:<n>s | VERIFY_WAIT:<n>ms  0 allowed, capped at baselineTimeoutMs;
 *                                       malformed → captureWaitMs (with a log line)
 *
 * Parsing follows the same rules as `parseCapDirective` (src/router/sessions.ts):
 * - the FIRST occurrence of each key wins;
 * - the text is scanned as-is, so a directive inside a fenced code block is
 *   still parsed (parity with `CAP:`);
 * - instructional examples injected by the router are ignored. For `CAP:` this
 *   is achieved because the example (`CAP:N or CAP:none`) either does not match
 *   the value grammar (`N`) or comes after the pinned real value. No shared
 *   helper exists, so the same rule is applied here: a placeholder value
 *   (`VERIFY:required|deferred`, `VERIFY_WAIT:<n>s`) is an example, not a
 *   directive, and is skipped silently so a later real directive still wins.
 *
 * SECURITY: directives may only come from the orchestrator's dispatch text.
 * Callers must NEVER pass subagent output (tool results, final answers) here —
 * a subagent could otherwise downgrade its own verification to `deferred` or
 * shorten the reference-capture wait.
 *
 * Pure: no process, filesystem or network access. Logging goes through the
 * injected `log` seam.
 */

export type VerifyMode = "required" | "deferred";

export interface VerifyDirectiveDefaults {
  /** Mode when no valid `VERIFY:` directive is present (§1.4 `defaultVerify`). */
  defaultVerify: VerifyMode;
  /** Wait when no valid `VERIFY_WAIT:` directive is present (§1.4 `captureWaitMs`). */
  captureWaitMs: number;
  /** Upper bound for `VERIFY_WAIT` (§1.4 `baselineTimeoutMs`). */
  baselineTimeoutMs: number;
}

export interface VerifyDirectives {
  mode: VerifyMode;
  waitMs: number;
  source: "directive" | "default";
}

export type DirectiveLogger = (message: string) => void;

const noopLog: DirectiveLogger = () => {};

const VERIFY_RE = /\bVERIFY\s*:\s*([^\s,;)\]}]*)/gi;
const WAIT_RE = /\bVERIFY_WAIT\s*:\s*([^\s,;)\]}]*)/gi;

/** A router-injected instructional example rather than a real directive. */
function isPlaceholder(value: string): boolean {
  return value.includes("|") || value.includes("<") || value.includes(">");
}

function firstRealValue(text: string, re: RegExp): string | null {
  for (const m of text.matchAll(re)) {
    const value = m[1] ?? "";
    if (isPlaceholder(value)) continue;
    return value;
  }
  return null;
}

export function parseVerifyDirectives(
  text: string,
  defaults: VerifyDirectiveDefaults,
  log: DirectiveLogger = noopLog,
): VerifyDirectives {
  let mode = defaults.defaultVerify;
  let waitMs = defaults.captureWaitMs;
  let fromDirective = false;

  const rawMode = firstRealValue(text, VERIFY_RE);
  if (rawMode !== null) {
    const v = rawMode.toLowerCase();
    if (v === "required" || v === "deferred") {
      mode = v;
      fromDirective = true;
    } else {
      log(`[verify] ignoring unknown VERIFY value "${rawMode}"; using default "${defaults.defaultVerify}"`);
    }
  }

  const rawWait = firstRealValue(text, WAIT_RE);
  if (rawWait !== null) {
    const m = /^(\d+)(ms|s)$/i.exec(rawWait);
    if (m) {
      const n = Number(m[1]);
      const ms = m[2]!.toLowerCase() === "s" ? n * 1000 : n;
      waitMs = Math.min(ms, defaults.baselineTimeoutMs);
      fromDirective = true;
    } else {
      log(`[verify] ignoring malformed VERIFY_WAIT value "${rawWait}"; using default ${defaults.captureWaitMs}ms`);
    }
  }

  return { mode, waitMs, source: fromDirective ? "directive" : "default" };
}
