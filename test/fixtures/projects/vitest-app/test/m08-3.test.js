import { describe, expect, it } from "vitest";
import { value08, double08, name08, combined08 } from "../src/m08.js";

describe("m08 (3)", () => {
  it("value adds 8", () => {
    expect(value08(3)).toBe(11);
  });

  it("double doubles the value", () => {
    expect(double08(3)).toBe(22);
  });

  it("exposes its name", () => {
    expect(name08).toBe("m08");
  });

  it("combined uses m04", () => {
    expect(combined08(3)).toBe(15);
  });
});
