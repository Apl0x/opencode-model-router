const { value04, label04, chained04 } = require("../src/a04");

describe("a04 (2)", () => {
  it("multiplies by 4", () => {
    expect(value04(2)).toBe(8);
  });

  it("has a label", () => {
    expect(label04()).toBe("a04");
  });

  it("ran the setup file", () => {
    expect(globalThis.__JEST_APP_SETUP__).toBe(true);
  });

  it("chains through a02", () => {
    expect(chained04(2)).toBe(8);
  });
});
