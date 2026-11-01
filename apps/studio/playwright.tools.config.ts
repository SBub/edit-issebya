import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// The export guardrail (`yarn workspace @edit-issebya/studio test:tools`): the
// real worker `once` renders with the real HyperFrames, so it runs on the
// owner's Mac only, never in CI. Same environment files and server adoption
// as playwright.config.ts; never set CI=1 in an ADW run.
for (const file of ["../worker/.env.development", ".env.development"]) {
  const path = new URL(file, import.meta.url).pathname;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- two fixed paths
  if (existsSync(path)) process.loadEnvFile(path);
}

const PORT = process.env.PORT ?? "3000";
const STUDIO_PORT = process.env.STUDIO_PORT ?? "3001";
const BASE_URL = `http://localhost:${PORT}`;
const VIEWPORT = { width: 1920, height: 1080 };

const server = {
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
  gracefulShutdown: { signal: "SIGTERM" as const, timeout: 5000 },
};

export default defineConfig({
  testDir: "./tools",
  testMatch: "**/*.spec.ts",
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  // A real render of the fixture reel takes minutes.
  timeout: 20 * 60 * 1000,
  use: {
    baseURL: BASE_URL,
    viewport: VIEWPORT,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: VIEWPORT } }],
  webServer: [
    {
      ...server,
      command: "yarn workspace @edit-issebya/studio dev",
      url: `http://localhost:${STUDIO_PORT}/studio`,
      env: { STUDIO_PORT, E2E_MOCK_STORAGE: "true" },
    },
    {
      ...server,
      command: "yarn workspace @edit-issebya/web dev",
      url: BASE_URL,
      env: { PORT, STUDIO_PORT },
    },
  ],
});
