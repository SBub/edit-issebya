// Flat config of the edit package (packages/edit): typescript-eslint's
// recommended rules plus the same security and format rules as apps/studio.
import prettierConfig from "eslint-config-prettier";
import noSecrets from "eslint-plugin-no-secrets";
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    plugins: { "no-secrets": noSecrets, security },
    rules: {
      "no-secrets/no-secrets": "error",
      "security/detect-unsafe-regex": "error",
      "security/detect-non-literal-regexp": "error",
      "security/detect-non-literal-require": "error",
      "security/detect-eval-with-expression": "error",
      "security/detect-no-csrf-before-method-override": "error",
      "security/detect-possible-timing-attacks": "error",
      "security/detect-child-process": "error",
      "security/detect-non-literal-fs-filename": "error",
      "security/detect-pseudoRandomBytes": "error",
      "security/detect-buffer-noassert": "error",
    },
  },
  // One builder for the studio's preview (a browser) and the worker's export
  // (Node): the source uses neither platform's API, no clock and no
  // randomness, so the same edit always builds the same page everywhere.
  // Callers pass in the fonts, HarfBuzz and the id generator.
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts", "src/test-support/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "node:*",
                "fs",
                "fs/*",
                "path",
                "os",
                "child_process",
                "crypto",
                "@edit-issebya/storage",
                "@supabase/*",
              ],
              message: "packages/edit runs in the browser and in Node: no platform API.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        ...[
          "process",
          "Buffer",
          "window",
          "document",
          "fetch",
          "navigator",
          "crypto",
          "performance",
          "Date",
          "setTimeout",
          "setInterval",
        ].map((name) => ({
          name,
          message: "packages/edit is deterministic and platform-neutral: no clock, no I/O.",
        })),
      ],
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "packages/edit is deterministic." },
      ],
    },
  },
  { ignores: ["node_modules/**"] },
);
