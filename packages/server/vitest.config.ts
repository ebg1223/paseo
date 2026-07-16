import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: "@server", replacement: path.resolve(__dirname, "./src") },
      // Resolve workspace SDK/plugin packages to source so tests and
      // implementation share one vite-processed module instance (mirrors
      // the root vitest.config.ts aliases).
      {
        find: /^@getpaseo\/provider-sdk\/(launch|history|pi-rpc)$/,
        replacement: path.resolve(__dirname, "../provider-sdk/src/$1/index.ts"),
      },
      {
        find: /^@getpaseo\/provider-sdk$/,
        replacement: path.resolve(__dirname, "../provider-sdk/src/index.ts"),
      },
      {
        find: /^@getpaseo\/provider-omp$/,
        replacement: path.resolve(__dirname, "../provider-omp/src/index.ts"),
      },
    ],
  },
  test: {
    testTimeout: 30000,
    hookTimeout: 60000,
    globals: true,
    environment: "node",
    setupFiles: [path.resolve(__dirname, "./src/test-utils/vitest-setup.ts")],
    pool: "forks",
    fileParallelism: false,
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**", "**/.dev/**"],
  },
});
