import { defineConfig } from "vitest/config";

// `yarn workspace @edit-issebya/worker test:tools`: the real ffmpeg and
// HyperFrames on the committed clip, on the owner's Mac, never in CI. The
// first whisper run may download the `small` model, hence the long timeout.
// Whisper `medium` (the re-listen) is never downloaded by a run: fetch it once
// with `yarn workspace @edit-issebya/worker models:fetch`.
export default defineConfig({
  test: {
    include: ["src/**/*.tools.test.ts"],
    testTimeout: 10 * 60 * 1000,
    hookTimeout: 10 * 60 * 1000,
    fileParallelism: false,
  },
});
