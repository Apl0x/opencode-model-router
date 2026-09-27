import { describe, expect, it } from "vitest";
import { value14, double14, name14, combined14 } from "../src/m14.js";

describe("m14 (3)", () => {
  it("value adds 14", () => {
    expect(value14(3)).toBe(17);
  });

  it("double doubles the value", () => {
    expect(double14(3)).toBe(34);
  });

  it("exposes its name", () => {
    expect(name14).toBe("m14");
  });

  it("combined uses m07", () => {
    expect(combined14(3)).toBe(24);
  });
});
