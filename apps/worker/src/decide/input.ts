import {
  type BehindForbid,
  type Edit,
  type EngineInput,
  NEW_TRANSITION_KINDS,
  type Preset,
  type Transcript,
  choicesOf,
  sentenceSpans,
  wordsText,
} from "@edit-issebya/edit";

// One spoken sentence: its first and last word ids and what is said.
interface SentenceChoice {
  from: string;
  to: string;
  text: string;
}

// The transcript's sentences as the AI sees them: word ids and words, no times.
function sentences(transcript: Transcript, preset: Preset): SentenceChoice[] {
  const ids = transcript.words.map((word) => word.id);
  return sentenceSpans(transcript).map(({ from, to }) => ({
    from,
    to,
    text: wordsText(ids.slice(ids.indexOf(from), ids.indexOf(to) + 1), transcript, preset),
  }));
}

// What of the preset the AI decides with: the transition kinds a new answer
// may pick (LIST, `numbered`), and the glossary. The hook's length is the hook
// call's (`hook.ts`). No count of components and no pace: how many is the
// editor's choice, and how often each shows is the layout engine's. No frame,
// box, font size, colour, spot or time: the layout owns every position, size
// and time.
export function presetSummary(preset: Preset) {
  return {
    transitions: NEW_TRANSITION_KINDS.map((kind) => ({
      kind,
      description: preset.transitions[kind].description ?? "",
    })),
    glossary: preset.glossary,
  };
}

// The current version's choices in the answer's own terms, for the prompt:
// an older title shows as a plain accent, a transition of a kind a new answer
// may not pick is left out, and no wish is shown. The answer's schema would
// refuse any of those, so the model never sees them as something to copy. A
// library photo is not a choice a new answer makes, so it is left out too. No
// hook: the written hook is its own call's answer, shown as `hook` instead.
export function currentChoices(choices: EngineInput): EngineInput {
  return {
    accents: choices.accents.map(({ from, to }) => ({ from, to })),
    big_words: choices.big_words.map(({ word }) => ({ word })),
    visuals: choices.visuals.map(({ from, to, description }) => ({
      from,
      to,
      ...(description ? { description } : {}),
    })),
    transitions: choices.transitions
      .filter((transition) => (NEW_TRANSITION_KINDS as readonly string[]).includes(transition.kind))
      .map(({ kind, from, to, key_from }) => ({ kind, from, to, key_from })),
    word_fixes: choices.word_fixes,
  };
}

export interface DecideInput {
  // The current version's choices, in the answer's own terms (`currentChoices`).
  current_choices: EngineInput;
  transcript: { id: string; text: string }[];
  sentences: SentenceChoice[];
  preset: ReturnType<typeof presetSummary>;
  // What the owner switched off for this reel, earlier (data: the answer keeps it off).
  behind_rules: { photos_forbidden: boolean; big_word_forbidden: boolean };
  // The written hook the reel opens with (decided by its own call this run):
  // words to show, shown as data; the components are chosen around it.
  hook: { text: string };
}

export function decideInput({
  current,
  transcript,
  preset,
  forbid = { photos: false, bigWord: false },
  hook,
}: {
  current: Edit;
  transcript: Transcript;
  preset: Preset;
  // The reel's stored behind forbids.
  forbid?: BehindForbid;
  // The hook the reel opens with.
  hook: { text: string };
}): DecideInput {
  return {
    current_choices: currentChoices(choicesOf(current, transcript, preset)),
    transcript: transcript.words.map(({ id, text }) => ({ id, text })),
    sentences: sentences(transcript, preset),
    preset: presetSummary(preset),
    behind_rules: { photos_forbidden: forbid.photos, big_word_forbidden: forbid.bigWord },
    hook: { text: hook.text },
  };
}
