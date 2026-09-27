/**
 * test/integration/deferred-verification.test.ts
 *
 * Phase 2.4.2 (plan Phase 2.4, section 1.5-14..17; pending.ts R3, R10, R11): mode routing between
 * deferred and required verification, the router footer, lineage and the pending sweep.
 *
 * - "wiring (2.4.2a)" drives createVerificationWiring directly: directives, the VERIFY_WAIT-bounded
 *   capture wait, the deferred finish and R11 lineage.
 *
 * Every process goes through the mocked exec seam and is recorded. The tree snapshot and the
 * reference capture are mocked (git only in production; nothing runs here), so a deferred
 * delegation must leave the exec record empty and never construct the S3 slot's scope opener.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolve } from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache } from "../../src/router/config";
import {
  canonicalTier,
  createVerificationWiring,
  DEFERRED_FINISH_MS,
  dispatchDirectiveText,
  hasTestsPass,
} from "../../src/verify/wiring";
import { createChangedFileStore, type TreeSnapshot } from "../../src/verify/dispatch";
import { gateResult } from "../../src/verify/gate";
import { HANDLE_PATTERN, UNATTRIBUTED_RISK_REASON } from "../../src/verify/pending";
import { REASONS } from "../../src/verify/risk";
import type { RouterConfig } from "../../src/router/config";
import type { DoD } from "../../src/verify/dod";
import type { DispatchReference } from "../../src/verify/reference";

const state = vi.hoisted(() => ({
  /** What snapshotTree resolves with (undefined = unavailable). */
  snapshot: undefined as TreeSnapshot | undefined,
  /** Replaces the snapshot mock when set. */
  snapshotImpl: undefined as (() => Promise<TreeSnapshot | undefined>) | undefined,
  /** Every shell or argv spawn, as "file arg…" or the shell string. */
  commands: [] as string[],
  captures: 0,
  captureResult: undefined as unknown,
  /** The capture settles after this many (fake) ms; undefined = at once; "never" = held forever. */
  captureDelayMs: undefined as number | "never" | undefined,
  /** createScopeOpener / createDirectTestsPassHook calls: the S3 slot and the scoped run live behind them. */
  scopeOpeners: 0,
  testsPassHooks: 0,
}));

vi.mock("../../src/verify/tree", () => ({
  snapshotTree: async () => (state.snapshotImpl ? state.snapshotImpl() : state.snapshot),
}));
vi.mock("../../src/verify/exec", () => ({
  runShell: async (command: string) => {
    state.commands.push(command);
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  },
  runArgv: async (file: string, args: readonly string[]) => {
    state.commands.push([file, ...args].join(" "));
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  },
}));
vi.mock("../../src/verify/deterministic", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/deterministic")>();
  return {
    ...actual,
    createScopeOpener: (deps: Parameters<typeof actual.createScopeOpener>[0]) => {
      state.scopeOpeners += 1;
      return actual.createScopeOpener(deps);
    },
    createDirectTestsPassHook: (deps: Parameters<typeof actual.createDirectTestsPassHook>[0]) => {
      state.testsPassHooks += 1;
      return actual.createDirectTestsPassHook(deps);
    },
  };
});
// The plugin's own wiring instance, so the tests can read its pending registry and spy on lineage.
const captured = vi.hoisted(() => ({
  wiring: undefined as import("../../src/verify/wiring").VerificationWiring | undefined,
  lineage: [] as Array<import("../../src/verify/wiring").LineageContext>,
}));
vi.mock("../../src/verify/wiring", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/wiring")>();
  return {
    ...actual,
    createVerificationWiring: (...args: Parameters<typeof actual.createVerificationWiring>) => {
      const wiring = actual.createVerificationWiring(...args);
      const wrapped: import("../../src/verify/wiring").VerificationWiring = {
        ...wiring,
        applyLineage: (res, ctx) => {
          captured.lineage.push(ctx);
          return wiring.applyLineage(res, ctx);
        },
      };
      captured.wiring = wrapped;
      return wrapped;
    },
  };
});
vi.mock("../../src/verify/reference", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/verify/reference")>()),
  captureReference: (_at: string, signal: AbortSignal) => {
    state.captures += 1;
    return new Promise((resolveCapture, rejectCapture) => {
      // Like the real capture, an abort (the store clearing the dispatch) ends it without a reference.
      signal.addEventListener("abort", () => rejectCapture(new Error("capture aborted")), { once: true });
      const delay = state.captureDelayMs;
      if (delay === "never") return;
      if (delay === undefined) resolveCapture(state.captureResult);
      else setTimeout(() => resolveCapture(state.captureResult), delay);
    });
  },
  gcStaleReferences: async () => ({ removed: [], kept: [], failed: [] }),
}));

