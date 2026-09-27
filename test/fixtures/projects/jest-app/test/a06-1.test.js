const { value06, label06, chained06 } = require("../src/a06");

describe("a06 (1)", () => {
  it("multiplies by 6", () => {
    expect(value06(1)).toBe(6);
  });

  it("has a label", () => {
    expect(label06()).toBe("a06");
  });

  it("ran the setup file", () => {
    expect(globalThis.__JEST_APP_SETUP__).toBe(true);
  });

  it("chains through a03", () => {
    expect(chained06(1)).toBe(9);
  });
});
