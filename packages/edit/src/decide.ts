import { z } from "zod";
import type { Preset } from "./preset.ts";
import { type Edit, HEX, custom, itemId } from "./schema.ts";
import type { Transcript } from "./transcript.ts";

// What the decide step's answer is checked against: one reel's words, its
// clip's length and one preset.
export interface DecideContext {
  transcript: Transcript;
  preset: Preset;
  // Seconds: the retimed clip's duration.
  clipDuration: number;
}

// The overlay with this id is the title; every other overlay is an accent.
export const TITLE_ID = "title";

function oneOf(values: string[], what: string) {
  const [first, ...rest] = values;
  if (first === undefined) throw new Error(`decide: no ${what} to choose from`);
  return z.enum([first, ...rest]);
}

// The answer's shape for one reel, mirroring the edit format (`schema.ts`)
// with this reel's word ids, times and the preset's choices as closed lists,
// so the schema Claude Code enforces already refuses a word, a font or a
// position the reel cannot have. `register` names the word-id list once.
function answerSchema(
  { transcript, preset, clipDuration }: DecideContext,
  register: (wordId: z.ZodType) => void = () => {},
) {
  const wordId = oneOf(
    transcript.words.map((word) => word.id),
    "words: the transcript is empty",
  );
  register(wordId);
  const wordAnchor = z.strictObject({
    word: wordId,
    edge: z.enum(["start", "end"]).optional(),
    offset: z.number().min(-0.5).max(0.5).optional(),
  });
  const timeAnchor = z.strictObject({ at: z.number().min(0).max(clipDuration) });
  const anchor = z.union([wordAnchor, timeAnchor]);
  const { safe } = preset;
  const style = z.strictObject({
    color: z
      .union([oneOf(Object.keys(preset.colors), "colours"), z.string().regex(HEX)])
      .optional(),
    size: z.number().positive().max(400).optional(),
    position: z
      .strictObject({
        x: z.number().min(safe.left).max(safe.right),
        y: z.number().min(safe.top).max(safe.bottom),
      })
      .optional(),
    font: oneOf(Object.keys(preset.fonts), "fonts").optional(),
  });
  const base = {
    id: itemId,
    start: anchor,
    end: anchor,
    style: style.optional(),
    // The free field: anything the format cannot say, as inline CSS.
    custom: custom.optional(),
  };
  const text = z.string().min(1).max(200);
  const span = z.strictObject(base);
  return z.strictObject({
    tracks: z.strictObject({
      footage: z.array(span).max(1),
      cutout: z.array(span).max(1),
      captions: z.array(z.strictObject({ ...base, text, words: z.array(wordId).optional() })),
      overlays: z.array(z.strictObject({ ...base, text })),
      transitions: z.array(
        z.strictObject({
          ...base,
          type: oneOf(preset.transitions, "transitions"),
          text: z.string().min(1).max(300).optional(),
        }),
      ),
      sounds: z.array(
        z.strictObject({
          ...base,
          sound: oneOf(Object.keys(preset.sounds), "sounds"),
          gainDb: z.number().min(-60).max(12).optional(),
        }),
      ),
    }),
    // One or two sentences: what changed and why.
    change_summary: z.string().min(1).max(300),
    // Each misheard word whose caption text was corrected.
    fixed_words: z.array(z.strictObject({ word: wordId, heard: z.string().min(1).max(200), text })),
    // What was asked for that the format could not express.
    unexpressed: z.array(z.string().min(1).max(300)),
    // Why each `custom` was needed.
    free_field: z.array(
      z.strictObject({ item: z.string().min(1).max(64), why: z.string().min(1).max(300) }),
    ),
  });
}

export type DecideAnswer = z.infer<ReturnType<typeof answerSchema>>;

// The Zod schema the worker checks the answer with, generated per reel.
export function decideAnswerSchema(context: DecideContext) {
  return answerSchema(context);
}

// The same schema as JSON Schema (draft 2020-12 keywords), for Claude Code's
// `--json-schema`: real `enum` lists and `minimum`/`maximum` bounds, the word
// ids once under `$defs.wordId`. No `$schema` key, so a validator of any
// draft reads it with its own default.
export function decideJsonSchema(context: DecideContext): Record<string, unknown> {
  const registry = z.registry<{ id: string }>();
  const schema = answerSchema(context, (wordId) => registry.add(wordId, { id: "wordId" }));
  const json: Record<string, unknown> = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    metadata: registry,
  });
  delete json.$schema;
  return json;
}

// The full edit: the answer's tracks with the parent version's inputs (the
// AI never changes fingerprints).
export function editFromAnswer(answer: DecideAnswer, inputs: Edit["inputs"]): Edit {
  return { format: 1, inputs, tracks: answer.tracks };
}

// What the step's log line counts.
export function answerCounts(answer: DecideAnswer): {
  accents: number;
  transitions: number;
  title: boolean;
  fixedWords: number;
} {
  const { overlays, transitions } = answer.tracks;
  return {
    accents: overlays.filter((overlay) => overlay.id !== TITLE_ID).length,
    transitions: transitions.length,
    title: overlays.some((overlay) => overlay.id === TITLE_ID),
    fixedWords: answer.fixed_words.length,
  };
}
