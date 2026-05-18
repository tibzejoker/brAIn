import { defineConfig } from "vitest/config";
import path from "path";
import { config } from "dotenv";

config({ path: path.resolve(__dirname, ".env") });

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    fileParallelism: false,
    globalSetup: ["./tests/_setup/nats-broker.ts"],
    // Tests dynamically import node handlers from the sibling
    // `storeprojects/` directory (`brain.service.ts` -> `loadHandler`
    // -> `import(require.resolve(typePath))`). Vite restricts dynamic
    // imports to the project root by default; widen the allow-list to
    // include the workspace parent so handlers in storeprojects load.
    server: {
      deps: { external: [/\/storeprojects\//] },
    },
    // Coverage emits lcov for SonarQube/SonarCloud ingestion. v8 is the
    // native Node coverage provider (no extra babel/istanbul transform).
    // `all: true` includes uncovered source files so the % isn't inflated
    // by ignoring untested code.
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
      all: true,
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/*.spec.ts",
        "**/dist/**",
        "**/node_modules/**",
        "**/*.d.ts",
      ],
    },
  },
  server: {
    fs: { allow: [path.resolve(__dirname, "..")] },
  },
  resolve: {
    alias: {
      "@brain/sdk": path.resolve(__dirname, "packages/sdk/src"),
      "@brain/core": path.resolve(__dirname, "packages/core/src"),
    },
  },
});
