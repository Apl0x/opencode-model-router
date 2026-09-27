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
import { resolve } from "node:path";
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
vi.mock("../../src/verify/reference", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/verify/reference")>()),
  captureReference: () => {
    state.captures += 1;
    return new Promise(resolveCapture => {
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
