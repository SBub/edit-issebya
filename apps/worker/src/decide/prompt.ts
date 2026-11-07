import { type PromptCall, type PromptText, renderPrompt } from "../prompts/source.ts";
import type { DecideInput } from "./input.ts";

export function fenced(value: unknown): string {
  return ["```json", JSON.stringify(value, null, 2), "```"].join("\n");
}

// The decide (components) prompt: the fetched template (`reel-components`) with
// the inputs filled in as fenced JSON and, on the retry, the reasons the first
// answer was refused.
export function decidePrompt(
  template: PromptText,
  input: DecideInput,
  previousReasons?: readonly string[],
): PromptCall {
  return renderPrompt(
    template,
    {
      current_choices: fenced(input.current_choices),
      transcript: fenced(input.transcript),
      sentences: fenced(input.sentences),
      preset: fenced(input.preset),
      behind_rules: fenced(input.behind_rules),
      hook: fenced(input.hook),
    },
    previousReasons,
  );
}
