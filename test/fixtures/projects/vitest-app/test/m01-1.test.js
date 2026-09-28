import { describe, expect, it } from "vitest";
import { value01, double01, name01 } from "../src/m01.js";

describe("m01 (1)", () => {
  it("value adds 1", () => {
    expect(value01(1)).toBe(2);
  });

  it("double doubles the value", () => {
    expect(double01(1)).toBe(4);
  });

  it("exposes its name", () => {
    expect(name01).toBe("m01");
  });
});
