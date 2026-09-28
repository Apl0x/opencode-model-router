import { describe, expect, it } from "vitest";
import { value15, double15, name15, combined15 } from "../src/m15.js";

describe("m15 (1)", () => {
  it("value adds 15", () => {
    expect(value15(1)).toBe(16);
  });

  it("double doubles the value", () => {
    expect(double15(1)).toBe(32);
  });
});
