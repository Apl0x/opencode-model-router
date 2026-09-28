import { describe, expect, it } from "vitest";
import { value13, double13, name13, combined13 } from "../src/m13.js";

describe("m13 (1)", () => {
  it("value adds 13", () => {
    expect(value13(1)).toBe(14);
  });

  it("double doubles the value", () => {
    expect(double13(1)).toBe(28);
  });

  it("exposes its name", () => {
    expect(name13).toBe("m13");
  });
});
