import { describe, expect, it } from "vitest";
import { value02, double02, name02, combined02 } from "../src/m02.js";

describe("m02 (1)", () => {
  it("value adds 2", () => {
    expect(value02(1)).toBe(3);
  });

  it("double doubles the value", () => {
    expect(double02(1)).toBe(6);
  });
});
