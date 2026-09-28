const { value01, label01 } = require("../src/a01");

describe("a01 (2)", () => {
  it("multiplies by 1", () => {
    expect(value01(2)).toBe(2);
  });

  it("has a label", () => {
    expect(label01()).toBe("a01");
  });

  it("ran the setup file", () => {
    expect(globalThis.__JEST_APP_SETUP__).toBe(true);
  });

  it("maps zero to zero", () => {
    expect(value01(0)).toBe(0);
  });
});
