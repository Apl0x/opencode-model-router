import { describe, expect, it } from "vitest";
import { value17, double17, name17, combined17 } from "../src/m17.js";

describe("m17 (3)", () => {
  it("value adds 17", () => {
    expect(value17(3)).toBe(20);
  });

  it("double doubles the value", () => {
    expect(double17(3)).toBe(40);
  });

  it("exposes its name", () => {
    expect(name17).toBe("m17");
  });

  it("combined uses m08", () => {
    expect(combined17(3)).toBe(28);
  });
});
