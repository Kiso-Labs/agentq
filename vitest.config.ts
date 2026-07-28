import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/support/setup.ts"],
    fileParallelism: false,
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
  },
});
