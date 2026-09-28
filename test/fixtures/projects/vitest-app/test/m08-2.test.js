import { describe, expect, it } from "vitest";
import { value08, double08, name08, combined08 } from "../src/m08.js";

describe("m08 (2)", () => {
  it("value adds 8", () => {
    expect(value08(2)).toBe(10);
  });

  it("double doubles the value", () => {
    expect(double08(2)).toBe(20);
  });

  it("exposes its name", () => {
    expect(name08).toBe("m08");
  });
});
