const { value03, label03, chained03 } = require("../src/a03");

describe("a03 (2)", () => {
  it("multiplies by 3", () => {
    expect(value03(2)).toBe(6);
  });

  it("has a label", () => {
    expect(label03()).toBe("a03");
  });
});
