import { describe, expect, it } from "vitest";
import { value08, double08, name08, combined08 } from "../src/m08.js";

describe("m08 (1)", () => {
  it("value adds 8", () => {
    expect(value08(1)).toBe(9);
  });

  it("double doubles the value", () => {
    expect(double08(1)).toBe(18);
  });
});
