const { value09, label09, chained09 } = require("../src/a09");

describe("a09 (2)", () => {
  it("multiplies by 9", () => {
    expect(value09(2)).toBe(18);
  });

  it("has a label", () => {
    expect(label09()).toBe("a09");
  });
});
