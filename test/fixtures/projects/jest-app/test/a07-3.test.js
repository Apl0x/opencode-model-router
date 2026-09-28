const { value07, label07, chained07 } = require("../src/a07");

describe("a07 (3)", () => {
  it("multiplies by 7", () => {
    expect(value07(3)).toBe(21);
  });

  it("has a label", () => {
    expect(label07()).toBe("a07");
  });
});
