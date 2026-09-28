const { value09, label09, chained09 } = require("../src/a09");

describe("a09 (1)", () => {
  it("multiplies by 9", () => {
    expect(value09(1)).toBe(9);
  });

  it("has a label", () => {
    expect(label09()).toBe("a09");
  });

  it("ran the setup file", () => {
    expect(globalThis.__JEST_APP_SETUP__).toBe(true);
  });

  it("chains through a04", () => {
    expect(chained09(1)).toBe(13);
  });
});
