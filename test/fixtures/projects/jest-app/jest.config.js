// Only test/ is collected. extra/ holds the opt-in pre-existing failure and is never collected.
module.exports = {
  testEnvironment: "node",
  testMatch: ["**/test/**/*.test.js"],
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
};
