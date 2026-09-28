import { describe, expect, it } from "vitest";
import { value11, double11, name11, combined11 } from "../src/m11.js";

describe("m11 (3)", () => {
  it("value adds 11", () => {
    expect(value11(3)).toBe(14);
  });

  it("double doubles the value", () => {
    expect(double11(3)).toBe(28);
  });

  it("exposes its name", () => {
    expect(name11).toBe("m11");
  });

  it("combined uses m05", () => {
    expect(combined11(3)).toBe(19);
  });
});
