import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirror tsconfig's "@/*" path so tests import modules the way the app does
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
  test: {
    // Database-free: the pre-push `yarn test` never needs the local stack.
    // The DB integration tests have their own config (vitest.db.config.ts).
    include: ["src/**/*.test.ts", "test-support/**/*.test.ts"],
  },
});
