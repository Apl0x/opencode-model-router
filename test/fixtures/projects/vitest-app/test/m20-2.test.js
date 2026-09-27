import { describe, expect, it } from "vitest";
import { value20, double20, name20, combined20 } from "../src/m20.js";

describe("m20 (2)", () => {
  it("value adds 20", () => {
    expect(value20(2)).toBe(22);
  });

  it("double doubles the value", () => {
    expect(double20(2)).toBe(44);
  });

  it("exposes its name", () => {
    expect(name20).toBe("m20");
  });
});