const root = resolve("deferred-verification-project");
const REF: DispatchReference = { root, head: "HEAD", commit: "HEAD", untracked: new Map(), tracked: new Map(), captureReasons: [], capturedAt: 0 };
const TESTS_DOD: DoD = { kind: "deterministic", source: "explicit", criteria: [], deliverable: null, checks: [{ kind: "testsPass", command: "npm test" }] };
const FILE_DOD: DoD = { kind: "deterministic", source: "explicit", criteria: [], deliverable: null, checks: [{ kind: "fileExists", path: "x.txt" }] };

function snap(files: TreeSnapshot["files"], fingerprint: string): TreeSnapshot {
  return { cwd: root, root, head: "HEAD", fingerprint, dirty: files.length > 0, files, digests: new Map() };
}

function makeWiring(verify: NonNullable<NonNullable<RouterConfig["enforcement"]>["verify"]> = {}) {
  const cfg: RouterConfig = {
    activePreset: "a",
    presets: { a: { medium: { model: "p/m" } } },
    defaultTier: "medium",
    rules: [],
    enforcement: { verify },
  };
  const warnings: string[] = [];
  const wiring = createVerificationWiring({
    client: {},
    directory: root,
    getConfig: () => cfg,
    logger: { warn: message => warnings.push(message) },
  });
  return { cfg, wiring, store: createChangedFileStore(), warnings };
}

