import { describe, expect, it } from "vitest";
import type { DoD } from "../../src/verify/dod";
import type { RiskAssessment } from "../../src/verify/risk";
import type { ChangedPath } from "../../src/verify/runner";
import type { ReferenceState } from "../../src/verify/types";
import {
  ABANDONED_REASON,
  DISPOSED_REASON,
  EXPIRED_HANDLE_TEXT,
  HANDLE_MAX_DRAWS,
  HANDLE_PATTERN,
  MAX_DESCRIPTION_CHARS,
  MAX_LEDGER_IDS,
  MAX_LEDGER_PER_SESSION,
  MAX_STORED_CHANGED_FILES,
  REFERENCE_FAILED_REASON,
  RELEASED_REASON,
  TOMBSTONE_MAX,
  UNATTRIBUTED_RISK_REASON,
  UNKNOWN_HANDLE_TEXT,
  VERIFYING_ELSEWHERE_TEXT,
  appendRouterFooter,
  buildDeferredFooter,
  buildLateNoticeBlock,
  buildLineageCaveat,
  buildPendingListBlock,
  createPendingRegistry,
  driftedPaths,
  formatRisk,
  normalizeHandle,
  sanitizeDescription,
  unattributedRisk,
  type ClaimResult,
  type EvictionCause,
  type PendingEntry,
  type PendingRegistration,
  type PendingRegistryOptions,
  type SettledVerification,
  type VerificationResult,
} from "../../src/verify/pending";

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const TTL = 3_600_000;
const MAX_VERIFYING = 60_000;
const DIRECTIVE = /\b(?:VERIFY|VERIFY_WAIT|CAP)\s*:/i;

const DOD: DoD = { kind: "deterministic", checks: [], criteria: [], deliverable: null, source: "explicit" };
const RISK: RiskAssessment = { level: "medium", reasons: ["6-15 files changed"] };

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void; set: (v: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (v) => {
      t = v;
    },
  };
}

/** Deterministic random: counter in the last bytes, so every draw is distinct. */
function counterRandom(): (bytes: number) => Uint8Array {
  let n = 0;
  return (bytes) => {
    n += 1;
    const out = new Uint8Array(bytes);
    out[bytes - 1] = n & 0xff;
    out[bytes - 2] = (n >> 8) & 0xff;
    return out;
  };
}

function hexOf(n: number): string {
  return `vrf_${n.toString(16).padStart(24, "0")}`;
}

function paths(n: number): ChangedPath[] {
  return Array.from({ length: n }, (_, i) => ({ path: `/repo/f${i}.ts`, status: "M" }));
}

function captured(untracked: number, tracked: number): ReferenceState {
  const map = (n: number, p: string): Map<string, string> =>
    new Map(Array.from({ length: n }, (_, i) => [`${p}${i}`, "0".repeat(64)]));
  return {
    kind: "captured",
    reference: {
      root: "/repo",
      head: "a".repeat(40),
      commit: "b".repeat(40),
      untracked: map(untracked, "u"),
      tracked: map(tracked, "t"),
      captureReasons: [],
      capturedAt: 0,
    },
  };
}

function reg(overrides: Partial<PendingRegistration> = {}): PendingRegistration {
  return {
    orchestratorSessionID: "orch",
    dispatchID: "d1",
    producerSessionID: "child",
    producerTier: "fast",
    description: "fix the parser",
    cwd: "/repo",
    root: "/repo",
    dispatchedAt: 999_000,
    dod: DOD,
    reference: Promise.resolve<ReferenceState>({ kind: "disabled" }),
    changedFiles: paths(2),
    risk: RISK,
    ...overrides,
  };
}

function setup(extra: Partial<PendingRegistryOptions> = {}) {
  const c = clock();
  const evictions: Array<{ handle: string; cause: EvictionCause }> = [];
  const registry = createPendingRegistry({
    ttlMs: TTL,
    maxVerifyingMs: MAX_VERIFYING,
    now: c.now,
    random: counterRandom(),
    onEvict: (entry, cause) => evictions.push({ handle: entry.handle, cause }),
    ...extra,
  });
  const add = (overrides: Partial<PendingRegistration> = {}): string => {
    const r = registry.register(reg(overrides));
    if (!r.ok) throw new Error(`register failed: ${r.code}`);
    return r.handle;
  };
  return { c, registry, evictions, add };
}

function claimed(result: ClaimResult): Extract<ClaimResult, { kind: "claimed" }> {
  if (result.kind !== "claimed") throw new Error(`expected claimed, got ${result.kind}`);
  return result;
}

const PASS: VerificationResult = {
  verdict: { pass: true, outcome: "pass", method: "deterministic", reasons: ["tests pass"] },
  retryable: false,
};
const BUSY: VerificationResult = {
  verdict: { pass: false, outcome: "unverifiable", method: "deterministic", reasons: ["slot busy"] },
  retryable: true,
};

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function stateOf(registry: ReturnType<typeof setup>["registry"], sid: string, handle: string): string {
  const found = registry.get(sid, handle);
  return found.kind === "found" ? found.entry.state : found.kind;
}

// ---------------------------------------------------------------------------------------------
// R2 handles
// ---------------------------------------------------------------------------------------------

