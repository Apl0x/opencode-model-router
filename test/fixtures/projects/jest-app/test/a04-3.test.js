const { value04, label04, chained04 } = require("../src/a04");

describe("a04 (3)", () => {
  it("multiplies by 4", () => {
    expect(value04(3)).toBe(12);
  });

  it("has a label", () => {
    expect(label04()).toBe("a04");
  });
});
