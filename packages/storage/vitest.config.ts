import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Database-free: the pre-push `yarn test` never needs the local stack.
    include: ["src/**/*.test.ts"],
    // The fake's tests do real filesystem work in a `mkdtemp` folder. The pre-push
    // `yarn test` runs every workspace's suite at once, and on a loaded machine this
    // suite has taken 45s against under 1s alone, so the 5s default fails a test that
    // is not hanging. 20s matches the worker's tests and `apps/studio/vitest.db.config.ts`;
    // the hooks get the same budget for `mkdtemp` and `rm`.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
