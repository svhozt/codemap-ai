import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Native modules (tree-sitter, better-sqlite3) are not safe to share across worker threads.
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
