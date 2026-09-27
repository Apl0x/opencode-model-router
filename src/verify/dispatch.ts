/**
 * src/verify/dispatch.ts — shared helpers and TTL-managed dispatch state
 * (Option (i) verify-dispatch around the built-in `task` tool, and Option (ii)
 * the plugin-owned `delegate` tool). No fs/network/SDK here; bounded background
 * work uses the shared timeout primitive, and the live adapters
 * (exec/fs/grader) are built in index.ts from PluginInput and injected.
 */
import type { RouterConfig } from "../router/config";
import { getActiveTiers } from "../router/protocol";
import { parseDoDFromDispatch, inferDoD } from "./dod";
import type { DoD, InferHints } from "./dod";
import { DEFAULT_IDLE_TTL_MS } from "../router/idle-sweep";
import { resolve } from "node:path";
import type { ExecResult } from "./types";
import { observeTests, type TestBaseline } from "./baseline";
import { withTimeout } from "./timeout";

export interface TreeSnapshot {
  cwd: string;
  /** Real path of `git rev-parse --show-toplevel` at capture time. */
  root?: string;
  head: string;
  fingerprint: string;
  dirty: boolean;
  files: ChangedFile[];
}

export interface BaselineCaptureDeps {
  snapshot(cwd: string, signal: AbortSignal): Promise<TreeSnapshot | undefined>;
  run(command: string, cwd: string, signal: AbortSignal): Promise<ExecResult>;
  timeoutMs: number;
}

