import { describe, expect, it } from "vitest";
import { value14, double14, name14, combined14 } from "../src/m14.js";

describe("m14 (2)", () => {
  it("value adds 14", () => {
    expect(value14(2)).toBe(16);
  });

  it("double doubles the value", () => {
    expect(double14(2)).toBe(32);
  });

  it("exposes its name", () => {
    expect(name14).toBe("m14");
  });
});
