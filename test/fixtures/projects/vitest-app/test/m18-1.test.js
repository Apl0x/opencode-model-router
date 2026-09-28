import { describe, expect, it } from "vitest";
import { value18, double18, name18, combined18 } from "../src/m18.js";

describe("m18 (1)", () => {
  it("value adds 18", () => {
    expect(value18(1)).toBe(19);
  });

  it("double doubles the value", () => {
    expect(double18(1)).toBe(38);
  });
});
