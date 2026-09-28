import { describe, expect, it } from "vitest";
import { value03, double03, name03, combined03 } from "../src/m03.js";

describe("m03 (1)", () => {
  it("value adds 3", () => {
    expect(value03(1)).toBe(4);
  });

  it("double doubles the value", () => {
    expect(double03(1)).toBe(8);
  });
});
