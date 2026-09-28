const { value07, label07, chained07 } = require("../src/a07");

describe("a07 (2)", () => {
  it("multiplies by 7", () => {
    expect(value07(2)).toBe(14);
  });

  it("has a label", () => {
    expect(label07()).toBe("a07");
  });

  it("ran the setup file", () => {
    expect(globalThis.__JEST_APP_SETUP__).toBe(true);
  });

  it("chains through a03", () => {
    expect(chained07(2)).toBe(13);
  });
});