describe("handles (R2)", () => {
  it("issues vrf_ + 24 lowercase hex from the default random source", () => {
    const registry = createPendingRegistry({ ttlMs: TTL, maxVerifyingMs: MAX_VERIFYING });
    const r = registry.register(reg());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.handle).toMatch(HANDLE_PATTERN);
  });

  it("uses the injected random source", () => {
    const { add } = setup();
    expect(add()).toBe(hexOf(1));
    expect(add()).toBe(hexOf(2));
  });

  it("redraws a collision with a live handle", () => {
    const draws = [1, 1, 1, 2];
    const random = (bytes: number): Uint8Array => {
      const out = new Uint8Array(bytes);
      out[bytes - 1] = draws.shift() ?? 9;
      return out;
    };
    const { add } = setup({ random });
    expect(add()).toBe(hexOf(1));
    expect(add()).toBe(hexOf(2));
  });

  it("returns handle-collision after HANDLE_MAX_DRAWS draws, evicting nothing", () => {
    let calls = 0;
    const random = (bytes: number): Uint8Array => {
      calls += 1;
      return new Uint8Array(bytes);
    };
    const { registry, add, evictions } = setup({ random, maxPerSession: 1 });
    add();
    calls = 0;
    const r = registry.register(reg());
    expect(r).toMatchObject({ ok: false, code: "handle-collision" });
    expect(calls).toBe(HANDLE_MAX_DRAWS);
    expect(evictions).toEqual([]);
    expect(registry.stats().entries).toBe(1);
  });

  it("never reissues a tombstoned handle", () => {
    const draws = [1, 1, 2];
    const random = (bytes: number): Uint8Array => {
      const out = new Uint8Array(bytes);
      out[bytes - 1] = draws.shift() ?? 9;
      return out;
    };
    const { registry, add } = setup({ random });
    const first = add();
    registry.forgetSession("other");
    registry.sweep(Number.MAX_SAFE_INTEGER);
    expect(registry.get("orch", first).kind).toBe("expired");
    expect(add()).toBe(hexOf(2));
  });

  it("redraws a random source that does not yield 12 bytes", () => {
    const sizes = [3, 12];
    const random = (): Uint8Array => new Uint8Array(sizes.shift() ?? 12).fill(0xab);
    const { add } = setup({ random });
    expect(add()).toBe(`vrf_${"ab".repeat(12)}`);
  });

  it("normalizeHandle trims, strips one pair of quotes/backticks and lowercases", () => {
    const h = hexOf(0xabc);
    expect(normalizeHandle(`  ${h}  `)).toBe(h);
    expect(normalizeHandle(`\`${h}\``)).toBe(h);
    expect(normalizeHandle(`"${h}"`)).toBe(h);
    expect(normalizeHandle(`'${h}'`)).toBe(h);
    expect(normalizeHandle(h.toUpperCase().replace("VRF_", "VRF_"))).toBe(h);
    expect(normalizeHandle(`""${h}""`)).toBeUndefined();
    expect(normalizeHandle(`"${h}'`)).toBeUndefined();
    expect(normalizeHandle(`${h}0`)).toBeUndefined();
    expect(normalizeHandle("vrf_xyz")).toBeUndefined();
    expect(normalizeHandle("")).toBeUndefined();
    expect(normalizeHandle("`")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// R3/R5 register
// ---------------------------------------------------------------------------------------------

describe("register (R3, R5)", () => {
  it("rejects empty or identical session ids as invalid-input", () => {
    const { registry } = setup();
    expect(registry.register(reg({ orchestratorSessionID: "" }))).toMatchObject({ ok: false, code: "invalid-input" });
    expect(registry.register(reg({ producerSessionID: "" }))).toMatchObject({ ok: false, code: "invalid-input" });
    expect(registry.register(reg({ producerSessionID: "orch" }))).toMatchObject({ ok: false, code: "invalid-input" });
    expect(registry.stats().entries).toBe(0);
  });

  it("stores the registration with a sanitized description and createdAt = now", () => {
    const { registry, add, c } = setup();
    const handle = add({ description: "fix\tthe `parser`\n now" });
    const found = registry.get("orch", handle);
    expect(found.kind).toBe("found");
    if (found.kind !== "found") return;
    expect(found.entry).toMatchObject({
      handle,
      orchestratorSessionID: "orch",
      dispatchID: "d1",
      producerSessionID: "child",
      producerTier: "fast",
      description: "fix the 'parser' now",
      createdAt: c.now(),
      state: "unverified",
      verifyingSince: undefined,
      result: undefined,
      changedFilesDropped: 0,
      digests: undefined,
      dod: DOD,
    });
    expect(found.entry.changedFiles).toEqual(paths(2));
    expect(registry.stats().weight).toBe(2);
  });

  it("stores more than MAX_STORED_CHANGED_FILES paths as unavailable with the dropped count", () => {
    const { registry, add } = setup();
    const handle = add({ changedFiles: paths(MAX_STORED_CHANGED_FILES + 1) });
    const found = registry.get("orch", handle);
    if (found.kind !== "found") throw new Error("not found");
    expect(found.entry.changedFiles).toBe("unavailable");
    expect(found.entry.changedFilesDropped).toBe(MAX_STORED_CHANGED_FILES + 1);
    expect(registry.stats().weight).toBe(0);
    const exact = add({ changedFiles: paths(MAX_STORED_CHANGED_FILES) });
    const e2 = registry.get("orch", exact);
    if (e2.kind !== "found") throw new Error("not found");
    expect(e2.entry.changedFiles).toHaveLength(MAX_STORED_CHANGED_FILES);
  });

  it("keeps unavailable changed files as unavailable", () => {
    const { registry, add } = setup();
    const handle = add({ changedFiles: "unavailable" });
    const found = registry.get("orch", handle);
    if (found.kind !== "found") throw new Error("not found");
    expect(found.entry.changedFiles).toBe("unavailable");
    expect(found.entry.changedFilesDropped).toBe(0);
  });

  it("normalizes a rejected reference and rejected digests (never rejects)", async () => {
    const { registry, add } = setup();
    const handle = add({
      reference: Promise.reject(new Error("boom")),
      digests: Promise.reject(new Error("fs")),
    });
    const found = registry.get("orch", handle);
    if (found.kind !== "found") throw new Error("not found");
    await expect(found.entry.reference).resolves.toEqual({ kind: "none", reason: REFERENCE_FAILED_REASON });
    await expect(found.entry.digests).resolves.toBeUndefined();
  });

  it("passes resolved digests through", async () => {
    const { registry, add } = setup();
    const digests = new Map([["/repo/a.ts", "x"]]);
    const handle = add({ digests: Promise.resolve(digests) });
    const found = registry.get("orch", handle);
    if (found.kind !== "found") throw new Error("not found");
    await expect(found.entry.digests).resolves.toBe(digests);
  });

  it("returns frozen snapshots that later transitions do not mutate", () => {
    const { registry, add } = setup();
    const handle = add();
    const before = registry.get("orch", handle);
    if (before.kind !== "found") throw new Error("not found");
    expect(Object.isFrozen(before.entry)).toBe(true);
    registry.markVerifying("orch", handle);
    expect(before.entry.state).toBe("unverified");
    expect(stateOf(registry, "orch", handle)).toBe("verifying");
  });
});

// ---------------------------------------------------------------------------------------------
// R6 scoping
// ---------------------------------------------------------------------------------------------

describe("scoping (R6)", () => {
  it("reports unknown for another session, the producer session, malformed and never-issued handles", () => {
    const { registry, add } = setup();
    const handle = add();
    add({ orchestratorSessionID: "other", producerSessionID: "child2" });
    const unknown = { kind: "unknown" };
    expect(registry.get("other", handle)).toMatchObject(unknown);
    expect(registry.get("child", handle)).toMatchObject(unknown);
    expect(registry.get("orch", "not-a-handle")).toMatchObject(unknown);
    expect(registry.get("orch", hexOf(0xfff))).toMatchObject(unknown);
    expect(registry.markVerifying("other", handle)).toMatchObject(unknown);
    expect(registry.markVerifying("child", handle)).toMatchObject(unknown);
    expect(registry.listUnverified("child")).toEqual([]);
    expect(registry.listOpen("child")).toEqual([]);
    expect(registry.listUnverified("orch").map((e) => e.handle)).toEqual([handle]);
  });

  it("reports expired for the own session's tombstone and unknown for any other session", () => {
    const { registry, add, c } = setup();
    const handle = add();
    c.advance(TTL);
    expect(registry.get("orch", handle)).toEqual({ kind: "expired", handle });
    expect(registry.markVerifying("orch", handle)).toEqual({ kind: "expired", handle });
    expect(registry.get("other", handle)).toEqual({ kind: "unknown", handle });
  });

  it("bounds tombstones FIFO at TOMBSTONE_MAX", () => {
    const { registry, add } = setup({ onEvict: undefined });
    const first = add();
    for (let i = 0; i < TOMBSTONE_MAX; i += 1) add({ orchestratorSessionID: `s${i}` });
    registry.sweep(Number.MAX_SAFE_INTEGER);
    expect(registry.stats().tombstones).toBe(TOMBSTONE_MAX);
    expect(registry.get("orch", first).kind).toBe("unknown");
  });

  it("exports the stable phrases", () => {
    expect(UNKNOWN_HANDLE_TEXT).toBe("unknown handle");
    expect(EXPIRED_HANDLE_TEXT).toBe("expired handle: older than pendingTtlMs or evicted; it can no longer be verified");
    expect(VERIFYING_ELSEWHERE_TEXT).toBe(
      "still being verified by another router_verify call; call again for its verdict",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// R4 transitions, R8 join
// ---------------------------------------------------------------------------------------------

describe("transitions (R4, R8)", () => {
  it("unverified -> verifying (claimed) -> joined -> verified (terminal) -> settled", async () => {
    const { registry, add, c } = setup();
    const handle = add();
    const claim = claimed(registry.markVerifying("orch", handle));
    expect(claim.entry.state).toBe("verifying");
    expect(claim.entry.verifyingSince).toBe(c.now());
    const joined = registry.markVerifying("orch", handle);
    expect(joined.kind).toBe("joined");
    if (joined.kind !== "joined") return;
    expect(joined.run).toBe(claim.run);
    c.advance(5);
    expect(claim.settle(PASS)).toBe(true);
    const settled = await claim.run;
    expect(await joined.run).toBe(settled);
    expect(settled).toMatchObject({ handle, settledAt: c.now(), retryable: false, verdict: PASS.verdict });
    const again = registry.markVerifying("orch", handle);
    expect(again).toMatchObject({ kind: "settled", result: settled });
    expect(stateOf(registry, "orch", handle)).toBe("verified");
    expect(registry.listOpen("orch")).toEqual([]);
    expect(registry.listUnverified("orch")).toEqual([]);
  });

  it("N concurrent markVerifying calls produce exactly one claim and one run", () => {
    const { registry, add } = setup();
    const handle = add();
    const results = Array.from({ length: 5 }, () => registry.markVerifying("orch", handle));
    expect(results.filter((r) => r.kind === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "joined")).toHaveLength(4);
    const runs = new Set(results.map((r) => ("run" in r ? r.run : undefined)));
    expect(runs.size).toBe(1);
    expect(registry.stats().verifying).toBe(1);
  });

  it("settle is single-use", () => {
    const { registry, add } = setup();
    const handle = add();
    const claim = claimed(registry.markVerifying("orch", handle));
    expect(claim.settle(PASS)).toBe(true);
    expect(claim.settle(BUSY)).toBe(false);
    expect(stateOf(registry, "orch", handle)).toBe("verified");
  });

  it("a retryable (non-informative) result returns the entry to unverified with lastResult", async () => {
    const { registry, add } = setup();
    const handle = add();
    const claim = claimed(registry.markVerifying("orch", handle));
    expect(claim.settle(BUSY)).toBe(true);
    const settled = await claim.run;
    expect(settled.retryable).toBe(true);
    const found = registry.get("orch", handle);
    if (found.kind !== "found") throw new Error("not found");
    expect(found.entry.state).toBe("unverified");
    expect(found.entry.result).toBe(settled);
    expect(found.entry.verifyingSince).toBeUndefined();
    expect(found.entry.dod).toBe(DOD);
    expect(registry.listUnverified("orch").map((e) => e.handle)).toEqual([handle]);
    const second = claimed(registry.markVerifying("orch", handle));
    expect(second.run).not.toBe(claim.run);
    expect(claim.settle(PASS)).toBe(false);
  });

  it("reaps an abandoned claim lazily and ignores its stale settle", async () => {
    const { registry, add, c } = setup();
    const handle = add();
    const claim = claimed(registry.markVerifying("orch", handle));
    c.advance(MAX_VERIFYING - 1);
    expect(stateOf(registry, "orch", handle)).toBe("verifying");
    c.advance(1);
    expect(stateOf(registry, "orch", handle)).toBe("unverified");
    const settled: SettledVerification = await claim.run;
    expect(settled).toMatchObject({ handle, retryable: true, settledAt: c.now() });
    expect(settled.verdict).toEqual({
      pass: false,
      outcome: "unverifiable",
      method: "deterministic",
      reasons: [ABANDONED_REASON],
      caveats: [ABANDONED_REASON],
    });
    expect(claim.settle(PASS)).toBe(false);
    const next = claimed(registry.markVerifying("orch", handle));
    expect(next.settle(PASS)).toBe(true);
  });

  it("releases the heavy fields on a terminal settle", async () => {
    const { registry, add } = setup();
    const handle = add({ digests: Promise.resolve(new Map()) });
    expect(registry.stats().weight).toBe(2);
    claimed(registry.markVerifying("orch", handle)).settle(PASS);
    const found = registry.get("orch", handle);
    if (found.kind !== "found") throw new Error("not found");
    expect(found.entry.dod).toBeUndefined();
    expect(found.entry.digests).toBeUndefined();
    expect(found.entry.changedFiles).toBe("unavailable");
    await expect(found.entry.reference).resolves.toEqual({ kind: "none", reason: RELEASED_REASON });
    expect(registry.stats().weight).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// R7 TTL, caps, weight, eviction order
// ---------------------------------------------------------------------------------------------

describe("TTL and eviction (R7)", () => {
  it("expires at read time without a sweep (get, listUnverified, listOpen, markVerifying)", () => {
    const { registry, add, c, evictions } = setup();
    const a = add();
    c.advance(10);
    const b = add();
    c.advance(TTL - 10);
    expect(registry.listUnverified("orch").map((e) => e.handle)).toEqual([b]);
    expect(evictions).toEqual([{ handle: a, cause: "ttl" }]);
    expect(registry.listOpen("orch").map((e) => e.handle)).toEqual([b]);
    c.advance(10);
    expect(registry.listUnverified("orch")).toEqual([]);
    expect(registry.markVerifying("orch", b)).toEqual({ kind: "expired", handle: b });
  });

  it("sweep evicts and counts; future stamps never expire", () => {
    const { registry, add, c } = setup();
    add();
    add();
    expect(registry.sweep(c.now() - 5_000_000)).toBe(0);
    expect(registry.sweep(c.now() + TTL - 1)).toBe(0);
    expect(registry.sweep(c.now() + TTL)).toBe(2);
    expect(registry.stats().entries).toBe(0);
    expect(registry.sweep()).toBe(0);
  });

  it("never evicts a verifying entry by TTL, and evicts it at settle once past its TTL", () => {
    const { registry, add, c, evictions } = setup({ maxVerifyingMs: TTL * 2 });
    const handle = add();
    const claim = claimed(registry.markVerifying("orch", handle));
    c.advance(TTL + 1);
    expect(registry.sweep()).toBe(0);
    expect(stateOf(registry, "orch", handle)).toBe("verifying");
    expect(claim.settle(PASS)).toBe(true);
    expect(evictions).toEqual([{ handle, cause: "ttl" }]);
    expect(registry.get("orch", handle).kind).toBe("expired");
  });

  it("ignores a throwing onEvict hook", () => {
    const { registry, add, c } = setup({
      onEvict: () => {
        throw new Error("log failure");
      },
    });
    const handle = add();
    c.advance(TTL);
    expect(registry.sweep()).toBe(1);
    expect(registry.get("orch", handle).kind).toBe("expired");
  });

  it("session cap evicts TTL-expired, then verified oldest, then unverified oldest; never verifying", () => {
    const { registry, add, c, evictions } = setup({ maxPerSession: 3 });
    const u1 = add();
    c.advance(1);
    const u2 = add();
    c.advance(1);
    const v = add();
    claimed(registry.markVerifying("orch", v)).settle(PASS);
    c.advance(1);
    const r1 = registry.register(reg());
    expect(r1).toMatchObject({ ok: true, evicted: [v] });
    expect(evictions).toEqual([{ handle: v, cause: "session-cap" }]);
    const r2 = registry.register(reg());
    expect(r2).toMatchObject({ ok: true, evicted: [u1] });
    claimed(registry.markVerifying("orch", u2));
    if (!r1.ok || !r2.ok) return;
    claimed(registry.markVerifying("orch", r1.handle));
    claimed(registry.markVerifying("orch", r2.handle));
    const full = registry.register(reg());
    expect(full).toMatchObject({ ok: false, code: "registry-full" });
    expect(registry.stats()).toMatchObject({ entries: 3, verifying: 3 });
    // Other sessions are unaffected by the session cap.
    expect(registry.register(reg({ orchestratorSessionID: "other" })).ok).toBe(true);
  });

  it("an expired entry is removed before the cap is applied", () => {
    const { registry, add, c, evictions } = setup({ maxPerSession: 1 });
    const old = add();
    c.advance(TTL);
    expect(registry.register(reg())).toMatchObject({ ok: true, evicted: [] });
    expect(evictions).toEqual([{ handle: old, cause: "ttl" }]);
  });

  it("global cap evicts across sessions in order; registry-full when everything is verifying", () => {
    const { registry, add, c, evictions } = setup({ maxGlobal: 2 });
    const a = add({ orchestratorSessionID: "s1" });
    c.advance(1);
    const b = add({ orchestratorSessionID: "s2" });
    c.advance(1);
    const r = registry.register(reg({ orchestratorSessionID: "s3" }));
    expect(r).toMatchObject({ ok: true, evicted: [a] });
    expect(evictions).toEqual([{ handle: a, cause: "global-cap" }]);
    expect(registry.stats().sessions).toBe(2);
    claimed(registry.markVerifying("s2", b));
    if (r.ok) claimed(registry.markVerifying("s3", r.handle));
    expect(registry.register(reg({ orchestratorSessionID: "s4" }))).toMatchObject({ ok: false, code: "registry-full" });
  });

  it("a zero per-session cap refuses every registration", () => {
    const { registry } = setup({ maxPerSession: 0 });
    expect(registry.register(reg())).toMatchObject({ ok: false, code: "registry-full" });
  });

  it("weight cap evicts by changed-path weight and refuses an entry that can never fit", () => {
    const { registry, add, c, evictions } = setup({ maxWeight: 10 });
    const a = add({ changedFiles: paths(4) });
    c.advance(1);
    add({ changedFiles: paths(4) });
    c.advance(1);
    expect(registry.register(reg({ changedFiles: paths(4) }))).toMatchObject({ ok: true, evicted: [a] });
    expect(evictions).toEqual([{ handle: a, cause: "weight-cap" }]);
    expect(registry.stats().weight).toBe(8);
    expect(registry.register(reg({ changedFiles: paths(11) }))).toMatchObject({ ok: false, code: "registry-full" });
    expect(registry.stats().entries).toBe(2);
  });

  it("adds the captured reference's weight when it resolves and evicts over the weight cap", async () => {
    const { registry, add, c, evictions } = setup({ maxWeight: 20 });
    const a = add({ changedFiles: paths(2) });
    c.advance(1);
    let resolveRef: (s: ReferenceState) => void = () => undefined;
    const pendingRef = new Promise<ReferenceState>((resolve) => {
      resolveRef = resolve;
    });
    const b = add({ changedFiles: paths(3), reference: pendingRef });
    await flush();
    expect(registry.stats().weight).toBe(5);
    resolveRef(captured(10, 5));
    await flush();
    expect(registry.stats().weight).toBe(20);
    expect(evictions).toEqual([]);
    const c2 = add({ changedFiles: paths(1), reference: Promise.resolve(captured(1, 0)) });
    await flush();
    expect(evictions).toEqual([{ handle: a, cause: "weight-cap" }]);
    expect(registry.stats().weight).toBe(20);
    expect(registry.listUnverified("orch").map((e) => e.handle)).toEqual([c2, b]);
  });

  it("does not add reference weight after the entry is gone or released", async () => {
    const { registry, add } = setup();
    let resolveRef: (s: ReferenceState) => void = () => undefined;
    const ref = new Promise<ReferenceState>((resolve) => {
      resolveRef = resolve;
    });
    const handle = add({ reference: ref });
    claimed(registry.markVerifying("orch", handle)).settle(PASS);
    resolveRef(captured(4, 4));
    await flush();
    expect(registry.stats().weight).toBe(0);
  });

  it("listUnverified is newest first with registration order breaking ties, and honours limit", () => {
    const { registry, add, c } = setup();
    const a = add();
    const b = add();
    c.advance(1);
    const d = add();
    const verifying = add();
    registry.markVerifying("orch", verifying);
    expect(registry.listUnverified("orch").map((e) => e.handle)).toEqual([d, b, a]);
    expect(registry.listUnverified("orch", 2).map((e) => e.handle)).toEqual([d, b]);
    expect(registry.listUnverified("orch", -1)).toEqual([]);
    expect(registry.listOpen("orch").map((e) => e.handle)).toEqual([verifying, d, b, a]);
    expect(registry.listUnverified("nobody")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// forgetSession, dispose
// ---------------------------------------------------------------------------------------------

describe("forgetSession and dispose (R5)", () => {
  it("forgetSession evicts entries, tombstones and rejections; a verifying entry is evicted at settle", async () => {
    const { registry, add, evictions } = setup();
    const gone = add();
    const busy = add();
    const other = add({ orchestratorSessionID: "other" });
    const claim = claimed(registry.markVerifying("orch", busy));
    registry.recordRejection({ orchestratorSessionID: "orch", root: "/repo", label: "x", landedAt: 0, introduced: ["t1"] });
    registry.forgetSession("orch");
    expect(evictions).toEqual([{ handle: gone, cause: "session-gone" }]);
    expect(registry.get("orch", gone).kind).toBe("unknown");
    expect(stateOf(registry, "orch", busy)).toBe("verifying");
    expect(registry.stats().rejections).toBe(0);
    expect(claim.settle(BUSY)).toBe(true);
    await claim.run;
    expect(evictions).toContainEqual({ handle: busy, cause: "session-gone" });
    expect(registry.get("orch", busy).kind).toBe("expired");
    expect(stateOf(registry, "other", other)).toBe("unverified");
  });

  it("a doomed verifying entry that is reaped is evicted", () => {
    const { registry, add, c, evictions } = setup();
    const busy = add();
    claimed(registry.markVerifying("orch", busy));
    registry.forgetSession("orch");
    c.advance(MAX_VERIFYING);
    registry.sweep();
    expect(evictions).toEqual([{ handle: busy, cause: "session-gone" }]);
  });

  it("dispose resolves claimers and joiners with DISPOSED and later settles return false", async () => {
    const { registry, add, evictions } = setup();
    const busy = add();
    const idle = add();
    const claim = claimed(registry.markVerifying("orch", busy));
    const join = registry.markVerifying("orch", busy);
    registry.dispose();
    const settled = await claim.run;
    expect(settled.verdict.reasons).toEqual([DISPOSED_REASON]);
    expect(settled.retryable).toBe(true);
    if (join.kind === "joined") expect(await join.run).toBe(settled);
    expect(claim.settle(PASS)).toBe(false);
    expect(evictions.map((e) => e.cause)).toEqual(["disposed", "disposed"]);
    expect(evictions.map((e) => e.handle).sort()).toEqual([busy, idle].sort());
    expect(registry.stats()).toMatchObject({ entries: 0, sessions: 0, verifying: 0, weight: 0, rejections: 0 });
  });
});

// ---------------------------------------------------------------------------------------------
// R11 lineage
// ---------------------------------------------------------------------------------------------

describe("lineage (R11)", () => {
  const base = { orchestratorSessionID: "orch", root: "/repo", label: "vrf_a", landedAt: 100, introduced: ["t1", "t2"] };

  it("matches the newest record of the same session and root with landedAt <= dispatchedAt", () => {
    const { registry } = setup();
    registry.recordRejection(base);
    registry.recordRejection({ ...base, label: "dispatch d9", landedAt: 150, introduced: ["t2", "t3"] });
    expect(
      registry.findLineage({ orchestratorSessionID: "orch", root: "/repo", dispatchedAt: 200, preexisting: ["t3", "t1", "t2"] }),
    ).toEqual({ label: "dispatch d9", ids: ["t3", "t2"] });
    expect(
      registry.findLineage({ orchestratorSessionID: "orch", root: "/repo", dispatchedAt: 120, preexisting: ["t2", "t1"] }),
    ).toEqual({ label: "vrf_a", ids: ["t2", "t1"] });
  });

  it("returns undefined for another session, another root, a later landedAt or no intersection", () => {
    const { registry } = setup();
    registry.recordRejection(base);
    const q = { orchestratorSessionID: "orch", root: "/repo", dispatchedAt: 200, preexisting: ["t1"] };
    expect(registry.findLineage(q)).toBeDefined();
    expect(registry.findLineage({ ...q, orchestratorSessionID: "other" })).toBeUndefined();
    expect(registry.findLineage({ ...q, root: "/elsewhere" })).toBeUndefined();
    expect(registry.findLineage({ ...q, dispatchedAt: 99 })).toBeUndefined();
    expect(registry.findLineage({ ...q, preexisting: ["t9"] })).toBeUndefined();
  });

  it("ignores empty records, caps ids and records, and expires records with ttlMs", () => {
    const { registry, c } = setup();
    registry.recordRejection({ ...base, introduced: [] });
    registry.recordRejection({ ...base, root: "" });
    registry.recordRejection({ ...base, orchestratorSessionID: "" });
    expect(registry.stats().rejections).toBe(0);
    const many = Array.from({ length: MAX_LEDGER_IDS + 5 }, (_, i) => `id${i}`);
    registry.recordRejection({ ...base, label: "first", introduced: many });
    const q = { orchestratorSessionID: "orch", root: "/repo", dispatchedAt: 200, preexisting: many };
    expect(registry.findLineage(q)?.ids).toHaveLength(MAX_LEDGER_IDS);
    for (let i = 0; i < MAX_LEDGER_PER_SESSION; i += 1) registry.recordRejection({ ...base, label: `r${i}`, introduced: ["x"] });
    expect(registry.stats().rejections).toBe(MAX_LEDGER_PER_SESSION);
    expect(registry.findLineage({ ...q, preexisting: ["x"] })?.label).toBe(`r${MAX_LEDGER_PER_SESSION - 1}`);
    // The oldest record ("first") was dropped by the per-session cap.
    expect(registry.findLineage(q)).toBeUndefined();
    c.advance(TTL);
    expect(registry.findLineage({ ...q, preexisting: ["x"] })).toBeUndefined();
    expect(registry.stats().rejections).toBe(0);
  });

  it("claim.settle records a terminal result with introduced ids and a known root", () => {
    const { registry, add, c } = setup();
    const handle = add();
    const created = c.now();
    claimed(registry.markVerifying("orch", handle)).settle({ ...PASS, verdict: { ...PASS.verdict, pass: false }, introduced: ["t1"] });
    expect(
      registry.findLineage({ orchestratorSessionID: "orch", root: "/repo", dispatchedAt: created, preexisting: ["t1"] }),
    ).toEqual({ label: handle, ids: ["t1"] });
    const noRoot = add({ root: undefined });
    claimed(registry.markVerifying("orch", noRoot)).settle({ ...PASS, introduced: ["t2"] });
    const retry = add();
    claimed(registry.markVerifying("orch", retry)).settle({ ...BUSY, introduced: ["t3"] });
    expect(registry.stats().rejections).toBe(1);
  });

  it("buildLineageCaveat is verbatim and caps ids at 10", () => {
    expect(buildLineageCaveat({ label: "vrf_a", ids: ["t1", "t2"] })).toBe(
      "t1, t2 failed after vrf_a in this session and still fail; the reference of this delegation already contained that change, so pre-existing cannot be told apart from not fixed",
    );
    const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
    expect(buildLineageCaveat({ label: "dispatch d1", ids })).toMatch(/^t0, .*t9 \(\+2 more\) failed after dispatch d1 /);
  });
});

// ---------------------------------------------------------------------------------------------
// R9 text
// ---------------------------------------------------------------------------------------------

function entry(handle: string, description: string, risk: RiskAssessment = RISK): PendingEntry {
  return {
    handle,
    orchestratorSessionID: "orch",
    dispatchID: "d",
    producerSessionID: "c",
    producerTier: "",
    description,
    cwd: "/repo",
    root: "/repo",
    dispatchedAt: 0,
    dod: undefined,
    reference: Promise.resolve({ kind: "disabled" }),
    changedFiles: "unavailable",
    changedFilesDropped: 0,
    risk,
    digests: undefined,
    createdAt: 0,
    state: "unverified",
    verifyingSince: undefined,
    result: undefined,
  };
}

describe("text (R9)", () => {
  const h = hexOf(1);

  it("builds the deferred footer verbatim with a handle", () => {
    const footer = buildDeferredFooter({ handle: h, risk: { level: "high", reasons: ["a", "b", "c", "d", "e"] } });
    expect(footer).toBe(
      `[router] unverified \u00b7 ${h} \u00b7 risk high (a; b; c; +2 more)\n` +
        "[router] Call `router_verify` with this handle before building on this work if the risk matters.",
    );
    expect(footer.split("\n")[0].slice("[router] ".length).split(" ")[0]).toBe("unverified");
  });

  it("builds the no-handle footer for every failure code", () => {
    const tail =
      "\n[router] This delegation cannot be verified later; re-dispatch it with required verification if the risk matters.";
    const risk: RiskAssessment = { level: "low", reasons: [] };
    expect(buildDeferredFooter({ handle: undefined, risk, unregistered: "registry-full" })).toBe(
      `[router] unverified \u00b7 no handle (pending registry full) \u00b7 risk low${tail}`,
    );
    expect(buildDeferredFooter({ handle: undefined, risk, unregistered: "handle-collision" })).toBe(
      `[router] unverified \u00b7 no handle (handle allocation failed) \u00b7 risk low${tail}`,
    );
    expect(buildDeferredFooter({ handle: undefined, risk, unregistered: "invalid-input" })).toBe(
      `[router] unverified \u00b7 no handle (not registered) \u00b7 risk low${tail}`,
    );
    expect(buildDeferredFooter({ handle: undefined, risk })).toContain("no handle (not registered)");
  });

  it("keeps the label rule even when a reason mentions verified", () => {
    const footer = buildDeferredFooter({ handle: h, risk: { level: "high", reasons: ["cannot be verified"] } });
    expect(footer.startsWith("[router] unverified \u00b7 ")).toBe(true);
  });

  it("formatRisk honours maxReasons and sanitizes reasons", () => {
    expect(formatRisk("medium", ["a", "b"], 3)).toBe("risk medium (a; b)");
    expect(formatRisk("medium", ["a", "b", "c", "d"], 3)).toBe("risk medium (a; b; c; +1 more)");
    expect(formatRisk("medium", ["a", "b"], 0)).toBe("risk medium");
    expect(formatRisk("low", [], 3)).toBe("risk low");
    expect(formatRisk("high", ["x\n`y`"], 1)).toBe("risk high (x 'y')");
  });

  it("appendRouterFooter trims the output end and handles empty output", () => {
    expect(appendRouterFooter("done\n\n  ", "[router] f")).toBe("done\n\n[router] f");
    expect(appendRouterFooter("  \n", "[router] f")).toBe("[router] f");
    expect(appendRouterFooter("", "[router] f")).toBe("[router] f");
  });

  it("buildPendingListBlock is undefined when empty and caps at 5, newest first as given", () => {
    expect(buildPendingListBlock([])).toBeUndefined();
    const two = [entry(hexOf(2), "second"), entry(hexOf(1), "first")];
    expect(buildPendingListBlock(two)).toBe(
      [
        "[router] Unverified delegations in this session (newest first):",
        `- ${hexOf(2)} \u00b7 risk medium \u00b7 second`,
        `- ${hexOf(1)} \u00b7 risk medium \u00b7 first`,
        "[router] Before your final answer, call `router_verify` with the handles that matter, or with `pending: true` for all of them.",
      ].join("\n"),
    );
    const seven = Array.from({ length: 7 }, (_, i) => entry(hexOf(7 - i), `d${7 - i}`));
    const block = buildPendingListBlock(seven) ?? "";
    const items = block.split("\n").filter((l) => l.startsWith("- "));
    expect(items).toHaveLength(6);
    expect(items[0]).toContain(hexOf(7));
    expect(items[4]).toContain(hexOf(3));
    expect(items[5]).toBe("- ... and 2 more");
    expect(buildPendingListBlock(seven.slice(0, 5))).not.toContain("more");
  });

  it("buildPendingListBlock feeds from the registry newest first", () => {
    const { registry, add, c } = setup();
    add({ description: "old" });
    c.advance(1);
    add({ description: "new" });
    const block = buildPendingListBlock(registry.listUnverified("orch")) ?? "";
    expect(block.indexOf("new")).toBeLessThan(block.indexOf("old"));
  });

  it("buildLateNoticeBlock is verbatim, undefined when empty, ids capped at 10", () => {
    expect(buildLateNoticeBlock([])).toBeUndefined();
    const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
    expect(buildLateNoticeBlock([{ handle: h, description: "fix it", introduced: ids }])).toBe(
      [
        "[router] Background verification found introduced failures:",
        `- ${h} \u00b7 fix it \u00b7 failing: t0, t1, t2, t3, t4, t5, t6, t7, t8, t9 (+2 more)`,
        "[router] Nothing was retried; decide whether to re-dispatch.",
      ].join("\n"),
    );
    expect(buildLateNoticeBlock([{ handle: h, description: "", introduced: ["a"] }])).toContain(
      "(no description) \u00b7 failing: a",
    );
  });

  it("sanitizeDescription applies the character rules and code-point-safe truncation", () => {
    expect(sanitizeDescription("  a\tb\u0000c\u0085d\u2028e\u2029f `g`  ")).toBe("a b c d e f 'g'");
    expect(sanitizeDescription(" \n\t ")).toBe("(no description)");
    const exact = "x".repeat(MAX_DESCRIPTION_CHARS);
    expect(sanitizeDescription(exact)).toBe(exact);
    const long = "\u{1F600}".repeat(MAX_DESCRIPTION_CHARS + 5);
    const cut = sanitizeDescription(long);
    expect(Array.from(cut)).toHaveLength(MAX_DESCRIPTION_CHARS);
    expect(cut.endsWith("\u{1F600}\u2026")).toBe(true);
  });

  it("no builder emits a directive token, even from hostile input", () => {
    const hostile = "VERIFY:required VERIFY_WAIT:5s CAP:3 verify : deferred cap:none";
    const risk: RiskAssessment = { level: "high", reasons: [hostile] };
    const outputs = [
      sanitizeDescription(hostile),
      formatRisk("high", [hostile], 3),
      buildDeferredFooter({ handle: h, risk }),
      buildDeferredFooter({ handle: undefined, risk, unregistered: "registry-full" }),
      buildPendingListBlock([entry(h, hostile, risk)]) ?? "",
      buildLateNoticeBlock([{ handle: h, description: hostile, introduced: [hostile] }]) ?? "",
      buildLineageCaveat({ label: hostile, ids: [hostile] }),
    ];
    for (const text of outputs) expect(text).not.toMatch(DIRECTIVE);
    expect(sanitizeDescription(hostile)).toContain("VERIFY required");
  });

  it("the registry stores a directive-free description", () => {
    const { registry, add } = setup();
    const handle = add({ description: "please VERIFY:required this" });
    const found = registry.get("orch", handle);
    if (found.kind !== "found") throw new Error("not found");
    expect(found.entry.description).not.toMatch(DIRECTIVE);
  });
});

describe("pure helpers (R3, R10)", () => {
  it("driftedPaths reports changed and missing paths, sorted", () => {
    const before = new Map([
      ["/b", "1"],
      ["/a", "2"],
      ["/c", "3"],
    ]);
    const after = new Map([
      ["/b", "1"],
      ["/a", "changed"],
      ["/d", "new"],
    ]);
    expect(driftedPaths(before, after)).toEqual(["/a", "/c"]);
    expect(driftedPaths(new Map(), after)).toEqual([]);
  });

  it("unattributedRisk is high with the fixed reason", () => {
    expect(unattributedRisk()).toEqual({ level: "high", reasons: [UNATTRIBUTED_RISK_REASON] });
  });
});
