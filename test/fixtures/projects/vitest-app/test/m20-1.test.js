import { describe, expect, it } from "vitest";
import { value20, double20, name20, combined20 } from "../src/m20.js";

describe("m20 (1)", () => {
  it("value adds 20", () => {
    expect(value20(1)).toBe(21);
  });

  it("double doubles the value", () => {
    expect(double20(1)).toBe(42);
  });
});
