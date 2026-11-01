// Flat config of the shared edit package (packages/edit): typescript-eslint's
// recommended rules plus the same security and format rules as apps/studio,
// and C3 for the package's own source: one builder for the browser and Node,
// so no environment-only API, no clock and no randomness.
import prettierConfig from "eslint-config-prettier";
import noSecrets from "eslint-plugin-no-secrets";
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

const C3 =
  "C3: one builder for the browser and Node (no server-only or browser-only code, no clock, no randomness)";

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
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts", "src/testdata/**"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...[
          "window",
          "document",
          "navigator",
          "process",
          "Buffer",
          "require",
          "fetch",
          "performance",
          "setTimeout",
          "Date",
        ].map((name) => ({ name, message: `${name}: ${C3}.` })),
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='Math'][property.name='random']",
          message: `Math.random: ${C3}.`,
        },
        { selector: "NewExpression[callee.name='Date']", message: `new Date: ${C3}.` },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: ["fs", "path", "crypto"].map((name) => ({ name, message: `${name}: ${C3}.` })),
          patterns: [{ group: ["node:*"], message: `node:* modules: ${C3}.` }],
        },
      ],
    },
  },
  { ignores: ["node_modules/**"] },
);
