const { value01, label01 } = require("../src/a01");

describe("a01 (1)", () => {
  it("multiplies by 1", () => {
    expect(value01(1)).toBe(1);
  });

  it("has a label", () => {
    expect(label01()).toBe("a01");
  });

  it("ran the setup file", () => {
    expect(globalThis.__JEST_APP_SETUP__).toBe(true);
  });
});
