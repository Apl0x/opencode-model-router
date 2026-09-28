import { describe, expect, it } from "vitest";
import { value11, double11, name11, combined11 } from "../src/m11.js";

describe("m11 (2)", () => {
  it("value adds 11", () => {
    expect(value11(2)).toBe(13);
  });

  it("double doubles the value", () => {
    expect(double11(2)).toBe(26);
  });

  it("exposes its name", () => {
    expect(name11).toBe("m11");
  });
});
