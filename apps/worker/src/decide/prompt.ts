import { type PromptCall, type PromptText, renderPrompt } from "../prompts/source.ts";
import type { DecideInput } from "./input.ts";

export function fenced(value: unknown): string {
  return ["```json", JSON.stringify(value, null, 2), "```"].join("\n");
}

// The decide (components) prompt: the fetched template (`reel-components`) with
// its four inputs filled in (the script and the hook as fenced JSON, the
// intensity and the target as plain text) and, on the retry, the reasons the
// first answer was refused.
export function decidePrompt(
  template: PromptText,
  input: DecideInput,
  previousReasons?: readonly string[],
): PromptCall {
  return renderPrompt(
    template,
    {
      script: fenced(input.script),
      hook: fenced(input.hook),
      intensity: input.intensity,
      target_picks: String(input.target_picks),
    },
    previousReasons,
  );
}
