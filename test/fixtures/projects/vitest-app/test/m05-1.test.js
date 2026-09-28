import { describe, expect, it } from "vitest";
import { value05, double05, name05, combined05 } from "../src/m05.js";

describe("m05 (1)", () => {
  it("value adds 5", () => {
    expect(value05(1)).toBe(6);
  });

  it("double doubles the value", () => {
    expect(double05(1)).toBe(12);
  });
});
