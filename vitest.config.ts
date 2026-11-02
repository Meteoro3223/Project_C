import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.review/**"],
    passWithNoTests: true,
    environment: "node",
    // Integration tests share one Postgres test database and truncate it
    // between tests, so test files must not run concurrently.
    fileParallelism: false,
  },
});
