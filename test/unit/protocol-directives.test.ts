import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { validateConfig } from "../../src/router/config";
import {
  assembleSystemPrompt,
  buildDelegationProtocol,
  buildDoDProtocolSection,
  DELEGATE_TOOL_DESCRIPTION,
} from "../../src/router/protocol";
import { parseVerifyDirectives } from "../../src/verify/directives";
import { parseCapDirective } from "../../src/router/sessions";
import type { RouterConfig } from "../../src/index";

// QA-1.6-4: the router's own protocol text documents VERIFY:/VERIFY_WAIT: with placeholder
// values only, so parsing it as dispatch text never yields a real directive.
describe("protocol text is not read as a directive", () => {
  const raw = JSON.parse(readFileSync(join(process.cwd(), "tiers.json"), "utf-8"));
  const base = validateConfig(raw);
  const defaults = { defaultVerify: "deferred" as const, captureWaitMs: 1234, baselineTimeoutMs: 60_000 };

  const configs: Array<[string, RouterConfig]> = [
    ...Object.keys(base.presets).map((p): [string, RouterConfig] => [
      p,
      { ...base, activePreset: p, activeMode: undefined },
    ]),
    ...Object.keys(base.modes ?? {}).map((m): [string, RouterConfig] => [
      `anthropic-mode-${m}`,
      { ...base, activePreset: "anthropic", activeMode: m },
    ]),
  ];

  for (const [name, cfg] of configs) {
    it(`${name}: VERIFY/VERIFY_WAIT fall back to defaults, CAP is unchanged`, () => {
      const texts = [
        buildDoDProtocolSection(cfg),
        assembleSystemPrompt(cfg, "openai/gpt-5", true),
        assembleSystemPrompt(cfg, "anthropic/claude-sonnet-4", true),
      ];
      expect(texts[0]).toContain("`VERIFY:` followed by `required` or `deferred`");
      expect(texts[0]).toContain("VERIFY_WAIT:<n>s");
      // QA-2.3-3: no pipe placeholder is presented as the thing to paste.
      expect(texts[0]).not.toMatch(/VERIFY:[a-z]+\|/i);
      for (const text of texts) {
        const d = parseVerifyDirectives(text, defaults);
        expect(d).toEqual({ mode: "deferred", waitMs: 1234, modeSource: "default", waitSource: "default" });
      }
      // The DoD section adds no CAP directive: the result is what the (unchanged) base protocol gives.
      expect(parseCapDirective(texts[0]!)).toBeNull();
      const baseline = parseCapDirective(buildDelegationProtocol(cfg));
      expect(parseCapDirective(texts[1]!)).toBe(baseline);
      expect(parseCapDirective(texts[2]!)).toBe(baseline);
    });
  }

  // QA-2.3-3: the delegate tool description (not dispatch text) shows the literal, working form.
  it("delegate tool description demonstrates a working VERIFY:required", () => {
    const d = parseVerifyDirectives(DELEGATE_TOOL_DESCRIPTION, defaults);
    expect(d.mode).toBe("required");
    expect(d.modeSource).not.toBe("default");
  });
});
