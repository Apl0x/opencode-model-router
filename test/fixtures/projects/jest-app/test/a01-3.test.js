const { value01, label01 } = require("../src/a01");

describe("a01 (3)", () => {
  it("multiplies by 1", () => {
    expect(value01(3)).toBe(3);
  });

  it("has a label", () => {
    expect(label01()).toBe("a01");
  });
});
