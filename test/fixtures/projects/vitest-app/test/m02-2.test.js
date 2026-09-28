import { describe, expect, it } from "vitest";
import { value02, double02, name02, combined02 } from "../src/m02.js";

describe("m02 (2)", () => {
  it("value adds 2", () => {
    expect(value02(2)).toBe(4);
  });

  it("double doubles the value", () => {
    expect(double02(2)).toBe(8);
  });

  it("exposes its name", () => {
    expect(name02).toBe("m02");
  });
});
