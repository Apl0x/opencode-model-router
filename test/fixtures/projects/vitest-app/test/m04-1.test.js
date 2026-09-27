import { describe, expect, it } from "vitest";
import { value04, double04, name04, combined04 } from "../src/m04.js";

describe("m04 (1)", () => {
  it("value adds 4", () => {
    expect(value04(1)).toBe(5);
  });

  it("double doubles the value", () => {
    expect(double04(1)).toBe(10);
  });

  it("exposes its name", () => {
    expect(name04).toBe("m04");
  });
});
