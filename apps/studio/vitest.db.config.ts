import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// The worker's file holds the local secret key the admin helper reads; the
// studio's holds the public URL and key. process.loadEnvFile never overrides a
// variable that is already set (CI exports its own stack's values).
for (const file of ["../worker/.env.development", ".env.development"]) {
  const path = new URL(file, import.meta.url).pathname;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- two fixed paths
  if (existsSync(path)) process.loadEnvFile(path);
}

export default defineConfig({
  resolve: {
    // Mirror tsconfig's "@/*" path, as vitest.config.ts does, for src/lib imports.
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
  test: {
    include: ["db-tests/**/*.test.ts"],
    // Every file talks to the one shared local stack.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
