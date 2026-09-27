import { describe, expect, it, vi } from "vitest";
import { parseVerifyDirectives, type VerifyDirectiveDefaults } from "../../src/verify/directives";
import { parseCapDirective } from "../../src/router/sessions";

const D: VerifyDirectiveDefaults = {
  defaultVerify: "deferred",
  captureWaitMs: 5000,
  baselineTimeoutMs: 15000,
};

const DEFAULT = { mode: "deferred", waitMs: 5000, source: "default" };

describe("parseVerifyDirectives", () => {
  it("returns defaults when no directive is present", () => {
    expect(parseVerifyDirectives("just do the task", D)).toEqual(DEFAULT);
    expect(parseVerifyDirectives("x", { ...D, defaultVerify: "required" }).mode).toBe("required");
  });

  it("is case-insensitive", () => {
    for (const t of ["verify:Required", "VERIFY:REQUIRED", "Verify: required"]) {
      expect(parseVerifyDirectives(t, D)).toEqual({ mode: "required", waitMs: 5000, source: "directive" });
    }
    expect(parseVerifyDirectives("VERIFY:Deferred", { ...D, defaultVerify: "required" }).mode).toBe("deferred");
  });

  it("first occurrence wins", () => {
    expect(parseVerifyDirectives("VERIFY:required\nVERIFY:deferred", D).mode).toBe("required");
    expect(parseVerifyDirectives("VERIFY_WAIT:1s VERIFY_WAIT:2s", D).waitMs).toBe(1000);
  });

  it("unknown VERIFY value → default + log", () => {
    const log = vi.fn();
    expect(parseVerifyDirectives("VERIFY:maybe", D, log)).toEqual(DEFAULT);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("maybe");
  });

  it("parses VERIFY_WAIT in s and ms, 0 allowed, capped at baselineTimeoutMs", () => {
    expect(parseVerifyDirectives("VERIFY_WAIT:0s", D)).toEqual({ mode: "deferred", waitMs: 0, source: "directive" });
    expect(parseVerifyDirectives("VERIFY_WAIT:750ms", D).waitMs).toBe(750);
    expect(parseVerifyDirectives("VERIFY_WAIT:99999s", D).waitMs).toBe(15000);
  });

  it.each(["VERIFY_WAIT:-1s", "VERIFY_WAIT:abc", "VERIFY_WAIT:5"])("malformed %s → default + log", (t) => {
    const log = vi.fn();
    expect(parseVerifyDirectives(t, D, log)).toEqual(DEFAULT);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("ignores router-injected instructional examples", () => {
    const log = vi.fn();
    const example =
      "To choose verification, put VERIFY:required|deferred and optionally VERIFY_WAIT:<n>s in the dispatch.";
    expect(parseVerifyDirectives(example, D, log)).toEqual(DEFAULT);
    expect(log).not.toHaveBeenCalled();
    // a real directive after the example still applies
    expect(parseVerifyDirectives(`${example}\n\nVERIFY:required VERIFY_WAIT:2s`, D)).toEqual({
      mode: "required",
      waitMs: 2000,
      source: "directive",
    });
  });

  it("parses directives inside a fenced code block (parity with parseCapDirective)", () => {
    const inputs = [
      "task\n```\nCAP:3 VERIFY:required\n```\n",
      "```txt\nVERIFY:required\nCAP:3\n```",
      "no directives at all",
      "```\nCAP:none\n```\nVERIFY:required",
    ];
    for (const t of inputs) {
      const cap = parseCapDirective(t);
      const v = parseVerifyDirectives(t, D);
      const hasCap = cap !== null;
      const hasVerify = v.source === "directive";
      expect(hasVerify).toBe(hasCap);
    }
    expect(parseVerifyDirectives("```\nVERIFY:required\n```", D).mode).toBe("required");
  });

  it("CAP: and VERIFY: together, in either order", () => {
    for (const t of ["CAP:3\nVERIFY:required VERIFY_WAIT:1s", "VERIFY_WAIT:1s VERIFY:required\nCAP:3"]) {
      expect(parseCapDirective(t)).toBe(3);
      expect(parseVerifyDirectives(t, D)).toEqual({ mode: "required", waitMs: 1000, source: "directive" });
    }
  });

  it("VERIFY: does not match VERIFY_WAIT: and vice versa", () => {
    expect(parseVerifyDirectives("VERIFY_WAIT:1s", D).mode).toBe("deferred");
    expect(parseVerifyDirectives("VERIFY:required", D).waitMs).toBe(5000);
  });

  it("security: only reads the text it is given (no ambient/subagent sources)", () => {
    // The caller contract: pass dispatch text only. Same input → same output, no hidden state.
    const t = "VERIFY:required";
    expect(parseVerifyDirectives(t, D)).toEqual(parseVerifyDirectives(t, D));
    expect(parseVerifyDirectives("", D)).toEqual(DEFAULT);
  });
});
