const { value10, label10, chained10 } = require("../src/a10");

describe("a10 (3)", () => {
  it("multiplies by 10", () => {
    expect(value10(3)).toBe(30);
  });

  it("has a label", () => {
    expect(label10()).toBe("a10");
  });
});
