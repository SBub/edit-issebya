import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// The worker's file holds the local secret key the test helpers read; the
// studio's holds the public URL and key. process.loadEnvFile never overrides a
// variable that is already set (CI exports its own stack's values).
for (const file of ["../worker/.env.development", ".env.development"]) {
  const path = new URL(file, import.meta.url).pathname;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- two fixed paths
  if (existsSync(path)) process.loadEnvFile(path);
}

// Specs reach the studio through the landing page's address, the way a
// browser does in production. The ADW test phase runs `yarn test:e2e` with
// PORT set to the run's port and STUDIO_PORT to its BACKEND_PORT, against the
// servers /prepare_app already started; 3000 and 3001 are only the local
// defaults.
const PORT = process.env.PORT ?? "3000";
const STUDIO_PORT = process.env.STUDIO_PORT ?? "3001";
const BASE_URL = `http://localhost:${PORT}`;
const VIEWPORT = { width: 1920, height: 1080 };

// CI has just run `yarn build`; locally the run's servers are usually already
// up and adopted. Never set CI=1 in an ADW run.
const server = {
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
  gracefulShutdown: { signal: "SIGTERM" as const, timeout: 5000 },
};

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  forbidOnly: !!process.env.CI,
  // A flaky spec should fail, not be retried into green.
  retries: 0,
  // One worker: every spec shares the one local Supabase stack and its users.
  workers: 1,
  use: {
    baseURL: BASE_URL,
    viewport: VIEWPORT,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: VIEWPORT } }],
  webServer: [
    {
      ...server,
      command: process.env.CI
        ? "yarn workspace @edit-issebya/studio start"
        : "yarn workspace @edit-issebya/studio dev",
      url: `http://localhost:${STUDIO_PORT}/studio`,
      env: { STUDIO_PORT },
    },
    {
      ...server,
      command: process.env.CI
        ? "yarn workspace @edit-issebya/web start"
        : "yarn workspace @edit-issebya/web dev",
      url: BASE_URL,
      env: { PORT, STUDIO_PORT },
    },
  ],
});
