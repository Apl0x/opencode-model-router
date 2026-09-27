import { describe, expect, it } from "vitest";
import { value13, double13, name13, combined13 } from "../src/m13.js";

describe("m13 (2)", () => {
  it("value adds 13", () => {
    expect(value13(2)).toBe(15);
  });

  it("double doubles the value", () => {
    expect(double13(2)).toBe(30);
  });

  it("exposes its name", () => {
    expect(name13).toBe("m13");
  });

  it("combined uses m06", () => {
    expect(combined13(2)).toBe(21);
  });
});
