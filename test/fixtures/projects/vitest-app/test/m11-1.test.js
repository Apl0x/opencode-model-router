import { describe, expect, it } from "vitest";
import { value11, double11, name11, combined11 } from "../src/m11.js";

describe("m11 (1)", () => {
  it("value adds 11", () => {
    expect(value11(1)).toBe(12);
  });

  it("double doubles the value", () => {
    expect(double11(1)).toBe(24);
  });
});
