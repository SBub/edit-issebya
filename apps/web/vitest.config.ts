import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirror tsconfig's "@/*" path so tests import modules the way the app does
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
