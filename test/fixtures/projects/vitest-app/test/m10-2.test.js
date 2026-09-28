import { describe, expect, it } from "vitest";
import { value10, double10, name10, combined10 } from "../src/m10.js";

describe("m10 (2)", () => {
  it("value adds 10", () => {
    expect(value10(2)).toBe(12);
  });

  it("double doubles the value", () => {
    expect(double10(2)).toBe(24);
  });

  it("exposes its name", () => {
    expect(name10).toBe("m10");
  });

  it("combined uses m05", () => {
    expect(combined10(2)).toBe(17);
  });
});
