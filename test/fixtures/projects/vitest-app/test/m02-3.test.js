import { describe, expect, it } from "vitest";
import { value02, double02, name02, combined02 } from "../src/m02.js";

describe("m02 (3)", () => {
  it("value adds 2", () => {
    expect(value02(3)).toBe(5);
  });

  it("double doubles the value", () => {
    expect(double02(3)).toBe(10);
  });

  it("exposes its name", () => {
    expect(name02).toBe("m02");
  });

  it("combined uses m01", () => {
    expect(combined02(3)).toBe(6);
  });
});
