const { value07, label07, chained07 } = require("../src/a07");

describe("a07 (1)", () => {
  it("multiplies by 7", () => {
    expect(value07(1)).toBe(7);
  });

  it("has a label", () => {
    expect(label07()).toBe("a07");
  });

  it("ran the setup file", () => {
    expect(globalThis.__JEST_APP_SETUP__).toBe(true);
  });
});
