/**
 * Per-dispatch verification directives (plan §1.5-15, Phase 1.6.1).
 *
 *   VERIFY:required | VERIFY:deferred   case-insensitive value; anything else is
 *                                       ignored with a log line; absent → defaultVerify
 *   VERIFY_WAIT:<n>s | VERIFY_WAIT:<n>ms  0 allowed, capped at baselineTimeoutMs;
 *                                       malformed → captureWaitMs (with a log line)
 *
 * Grammar (same rules as `parseCapDirective`, src/router/sessions.ts):
 * - key, then horizontal whitespace (`[^\S\r\n\u2028\u2029]*`, so NBSP/U+3000 are fine) around
 *   the colon — a directive never straddles a line break (QA-1.6-20);
 * - only key + colon is matched; the value token is read with a sticky regex, so scanning resumes
 *   after the colon and `VERIFY:maybe,VERIFY:required` → required, like `CAP:abc,CAP:3` → 3 (QA-1.6-19);
 * - prose guard (QA-1.6-18): when the key is NOT written as upper-case `VERIFY`/`VERIFY_WAIT`,
 *   the value counts only if it ends the line (optionally followed by closing quotes, `*`, `_`,
 *   `)`/`]` or punctuation). So `verify: required` alone on a line → required (decision), but
 *   `Things to verify: deferred loading works` and `Please verify: "deferred" state…` are prose
 *   and ignored silently. Upper-case keys keep the word-boundary rule below;
 * - the value ends at a word boundary, like `CAP:`'s `(none|\d+)\b`:
 *   `VERIFY:([a-z]+)\b`, `VERIFY_WAIT:(\d+)(ms|s)\b`. So `**VERIFY:required**`,
 *   `` `VERIFY:required` `` and `VERIFY:required.` all parse;
 * - one leading quote or markdown mark (`"`, `'`, `` ` ``, `*`, `_`) before the value is
 *   accepted, so `VERIFY:"required"` parses as `required` (decision, QA-1.6-1);
 * - the FIRST VALID occurrence of each key wins; occurrences whose value does not fit the
 *   grammar/allowed set are skipped, as `CAP:abc CAP:3` → 3. An unknown/malformed value is
 *   logged only when no valid occurrence of that key exists, at most once per key per parse;
 * - the text is scanned as-is, so a directive inside a fenced code block is still parsed.
 *
 * Router-example contract (QA-1.6-4): a value starting with `<` or immediately followed by `|`
 * is a placeholder (`VERIFY:required|deferred`, `VERIFY_WAIT:<n>s`) and is skipped silently.
 * Consequently a padding-less table cell `|VERIFY:required|` is also skipped; use `| VERIFY:required |`.
 * Any VERIFY example the router injects into dispatch text MUST use `|` or `<…>` placeholders,
 * or be preceded by a pinned resolved `VERIFY:<mode>` / `VERIFY_WAIT:<n>ms` (the `CAP:` pattern:
 * dispatch-header.ts pins `CAP:<n>` before its instructional sentence). A literal valid example
 * such as "put VERIFY:required or VERIFY:deferred" would otherwise win.
 *
 * SECURITY (enforced by the caller, not here — this module cannot know where text came from):
 * - 2.4 must parse ONLY the orchestrator-authored `task`/`delegate` `prompt` argument. Never tool
 *   results, the subagent's final text or the child session's messages — a subagent could
 *   otherwise downgrade its own verification to `deferred` or shorten the capture wait.
 * - Because the first valid occurrence wins, orchestrator text that quotes an earlier subagent's
 *   output containing `VERIFY:deferred` before its own directive would also win. Pinning the
 *   resolved value first (the `CAP:` pattern) removes this.
 *
 * Result sources (QA-1.6-6, deviation from the plan's single `source`): `modeSource` says whether
 * the mode came from a `VERIFY:` directive, `waitSource` whether the wait came from `VERIFY_WAIT:`.
 *
 * Pure: no imports, no process, filesystem or network access. Logging goes through the injected
 * `log` seam; logged values are truncated to 32 characters; control, bidi and other format characters are
 * escaped (QA-1.6-24).
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

export type DirectiveSource = "directive" | "default";

export interface VerifyDirectives {
  mode: VerifyMode;
  waitMs: number;
  /** Whether `mode` came from a `VERIFY:` directive. */
  modeSource: DirectiveSource;
  /** Whether `waitMs` came from a `VERIFY_WAIT:` directive. */
  waitSource: DirectiveSource;
}