function pathKey(path: string): string {
  const normalized = resolve(path).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export interface ChangedFileStoreOptions {
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

/** Tools that mutate the workspace (mirrors the guard taxonomy). */
const WRITE_TOOLS = new Set(["write", "edit", "patch", "multiedit", "apply_patch"]);
// Shell commands can edit too. Without a command-level proof of read-onlyness,
// discarding a capture is safer than allowing an unobserved shell edit to seed it.
const MAY_WRITE_TOOLS = new Set([...WRITE_TOOLS, "bash", "shell", "powershell", "exec"]);

export interface ChangedFile {
  path: string;
  status: string;
  /** Rename/copy source (absolute) when git status reports R or C. */
  previousPath?: string;
}

/** Derive a {path,status} record from a write/edit tool call, or null. */
export function extractChangedFile(tool: string, args: unknown): ChangedFile | null {
  if (!WRITE_TOOLS.has(tool)) return null;
  const a = (args ?? {}) as Record<string, unknown>;
  const path =
    typeof a.filePath === "string"
      ? a.filePath
      : typeof a.path === "string"
        ? a.path
        : typeof a.file === "string"
          ? a.file
          : "";
  if (!path) return null;
  const status = tool === "write" ? "written" : "modified";
  return { path, status };
}

/**
 * Per-session changed-file tracker. We attribute changed files to a delegation
 * by observing that session's own edit/write tool calls (ADR 0002 D3 — NOT a
 * global git diff), which is concurrency-safe under interleaved subagents.
 */
export function createChangedFileStore(options: ChangedFileStoreOptions = {}) {
  const now = options.now ?? Date.now;
  const bySession = new Map<string, Map<string, string>>();
  const lastTouch = new Map<string, number>();
  const dispatches = new Map<string, {
    cwd: string; pending: boolean; contaminated: boolean;
    snapshot?: TreeSnapshot;
    ready: Promise<void>;
    baselines: Map<string, Promise<TestBaseline | undefined>>;
  }>();
  const cache = new Map<string, {
    cwd: string; command: string; pending: boolean; contaminated: boolean; stamp: number;
    controller: AbortController; result: Promise<TestBaseline | undefined>;
  }>();

  function observeEdit(tool: string, cwd?: string): void {
    if (!MAY_WRITE_TOOLS.has(tool.toLowerCase())) return;
    // Unknown directory is conservatively treated as overlapping every capture.
    const overlaps = (other: string) => !cwd || pathKey(cwd) === pathKey(other)
      || pathKey(cwd).startsWith(pathKey(other) + "/") || pathKey(other).startsWith(pathKey(cwd) + "/");
    for (const d of dispatches.values()) if (d.pending && overlaps(d.cwd)) d.contaminated = true;
    for (const c of cache.values()) if (c.pending && overlaps(c.cwd)) c.contaminated = true;
  }

  function touch(sessionID: string): void {
    lastTouch.set(sessionID, now());
  }

  function evict(sessionID: string): void {
    bySession.delete(sessionID);
    lastTouch.delete(sessionID);
    dispatches.delete(sessionID);
  }

  return {
    /** Non-blocking: fingerprint and test run are bounded background work. */
    beginDispatch(id: string, cwd: string, commands: string[], deps: BaselineCaptureDeps): void {
      touch(id);
      bySession.delete(id);
      const controller = new AbortController();
      const d = {
        cwd, pending: true, contaminated: false, snapshot: undefined as TreeSnapshot | undefined,
        ready: Promise.resolve(), baselines: new Map<string, Promise<TestBaseline | undefined>>(),
      };
      dispatches.set(id, d);
      d.ready = withTimeout(deps.snapshot(cwd, controller.signal), deps.timeoutMs, "dispatch fingerprint")
        .then(snapshot => {
          if (!snapshot || d.contaminated || dispatches.get(id) !== d) return;
          d.snapshot = snapshot;
          for (const command of new Set(commands)) {
            const key = JSON.stringify([pathKey(snapshot.cwd), snapshot.head, snapshot.fingerprint, command]);
            let entry = cache.get(key);
            // A suite already running in this directory is not started again under a new
            // fingerprint: concurrent full suites saturate every core, and the dispatch
            // falls back to the same "no baseline" path as a contaminated capture.
            if (!entry && [...cache.values()].some(c => c.pending && c.command === command && pathKey(c.cwd) === pathKey(cwd))) continue;
            if (!entry) {
              const capture = {
                cwd, command, pending: true, contaminated: false, stamp: now(),
                controller: new AbortController(), result: Promise.resolve<TestBaseline | undefined>(undefined),
              };
              cache.set(key, capture);
              capture.result = withTimeout((async () => {
                const result = await deps.run(command, cwd, capture.controller.signal);
                if (result.timedOut || capture.contaminated) return undefined;
                const end = await deps.snapshot(cwd, capture.controller.signal);
                if (!end || capture.contaminated || end.head !== snapshot.head || end.fingerprint !== snapshot.fingerprint) return undefined;
                return { observation: observeTests(result), dirty: snapshot.dirty };
              })(), deps.timeoutMs, "test baseline")
                .catch(() => undefined)
                .then(result => {
                  capture.pending = false;
                  capture.controller.abort();
                  if (!result && cache.get(key) === capture) cache.delete(key);
                  return result;
                });
              entry = capture;
            }
            entry.stamp = now();
            d.baselines.set(command, entry.result);
          }
        })
        .catch(() => { /* Fingerprinting unavailable: retain explicit missing-snapshot state. */ })
        .finally(() => { d.pending = false; controller.abort(); });
    },
    observeEdit,
    async baseline(id: string, command: string, currentHead?: string): Promise<TestBaseline | undefined> {
      const d = dispatches.get(id);
      if (!d) return undefined;
      touch(id);
      await d.ready;
      if (!currentHead || d.snapshot?.head !== currentHead) return undefined;
      return d.baselines.get(command);
    },
    delta(id: string, childID: string, current?: TreeSnapshot, fallbackCwd?: string): { changedFiles: ChangedFile[]; changeBaseline: "available" | "unavailable" } {
      const d = dispatches.get(id);
      const snapshot = d?.snapshot;
      const files = new Map<string, ChangedFile>();
      for (const [path, status] of bySession.get(childID) ?? []) {
        const base = d?.cwd ?? current?.cwd ?? fallbackCwd;
        const absolute = base ? resolve(base, path) : path;
        files.set(base ? pathKey(absolute) : path, { path: absolute, status });
      }
      const available = !!snapshot && !!current;
      if (available) {
        const before = new Set(snapshot.files.map(f => pathKey(f.path)));
        for (const file of current.files) if (!before.has(pathKey(file.path))) files.set(pathKey(file.path), file);
      }
      return { changedFiles: [...files.values()], changeBaseline: available ? "available" : "unavailable" };
    },
    record(sessionID: string, tool: string, args: unknown): void {
      touch(sessionID);
      observeEdit(tool, dispatches.get(sessionID)?.cwd);
      if (tool.toLowerCase() === "apply_patch") {
        const a = args && typeof args === "object" ? args as Record<string, unknown> : {};
        const patch = typeof a.patchText === "string" ? a.patchText : typeof a.patch === "string" ? a.patch : "";
        const files = bySession.get(sessionID) ?? new Map<string, string>();
        for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) files.set(match[1].trim(), "modified");
        bySession.set(sessionID, files);
      }
      const cf = extractChangedFile(tool, args);
      if (!cf) return;
      let m = bySession.get(sessionID);
      if (!m) {
        m = new Map();
        bySession.set(sessionID, m);
      }
      // "written" (created) is stickier than a later "modified".
      const prev = m.get(cf.path);
      m.set(cf.path, prev === "written" ? "written" : cf.status);
    },
    get(sessionID: string): ChangedFile[] {
      const m = bySession.get(sessionID);
      if (!m) return [];
      return [...m.entries()].map(([path, status]) => ({ path, status }));
    },
    clear(sessionID: string): void {
      evict(sessionID);
    },
    /** Evict every session idle for >= ttlMs. Future stamps are never evicted. */
    sweep(nowMs: number = now(), ttlMs: number = DEFAULT_IDLE_TTL_MS): void {
      for (const [sessionID, stamp] of [...lastTouch.entries()]) {
        if (nowMs - stamp >= ttlMs) evict(sessionID);
      }
      for (const [key, entry] of cache) {
        if (nowMs - entry.stamp >= ttlMs) {
          entry.controller.abort();
          cache.delete(key);
        }
      }
    },
  };
}

const TASK_RESULT_OPEN = "<task_result>";
const TASK_RESULT_CLOSE = "</task_result>";

/**
 * Linear-time extraction of the <task_result> body. Any regex scan here, even a
 * lazy one, backtracks polynomially on repeated open tags with no close
 * (CodeQL js/polynomial-redos), so this walks the string with indexOf instead.
 * Case-insensitive, like the regex it replaced: first open tag, then the first
 * close tag after it. Returns null when either tag is missing.
 */
function extractTaskResult(raw: string): string | null {
  const lower = raw.toLowerCase();
  const start = lower.indexOf(TASK_RESULT_OPEN);
  if (start === -1) return null;
  const end = lower.indexOf(TASK_RESULT_CLOSE, start + TASK_RESULT_OPEN.length);
  if (end === -1) return null;
  return raw.slice(start + TASK_RESULT_OPEN.length, end);
}

/**
 * Parse the built-in `task` tool's after-hook output: the child's final return
 * is wrapped in <task_result>...</task_result> and the child session id lives in
 * output.metadata.sessionId (spike capability C).
 */
export function parseTaskResult(output: unknown): {
  finalReturnText: string;
  childSessionID: string | null;
} {
  const o = (output ?? {}) as Record<string, unknown>;
  const raw = typeof o.output === "string" ? o.output : "";
  const inner = extractTaskResult(raw);
  const finalReturnText = (inner ?? raw).trim();
  const meta = (o.metadata ?? {}) as Record<string, unknown>;
  const childSessionID =
    typeof meta.sessionId === "string"
      ? meta.sessionId
      : typeof meta.sessionID === "string"
        ? meta.sessionID
        : null;
  return { finalReturnText, childSessionID };
}

/**
 * Build the DoD for a delegation from its dispatch text: an explicit
 * [acceptance] block wins; otherwise auto-infer a minimal, non-vacuous DoD
 * (M2 default). `acceptance` (if provided) is parsed for the block first.
 */
export function buildDelegationDoD(
  args: { prompt?: string; description?: string; acceptance?: string },
  hints: InferHints = {},
): DoD {
  const blockSource = args.acceptance ?? args.prompt ?? args.description ?? "";
  const explicit = parseDoDFromDispatch(blockSource);
  if (explicit) return explicit;
  const dispatch = args.prompt ?? args.description ?? "";
  return inferDoD(dispatch, "", hints);
}

/** Resolve a tier name to {providerID, modelID} for client.session.prompt. */
export function tierModel(
  cfg: RouterConfig,
  tierName: string,
): { providerID: string; modelID: string } | null {
  const tiers = getActiveTiers(cfg);
  const t = tiers[tierName];
  if (!t || typeof t.model !== "string") return null;
  const slash = t.model.indexOf("/");
  if (slash <= 0 || slash >= t.model.length - 1) return null;
  return {
    providerID: t.model.slice(0, slash),
    modelID: t.model.slice(slash + 1),
  };
}

/** Decide whether a built-in `task` tool call should be verify-dispatched (Option i). */
export function shouldVerifyTask(
  tool: string,
  mode: string,
  require: string | undefined,
): boolean {
  if (tool !== "task") return false;
  if (mode === "off") return false;
  if ((require ?? "whenDoDPresent") === "never") return false;
  return true;
}

/** Build the advisory forcing note appended to a task result the gate did not accept. */
export function buildForcingNote(
  reasons: string[],
  escalation?: { producerTier?: string; nextTier?: string | null },
): string {
  const body =
    reasons.length > 0
      ? reasons.map((r) => `- ${r}`).join("\n")
      : "- (no reasons provided)";
  const next =
    escalation?.nextTier
      ? `NEXT: address the above, then re-run via \`Task(subagent_type="${escalation.nextTier}")\`` +
        `${escalation.producerTier ? ` (escalated from ${escalation.producerTier})` : ""}; ` +
        `do not treat the prior result as complete.`
      : `NEXT: address the above and re-run the delegation; do not treat the prior result as complete.`;
  return (
    `[router \u26a0 NOT ACCEPTED] The delegated result was not accepted by independent verification:\n` +
    `${body}\n` +
    next
  );
}

/** Suffix appended to an accepted delegate-tool result. */
export function buildAcceptedSuffix(method: string, caveats: string[] = [], notes: string[] = []): string {
  return `\n\n[router \u2713 accepted: ${method}]` + (caveats.length
    ? `\nVerification caveats — NOT verified (acceptance is not a passing check):\n${caveats.map(r => `- ${r}`).join("\n")}`
    : "") + (notes.length ? `\nVerification notes:\n${notes.map(r => `- ${r}`).join("\n")}` : "");
}
