import { describe, expect, it } from "vitest";
import { value05, double05, name05, combined05 } from "../src/m05.js";

describe("m05 (2)", () => {
  it("value adds 5", () => {
    expect(value05(2)).toBe(7);
  });

  it("double doubles the value", () => {
    expect(double05(2)).toBe(14);
  });

  it("exposes its name", () => {
    expect(name05).toBe("m05");
  });
});
