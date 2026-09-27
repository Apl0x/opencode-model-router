import { describe, expect, it } from "vitest";
import { value01, double01, name01 } from "../src/m01.js";

describe("m01 (2)", () => {
  it("value adds 1", () => {
    expect(value01(2)).toBe(3);
  });

  it("double doubles the value", () => {
    expect(double01(2)).toBe(6);
  });

  it("exposes its name", () => {
    expect(name01).toBe("m01");
  });

  it("value is monotonic", () => {
    expect(value01(3)).toBeGreaterThan(value01(2));
  });
});
