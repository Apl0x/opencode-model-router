import { describe, expect, it } from "vitest";
import { value14, double14, name14, combined14 } from "../src/m14.js";

describe("m14 (1)", () => {
  it("value adds 14", () => {
    expect(value14(1)).toBe(15);
  });

  it("double doubles the value", () => {
    expect(double14(1)).toBe(30);
  });
});
