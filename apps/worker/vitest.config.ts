import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Database-free: the pre-push `yarn test` never needs the local stack.
    include: ["src/**/*.test.ts"],
  },
});
