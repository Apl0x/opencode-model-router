const { value08, label08, chained08 } = require("../src/a08");

describe("a08 (1)", () => {
  it("multiplies by 8", () => {
    expect(value08(1)).toBe(8);
  });

  it("has a label", () => {
    expect(label08()).toBe("a08");
  });

  it("ran the setup file", () => {
    expect(globalThis.__JEST_APP_SETUP__).toBe(true);
  });
});
