const { value05, label05, chained05 } = require("../src/a05");

describe("a05 (1)", () => {
  it("multiplies by 5", () => {
    expect(value05(1)).toBe(5);
  });

  it("has a label", () => {
    expect(label05()).toBe("a05");
  });

  it("ran the setup file", () => {
    expect(globalThis.__JEST_APP_SETUP__).toBe(true);
  });
});