export type DirectiveLogger = (message: string) => void;

const noopLog: DirectiveLogger = () => {};

/** Horizontal whitespace (incl. NBSP, U+3000); never a line break (QA-1.6-20). */
const HWS = "[^\\S\\r\\n\\u2028\\u2029]*";
// Key + colon only; the value is read with a sticky regex so scanning resumes right after the
// colon and a second occurrence in the same token is still found (QA-1.6-19).
const VERIFY_RE = new RegExp(`\\bVERIFY${HWS}:${HWS}`, "gi");
const WAIT_RE = new RegExp(`\\bVERIFY_WAIT${HWS}:${HWS}`, "gi");
const TOKEN = /\S*/y;
const LEAD = /^["'`*_]?/;
const MODE_VALUE = /^([a-z]+)\b/i;
const WAIT_VALUE = /^(\d+)(ms|s)\b/i;
/** After a non-upper-case key the value must end the line, bar closing marks (QA-1.6-18). */
const LINE_TAIL = /^["'`*_.,;:!?)\]]*[^\S\r\n\u2028\u2029]*(?:[\r\n\u2028\u2029]|$)/;
const MAX_LOGGED = 32;
/** C1/DEL, soft hyphen, bidi controls, zero-width and other format characters (QA-1.6-24). */
const UNSAFE = /[\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;

/** Bounded, escaped rendering of an untrusted value for a log line. */
function safe(value: string): string {
  return JSON.stringify(value.slice(0, MAX_LOGGED)).replace(
    UNSAFE,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

interface Scan<T> {
  value: T | null;
  firstInvalid: string | null;
}

function scan<T>(
  text: string,
  keyRe: RegExp,
  upperKey: string,
  valueRe: RegExp,
  accept: (m: RegExpExecArray) => T | null,
): Scan<T> {
  let firstInvalid: string | null = null;
  const re = new RegExp(keyRe.source, keyRe.flags);
  const token = new RegExp(TOKEN.source, TOKEN.flags);
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const start = m.index + m[0].length;
    token.lastIndex = start;
    const raw = token.exec(text)?.[0] ?? "";
    if (raw === "") continue;
    const body = raw.replace(LEAD, "");
    if (body.startsWith("<")) continue; // placeholder
    const v = valueRe.exec(body);
    if (v && body.charAt(v[0].length) === "|") continue; // placeholder
    if (!m[0].startsWith(upperKey)) {
      // Prose guard: `Things to verify: deferred loading works` is not a directive.
      const end = v ? start + (raw.length - body.length) + v[0].length : start + raw.length;
      if (!LINE_TAIL.test(text.slice(end, end + 256).split(/[\r\n\u2028\u2029]/)[0] ?? "")) continue;
    }
    const accepted = v ? accept(v) : null;
    if (accepted !== null) return { value: accepted, firstInvalid };
    firstInvalid ??= raw;
  }
  return { value: null, firstInvalid };
}
export function parseVerifyDirectives(
  text: string,
  defaults: VerifyDirectiveDefaults,
  log: DirectiveLogger = noopLog,
): VerifyDirectives {
  const modeScan = scan<VerifyMode>(text, VERIFY_RE, "VERIFY", MODE_VALUE, (m) => {
    const v = (m[1] ?? "").toLowerCase();
    return v === "required" || v === "deferred" ? v : null;
  });
  if (modeScan.value === null && modeScan.firstInvalid !== null) {
    log(`[verify] ignoring unknown VERIFY value ${safe(modeScan.firstInvalid)}; using default "${defaults.defaultVerify}"`);
  }

  const waitScan = scan<number>(text, WAIT_RE, "VERIFY_WAIT", WAIT_VALUE, (m) => {
    const n = Number(m[1]);
    const ms = (m[2] ?? "").toLowerCase() === "s" ? n * 1000 : n;
    return Number.isNaN(ms) ? null : Math.min(ms, defaults.baselineTimeoutMs);
  });
  if (waitScan.value === null && waitScan.firstInvalid !== null) {
    log(`[verify] ignoring malformed VERIFY_WAIT value ${safe(waitScan.firstInvalid)}; using default ${defaults.captureWaitMs}ms`);
  }

  return {
    mode: modeScan.value ?? defaults.defaultVerify,
    waitMs: waitScan.value ?? defaults.captureWaitMs,
    modeSource: modeScan.value === null ? "default" : "directive",
    waitSource: waitScan.value === null ? "default" : "directive",
  };
}
