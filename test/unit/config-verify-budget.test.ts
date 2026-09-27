import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deepMerge,
  resolveVerifyBudget,
  resetVerifyBudgetWarnings,
  validateConfig,
  type RouterConfig,
  type VerifyBudget,
} from "../../src/router/config";
import type { PluginLogger } from "../../src/router/logger";

function validRaw(verify?: unknown): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    activePreset: "anthropic",
    presets: {
      anthropic: {
        fast: { model: "anthropic/claude-haiku-4-5", description: "fast tier", whenToUse: ["recon"] },
      },
    },
    rules: ["r1"],
    defaultTier: "fast",
  };
  if (verify !== undefined) raw.enforcement = { verify };
  return raw;
}

function cfgWith(verify?: unknown): RouterConfig {
  return validateConfig(validRaw(verify));
}

function mockLogger() {
  const warn = vi.fn<PluginLogger["warn"]>();
  const logger: PluginLogger = { warn, flush: async () => undefined };
  return { ...logger, warn };
}

const DEFAULTS: VerifyBudget = {
  testScope: "affected",
  maxWorkers: 2,
  lowPriority: true,
  maxConcurrentVerifications: 2,
  defaultVerify: "deferred",
  captureWaitMs: 5000,
  background: false,
  pendingTtlMs: 3_600_000,
  slotWaitMs: 60_000,
  batchWindowMs: 2000,
  failureRecheck: true,
  recheckTimeoutMs: 60_000,
  baselineTimeoutMs: 15_000,
  gateBudgetMs: 90_000,
};

beforeEach(() => resetVerifyBudgetWarnings());

describe("resolveVerifyBudget — defaults", () => {
  it("applies every default when verify is absent", () => {
    expect(resolveVerifyBudget(cfgWith(), { cores: 16 })).toEqual(DEFAULTS);
  });
  it("applies every default when verify is empty", () => {
    expect(resolveVerifyBudget(cfgWith({}), { cores: 16 })).toEqual(DEFAULTS);
  });
  it("applies defaults for an undefined config", () => {
    expect(resolveVerifyBudget(undefined, { cores: 16 })).toEqual(DEFAULTS);
  });
  it("keeps defaults for keys a partial verify leaves unset", () => {
    expect(resolveVerifyBudget(cfgWith({ maxWorkers: 4 }), { cores: 16 })).toEqual({
      ...DEFAULTS,
      maxWorkers: 4,
    });
  });
  it("deep-merged overrides keep sibling keys and defaults", () => {
    const base = validRaw({ testScope: "full", slotWaitMs: 10 });
    const merged = deepMerge(base, { enforcement: { verify: { maxWorkers: 3 } } });
    const budget = resolveVerifyBudget(validateConfig(merged), { cores: 16 });
    expect(budget).toEqual({ ...DEFAULTS, testScope: "full", slotWaitMs: 10, maxWorkers: 3 });
  });
  it("an undefined override value does not delete a base value", () => {
    const base = validRaw({ maxWorkers: 5 });
    const merged = deepMerge(base, { enforcement: { verify: { maxWorkers: undefined } } });
    expect(resolveVerifyBudget(validateConfig(merged), { cores: 16 }).maxWorkers).toBe(5);
  });
  it("defaultVerify defaults to deferred and background to false", () => {
    const b = resolveVerifyBudget(cfgWith({}), { cores: 1 });
    expect(b.defaultVerify).toBe("deferred");
    expect(b.background).toBe(false);
  });
  it("uses the real core count when none is injected", () => {
    const n = resolveVerifyBudget(cfgWith()).maxConcurrentVerifications;
    expect(Number.isInteger(n) && n >= 1).toBe(true);
  });
  it("round-trips every explicit value", () => {
    const explicit: VerifyBudget = {
      testScope: "full",
      maxWorkers: 7,
      lowPriority: false,
      maxConcurrentVerifications: 3,
      defaultVerify: "required",
      captureWaitMs: 1,
      background: true,
      pendingTtlMs: 5,
      slotWaitMs: 6,
      batchWindowMs: 8,
      failureRecheck: false,
      recheckTimeoutMs: 9,
      baselineTimeoutMs: 10,
      gateBudgetMs: 11,
    };
    expect(resolveVerifyBudget(cfgWith(explicit), { cores: 64 })).toEqual(explicit);
  });
});

describe("resolveVerifyBudget — maxConcurrentVerifications from injected cores", () => {
  it.each([
    [1, 1],
    [8, 1],
    [16, 2],
    [64, 8],
    [0, 1],
    [Number.NaN, 1],
  ])("%s cores → %s", (cores, expected) => {
    expect(resolveVerifyBudget(cfgWith(), { cores }).maxConcurrentVerifications).toBe(expected);
  });
  it("an explicit value always wins", () => {
    expect(
      resolveVerifyBudget(cfgWith({ maxConcurrentVerifications: 5 }), { cores: 1 })
        .maxConcurrentVerifications,
    ).toBe(5);
    expect(
      resolveVerifyBudget(cfgWith({ maxConcurrentVerifications: 1 }), { cores: 64 })
        .maxConcurrentVerifications,
    ).toBe(1);
  });
});

