import { describe, expect, it } from "vitest";
import { value05, double05, name05, combined05 } from "../src/m05.js";

describe("m05 (3)", () => {
  it("value adds 5", () => {
    expect(value05(3)).toBe(8);
  });

  it("double doubles the value", () => {
    expect(double05(3)).toBe(16);
  });

  it("exposes its name", () => {
    expect(name05).toBe("m05");
  });

  it("combined uses m02", () => {
    expect(combined05(3)).toBe(10);
  });
});
