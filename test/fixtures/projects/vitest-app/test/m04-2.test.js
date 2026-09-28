import { describe, expect, it } from "vitest";
import { value04, double04, name04, combined04 } from "../src/m04.js";

describe("m04 (2)", () => {
  it("value adds 4", () => {
    expect(value04(2)).toBe(6);
  });

  it("double doubles the value", () => {
    expect(double04(2)).toBe(12);
  });

  it("exposes its name", () => {
    expect(name04).toBe("m04");
  });

  it("combined uses m02", () => {
    expect(combined04(2)).toBe(8);
  });
});
