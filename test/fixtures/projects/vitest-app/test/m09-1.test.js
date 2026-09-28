import { describe, expect, it } from "vitest";
import { value09, double09, name09, combined09 } from "../src/m09.js";

describe("m09 (1)", () => {
  it("value adds 9", () => {
    expect(value09(1)).toBe(10);
  });

  it("double doubles the value", () => {
    expect(double09(1)).toBe(20);
  });
});
