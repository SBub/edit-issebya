import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Database-free: the pre-push `yarn test` never needs the local stack.
    include: ["src/**/*.test.ts"],
    // Real ffmpeg and HyperFrames: `test:tools` only (vitest.tools.config.ts).
    exclude: [...configDefaults.exclude, "src/**/*.tools.test.ts"],
  },
});
