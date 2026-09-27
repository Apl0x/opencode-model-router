import { describe, expect, it } from "vitest";
import { value10, double10, name10, combined10 } from "../src/m10.js";

describe("m10 (1)", () => {
  it("value adds 10", () => {
    expect(value10(1)).toBe(11);
  });

  it("double doubles the value", () => {
    expect(double10(1)).toBe(22);
  });

  it("exposes its name", () => {
    expect(name10).toBe("m10");
  });
});
