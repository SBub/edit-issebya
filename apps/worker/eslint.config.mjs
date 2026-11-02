// Flat config of the worker (apps/worker): typescript-eslint's
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
  { ignores: ["node_modules/**"] },
);
