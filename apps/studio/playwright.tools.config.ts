import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";

// `yarn workspace @edit-issebya/studio test:tools`: the preview-matches-export
// guardrail, a real HyperFrames render through the worker. On the owner's Mac
// only, against the run's servers; never in `yarn test:e2e` or CI.
export default defineConfig({
  ...base,
  testDir: "./e2e-tools",
  timeout: 15 * 60_000,
  workers: 1,
  retries: 0,
});
