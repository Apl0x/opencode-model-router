import { describe, expect, it } from "vitest";
import { value19, double19, name19, combined19 } from "../src/m19.js";

describe("m19 (1)", () => {
  it("value adds 19", () => {
    expect(value19(1)).toBe(20);
  });

  it("double doubles the value", () => {
    expect(double19(1)).toBe(40);
  });

  it("exposes its name", () => {
    expect(name19).toBe("m19");
  });
});
