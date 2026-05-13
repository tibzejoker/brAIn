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
