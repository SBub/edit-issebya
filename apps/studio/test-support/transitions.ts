import { readFile } from "node:fs/promises";
import {
  type Edit,
  type EngineInput,
  type EngineNote,
  DEFAULT_FONT_PAIR_ID,
  FONT_PAIRS,
  FONT_ROLES,
  type FontRole,
  ISSEBYA_PRESET,
  type RevealWord,
  type Transcript,
  choicesOf,
  createMeasurer,
  editFromAnswer,
  headTrackSchema,
  wordReveal,
  questionText,
  resolveTimeline,
  wordsText,
} from "@edit-issebya/edit";
import * as hb from "harfbuzzjs";

// The fixture clip's head track (fixtures/pipeline/, no person in it).
const HEAD_TRACK = new URL(
  "../../../fixtures/pipeline/head_track/head-track.json",
  import.meta.url,
);

// The LIST the preview and export specs place on the fixture clip: one item,
// "clip for the" (w0006 to w0008), its lead-in "clip" in caption text and its
// key phrase "for the" (from w0007) in accent text. A list of one item shows
// no number.
const LIST_ITEM = {
  from: "w0006",
  to: "w0008",
  key_from: "w0007",
} as const;

async function measurer() {
  const pair = FONT_PAIRS[DEFAULT_FONT_PAIR_ID];
  const fonts = await Promise.all(
    FONT_ROLES.map(async (role) => {
      const url = new URL(`../../../packages/edit/${pair[role].file}`, import.meta.url);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- packages/edit's own font assets
      return [role, new Uint8Array(await readFile(url))] as const;
    }),
  );
  return createMeasurer(hb, pair, Object.fromEntries(fonts) as Record<FontRole, Uint8Array>);
}

// `base`'s choices changed by `change`, placed by the layout engine the way
// the worker's decide step places an answer.
async function placed(
  base: Edit,
  transcript: Transcript,
  change: (choices: EngineInput) => EngineInput,
) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
  const headTrack = headTrackSchema.parse(JSON.parse(await readFile(HEAD_TRACK, "utf8")));
  const made = editFromAnswer(
    base,
    change(choicesOf(base, transcript, ISSEBYA_PRESET)),
    ISSEBYA_PRESET,
    transcript,
    headTrack,
    await measurer(),
  );
  if (!made.ok) throw new Error(`the answer was refused: ${made.reasons.join("; ")}`);
  return made;
}

// `base`'s choices with the LIST, placed by the layout engine: the
// transition's layer and its two text levels, its phrase's captions shown only
// there. `accents` (word ranges) join the answer too, so the engine places
// them like any other accent.
export async function withNumberedTransition(
  base: Edit,
  transcript: Transcript,
  accents: { from: string; to: string }[] = [],
): Promise<Edit> {
  const made = await placed(base, transcript, (choices) => ({
    ...choices,
    accents: [...choices.accents, ...accents],
    lists: [{ items: [LIST_ITEM] }],
  }));
  if (made.edit.tracks.transitions.length !== 1) {
    throw new Error(
      `the LIST was not kept: ${JSON.stringify(made.record.filter((note) => note.item === "transition-1"))}`,
    );
  }
  return made.edit;
}

// The QUESTION the preview and export specs place on the fixture clip: "test
// clip for the real studio?" (w0005 to w0010), six words spoken from 0.881 s
// to 2.605 s, so it builds up over most of the reel.
const QUESTION = { from: "w0005", to: "w0010" } as const;

// `base`'s choices with the QUESTION as the only question, placed by the
// layout engine (`question-1`).
export async function withQuestion(base: Edit, transcript: Transcript): Promise<Edit> {
  return (await placedQuestion(base, transcript)).edit;
}

// The same, with the engine's record of it (the variant it placed the question
// with), to save with the version as the decide step does.
export async function placedQuestion(
  base: Edit,
  transcript: Transcript,
): Promise<{ edit: Edit; record: EngineNote[] }> {
  const made = await placed(base, transcript, (choices) => ({
    ...choices,
    questions: [QUESTION],
  }));
  if (!made.edit.tracks.overlays.some((item) => item.id === "question-1")) {
    throw new Error(
      `the QUESTION was not kept: ${JSON.stringify(made.record.filter((note) => note.item === "question-1"))}`,
    );
  }
  return { edit: made.edit, record: made.record };
}

// The ACCENT and the caption word fix the preview spec places on the fixture
// clip: "test clip for the real studio" (w0005 to w0010) as `accent-1`, and
// the caption of "is" (w0002) written as two words, "is so".
const ACCENT = { from: "w0005", to: "w0010" } as const;
const CAPTION_FIX = { word: "w0002", text: "is so" } as const;

// `base`'s choices with the ACCENT as the only accent and the caption fix,
// placed by the layout engine (`accent-1`).
export async function withAccent(base: Edit, transcript: Transcript): Promise<Edit> {
  const made = await placed(base, transcript, (choices) => ({
    ...choices,
    accents: [ACCENT],
    word_fixes: [...choices.word_fixes, CAPTION_FIX],
  }));
  if (!made.edit.tracks.overlays.some((item) => item.id === "accent-1")) {
    throw new Error(
      `the ACCENT was not kept: ${JSON.stringify(made.record.filter((note) => note.item === "accent-1"))}`,
    );
  }
  return made.edit;
}

// The shown words of a caption, an accent or a QUESTION with the moment each
// appears, and its time on screen: what the builder draws.
export function revealOf(
  edit: Edit,
  transcript: Transcript,
  id: string,
): { reveal: RevealWord[]; start: number; end: number } {
  const item =
    edit.tracks.overlays.find((overlay) => overlay.id === id) ??
    edit.tracks.captions.find((caption) => caption.id === id);
  if (!item?.words) throw new Error(`the version has no spoken text ${id}`);
  const span = resolveTimeline(edit, transcript).get(item.id)!;
  const byId = new Map(transcript.words.map((word) => [word.id, word]));
  const written = item.text ?? wordsText(item.words, transcript, ISSEBYA_PRESET);
  const reveal = wordReveal(
    id.startsWith("question-") ? questionText(written) : written,
    item.words.map((word) => byId.get(word)!),
    span,
  );
  return { reveal, start: span.start, end: span.end };
}

// The same for the placed QUESTION (`question-1`).
export function questionOf(
  edit: Edit,
  transcript: Transcript,
): { reveal: RevealWord[]; start: number; end: number } {
  return revealOf(edit, transcript, "question-1");
}
