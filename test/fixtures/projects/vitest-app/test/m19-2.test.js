import { describe, expect, it } from "vitest";
import { value19, double19, name19, combined19 } from "../src/m19.js";

describe("m19 (2)", () => {
  it("value adds 19", () => {
    expect(value19(2)).toBe(21);
  });

  it("double doubles the value", () => {
    expect(double19(2)).toBe(42);
  });

  it("exposes its name", () => {
    expect(name19).toBe("m19");
  });

  it("combined uses m09", () => {
    expect(combined19(2)).toBe(30);
  });
});
