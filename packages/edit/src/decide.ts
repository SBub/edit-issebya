import { z } from "zod";
import { type EngineInput, WISHES, placeDirect } from "./engine-input.ts";
import type { HeadTrack } from "./head-track.ts";
import { wordsText } from "./layout.ts";
import { type Preset, TRANSITION_TYPES, cleanWord } from "./preset.ts";
import { BEHIND_WORD, type Edit, issueReasons, parseEdit } from "./schema.ts";
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

// Item references a checklist entry may name: one of the answer's list items
// by index, the big word, or the behind rules.
const ITEM_REF = /^(?:(?:accents|photos|transitions|word_fixes)\[\d{1,2}\]|big_word|behind_rules)$/;
const MAX_ACCENTS = 12;
const MAX_TRANSITIONS = 12;
const MAX_FIXES = 60;
const MAX_ASKS = 10;

// The decide step's answer, meaning only ("B strict"): Claude names words by
// their transcript ids and photos by their library ids, never a time, a
// position, a size or a spot. It is the layout engine's input (`EngineInput`)
// plus the request checklist and the records. Built per reel: word ids from
// its transcript, photos from `photoIds` (the owner's ready library photos;
// none given: no photo can be named) and at most the preset's count, a
// `wish` only from the fixed list. `behind_rules` says what the answer does
// with the reel's forbids; without a request it can only `keep` them, and
// the checklist is empty and no item has a wish. The refinement (dropped from
// the JSON Schema) refuses a phrase ending before it starts, a wish without a
// request, a second title, a kind the rules
// forbid, a big word that is not one plain word, a word fixed twice and a
// checklist entry naming an item the answer does not have.
export function decideAnswerSchemaFor(
  preset: Preset,
  transcript: Transcript,
  photoIds: readonly string[] = [],
  rules: DecideRules = NO_RULES,
) {
  const rule = rules.requested ? z.enum(["keep", "forbid", "allow"]) : z.enum(["keep"]);
  const ids = transcript.words.map((word) => word.id);
  const order = new Map(ids.map((id, index) => [id, index]));
  const words = new Map(transcript.words.map((word) => [word.id, word]));
  const wordId = ids.length > 0 ? z.enum(ids as [string, ...string[]]) : z.never();
  const photoId = photoIds.length > 0 ? z.enum(photoIds as [string, ...string[]]) : z.never();
  const wish = z.enum(WISHES).optional();
  const phrase = { from: wordId, to: wordId };
  const { maxPhotos } = preset.behind;
  return z
    .strictObject({
      accents: z
        .array(z.strictObject({ ...phrase, title: z.boolean(), wish }))
        .max(MAX_ACCENTS, { message: `at most ${MAX_ACCENTS} accents` }),
      // The one big word behind the speaker, or null.
      big_word: z.strictObject({ word: wordId, wish }).nullable(),
      photos: z
        .array(z.strictObject({ photo_id: photoId, ...phrase, wish }))
        .max(maxPhotos, { message: `at most ${maxPhotos} photos per reel` }),
      transitions: z
        .array(z.strictObject({ kind: z.enum(TRANSITION_TYPES), ...phrase, wish }))
        .max(MAX_TRANSITIONS, { message: `at most ${MAX_TRANSITIONS} transitions` }),
      word_fixes: z
        .array(z.strictObject({ word: wordId, text: z.string().min(1).max(60) }))
        .max(MAX_FIXES),
      // What the owner asked for, each ask linked to the items fulfilling it.
      checklist: z
        .array(
          z.strictObject({
            ask: z.string().min(1).max(200),
            wants: z.string().min(1).max(200),
            fulfilled_by: z.array(z.string().regex(ITEM_REF)).max(10),
          }),
        )
        .max(rules.requested ? MAX_ASKS : 0, {
          message: rules.requested
            ? `at most ${MAX_ASKS} asks`
            : "the checklist stays empty without a request",
        }),
      behind_rules: z.strictObject({ photos: rule, big_word: rule }),
      // What the owner reads in the versions list: a short plain title and a
      // one or two sentence summary, both about what the viewer sees.
      change_title: z.string().min(1).max(60),
      change_summary: z.string().min(1).max(300),
      unexpressed: z.array(z.string().min(1).max(300)).max(20),
    })
    .superRefine((answer, ctx) => {
      const lists = {
        accents: answer.accents,
        photos: answer.photos,
        transitions: answer.transitions,
      };
      for (const [name, list] of Object.entries(lists)) {
        list.forEach((item, index) => {
          if (order.get(item.to)! < order.get(item.from)!) {
            ctx.addIssue({
              code: "custom",
              path: [name, index, "to"],
              message: `ends on ${item.to}, before it starts on ${item.from}`,
            });
          }
        });
      }
      // A wish forwards the owner's own placement words: none without a request.
      if (!rules.requested) {
        const wished: [string, { wish?: string }[]][] = [
          ...Object.entries(lists),
          ["big_word", answer.big_word ? [answer.big_word] : []],
        ];
        for (const [name, list] of wished) {
          list.forEach((item, index) => {
            if (item.wish === undefined) return;
            ctx.addIssue({
              code: "custom",
              path: name === "big_word" ? [name, "wish"] : [name, index, "wish"],
              message: "a wish only forwards the owner's request; there is none, leave it out",
            });
          });
        }
      }
      if (answer.accents.filter((accent) => accent.title).length > 1) {
        ctx.addIssue({
          code: "custom",
          path: ["accents"],
          message: "only one accent is the title",
        });
      }
      const forbid = applyBehindRules(rules.forbid, answer.behind_rules);
      if (forbid.photos && answer.photos.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["photos"],
          message: "photos are switched off for this reel by the owner; leave them out",
        });
      }
      if (answer.big_word) {
        if (forbid.bigWord) {
          ctx.addIssue({
            code: "custom",
            path: ["big_word"],
            message: "the big word is switched off for this reel by the owner; leave it out",
          });
        }
        const text = cleanWord(words.get(answer.big_word.word)?.text ?? "", preset);
        if (!BEHIND_WORD.test(text)) {
          ctx.addIssue({
            code: "custom",
            path: ["big_word", "word"],
            message: `${answer.big_word.word} (${JSON.stringify(text)}) is not one plain word of at most 24 letters`,
          });
        }
      }
      const fixed = new Set<string>();
      for (const fix of answer.word_fixes) {
        if (fixed.has(fix.word)) {
          ctx.addIssue({
            code: "custom",
            path: ["word_fixes"],
            message: `${fix.word} is fixed twice`,
          });
        }
        fixed.add(fix.word);
      }
      const sizes: Record<string, number> = {
        accents: answer.accents.length,
        photos: answer.photos.length,
        transitions: answer.transitions.length,
        word_fixes: answer.word_fixes.length,
      };
      answer.checklist.forEach((entry, index) => {
        for (const ref of entry.fulfilled_by) {
          const list = /^(\w+)\[(\d+)\]$/.exec(ref);
          const exists = list
            ? Number(list[2]) < (sizes[list[1]!] ?? 0)
            : ref === "behind_rules" || (ref === "big_word" && answer.big_word !== null);
          if (!exists) {
            ctx.addIssue({
              code: "custom",
              path: ["checklist", index, "fulfilled_by"],
              message: `${ref} is not in the answer`,
            });
          }
        }
      });
    });
}

