const { value03, label03, chained03 } = require("../src/a03");

describe("a03 (1)", () => {
  it("multiplies by 3", () => {
    expect(value03(1)).toBe(3);
  });

  it("has a label", () => {
    expect(label03()).toBe("a03");
  });

  it("ran the setup file", () => {
    expect(globalThis.__JEST_APP_SETUP__).toBe(true);
  });

  it("chains through a01", () => {
    expect(chained03(1)).toBe(4);
  });
});