beforeEach(() => {
  Object.assign(state, {
    snapshot: snap([], "clean"),
    snapshotImpl: undefined,
    commands: [],
    captures: 0,
    captureResult: REF,
    captureDelayMs: undefined,
    scopeOpeners: 0,
    testsPassHooks: 0,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("wiring (2.4.2a)", () => {
  describe("directives: the orchestrator prompt only, defaults from the config", () => {
    it("defaultVerify decides when no directive is present, and a directive overrides it", () => {
      expect(makeWiring().wiring.resolveDirectives("do it").mode).toBe("deferred");
      const required = makeWiring({ defaultVerify: "required" }).wiring;
      expect(required.resolveDirectives("do it")).toMatchObject({ mode: "required", modeSource: "default" });
      expect(required.resolveDirectives("VERIFY:deferred\ndo it")).toMatchObject({ mode: "deferred", modeSource: "directive" });
      expect(makeWiring().wiring.resolveDirectives("VERIFY:required do it")).toMatchObject({ mode: "required", modeSource: "directive" });
    });

    it("VERIFY_WAIT defaults to captureWaitMs, allows 0 and is capped at baselineTimeoutMs", () => {
      const { wiring } = makeWiring({ captureWaitMs: 1234, baselineTimeoutMs: 4000 });
      expect(wiring.resolveDirectives("x").waitMs).toBe(1234);
      expect(wiring.resolveDirectives("VERIFY_WAIT:0s").waitMs).toBe(0);
      expect(wiring.resolveDirectives("VERIFY_WAIT:60s").waitMs).toBe(4000);
    });

    it("an unknown VERIFY value is logged and ignored", () => {
      const { wiring, warnings } = makeWiring();
      expect(wiring.resolveDirectives("VERIFY:maybe").mode).toBe("deferred");
      expect(warnings.some(w => w.includes("ignoring unknown VERIFY value"))).toBe(true);
    });

    it("the directive text is the prompt, or the description when the prompt is blank", () => {
      expect(dispatchDirectiveText("VERIFY:required", "VERIFY:deferred")).toBe("VERIFY:required");
      expect(dispatchDirectiveText("  ", "VERIFY:deferred")).toBe("VERIFY:deferred");
      expect(dispatchDirectiveText(undefined, undefined)).toBe("");
    });

    it("takeDispatch returns the remembered start once, then re-parses", async () => {
      const { wiring, store } = makeWiring();
      const start = await wiring.startDispatch(store, "task:o:1", root, TESTS_DOD, "VERIFY:required", true);
      expect(wiring.takeDispatch("task:o:1", "VERIFY:deferred")).toBe(start);
      expect(wiring.takeDispatch("task:o:1", "VERIFY:deferred").directives.mode).toBe("deferred");
    });
  });

  describe("VERIFY_WAIT bounds the capture wait (section 1.5-14)", () => {
    it("a capture that resolves after 20 s under VERIFY_WAIT:5s releases the dispatch at 5 s", async () => {
      vi.useFakeTimers();
      state.captureDelayMs = 20_000;
      const { wiring, store } = makeWiring();
      let done = false;
      const started = wiring.startDispatch(store, "d1", root, TESTS_DOD, "VERIFY_WAIT:5s", false).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await started;
      expect(done).toBe(true);
    });

    it("VERIFY_WAIT:0s releases the dispatch at once", async () => {
      vi.useFakeTimers();
      state.captureDelayMs = "never";
      const { wiring, store } = makeWiring();
      let done = false;
      const started = wiring.startDispatch(store, "d2", root, TESTS_DOD, "VERIFY_WAIT:0s", false).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      await started;
      expect(done).toBe(true);
    });

    it("a capture that resolves at 2 s under a 5 s wait releases the dispatch at 2 s", async () => {
      vi.useFakeTimers();
      state.captureDelayMs = 2_000;
      const { wiring, store } = makeWiring();
      let done = false;
      const started = wiring.startDispatch(store, "d3", root, TESTS_DOD, "VERIFY_WAIT:5s", false).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await started;
      expect(done).toBe(true);
    });
  });

  describe("isDeferred", () => {
    it("defers only a testsPass DoD in deferred mode with verification enabled", () => {
      const { wiring } = makeWiring();
      const deferred = wiring.resolveDirectives("");
      const required = wiring.resolveDirectives("VERIFY:required");
      expect(hasTestsPass(TESTS_DOD)).toBe(true);
      expect(wiring.isDeferred(TESTS_DOD, deferred)).toBe(true);
      expect(wiring.isDeferred(TESTS_DOD, required)).toBe(false);
      expect(wiring.isDeferred(FILE_DOD, deferred)).toBe(false);
      expect(makeWiring({ require: "never" }).wiring.isDeferred(TESTS_DOD, deferred)).toBe(false);
    });
  });

  describe("finishDeferred", () => {
    const input = (over: Partial<Parameters<ReturnType<typeof makeWiring>["wiring"]["finishDeferred"]>[1]> = {}) => ({
      dispatchID: "task:orch:1",
      orchestratorSessionID: "orch",
      producerSessionID: "child",
      producerTier: " Fast ",
      description: "add the parser",
      cwd: root,
      dod: TESTS_DOD,
      dispatchedAt: 0,
      ...over,
    });

    it("registers the delegation and returns the footer; no process, no slot, no scoped run", async () => {
      const { wiring, store } = makeWiring();
      await wiring.startDispatch(store, "task:orch:1", root, TESTS_DOD, "", false);
      state.snapshot = snap([{ path: resolve(root, "src", "a.ts"), status: "??" }], "after");
      const finish = await wiring.finishDeferred(store, input());
      expect(finish.handle).toMatch(HANDLE_PATTERN);
      const first = finish.footer.split("\n")[0];
      expect(first.startsWith(`[router] unverified \u00b7 ${finish.handle} \u00b7 risk `)).toBe(true);
      expect(finish.footer).not.toMatch(/\baccepted\b|\[router\] verified/i);
      // Zero spawns: HEAD did not move (no git diff), the capture and snapshot are seams.
      expect(state.commands).toEqual([]);
      expect(state.scopeOpeners).toBe(0);
      expect(state.testsPassHooks).toBe(0);
      const listed = wiring.pending.listUnverified("orch");
      expect(listed.map(e => e.handle)).toEqual([finish.handle]);
      expect(listed[0]).toMatchObject({ producerTier: "fast", root, dispatchID: "task:orch:1", producerSessionID: "child" });
      expect(listed[0].changedFiles).toEqual([{ path: resolve(root, "src", "a.ts"), status: "??" }]);
      // The producer tier is canonical: "fast" raises the risk (risk.ts row 11).
      expect(finish.risk.reasons).toContain(REASONS.fastTier);
      // A captured reference at return: no "no reference" step.
      expect(finish.risk.reasons).not.toContain(REASONS.noReference);
      expect(await listed[0].reference).toEqual({ kind: "captured", reference: REF });
    });

    it("a capture still in flight at return counts as no reference, and the record outlives it", async () => {
      vi.useFakeTimers();
      state.captureDelayMs = 10_000;
      const { wiring, store } = makeWiring();
      const started = wiring.startDispatch(store, "task:orch:1", root, TESTS_DOD, "VERIFY_WAIT:0s", false);
      await vi.advanceTimersByTimeAsync(0);
      await started;
      const reference = store.reference("task:orch:1");
      state.snapshot = snap([{ path: resolve(root, "src", "a.ts"), status: " M" }], "after");
      const finishing = wiring.finishDeferred(store, input({ producerTier: "medium" }));
      await vi.advanceTimersByTimeAsync(0);
      const finish = await finishing;
      expect(finish.risk.reasons).toContain(REASONS.noReference);
      // Not cleared yet: clearing would abort the capture (dispatch.ts evict).
      expect(store.reference("task:orch:1")).toBe(reference);
      await vi.advanceTimersByTimeAsync(10_000);
      const [entry] = wiring.pending.listUnverified("orch");
      expect(await entry.reference).toEqual({ kind: "captured", reference: REF });
      // Cleared once the capture settled.
      expect(store.reference("task:orch:1")).not.toBe(reference);
    });

    it("no change baseline -> changedFiles unavailable and the unattributed risk, never []", async () => {
      const { wiring, store } = makeWiring();
      state.snapshot = undefined;
      await wiring.startDispatch(store, "task:orch:1", root, TESTS_DOD, "", false);
      const finish = await wiring.finishDeferred(store, input());
      expect(finish.risk).toEqual({ level: "high", reasons: [UNATTRIBUTED_RISK_REASON] });
      expect(wiring.pending.listUnverified("orch")[0].changedFiles).toBe("unavailable");
    });

    it("a snapshot slower than DEFERRED_FINISH_MS -> unavailable, and the result is not held longer", async () => {
      vi.useFakeTimers();
      const { wiring, store } = makeWiring();
      await wiring.startDispatch(store, "task:orch:1", root, TESTS_DOD, "", false);
      state.snapshotImpl = () => new Promise(() => undefined);
      let done = false;
      const finishing = wiring.finishDeferred(store, input()).then(f => {
        done = true;
        return f;
      });
      await vi.advanceTimersByTimeAsync(DEFERRED_FINISH_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const finish = await finishing;
      expect(finish.risk.reasons).toEqual([UNATTRIBUTED_RISK_REASON]);
      expect(finish.handle).toMatch(HANDLE_PATTERN);
    });

    it("a registration the registry refuses still yields an unverified footer without a handle", async () => {
      const { wiring, store } = makeWiring();
      await wiring.startDispatch(store, "task:orch:1", root, TESTS_DOD, "", false);
      const finish = await wiring.finishDeferred(store, input({ producerSessionID: "" }));
      expect(finish.handle).toBeUndefined();
      expect(finish.footer.startsWith("[router] unverified \u00b7 no handle (not registered)")).toBe(true);
    });

    it("canonicalTier lowercases and trims", () => {
      expect(canonicalTier("  HEAVY ")).toBe("heavy");
    });
  });

  describe("applyLineage (R11)", () => {
    const failing = (introduced: string[], preexisting: string[]) =>
      gateResult({ pass: false, outcome: "fail", method: "deterministic", reasons: ["introduced"], failures: { introduced, preexisting, unknown: [] } }, "explicit");
    const passing = (preexisting: string[]) =>
      gateResult({ pass: true, outcome: "pass", method: "deterministic", reasons: [], notes: ["no worse than before"], failures: { introduced: [], preexisting, unknown: [] } }, "explicit");
    const ctx = (over: Partial<Parameters<ReturnType<typeof makeWiring>["wiring"]["applyLineage"]>[1]> = {}) => ({
      orchestratorSessionID: "orch",
      root,
      dispatchID: "task:orch:1",
      dispatchedAt: 100,
      returnedAt: 200,
      strictUnverifiable: false,
      ...over,
    });

    it("a rejection is recorded; a later pass on those pre-existing ids becomes unverifiable with the caveat", () => {
      const { wiring } = makeWiring();
      const rejected = failing(["t > a"], []);
      expect(wiring.applyLineage(rejected, ctx())).toBe(rejected);
      const later = wiring.applyLineage(passing(["t > a", "t > b"]), ctx({ dispatchID: "task:orch:2", dispatchedAt: 300, returnedAt: 400 }));
      expect(later.accepted).toBe(true);
      expect(later.verdict.outcome).toBe("unverifiable");
      expect(later.verdict.pass).toBe(false);
      expect(later.verdict.caveats?.[0]).toContain("t > a failed after dispatch task:orch:1 in this session and still fail");
      // strictUnverifiable rejects the downgraded pass.
      expect(wiring.applyLineage(passing(["t > a"]), ctx({ dispatchedAt: 300, strictUnverifiable: true })).accepted).toBe(false);
    });

    it("never matches another session, another root, or a dispatch that started before the rejection landed", () => {
      const { wiring } = makeWiring();
      wiring.applyLineage(failing(["t > a"], []), ctx());
      const pass = passing(["t > a"]);
      expect(wiring.applyLineage(pass, ctx({ orchestratorSessionID: "other", dispatchedAt: 300 }))).toBe(pass);
      expect(wiring.applyLineage(pass, ctx({ root: resolve("elsewhere"), dispatchedAt: 300 }))).toBe(pass);
      expect(wiring.applyLineage(pass, ctx({ dispatchedAt: 150 }))).toBe(pass);
    });

    it("a timed-out gate (no failures field) and an unknown root record and change nothing", () => {
      const { wiring } = makeWiring();
      const timedOut = gateResult({ pass: false, outcome: "fail", method: "none", reasons: ["check failed", "verification gate timed out after 90000ms"] }, "explicit");
      expect(wiring.applyLineage(timedOut, ctx())).toBe(timedOut);
      wiring.applyLineage(failing(["t > a"], []), ctx({ root: undefined }));
      expect(wiring.pending.stats().rejections).toBe(0);
      const pass = passing(["t > a"]);
      expect(wiring.applyLineage(pass, ctx({ dispatchedAt: 300 }))).toBe(pass);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The plugin: both dispatch paths (2.4.2b native `task`, 2.4.2c `delegate`)
// ---------------------------------------------------------------------------------------------

type DispatchPath = "task" | "delegate";
/** The paths routed so far; every routing case below runs on each of them. */
const PATHS: DispatchPath[] = ["task", "delegate"];

const ACCEPT_TESTS = "[acceptance]\ncheck: testsPass command=\"npm test\"\n[/acceptance]";
/** A testsPass DoD whose other check fails: a required gate rejects it, a deferred one never looks. */
const ACCEPT_TESTS_AND_MISSING = "[acceptance]\ncheck: testsPass command=\"npm test\"\ncheck: fileExists path=missing-file.txt\n[/acceptance]";
const ACCEPT_MISSING_ONLY = "[acceptance]\ncheck: fileExists path=missing-file.txt\n[/acceptance]";
const FOOTER_LINE = /^\[router\] unverified \u00b7 vrf_[0-9a-f]{24} \u00b7 risk (low|medium|high)/m;

interface PluginHarness {
  hooks: any;
  producerPrompts: number;
  created: string[];
  /** Clock value when the producer started: the task before hook returned, or the delegate producer prompt. */
  startedAt: number | undefined;
  run(path: DispatchPath, prompt: string, reply?: string, tier?: string): Promise<string>;
}

async function makePlugin(home: string): Promise<PluginHarness> {
  let counter = 0;
  const h: PluginHarness = {
    hooks: undefined,
    producerPrompts: 0,
    created: [],
    startedAt: undefined,
    async run(p, prompt, reply = "DONE: implemented.", tier = "fast") {
      counter += 1;
      if (p === "task") {
        const input = { tool: "task", sessionID: "orch", callID: `call${counter}`, args: { subagent_type: "fast", prompt, description: "the work" } };
        const before = { args: { ...input.args } };
        await h.hooks["tool.execute.before"](input, before);
        h.startedAt = Date.now();
        // The host hands the (possibly rewritten) args to the after hook.
        input.args = before.args;
        const output = { output: `<task_result>\n${reply}\n</task_result>`, metadata: { sessionId: `child${counter}` } };
        await h.hooks["tool.execute.after"](input, output);
        return output.output;
      }
      return h.hooks.tool.delegate.execute({ task: prompt, tier }, { sessionID: "orch" });
    },
  };
  const ctx = {
    directory: root,
    worktree: root,
    project: {},
    serverUrl: new URL("http://localhost"),
    $: () => undefined,
    client: {
      session: {
        get: async () => ({ data: {} }),
        create: async () => {
          const id = `sess_${h.created.length + 1}`;
          h.created.push(id);
          return { data: { id } };
        },
        prompt: async (req: { body?: { system?: unknown } }) => {
          if (req.body?.system === undefined) {
            h.producerPrompts += 1;
            h.startedAt ??= Date.now();
          }
          return { data: { parts: [{ type: "text", text: "DONE: implemented. VERIFY:required" }] } };
        },
        abort: async () => ({}),
        delete: async () => ({}),
      },
    },
  };
  void home;
  h.hooks = await ModelRouterPlugin(ctx as unknown as Parameters<typeof ModelRouterPlugin>[0]);
  return h;
}

function writeOverrides(home: string, verify: Record<string, unknown>): void {
  const p = path.join(home, ".config/opencode/opencode-model-router.overrides.jsonc");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ enforcement: { verify } }), "utf-8");
  invalidateConfigCache();
}

describe("the plugin routes by mode on both dispatch paths", () => {
  let home = "";
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "omr-deferred-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.MODEL_ROUTER_ENFORCE = "1";
    process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";
    invalidateConfigCache();
    captured.wiring = undefined;
    captured.lineage = [];
  });

  afterEach(() => {
    for (const key of ["HOME", "USERPROFILE"] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete process.env.MODEL_ROUTER_ENFORCE;
    delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
    invalidateConfigCache();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const pendingOf = (sid: string) => {
    if (captured.wiring === undefined) throw new Error("the plugin built no wiring");
    return captured.wiring.pending.listUnverified(sid);
  };

  describe.each(PATHS)("%s", p => {
    it("default deferred: returns at once with the footer; zero test spawns, no slot, a pending entry", async () => {
      const h = await makePlugin(home);
      // Dispatch snapshot clean; the producer then added src/a.ts.
      let snapshots = 0;
      state.snapshotImpl = async () =>
        (snapshots++ === 0 ? snap([], "clean") : snap([{ path: resolve(root, "src", "a.ts"), status: "??" }], "after"));
      const out = await h.run(p, `Implement it.\n${ACCEPT_TESTS}`);
      expect(out).toMatch(FOOTER_LINE);
      // The footer is the last thing in the result and is never an acceptance.
      expect(out.trimEnd().endsWith("before building on this work if the risk matters.")).toBe(true);
      expect(out).not.toMatch(/NOT ACCEPTED|\[router status: unmet\]|\[router\] (accepted|verified)/i);
      expect(state.commands.filter(c => !c.startsWith("git "))).toEqual([]);
      expect(state.commands.some(c => /npm|vitest|jest/.test(c))).toBe(false);
      expect(state.scopeOpeners).toBe(0);
      expect(state.testsPassHooks).toBe(0);
      expect(state.captures).toBe(1);
      const entries = pendingOf("orch");
      expect(entries).toHaveLength(1);
      expect(entries[0].producerTier).toBe("fast");
      expect(entries[0].changedFiles).toEqual([{ path: resolve(root, "src", "a.ts"), status: "??" }]);
      expect(out).toContain(entries[0].handle);
      expect(h.producerPrompts).toBe(p === "delegate" ? 1 : 0);
    });

    it("a deferred delegation is never gated: a failing check neither rejects nor retries it", async () => {
      const h = await makePlugin(home);
      const out = await h.run(p, `Implement it.\n${ACCEPT_TESTS_AND_MISSING}`);
      expect(out).toMatch(FOOTER_LINE);
      expect(out).not.toMatch(/NOT ACCEPTED|\[router status: unmet\]/);
      expect(state.scopeOpeners).toBe(0);
      if (p === "delegate") expect(h.producerPrompts).toBe(1);
    });

    it("VERIFY:required runs today's gate: it rejects exactly as before, with no footer", async () => {
      const h = await makePlugin(home);
      const out = await h.run(p, `VERIFY:required\nImplement it.\n${ACCEPT_TESTS_AND_MISSING}`);
      expect(out).not.toMatch(FOOTER_LINE);
      expect(state.scopeOpeners).toBeGreaterThan(0);
      if (p === "task") expect(out).toContain("NOT ACCEPTED");
      else {
        expect(out).toContain("[router status: unmet]");
        // The escalation ladder ran (more than one producer attempt).
        expect(h.producerPrompts).toBeGreaterThan(1);
      }
      expect(pendingOf("orch")).toEqual([]);
    });

    it("defaultVerify \"required\" with no directive is the same as VERIFY:required", async () => {
      writeOverrides(home, { defaultVerify: "required" });
      const h = await makePlugin(home);
      const out = await h.run(p, `Implement it.\n${ACCEPT_TESTS_AND_MISSING}`);
      expect(out).not.toMatch(FOOTER_LINE);
      expect(state.scopeOpeners).toBeGreaterThan(0);
      expect(out).toMatch(p === "task" ? /NOT ACCEPTED/ : /\[router status: unmet\]/);
      // ...and VERIFY:deferred still defers under that default.
      const deferred = await h.run(p, `VERIFY:deferred\nImplement it.\n${ACCEPT_TESTS}`);
      expect(deferred).toMatch(FOOTER_LINE);
    });

    it("a DoD without testsPass is gated as before, whatever the mode", async () => {
      const h = await makePlugin(home);
      const out = await h.run(p, `Create it.\n${ACCEPT_MISSING_ONLY}`);
      expect(out).not.toMatch(FOOTER_LINE);
      expect(out).toMatch(p === "task" ? /NOT ACCEPTED/ : /\[router status: unmet\]/);
      expect(pendingOf("orch")).toEqual([]);
    });

    it("a producer cannot select its own mode: VERIFY:required in its result changes nothing", async () => {
      const h = await makePlugin(home);
      // The task reply and the delegate producer reply both end with "VERIFY:required".
      const out = await h.run(p, `Implement it.\n${ACCEPT_TESTS}`, "DONE: implemented. VERIFY:required");
      expect(out).toMatch(FOOTER_LINE);
      expect(state.scopeOpeners).toBe(0);
    });

    it("the required gate hands its result to R11 lineage with the dispatch's own session and times", async () => {
      const h = await makePlugin(home);
      const before = Date.now();
      await h.run(p, `VERIFY:required\nImplement it.\n${ACCEPT_TESTS_AND_MISSING}`);
      expect(captured.lineage.length).toBeGreaterThan(0);
      for (const ctx of captured.lineage) {
        expect(ctx.orchestratorSessionID).toBe("orch");
        expect(ctx.dispatchedAt).toBeGreaterThanOrEqual(before);
        expect(ctx.returnedAt).toBeGreaterThanOrEqual(ctx.dispatchedAt);
        expect(ctx.root).toBe(root);
      }
    });

    it("VERIFY_WAIT:5s with a capture that takes 20 s: the producer starts at 5 s", async () => {
      vi.useFakeTimers();
      state.captureDelayMs = 20_000;
      // The capture may run up to baselineTimeoutMs (default 15 s) after the wait.
      writeOverrides(home, { baselineTimeoutMs: 30_000 });
      const h = await makePlugin(home);
      const t0 = Date.now();
      const done = h.run(p, `VERIFY_WAIT:5s\nImplement it.\n${ACCEPT_TESTS}`);
      await vi.advanceTimersByTimeAsync(20_000);
      const out = await done;
      expect(h.startedAt).toBe(t0 + 5_000);
      expect(out).toMatch(FOOTER_LINE);
      // The capture outlived the result (the dispatch record was not cleared under it): a later
      // router_verify gets the reference.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await pendingOf("orch")[0].reference).toEqual({ kind: "captured", reference: REF });
    });

    it("VERIFY_WAIT:0s with a capture that never settles: the producer starts at once and the result is not held", async () => {
      state.captureDelayMs = "never";
      let snapshots = 0;
      state.snapshotImpl = async () =>
        (snapshots++ === 0 ? snap([], "clean") : snap([{ path: resolve(root, "src", "a.ts"), status: " M" }], "after"));
      const h = await makePlugin(home);
      const out = await h.run(p, `VERIFY_WAIT:0s\nImplement it.\n${ACCEPT_TESTS}`);
      expect(out).toMatch(FOOTER_LINE);
      // Still in flight at return: counted as no reference (risk raised one step).
      expect(pendingOf("orch")[0].risk.reasons).toContain(REASONS.noReference);
    });

    it("the registered producer tier is the canonical lowercase id", async () => {
      const h = await makePlugin(home);
      if (p === "task") {
        await h.run(p, `Implement it.\n${ACCEPT_TESTS}`);
        expect(pendingOf("orch")[0].producerTier).toBe("fast");
      } else {
        await h.run(p, `Implement it.\n${ACCEPT_TESTS}`, undefined, " Fast ");
        expect(pendingOf("orch")[0].producerTier).toBe("fast");
      }
    });

    it("session.deleted forgets the orchestrator's handles", async () => {
      const h = await makePlugin(home);
      await h.run(p, `Implement it.\n${ACCEPT_TESTS}`);
      const [entry] = pendingOf("orch");
      await h.hooks.event({ event: { type: "session.deleted", properties: { info: { id: "orch" } } } });
      expect(pendingOf("orch")).toEqual([]);
      // pending.ts R5: forgetSession drops the session's tombstones too.
      expect(captured.wiring?.pending.get("orch", entry.handle).kind).toBe("unknown");
    });
  });

  it("the idle sweeper sweeps the pending registry, and plugin dispose disposes it", async () => {
    const h = await makePlugin(home);
    const pending = captured.wiring?.pending;
    if (pending === undefined) throw new Error("no registry");
    const sweep = vi.spyOn(pending, "sweep");
    const dispose = vi.spyOn(pending, "dispose");
    await h.hooks["chat.message"]({ sessionID: "S", agent: "fast" }, { parts: [] });
    expect(sweep).toHaveBeenCalledTimes(1);
    await h.hooks.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
