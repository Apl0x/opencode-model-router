const { value01 } = require("../src/a01");

// Deliberately failing. Copied into test/ and committed by the e2e helper when asked.
describe("preexisting failure", () => {
  it("asserts something false", () => {
    expect(value01(1)).toBe(999);
  });
});
