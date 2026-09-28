import { describe, expect, it } from "vitest";
import { value17, double17, name17, combined17 } from "../src/m17.js";

describe("m17 (1)", () => {
  it("value adds 17", () => {
    expect(value17(1)).toBe(18);
  });

  it("double doubles the value", () => {
    expect(double17(1)).toBe(36);
  });
});
