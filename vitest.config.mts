import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Each file starts its own in-memory Postgres (PGlite), which takes a moment.
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
