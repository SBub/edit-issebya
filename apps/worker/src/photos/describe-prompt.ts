import { readFileSync } from "node:fs";

// Bump with every change to describe-prompt.md: each photo row records it.
export const DESCRIBE_PROMPT_VERSION = "describe-photo-1";

// eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed prompt
const TEMPLATE = readFileSync(new URL("./describe-prompt.md", import.meta.url), "utf8");

// The describe prompt: the committed instructions and, on the retry, the
// reasons the first answer was refused.
export function describePrompt(previousReasons?: readonly string[]): string {
  if (!previousReasons || previousReasons.length === 0) return TEMPLATE;
  return [
    TEMPLATE.trimEnd(),
    "",
    "Your previous answer was refused for these reasons. Fix them and answer again:",
    ...previousReasons.map((reason) => `- ${reason}`),
    "",
  ].join("\n");
}
