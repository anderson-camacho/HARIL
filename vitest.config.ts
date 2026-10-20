import { defineConfig } from "vitest/config";

// Hosted Windows runners intermittently exceed individual test timeouts while
// dozens of Vitest project files contend for CPU/SQLite disk access. Bound only
// CI's Windows parallelism; local development and Linux keep their defaults.
const windowsCi = process.platform === "win32" && process.env.CI === "true";

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: ["packages/*", "integrations/*", "apps/*"],
    ...(windowsCi ? { maxWorkers: 2, minWorkers: 1 } : {}),
  },
});
