import { describe, expect, it } from "vitest";
import { value16, double16, name16, combined16 } from "../src/m16.js";

describe("m16 (1)", () => {
  it("value adds 16", () => {
    expect(value16(1)).toBe(17);
  });

  it("double doubles the value", () => {
    expect(double16(1)).toBe(34);
  });

  it("exposes its name", () => {
    expect(name16).toBe("m16");
  });
});