describe("validateConfig — enforcement.verify budget keys", () => {
  const ge1 = ["maxWorkers", "maxConcurrentVerifications", "pendingTtlMs", "recheckTimeoutMs", "baselineTimeoutMs", "gateBudgetMs"];
  const ge0 = ["captureWaitMs", "slotWaitMs", "batchWindowMs"];
  const bools = ["lowPriority", "background", "failureRecheck", "testBaseline"];
  const badNumbers: unknown[] = [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, "5", null, true, {}];

  for (const key of ge1) {
    it(`${key} rejects 0 and bad values with the standard message`, () => {
      for (const bad of [0, ...badNumbers]) {
        expect(() => cfgWith({ [key]: bad })).toThrow(
          new RegExp(`^tiers\\.json: enforcement\\.verify\\.${key} must be an integer >= 1`),
        );
      }
      expect(() => cfgWith({ [key]: 1 })).not.toThrow();
    });
  }
  for (const key of ge0) {
    it(`${key} accepts 0 and rejects bad values`, () => {
      expect(resolveVerifyBudget(cfgWith({ [key]: 0 }), { cores: 1 })[key as keyof VerifyBudget]).toBe(0);
      for (const bad of badNumbers) {
        expect(() => cfgWith({ [key]: bad })).toThrow(
          `tiers.json: enforcement.verify.${key} must be an integer >= 0 (milliseconds)`,
        );
      }
    });
  }
  for (const key of bools) {
    it(`${key} rejects non-booleans`, () => {
      for (const bad of ["true", 1, 0, null, {}]) {
        expect(() => cfgWith({ [key]: bad })).toThrow(
          `tiers.json: enforcement.verify.${key} must be a boolean`,
        );
      }
    });
  }
  it("testScope accepts only the case-sensitive literals", () => {
    expect(() => cfgWith({ testScope: "affected" })).not.toThrow();
    expect(() => cfgWith({ testScope: "full" })).not.toThrow();
    for (const bad of ["all", "Affected", "FULL", "", null, 1]) {
      expect(() => cfgWith({ testScope: bad })).toThrow(
        'tiers.json: enforcement.verify.testScope must be "affected" or "full"',
      );
    }
  });
  it("defaultVerify accepts only deferred/required", () => {
    expect(resolveVerifyBudget(cfgWith({ defaultVerify: "required" })).defaultVerify).toBe("required");
    for (const bad of ["optional", "Deferred", null, false]) {
      expect(() => cfgWith({ defaultVerify: bad })).toThrow(
        'tiers.json: enforcement.verify.defaultVerify must be "deferred" or "required"',
      );
    }
  });
  it("a __proto__ key in parsed JSON neither bypasses validation nor pollutes", () => {
    const verify = JSON.parse('{"__proto__": {"maxWorkers": 99, "testScope": "all"}}');
    const b = resolveVerifyBudget(cfgWith(verify), { cores: 16 });
    expect(b).toEqual(DEFAULTS);
    expect(({} as Record<string, unknown>).maxWorkers).toBeUndefined();
  });
  it("a value inherited through a real prototype is validated and never applied", () => {
    const bad = Object.create({ maxWorkers: "x" });
    expect(() => cfgWith(bad)).toThrow("enforcement.verify.maxWorkers must be an integer >= 1");
    const good = Object.create({ maxWorkers: 9 });
    expect(resolveVerifyBudget(cfgWith(good), { cores: 16 }).maxWorkers).toBe(2);
  });
  it("a null verify block resolves to defaults", () => {
    expect(resolveVerifyBudget(cfgWith(null), { cores: 16 })).toEqual(DEFAULTS);
  });
});

describe("resolveVerifyBudget — testBaseline deprecation", () => {
  it("testBaseline:false maps to failureRecheck:false", () => {
    expect(resolveVerifyBudget(cfgWith({ testBaseline: false })).failureRecheck).toBe(false);
  });
  it("testBaseline:true changes nothing", () => {
    expect(resolveVerifyBudget(cfgWith({ testBaseline: true })).failureRecheck).toBe(true);
  });
  it("explicit failureRecheck wins over the deprecated key", () => {
    expect(
      resolveVerifyBudget(cfgWith({ testBaseline: false, failureRecheck: true })).failureRecheck,
    ).toBe(true);
    expect(
      resolveVerifyBudget(cfgWith({ testBaseline: true, failureRecheck: false })).failureRecheck,
    ).toBe(false);
  });
  it("warns once across repeated resolves, through the logger", () => {
    const logger = mockLogger();
    for (let i = 0; i < 5; i++) resolveVerifyBudget(cfgWith({ testBaseline: false }), { logger });
    resolveVerifyBudget(cfgWith({ testBaseline: true }), { logger });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toMatch(/testBaseline is deprecated/);
  });
  it("does not warn when the deprecated key is absent", () => {
    const logger = mockLogger();
    resolveVerifyBudget(cfgWith({ failureRecheck: false }), { logger });
    expect(logger.warn).not.toHaveBeenCalled();
  });
  it("a resolve without a logger does not consume the one warning", () => {
    resolveVerifyBudget(cfgWith({ testBaseline: false }));
    const logger = mockLogger();
    resolveVerifyBudget(cfgWith({ testBaseline: false }), { logger });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
