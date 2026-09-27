import { describe, expect, it } from "vitest";
import { value07, double07, name07, combined07 } from "../src/m07.js";

describe("m07 (2)", () => {
  it("value adds 7", () => {
    expect(value07(2)).toBe(9);
  });

  it("double doubles the value", () => {
    expect(double07(2)).toBe(18);
  });

  it("exposes its name", () => {
    expect(name07).toBe("m07");
  });

  it("combined uses m03", () => {
    expect(combined07(2)).toBe(12);
  });
});
