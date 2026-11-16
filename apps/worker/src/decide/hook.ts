import { type Preset, type Transcript } from "@edit-issebya/edit";
import { type PromptCall, type PromptText, renderPrompt } from "../prompts/source.ts";
import { fenced } from "./prompt.ts";

// What the hook call sees: the transcript's words in order (no ids, no times,
// no geometry) and the style's hook length.
export interface HookInput {
  transcript: string;
  style: { hook_length: { words: number; characters: number } };
}

export function hookInput(transcript: Transcript, preset: Preset): HookInput {
  return {
    transcript: transcript.words
      .map((word) => word.text.trim())
      .filter((word) => word.length > 0)
      .join(" "),
    style: {
      hook_length: { words: preset.pace.hook.maxWords, characters: preset.pace.hook.maxCharacters },
    },
  };
}

// The hook prompt: the fetched template (`reel-hook`) with the transcript and
// the style as fenced JSON and, on the retry, the reasons the first answer was
// refused.
export function hookPrompt(
  template: PromptText,
  input: HookInput,
  previousReasons?: readonly string[],
): PromptCall {
  return renderPrompt(
    template,
    { transcript: fenced(input.transcript), style: fenced(input.style) },
    previousReasons,
  );
}
