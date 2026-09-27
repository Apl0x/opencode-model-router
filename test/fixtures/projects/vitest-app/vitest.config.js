import { defineConfig } from "vitest/config";

// Only test/ is collected. extra/ holds the opt-in pre-existing failure and is never collected.
export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    environment: "node",
  },
});
