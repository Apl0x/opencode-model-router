const { value10, label10, chained10 } = require("../src/a10");

describe("a10 (1)", () => {
  it("multiplies by 10", () => {
    expect(value10(1)).toBe(10);
  });

  it("has a label", () => {
    expect(label10()).toBe("a10");
  });

  it("ran the setup file", () => {
    expect(globalThis.__JEST_APP_SETUP__).toBe(true);
  });
});
