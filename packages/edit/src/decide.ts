import { z } from "zod";
import { wordsText } from "./layout.ts";
import type { Preset } from "./preset.ts";
import { type Edit, ITEM_ID, issueReasons, parseEdit, tracksSchemaFor } from "./schema.ts";
import type { Transcript } from "./transcript.ts";

// The decide step's answer: the tracks of the new version (format, preset,
// duration and inputs come from the current version, so the AI cannot touch
// the input fingerprints) and three short records. Built per reel: word ids
// from its transcript, `{ time }` anchors capped at its duration, positions
// inside the preset's safe box, fonts and transition types from the preset.
// By convention the title is the overlay with id `title`, anchored at
// `{ reel: "start" }`.
export function decideAnswerSchemaFor(preset: Preset, transcript: Transcript, duration: number) {
  return z.object({
    // No cut-out track: the pipeline makes no cut-out until #20 brings it back.
    tracks: tracksSchemaFor(preset, transcript, { duration, bounds: preset.safe }).omit({
      cutout: true,
    }),
    change_summary: z.string().min(1).max(300),
    unexpressed: z.array(z.string().min(1).max(300)).max(20),
    free_field: z
      .array(z.object({ item: z.string().regex(ITEM_ID), reason: z.string().min(1).max(300) }))
      .max(20),
  });
}

export type DecideAnswer = z.infer<ReturnType<typeof decideAnswerSchemaFor>>;

// The answer's JSON Schema, for Claude Code's `--json-schema`: real `enum`
// lists, every object closed (`additionalProperties: false`), refs inlined.
// Draft-07, because the Claude Code CLI's validator rejects a schema whose
// `$schema` is draft 2020-12 ("no schema with key or ref"). Every keyword this
// schema uses (`enum`, `const`, `anyOf`, `propertyNames`, closed objects) is
// draft-07 too, so only the `$schema` line differs from the 2020-12 output.
// The worker doctor's `ai structured call` sends this schema to the real CLI.
export function decideJsonSchema(
  preset: Preset,
  transcript: Transcript,
  duration: number,
): Record<string, unknown> {
  return z.toJSONSchema(decideAnswerSchemaFor(preset, transcript, duration), {
    target: "draft-07",
    io: "output",
    reused: "inline",
  }) as Record<string, unknown>;
}

// The answer checked again by Zod, with readable reasons.
export function parseDecideAnswer(
  json: unknown,
  preset: Preset,
  transcript: Transcript,
  duration: number,
): { ok: true; answer: DecideAnswer } | { ok: false; reasons: string[] } {
  const result = decideAnswerSchemaFor(preset, transcript, duration).safeParse(json);
  if (result.success) return { ok: true, answer: result.data };
  return { ok: false, reasons: issueReasons(json, result.error.issues) };
}

// The answer's tracks over the current version: a full edit, parsed with the
// decide limits and the refinement (ids used once, nothing ending before it
// starts, overlays with words or text).
export function editFromAnswer(
  current: Edit,
  answer: Pick<DecideAnswer, "tracks">,
  preset: Preset,
  transcript: Transcript,
): { ok: true; edit: Edit } | { ok: false; reasons: string[] } {
  // Only the answer's own tracks: a cut-out track it carries anyway is dropped.
  const { footage, captions, overlays, transitions, sounds } = answer.tracks;
  const tracks = { footage, captions, overlays, transitions, sounds };
  const json = {
    format: 1,
    preset: preset.id,
    duration: current.duration,
    inputs: current.inputs,
    tracks,
  };
  return parseEdit(json, preset, transcript, { duration: current.duration, bounds: preset.safe });
}

export interface DecideCounts {
  accents: number;
  transitions: number;
  title: boolean;
  wordsFixed: number;
}

// What the step line names: accent overlays (the title apart), transitions,
// whether there is a title, and captions whose text differs from their words.
export function decideCounts(edit: Edit, transcript: Transcript, preset: Preset): DecideCounts {
  const { overlays, transitions, captions } = edit.tracks;
  return {
    accents: overlays.filter((item) => item.id !== "title").length,
    transitions: transitions.length,
    title: overlays.some((item) => item.id === "title"),
    wordsFixed: captions.filter(
      (item) => item.text !== undefined && item.text !== wordsText(item.words, transcript, preset),
    ).length,
  };
}

// Whether any item, on any track, sets the free custom-style field.
export function usedFreeField(edit: Edit): boolean {
  const { tracks } = edit;
  return [
    ...tracks.footage,
    ...(tracks.cutout ?? []),
    ...tracks.captions,
    ...tracks.overlays,
    ...tracks.transitions,
    ...tracks.sounds,
  ].some((item) => item.style !== undefined && Object.keys(item.style).length > 0);
}
