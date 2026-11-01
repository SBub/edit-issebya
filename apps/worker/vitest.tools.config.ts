import { defineConfig } from "vitest/config";

// `yarn workspace @edit-issebya/worker test:tools`: the real ffmpeg and
// HyperFrames on the committed clips, on the owner's Mac, never in CI. The
// first whisper run may download the `small` model, hence the long timeout.
export default defineConfig({
  test: {
    include: ["src/**/*.tools.test.ts"],
    testTimeout: 10 * 60 * 1000,
    hookTimeout: 10 * 60 * 1000,
    fileParallelism: false,
  },
});
