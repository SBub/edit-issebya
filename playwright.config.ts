import { defineConfig, devices } from "@playwright/test";

// The ADW test phase runs the suite as `PORT=<run port> yarn test:e2e` against
// the server /prepare_app already started on that port; 3000 is only the local
// default.
const PORT = process.env.PORT ?? "3000";
const BASE_URL = `http://localhost:${PORT}`;

// The review viewport, the same as playwright-mcp-config.json. Specs that need
// 375 or 390 call page.setViewportSize themselves.
const VIEWPORT = { width: 1920, height: 1080 };

export default defineConfig({
  testDir: "./e2e",
  // Only *.spec.ts files are collected; any agent-driven e2e/*.md journey the
  // test phase runs through the MCP must never be.
  testMatch: "**/*.spec.ts",
  forbidOnly: !!process.env.CI,
  // A flaky spec should fail, not be retried into green, locally and in CI.
  retries: 0,
  // One worker, deliberately. Playwright runs separate files in parallel by
  // default, but every spec here drives the same process-global state: one
  // server, and in it one Stripe mock capture and one missing-key toggle (see
  // src/lib/e2e-stripe-mock.ts). Parallel files would race on them: one spec's
  // DELETE of the capture or its keyMissing toggle would land in another's
  // checkout.
  workers: 1,
  use: {
    baseURL: BASE_URL,
    viewport: VIEWPORT,
  },
  // Chromium only; Firefox and WebKit are out of scope. The device preset
  // brings its own 1280x720 viewport, so the review one is repeated after it.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: VIEWPORT } }],
  webServer: {
    // CI has just run `yarn build`; locally the ADW run's server is usually
    // already up and adopted.
    command: process.env.CI ? "yarn start" : "yarn dev",
    url: BASE_URL,
    // This is how the /prepare_app server on the run's port is adopted; never
    // set CI=1 in an ADW run.
    reuseExistingServer: !process.env.CI,
    // The first `next dev` compile of / can be slow.
    timeout: 120_000,
    // Let next close its sockets before any fallback SIGKILL.
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
    // Pins the spawned server to the port baseURL points at; `next dev` and
    // `next start` both read PORT, so nothing passes --port. E2E_MOCK_STRIPE
    // turns on the in-process Stripe mock (src/instrumentation.ts) and its
    // /api/e2e-stripe-mock route, for `yarn dev` and `yarn start` alike. An
    // adopted server never sees this env, so ADW's /prepare_app server must
    // be started with the same flag set to true in front of `yarn dev`.
    env: { PORT, E2E_MOCK_STRIPE: "true" },
  },
});