export type DecideAnswer = z.infer<ReturnType<typeof decideAnswerSchemaFor>>;

// The answer's JSON Schema, for Claude Code's `--json-schema`: real `enum`
// lists, every object closed (`additionalProperties: false`), refs inlined.
// Draft-07, because the Claude Code CLI's validator rejects a schema whose
// `$schema` is draft 2020-12 ("no schema with key or ref"). Every keyword this
// schema uses (`enum`, `anyOf`, `pattern`, closed objects) is draft-07 too, so
// only the `$schema` line differs from the 2020-12 output.
// The worker doctor's `ai structured call` sends this schema to the real CLI.
export function decideJsonSchema(
  preset: Preset,
  transcript: Transcript,
  photoIds: readonly string[] = [],
  rules: DecideRules = NO_RULES,
): Record<string, unknown> {
  return z.toJSONSchema(decideAnswerSchemaFor(preset, transcript, photoIds, rules), {
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
  photoIds: readonly string[] = [],
  rules: DecideRules = NO_RULES,
): { ok: true; answer: DecideAnswer } | { ok: false; reasons: string[] } {
  const result = decideAnswerSchemaFor(preset, transcript, photoIds, rules).safeParse(json);
  if (result.success) return { ok: true, answer: result.data };
  return { ok: false, reasons: issueReasons(json, result.error.issues) };
}

// The answer placed over the current version (`placeDirect`, the stand-in for
// the layout engine) as a full edit, parsed with the decide limits and the
// refinement (ids used once, nothing ending before it starts, the behind
// counts and lengths). The current version's masks and photos are not carried
// over: the worker's cut-out step names them again for the new behind track.
export function editFromAnswer(
  current: Edit,
  answer: EngineInput,
  preset: Preset,
  transcript: Transcript,
  headTrack: HeadTrack,
): { ok: true; edit: Edit } | { ok: false; reasons: string[] } {
  const inputs = { ...current.inputs };
  delete inputs.masks;
  delete inputs.photos;
  const json = {
    format: 1,
    preset: preset.id,
    duration: current.duration,
    inputs,
    tracks: placeDirect(current, answer, transcript, headTrack, preset),
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
