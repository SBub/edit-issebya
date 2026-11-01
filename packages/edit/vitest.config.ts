import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Two projects over the same fixtures and goldens: Node (the worker) and
// Chromium (the studio). The builder must give the same bytes in both.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.browser.test.ts"],
        },
      },
      {
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.ts"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
