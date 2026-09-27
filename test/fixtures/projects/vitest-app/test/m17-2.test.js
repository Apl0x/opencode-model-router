import { describe, expect, it } from "vitest";
import { value17, double17, name17, combined17 } from "../src/m17.js";

describe("m17 (2)", () => {
  it("value adds 17", () => {
    expect(value17(2)).toBe(19);
  });

  it("double doubles the value", () => {
    expect(double17(2)).toBe(38);
  });

  it("exposes its name", () => {
    expect(name17).toBe("m17");
  });
});
