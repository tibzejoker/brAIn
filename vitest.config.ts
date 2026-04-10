import { defineConfig } from "vitest/config";
import path from "path";
import { config } from "dotenv";

config({ path: path.resolve(__dirname, ".env") });

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@brain/sdk": path.resolve(__dirname, "packages/sdk/src"),
      "@brain/core": path.resolve(__dirname, "packages/core/src"),
    },
  },
});
