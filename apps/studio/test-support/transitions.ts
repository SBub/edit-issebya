import { readFile } from "node:fs/promises";
import {
  type Edit,
  DEFAULT_FONT_PAIR_ID,
  FONT_PAIRS,
  FONT_ROLES,
  type FontRole,
  ISSEBYA_PRESET,
  type Transcript,
  choicesOf,
  createMeasurer,
  editFromAnswer,
  headTrackSchema,
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
      const url = new URL(`../../../packages/edit/file`, import.meta.url);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- packages/edit's own font assets
      return [role, new Uint8Array(await readFile(url))] as const;
    }),
  );
  return createMeasurer(hb, pair, Object.fromEntries(fonts) as Record<FontRole, Uint8Array>);
}

// `base`'s choices with the LIST, placed by the layout engine the way the
// worker's decide step places an answer: the transition's layer and its two
// text levels, its phrase's captions shown only there.
export async function withNumberedTransition(base: Edit, transcript: Transcript): Promise<Edit> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
  const headTrack = headTrackSchema.parse(JSON.parse(await readFile(HEAD_TRACK, "utf8")));
  const made = editFromAnswer(
    base,
    { ...choicesOf(base, transcript, ISSEBYA_PRESET), lists: [{ items: [LIST_ITEM] }] },
    ISSEBYA_PRESET,
    transcript,
    headTrack,
    await measurer(),
  );
  if (!made.ok) throw new Error(`the LIST was refused: ${made.reasons.join("; ")}`);
  if (made.edit.tracks.transitions.length !== 1) {
    throw new Error(
      `the LIST was not kept: ${JSON.stringify(made.record.filter((note) => note.item === "transition-1"))}`,
    );
  }
  return made.edit;
}
