import { describe, expect, it } from "vitest";
import { value06, double06, name06, combined06 } from "../src/m06.js";

describe("m06 (1)", () => {
  it("value adds 6", () => {
    expect(value06(1)).toBe(7);
  });

  it("double doubles the value", () => {
    expect(double06(1)).toBe(14);
  });
});
