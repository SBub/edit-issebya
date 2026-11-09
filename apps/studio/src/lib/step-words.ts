import type { JobKind } from "./jobs";

// The one place for the words the reel page uses for the worker's steps
// (app_docs/status.md): what a step is doing, what failed, and the plain words
// for a refused answer's check rules. Every step name the worker runs
// (apps/worker/src/step-names.ts) has its own entry; an unknown name falls back
// to "Working on it", so a future step never shows a machine name.

export interface StepWords {
  doing: string;
  failed: string;
}

interface WordsContext {
  // The version a restore job goes back to.
  restoreNumber?: number | null;
}

// `failed` when absent: "Could not finish" and the doing words, lowercased.
const STEP_WORDS: Record<string, { doing: string; failed?: string }> = {
  check_footage: { doing: "Checking your video" },
  convert: { doing: "Preparing your video" },
  transcribe: { doing: "Listening to your words" },
  retime: { doing: "Tightening the pace" },
  head_track: { doing: "Finding your face" },
  preview_copies: { doing: "Making the preview" },
  first_version: { doing: "First version", failed: "Could not make the first version" },
  decide: { doing: "Styling your reel", failed: "Could not finish styling" },
  cutout: { doing: "Cutting you out for the photo" },
  backgrounds: { doing: "Reading the background" },
  restore: { doing: "Going back to version N", failed: "Could not go back to version N" },
  render: { doing: "Exporting" },
  describe_photo: { doing: "Describing your photo" },
  photo_images: { doing: "Preparing your photo" },
};

const UNKNOWN: StepWords = { doing: "Working on it", failed: "Could not finish this step" };

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

// The words for a step name; `restore` names its version when known.
export function stepWords(name: string, context: WordsContext = {}): StepWords {
  const entry = Object.hasOwn(STEP_WORDS, name) ? STEP_WORDS[name] : undefined;
  if (!entry) return UNKNOWN;
  const failed = entry.failed ?? `Could not finish ${lowerFirst(entry.doing)}`;
  const version =
    context.restoreNumber === null || context.restoreNumber === undefined
      ? "an earlier version"
      : `version ${context.restoreNumber}`;
  return {
    doing: entry.doing.replace("version N", version),
    failed: failed.replace("version N", version),
  };
}

// The steps a job of each kind runs, in order: step k of n. A `cutout` step
// runs inside `decide` and counts as it.
export const JOB_STEPS: Record<JobKind, readonly string[]> = {
  process: [
    "check_footage",
    "convert",
    "transcribe",
    "retime",
    "head_track",
    "preview_copies",
    "first_version",
    "decide",
  ],
  change: ["decide"],
  restore: ["restore"],
  render: ["render"],
  start_over: ["decide"],
};

// Plain words per rule that can name a refused answer: the checks' rules (what
// the layout would break), the answer's own refusals, and the engine's
// hidden-footage rule. The rule names only reach the page, never the AI's or
// the checks' free text. The engine's other notes never refuse an answer, so
// they have no words here.
export const RULE_WORDS: Record<string, string> = {
  "safe-box": "something would sit outside the safe area",
  face: "something would cover your face",
  "text-overlap": "two texts would sit on top of each other",
  "same-text": "the same word would show twice on screen",
  timing: "something would show for too short a time",
  "big-word-timing": "a big word would show before its word is said",
  "sound-gap": "two sounds would play too close together",
  "time-in-speech": "an accent would land outside your words",
  "out-of-reel": "something would run past the end",
  glossary: "a word would be spelled differently from your glossary",
  "answer-json": "the AI's answer could not be used",
  "answer-schema": "the AI's answer could not be used",
  "answer-edit": "the AI's answer could not be used",
  "hidden-footage": "that part of the clip is cut",
};

// The reason line of a refused answer: the first two distinct rule words
// joined with "and", capitalised; null when no rule is known.
export function refusalReason(rules: readonly string[] | null): string | null {
  const words: string[] = [];
  for (const rule of rules ?? []) {
    const text = Object.hasOwn(RULE_WORDS, rule) ? RULE_WORDS[rule] : undefined;
    if (text && !words.includes(text)) words.push(text);
    if (words.length === 2) break;
  }
  if (words.length === 0) return null;
  const joined = words.join(" and ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}
