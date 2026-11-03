import { z } from "zod";
import { wordsText } from "./layout.ts";
import { type Preset, cleanWord } from "./preset.ts";
import {
  type Edit,
  type EditLimits,
  ITEM_ID,
  issueReasons,
  parseEdit,
  refineBehind,
  tracksSchemaFor,
} from "./schema.ts";
import { resolveAnchor } from "./timeline.ts";
import type { Transcript } from "./transcript.ts";

// What an answer does with the reel's behind rules: `keep` leaves the stored
// flag, `forbid` sets it, `allow` lifts it.
export type BehindRule = "keep" | "forbid" | "allow";

export interface BehindForbid {
  photos: boolean;
  bigWord: boolean;
}

// The reel's behind rules for one decide run: whether the owner made a request
// (only a request may set or lift a rule) and what is forbidden now.
export interface DecideRules {
  requested: boolean;
  forbid: BehindForbid;
}

export const NO_RULES: DecideRules = {
  requested: false,
  forbid: { photos: false, bigWord: false },
};

function applyRule(stored: boolean, rule: BehindRule): boolean {
  if (rule === "forbid") return true;
  if (rule === "allow") return false;
  return stored;
}

// The forbids in force after an answer: the stored flags with its rules applied.
export function applyBehindRules(
  stored: BehindForbid,
  answer: { photos: BehindRule; big_word: BehindRule },
): BehindForbid {
  return {
    photos: applyRule(stored.photos, answer.photos),
    bigWord: applyRule(stored.bigWord, answer.big_word),
  };
}

// The decide step's answer: the tracks of the new version (format, preset,
// duration and inputs come from the current version, so the AI cannot touch
// the input fingerprints) and three short records. Built per reel: word ids
// from its transcript, `{ time }` anchors capped at its duration, positions
// inside the preset's safe box, fonts and transition types from the preset.
// By convention the title is the overlay with id `title`, anchored at
// `{ reel: "start" }`.
// The behind track's photos are limited to `photoIds`, the owner's ready
// library photos (none given: no photo can be named), and to the preset's
// counts. `behind_rules` says what the answer does with the reel's forbids;
// without a request it can only `keep` them. The refinement (dropped from the
// JSON Schema) adds the behind track's counts and lengths, refuses a kind the
// rules forbid and, without a request, a big word not spoken while it shows.
export function decideAnswerSchemaFor(
  preset: Preset,
  transcript: Transcript,
  duration: number,
  photoIds: readonly string[] = [],
  rules: DecideRules = NO_RULES,
) {
  const rule = rules.requested ? z.enum(["keep", "forbid", "allow"]) : z.enum(["keep"]);
  const words = new Map(transcript.words.map((word) => [word.id, word]));
  const said = (text: string) => cleanWord(text, preset).toLowerCase();
  const limits: EditLimits = {
    duration,
    bounds: preset.safe,
    photoIds,
    behindCounts: { photos: preset.behind.maxPhotos, words: preset.behind.maxWords },
  };
  return z
    .object({
      // No whole-clip cut-out track: masks are made only for behind items.
      tracks: tracksSchemaFor(preset, transcript, limits).omit({
        cutout: true,
      }),
      change_summary: z.string().min(1).max(300),
      unexpressed: z.array(z.string().min(1).max(300)).max(20),
      free_field: z
        .array(z.object({ item: z.string().regex(ITEM_ID), reason: z.string().min(1).max(300) }))
        .max(20),
      behind_rules: z.object({ photos: rule, big_word: rule }),
    })
    .superRefine((answer, ctx) => {
      refineBehind({ duration, tracks: answer.tracks }, transcript, preset, limits, ctx);
      const forbid = applyBehindRules(rules.forbid, answer.behind_rules);
      for (const item of answer.tracks.behind ?? []) {
        if (item.kind === "photo" && forbid.photos) {
          ctx.addIssue({
            code: "custom",
            message: `behind ${item.id}: photos are switched off for this reel by the owner; leave them out`,
          });
        }
        if (item.kind !== "word") continue;
        if (forbid.bigWord) {
          ctx.addIssue({
            code: "custom",
            message: `behind ${item.id}: the big word is switched off for this reel by the owner; leave it out`,
          });
          continue;
        }
        if (rules.requested) continue;
        const start = resolveAnchor(item.start, words, duration);
        const end = resolveAnchor(item.end, words, duration);
        const spoken = transcript.words.some(
          (word) => word.start < end && word.end > start && said(word.text) === said(item.text),
        );
        if (!spoken) {
          ctx.addIssue({
            code: "custom",
            message: `behind ${item.id}: the big word must be one of the words spoken while it shows`,
          });
        }
      }
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
  photoIds: readonly string[] = [],
  rules: DecideRules = NO_RULES,
): Record<string, unknown> {
  return z.toJSONSchema(decideAnswerSchemaFor(preset, transcript, duration, photoIds, rules), {
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
  photoIds: readonly string[] = [],
  rules: DecideRules = NO_RULES,
): { ok: true; answer: DecideAnswer } | { ok: false; reasons: string[] } {
  const result = decideAnswerSchemaFor(preset, transcript, duration, photoIds, rules).safeParse(
    json,
  );
  if (result.success) return { ok: true, answer: result.data };
  return { ok: false, reasons: issueReasons(json, result.error.issues) };
}

// The answer's tracks over the current version: a full edit, parsed with the
// decide limits and the refinement (ids used once, nothing ending before it
// starts, overlays with words or text, the behind counts).
export function editFromAnswer(
  current: Edit,
  answer: Pick<DecideAnswer, "tracks">,
  preset: Preset,
  transcript: Transcript,
): { ok: true; edit: Edit } | { ok: false; reasons: string[] } {
  // Only the answer's own tracks: a cut-out track it carries anyway is dropped.
  const { footage, captions, overlays, transitions, sounds, behind } = answer.tracks;
  const tracks = {
    footage,
    captions,
    overlays,
    transitions,
    sounds,
    ...(behind && behind.length > 0 ? { behind } : {}),
  };
  // The current version's masks and photos are not carried over: the worker's
  // cut-out step names them again for the new behind track.
  const inputs = { ...current.inputs };
  delete inputs.masks;
  delete inputs.photos;
  const json = {
    format: 1,
    preset: preset.id,
    duration: current.duration,
    inputs,
    tracks,
  };
  return parseEdit(json, preset, transcript, {
    duration: current.duration,
    bounds: preset.safe,
    behindCounts: { photos: preset.behind.maxPhotos, words: preset.behind.maxWords },
  });
}

export interface DecideCounts {
  accents: number;
  transitions: number;
  title: boolean;
  wordsFixed: number;
  behindPhotos: number;
  behindWords: number;
}

// What the step line names: accent overlays (the title apart), transitions,
// whether there is a title, and captions whose text differs from their words.
export function decideCounts(edit: Edit, transcript: Transcript, preset: Preset): DecideCounts {
  const { overlays, transitions, captions } = edit.tracks;
  const behind = edit.tracks.behind ?? [];
  return {
    behindPhotos: behind.filter((item) => item.kind === "photo").length,
    behindWords: behind.filter((item) => item.kind === "word").length,
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
    ...(tracks.behind ?? []),
  ].some((item) => item.style !== undefined && Object.keys(item.style).length > 0);
}
