import { readFile } from "node:fs/promises";
import {
  type Edit,
  type EngineInput,
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
  questionReveal,
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
  const made = await placed(base, transcript, (choices) => ({
    ...choices,
    questions: [QUESTION],
  }));
  if (!made.edit.tracks.overlays.some((item) => item.id === "question-1")) {
    throw new Error(
      `the QUESTION was not kept: ${JSON.stringify(made.record.filter((note) => note.item === "question-1"))}`,
    );
  }
  return made.edit;
}

// The shown words of the placed QUESTION (`question-1`) with the moment each
// appears, and its time on screen: what the builder draws.
export function questionOf(
  edit: Edit,
  transcript: Transcript,
): { reveal: RevealWord[]; start: number; end: number } {
  const overlay = edit.tracks.overlays.find((item) => item.id === "question-1");
  if (!overlay?.words) throw new Error("the version has no question");
  const span = resolveTimeline(edit, transcript).get(overlay.id)!;
  const byId = new Map(transcript.words.map((word) => [word.id, word]));
  const reveal = questionReveal(
    questionText(wordsText(overlay.words, transcript, ISSEBYA_PRESET)),
    overlay.words.map((id) => byId.get(id)!),
    span,
  );
  return { reveal, start: span.start, end: span.end };
}
