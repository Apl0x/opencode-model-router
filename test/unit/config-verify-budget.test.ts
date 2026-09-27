import { availableParallelism } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deepMerge,
  resolveVerifyBudget,
  resetVerifyBudgetWarnings,
  validateConfig,
  warnDeprecatedVerifyKeys,
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
    expect(n).toBe(Math.max(1, Math.floor(availableParallelism() / 8)));
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
    [15.9, 1],
    [16.5, 2],
    [Number.POSITIVE_INFINITY, 1],
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
  const badNumbers: unknown[] = [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, "5", null, true, {}, 1e21];
  const msKeys = new Set([...ge1.filter((k) => k.endsWith("Ms")), ...ge0]);

  for (const key of ge1) {
    it(`${key} rejects 0 and bad values with the standard message`, () => {
      const extra = msKeys.has(key) ? [2 ** 31] : [];
      for (const bad of [0, ...badNumbers, ...extra]) {
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
      for (const bad of [...badNumbers, 2 ** 31]) {
        expect(() => cfgWith({ [key]: bad })).toThrow(
          `tiers.json: enforcement.verify.${key} must be an integer >= 0 and <= 2147483647 (milliseconds)`,
        );
      }
      expect(() => cfgWith({ [key]: 2_147_483_647 })).not.toThrow();
    });
  }
  it("millisecond keys accept the 2^31-1 timer ceiling", () => {
    for (const key of ge1.filter((k) => k.endsWith("Ms"))) {
      expect(() => cfgWith({ [key]: 2_147_483_647 })).not.toThrow();
    }
  });
  it("count keys accept a large safe integer", () => {
    expect(() => cfgWith({ maxWorkers: 2 ** 31 })).not.toThrow();
  });
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
  it("an own __proto__ key is inert and does not pollute", () => {
    const verify = JSON.parse('{"__proto__": {"maxWorkers": 99, "testScope": "all"}}');
    expect(Object.getPrototypeOf(verify)).toBe(Object.prototype);
    expect(() => cfgWith(verify)).toThrow(
      'tiers.json: enforcement.verify must not contain the key "__proto__"',
    );
    expect(Object.getPrototypeOf(verify)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).maxWorkers).toBeUndefined();
    expect(({} as Record<string, unknown>).testScope).toBeUndefined();
  });
  it.each(["constructor", "prototype"])("rejects an own %s key inside verify", (key) => {
    const verify = JSON.parse(`{"${key}": {"maxWorkers": 99}}`);
    expect(() => cfgWith(verify)).toThrow(
      `tiers.json: enforcement.verify must not contain the key "${key}"`,
    );
  });
  it("a value inherited through a real prototype is validated and never applied", () => {
    const bad = Object.create({ maxWorkers: "x" });
    expect(() => cfgWith(bad)).toThrow("enforcement.verify.maxWorkers must be an integer >= 1");
    const good = Object.create({ maxWorkers: 9 });
    expect(resolveVerifyBudget(cfgWith(good), { cores: 16 }).maxWorkers).toBe(2);
  });
  it("a non-object verify block is rejected", () => {
    for (const bad of [null, "x", 5, []]) {
      expect(() => cfgWith(bad)).toThrow("tiers.json: enforcement.verify must be an object");
    }
  });
  it("an override verify:null cannot erase the base block through deepMerge", () => {
    const merged = deepMerge(validRaw({ maxWorkers: 4 }), { enforcement: { verify: null } });
    expect(() => validateConfig(merged)).toThrow(
      "tiers.json: enforcement.verify must be an object",
    );
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
  it("resolving never warns and consumes no warning state", () => {
    const logger = mockLogger();
    resolveVerifyBudget(cfgWith({ testBaseline: false }), { cores: 1 });
    warnDeprecatedVerifyKeys(cfgWith({ testBaseline: false }), logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("warnDeprecatedVerifyKeys", () => {
  it("warns once across repeated calls, through the logger", () => {
    const logger = mockLogger();
    for (let i = 0; i < 5; i++) warnDeprecatedVerifyKeys(cfgWith({ testBaseline: false }), logger);
    warnDeprecatedVerifyKeys(cfgWith({ testBaseline: true }), logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toMatch(/testBaseline is deprecated/);
  });
  it("testBaseline:true alone warns on a fresh flag", () => {
    const logger = mockLogger();
    warnDeprecatedVerifyKeys(cfgWith({ testBaseline: true }), logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
  it("does not warn when the deprecated key is absent", () => {
    const logger = mockLogger();
    warnDeprecatedVerifyKeys(cfgWith({ failureRecheck: false }), logger);
    warnDeprecatedVerifyKeys(cfgWith(), logger);
    warnDeprecatedVerifyKeys(undefined, logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });
  it("a call without the key does not consume the one warning", () => {
    const logger = mockLogger();
    warnDeprecatedVerifyKeys(cfgWith({}), logger);
    warnDeprecatedVerifyKeys(cfgWith({ testBaseline: false }), logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
