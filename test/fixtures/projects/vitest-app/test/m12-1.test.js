import { describe, expect, it } from "vitest";
import { value12, double12, name12, combined12 } from "../src/m12.js";

describe("m12 (1)", () => {
  it("value adds 12", () => {
    expect(value12(1)).toBe(13);
  });

  it("double doubles the value", () => {
    expect(double12(1)).toBe(26);
  });
});
