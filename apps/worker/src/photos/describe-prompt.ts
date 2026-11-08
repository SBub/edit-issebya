import { type PromptCall, type PromptText, renderPrompt } from "../prompts/source.ts";

// The describe prompt: the fetched template (`photo-describe`) and, on the
// retry, the reasons the first answer was refused. Nothing is filled in: the
// image rides with the call, not in the text.
export function describePrompt(
  template: PromptText,
  previousReasons?: readonly string[],
): PromptCall {
  return renderPrompt(template, {}, previousReasons);
}
