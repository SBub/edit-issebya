// Flat config of the studio (apps/studio). It mirrors apps/web's config (same
// security and format rules) and adds two guards: app code under src/ never
// imports the test helpers, which hold the local secret key, and never reads
// the worker's secrets.
import nextConfig from "eslint-config-next";
import prettierConfig from "eslint-config-prettier";
import noSecrets from "eslint-plugin-no-secrets";
import security from "eslint-plugin-security";

// The worker's secrets; app code under src/ never reads them.
const WORKER_SECRETS = [
  "SUPABASE_SECRET_KEY",
  "R2_WORKER_ACCESS_KEY_ID",
  "R2_WORKER_SECRET_ACCESS_KEY",
];

const eslintConfig = [
  ...nextConfig,
  prettierConfig,
  {
    plugins: { "no-secrets": noSecrets, security },
    rules: {
      "no-secrets/no-secrets": "error",
      "import/no-cycle": "error",
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
    files: ["src/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/test-support/**"],
              message: "Test helpers hold the local secret key; app code never imports them.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: `MemberExpression[property.name=/^(${WORKER_SECRETS.join("|")})$/]`,
          message: "The worker's secrets never reach the studio's app code.",
        },
      ],
    },
  },
  {
    ignores: [
      ".next/**",
      "next-env.d.ts",
      "playwright-report/**",
      "test-results/**",
      "blob-report/**",
    ],
  },
];

export default eslintConfig;
