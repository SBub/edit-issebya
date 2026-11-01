import { readFileSync } from "node:fs";
import type { DecideInput } from "./input.ts";

// Bump with every change to prompt.md: each version row records it.
export const PROMPT_VERSION = "decide-1";

// eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed prompt
const TEMPLATE = readFileSync(new URL("./prompt.md", import.meta.url), "utf8");

function fenced(value: unknown): string {
  return ["```json", JSON.stringify(value, null, 2), "```"].join("\n");
}

// The decide prompt: the committed instructions with the inputs filled in as
// fenced JSON and, on the retry, the reasons the first answer was refused.
export function decidePrompt(input: DecideInput, previousReasons?: readonly string[]): string {
  const values: Record<string, string> = {
    current_version: fenced(input.current_version),
    transcript: fenced(input.transcript),
    head_track: fenced(input.head_track),
    preset: fenced(input.preset),
    request: input.request ?? "(none)",
  };
  const filled = TEMPLATE.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match);
  if (!previousReasons || previousReasons.length === 0) return filled;
  return [
    filled.trimEnd(),
    "",
    "Your previous answer was refused for these reasons. Fix them and answer again:",
    ...previousReasons.map((reason) => `- ${reason}`),
    "",
  ].join("\n");
}
