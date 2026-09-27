import { describe, expect, it } from "vitest";
import { value20, double20, name20, combined20 } from "../src/m20.js";

describe("m20 (3)", () => {
  it("value adds 20", () => {
    expect(value20(3)).toBe(23);
  });

  it("double doubles the value", () => {
    expect(double20(3)).toBe(46);
  });

  it("exposes its name", () => {
    expect(name20).toBe("m20");
  });

  it("combined uses m10", () => {
    expect(combined20(3)).toBe(33);
  });
});
