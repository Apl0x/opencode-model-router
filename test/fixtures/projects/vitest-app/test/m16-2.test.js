import { describe, expect, it } from "vitest";
import { value16, double16, name16, combined16 } from "../src/m16.js";

describe("m16 (2)", () => {
  it("value adds 16", () => {
    expect(value16(2)).toBe(18);
  });

  it("double doubles the value", () => {
    expect(double16(2)).toBe(36);
  });

  it("exposes its name", () => {
    expect(name16).toBe("m16");
  });

  it("combined uses m08", () => {
    expect(combined16(2)).toBe(26);
  });
});
