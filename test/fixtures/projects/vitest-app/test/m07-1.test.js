import { describe, expect, it } from "vitest";
import { value07, double07, name07, combined07 } from "../src/m07.js";

describe("m07 (1)", () => {
  it("value adds 7", () => {
    expect(value07(1)).toBe(8);
  });

  it("double doubles the value", () => {
    expect(double07(1)).toBe(16);
  });

  it("exposes its name", () => {
    expect(name07).toBe("m07");
  });
});
