import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig } from "vitest/config";

// The repository root: the browser run imports fixtures/pipeline/ JSON.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Two projects over the same fixtures: `node` (the worker's environment) and
// `browser` (Chromium through Playwright, the studio's). Both must produce the
// committed goldens byte for byte. Database-free, like every `yarn test`.
export default defineConfig({
  server: { fs: { allow: [ROOT] } },
  // harfbuzzjs finds its wasm next to itself (`new URL(..., import.meta.url)`):
  // pre-bundling would move the module away from it.
  optimizeDeps: { exclude: ["harfbuzzjs"] },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["src/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "src/**/*.browser.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.ts"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
            // Nothing written into the package on a failure.
            screenshotFailures: false,
          },
        },
      },
    ],
  },
});
