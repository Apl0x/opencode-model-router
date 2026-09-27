import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { parseVerifyDirectives, type VerifyDirectiveDefaults } from "../../src/verify/directives";
import { parseCapDirective } from "../../src/router/sessions";

const D: VerifyDirectiveDefaults = {
  defaultVerify: "deferred",
  captureWaitMs: 5000,
  baselineTimeoutMs: 15000,
};

const DEFAULT = { mode: "deferred", waitMs: 5000, modeSource: "default", waitSource: "default" };
const REQUIRED = { mode: "required", waitMs: 5000, modeSource: "directive", waitSource: "default" };

describe("parseVerifyDirectives", () => {
  it("returns defaults when no directive is present", () => {
    expect(parseVerifyDirectives("just do the task", D)).toEqual(DEFAULT);
    expect(parseVerifyDirectives("x", { ...D, defaultVerify: "required" }).mode).toBe("required");
  });

  it("is case-insensitive", () => {
    for (const t of ["verify:Required", "VERIFY:REQUIRED", "Verify: required"]) {
      expect(parseVerifyDirectives(t, D)).toEqual(REQUIRED);
    }
    expect(parseVerifyDirectives("VERIFY:Deferred", { ...D, defaultVerify: "required" }).mode).toBe("deferred");
  });

  it("first occurrence wins", () => {
    expect(parseVerifyDirectives("VERIFY:required\nVERIFY:deferred", D).mode).toBe("required");
    expect(parseVerifyDirectives("VERIFY_WAIT:1s VERIFY_WAIT:2s", D).waitMs).toBe(1000);
  });

  it("QA-1.6-1: values end at a word boundary (markdown, punctuation, quotes)", () => {
    for (const t of ["**VERIFY:required**", "`VERIFY:required`", "VERIFY:required.", 'VERIFY:"required"', "VERIFY: 'required'"]) {
      expect(parseVerifyDirectives(t, D), t).toEqual(REQUIRED);
    }
    expect(parseVerifyDirectives("**VERIFY_WAIT:2s**", D).waitMs).toBe(2000);
    expect(parseVerifyDirectives("`VERIFY_WAIT:750ms`.", D).waitMs).toBe(750);
    expect(parseVerifyDirectives("VERIFY:required2", D)).toEqual(DEFAULT);
    expect(parseVerifyDirectives("VERIFY_WAIT:2sec", D).waitSource).toBe("default");
  });

  it("QA-1.6-1/16: parity with parseCapDirective on formatted input", () => {
    const wraps: [string, string][] = [["**", "**"], ["`", "`"], ["", "."], ["", ","], ["(", ")"], ["", ""]];
    for (const [a, b] of wraps) {
      expect(parseCapDirective(`${a}CAP:3${b}`)).toBe(3);
      expect(parseVerifyDirectives(`${a}VERIFY:required${b}`, D).modeSource).toBe("directive");
      const both = `task ${a}CAP:3${b} and ${a}VERIFY:required${b}`;
      expect(parseCapDirective(both)).toBe(3);
      expect(parseVerifyDirectives(both, D).mode).toBe("required");
    }
  });

  it("QA-1.6-2: the first VALID occurrence wins; prose is skipped like CAP:abc", () => {
    const log = vi.fn();
    expect(parseCapDirective("CAP:abc CAP:3")).toBe(3);
    expect(parseVerifyDirectives("Verify: run npm test and report.\n\nVERIFY:required", D, log)).toEqual(REQUIRED);
    expect(parseVerifyDirectives("VERIFY_WAIT:abc VERIFY_WAIT:1s", D, log).waitMs).toBe(1000);
    expect(log).not.toHaveBeenCalled();
  });

  it("unknown VERIFY value → default + one log line per key", () => {
    const log = vi.fn();
    expect(parseVerifyDirectives("VERIFY:maybe VERIFY:perhaps VERIFY_WAIT:x VERIFY_WAIT:y", D, log)).toEqual(DEFAULT);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]![0]).toContain("maybe");
    expect(log.mock.calls[0]![0]).not.toContain("perhaps");
  });

  it("QA-1.6-3: a directive does not straddle a line break", () => {
    expect(parseVerifyDirectives("Steps to verify:\nrequired fields present", D)).toEqual(DEFAULT);
    expect(parseVerifyDirectives("VERIFY:\ndeferred", { ...D, defaultVerify: "required" }).mode).toBe("required");
    expect(parseVerifyDirectives("VERIFY :\trequired", D).mode).toBe("required");
  });

  it("QA-1.6-7: logged values are truncated and control characters escaped", () => {
    const log = vi.fn();
    parseVerifyDirectives(`verify:${"A".repeat(200)}`, D, log);
    expect(log.mock.calls[0]![0]).toContain(`"${"A".repeat(32)}"`);
    expect(log.mock.calls[0]![0]).not.toContain("A".repeat(33));
    const log2 = vi.fn();
    parseVerifyDirectives("verify:\u001b[31mred\u009b", D, log2);
    const line = log2.mock.calls[0]![0] as string;
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(line).toContain("\\u001b");
  });

  it("parses VERIFY_WAIT in s and ms, 0 allowed, capped at baselineTimeoutMs", () => {
    expect(parseVerifyDirectives("VERIFY_WAIT:0s", D)).toEqual({ ...DEFAULT, waitMs: 0, waitSource: "directive" });
    expect(parseVerifyDirectives("VERIFY_WAIT:750ms", D).waitMs).toBe(750);
    expect(parseVerifyDirectives("VERIFY_WAIT:99999s", D).waitMs).toBe(15000);
  });

  it.each(["VERIFY_WAIT:-1s", "VERIFY_WAIT:abc", "VERIFY_WAIT:5", "VERIFY_WAIT:1.5s"])("malformed %s → default + log", (t) => {
    const log = vi.fn();
    expect(parseVerifyDirectives(t, D, log)).toEqual(DEFAULT);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("QA-1.6-6: modeSource and waitSource are independent", () => {
    expect(parseVerifyDirectives("VERIFY_WAIT:2s", D)).toEqual({ ...DEFAULT, waitMs: 2000, waitSource: "directive" });
    expect(parseVerifyDirectives("VERIFY:maybe VERIFY_WAIT:1s", D).modeSource).toBe("default");
    expect(parseVerifyDirectives("VERIFY:required", D).waitSource).toBe("default");
  });

  it("ignores router-injected instructional examples", () => {
    const log = vi.fn();
    const example =
      "To choose verification, put VERIFY:required|deferred and optionally VERIFY_WAIT:<n>s in the dispatch.";
    expect(parseVerifyDirectives(example, D, log)).toEqual(DEFAULT);
    expect(log).not.toHaveBeenCalled();
    expect(parseVerifyDirectives(`${example}\n\nVERIFY:required VERIFY_WAIT:2s`, D)).toEqual({
      mode: "required",
      waitMs: 2000,
      modeSource: "directive",
      waitSource: "directive",
    });
  });

  it("parses directives inside a fenced code block (parity with parseCapDirective)", () => {
    const inputs = [
      "task\n```\nCAP:3 VERIFY:required\n```\n",
      "```txt\nVERIFY:required\nCAP:3\n```",
      "no directives at all",
      "```\nCAP:none\n```\nVERIFY:required",
      "```\n**CAP:3** **VERIFY:required**\n```",
      "`CAP:3`, `VERIFY:required`.",
    ];
    for (const t of inputs) {
      expect(parseVerifyDirectives(t, D).modeSource === "directive", t).toBe(parseCapDirective(t) !== null);
    }
    expect(parseVerifyDirectives("```\nVERIFY:required\n```", D).mode).toBe("required");
  });

  it("CAP: and VERIFY: together, in either order", () => {
    for (const t of ["CAP:3\nVERIFY:required VERIFY_WAIT:1s", "VERIFY_WAIT:1s VERIFY:required\nCAP:3"]) {
      expect(parseCapDirective(t)).toBe(3);
      expect(parseVerifyDirectives(t, D)).toEqual({ mode: "required", waitMs: 1000, modeSource: "directive", waitSource: "directive" });
    }
  });

  it("VERIFY: does not match VERIFY_WAIT: and vice versa", () => {
    expect(parseVerifyDirectives("VERIFY_WAIT:1s", D).mode).toBe("deferred");
    expect(parseVerifyDirectives("VERIFY:required", D).waitMs).toBe(5000);
  });

  it("is deterministic and stateless", () => {
    const t = "VERIFY:required";
    expect(parseVerifyDirectives(t, D)).toEqual(parseVerifyDirectives(t, D));
    expect(parseVerifyDirectives("", D)).toEqual(DEFAULT);
  });

  it("QA-1.6-16: directives.ts imports nothing (no process, fs or network)", () => {
    const src = readFileSync(new URL("../../src/verify/directives.ts", import.meta.url), "utf8");
    expect(src.match(/^import .*$/gm)).toBeNull();
    expect(src).not.toMatch(/child_process|\brequire\(|\bimport\(|node:|\bprocess\.|\bfetch\(|\bWebSocket\b|\bXMLHttpRequest\b|^export .* from/m);
  });

  it("QA-1.6-18: lower/mixed-case key in prose is not a directive; upper case unchanged", () => {
    const R = { ...D, defaultVerify: "required" as const };
    for (const t of [
      "Verify: required fields are validated",
      "Also verify: *required* fields show an error.",
      "verify: \u0027required\u0027 props are passed",
    ]) {
      expect(parseVerifyDirectives(t, D)).toEqual(DEFAULT);
    }
    for (const t of [
      "Things to verify: deferred loading works",
      "Please verify: \"deferred\" state is rendered correctly.",
      "Things to verify: `deferred` imports still resolve",
    ]) {
      expect(parseVerifyDirectives(t, R)).toEqual({ ...DEFAULT, mode: "required" });
    }
    expect(parseVerifyDirectives("verify: required", D)).toEqual(REQUIRED);
    expect(parseVerifyDirectives("intro\nverify: *required*.\nmore", D)).toEqual(REQUIRED);
    expect(parseVerifyDirectives("VERIFY: required fields are validated", D)).toEqual(REQUIRED);
    expect(parseVerifyDirectives("verify_wait: 2s please", D).waitMs).toBe(5000);
    expect(parseVerifyDirectives("verify_wait: 2s", D).waitMs).toBe(2000);
  });

  it("QA-1.6-19: a second occurrence in the same token is found (CAP parity)", () => {
    expect(parseCapDirective("CAP:abc,CAP:3")).toBe(3);
    const log = vi.fn();
    expect(parseVerifyDirectives("VERIFY:maybe,VERIFY:required", D, log)).toEqual(REQUIRED);
    expect(log).not.toHaveBeenCalled();
    expect(parseVerifyDirectives("(VERIFY:tbd)/VERIFY:required", D).mode).toBe("required");
    expect(parseVerifyDirectives("VERIFY_WAIT:soon,VERIFY_WAIT:2s", D).waitMs).toBe(2000);
  });

  it("QA-1.6-20: NBSP and ideographic space around the colon parse; newline does not", () => {
    expect(parseCapDirective("CAP:\u00a03")).toBe(3);
    for (const t of ["VERIFY:\u00a0required", "VERIFY:\u3000required", "VERIFY\u00a0:required"]) {
      expect(parseVerifyDirectives(t, D)).toEqual(REQUIRED);
    }
    expect(parseVerifyDirectives("VERIFY:\u2028required", D)).toEqual(DEFAULT);
    expect(parseVerifyDirectives("VERIFY:\nrequired", D)).toEqual(DEFAULT);
  });

  it("QA-1.6-24: bidi and format characters are escaped in log lines", () => {
    const log = vi.fn();
    parseVerifyDirectives("VERIFY:x\u202eevil\u200b\u2066", D, log);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("\\u202e");
    expect(line).toContain("\\u200b");
    expect(line).toContain("\\u2066");
    expect(line).not.toMatch(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\u200b]/);
  });
});
