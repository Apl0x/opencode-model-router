const { value02, label02, chained02 } = require("../src/a02");

describe("a02 (1)", () => {
  it("multiplies by 2", () => {
    expect(value02(1)).toBe(2);
  });

  it("has a label", () => {
    expect(label02()).toBe("a02");
  });

  it("ran the setup file", () => {
    expect(globalThis.__JEST_APP_SETUP__).toBe(true);
  });
});
