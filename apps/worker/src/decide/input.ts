import {
  type BehindForbid,
  type Edit,
  type EngineInput,
  type Preset,
  TRANSITION_KINDS,
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

// What of the preset the AI decides with: the transition library (each kind
// with the line saying what it is for) and how often a transition comes, the
// glossary and the behind counts. No frame, box, font size, colour or spot:
// the layout owns every position, size and time.
export function presetSummary(preset: Preset) {
  return {
    transitions: TRANSITION_KINDS.map((kind) => ({
      kind,
      description: preset.transitions[kind].description ?? "",
    })),
    transition_every_seconds: preset.transition.perSeconds,
    glossary: preset.glossary,
    behind: { max_photos: preset.behind.maxPhotos, max_words: preset.behind.maxWords },
  };
}

// A ready library photo as the AI sees it: its id and what describe_photo
// wrote about it. Data, never instructions.
export interface LibraryEntry {
  id: string;
  description: string;
  tags: string[];
}

export interface DecideInput {
  // The current version's choices, in the answer's own terms.
  current_choices: EngineInput;
  transcript: { id: string; text: string }[];
  sentences: SentenceChoice[];
  preset: ReturnType<typeof presetSummary>;
  library: LibraryEntry[];
  // What the owner switched off for this reel.
  behind_rules: { photos_forbidden: boolean; big_word_forbidden: boolean };
  request: string | null;
}

export function decideInput({
  current,
  transcript,
  preset,
  library = [],
  forbid = { photos: false, bigWord: false },
  request,
}: {
  current: Edit;
  transcript: Transcript;
  preset: Preset;
  library?: readonly LibraryEntry[];
  // The reel's stored behind forbids.
  forbid?: BehindForbid;
  request: string | null;
}): DecideInput {
  // Photos switched off and no request to lift it: no photo to offer.
  const offered = forbid.photos && request === null ? [] : library;
  return {
    current_choices: choicesOf(current, transcript, preset),
    transcript: transcript.words.map(({ id, text }) => ({ id, text })),
    sentences: sentences(transcript, preset),
    preset: presetSummary(preset),
    library: offered.map(({ id, description, tags }) => ({ id, description, tags: [...tags] })),
    behind_rules: { photos_forbidden: forbid.photos, big_word_forbidden: forbid.bigWord },
    request,
  };
}
