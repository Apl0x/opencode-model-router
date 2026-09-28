const { value06, label06, chained06 } = require("../src/a06");

describe("a06 (2)", () => {
  it("multiplies by 6", () => {
    expect(value06(2)).toBe(12);
  });

  it("has a label", () => {
    expect(label06()).toBe("a06");
  });
});
