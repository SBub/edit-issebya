import { z } from "zod";
import type { Backgrounds } from "./background.ts";
import {
  type EngineNote,
  type FreeSentence,
  type PhotoLook,
  type UnplacedItem,
  placeEdit,
} from "./engine.ts";
import { type EngineInput, WISHES } from "./engine-input.ts";
import type { HeadTrack } from "./head-track.ts";
import { wordsText } from "./layout.ts";
import type { Measurer } from "./measure.ts";
import { type Preset, TRANSITION_KINDS, cleanWord } from "./preset.ts";
import { BEHIND_WORD, type Edit, PHOTO_REASONS, issueReasons, parseEdit } from "./schema.ts";
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
// by index, the behind rules, or the hook (its new text, or none when the
// owner asked it out).
const ITEM_REF =
  /^(?:(?:accents|big_words|photos|transitions|word_fixes)\[\d{1,2}\]|behind_rules|hook)$/;
// Bounds on the answer's size only, never a per-reel limit the editor works
// to: how many of each it takes is the editor's choice.
const MAX_ACCENTS = 12;
const MAX_BIG_WORDS = 12;
const MAX_PHOTOS = 12;
const MAX_TRANSITIONS = 12;
const MAX_FIXES = 60;
const MAX_ASKS = 10;
// The hook's text: no line break and nothing that could leave its tag (a
// plain pattern, so a provider's JSON Schema validator reads it as is).
const HOOK_TEXT = /^[^\n\r<>]+$/;

// The hook as placed and saved: its final full stops and ellipses (".",
// "...", "…", with any spaces after them) taken off, since a hook reads like
// a post and never ends with a dot; "?" and "!" stay, and so does a dot
// inside. Applied to every hook the answer writes, the owner's exact words too.
export function stripHookStop(text: string): string {
  return text.replace(/[\s.\u2026]+$/u, "");
}

// The decide step's answer, meaning only ("B strict"): Claude names words by
// their transcript ids and photos by their library ids, never a time, a
// position, a size or a spot. It is the layout engine's input (`EngineInput`)
// plus the request checklist and the records. Built per reel: word ids from
// its transcript, photos from `photoIds` (the owner's ready library photos;
// none given: no photo can be named, each with its reason, `match` or `mood`),
// any number of photos and big words, a
// `wish` only from the fixed list. `behind_rules` says what the answer does
// with the reel's forbids; without a request it can only `keep` them, and
// the checklist is empty and no item has a wish. The refinement (dropped from
// the JSON Schema) refuses a phrase ending before it starts, a transition's
// key phrase starting outside its phrase, a wish without a request, a second title, a kind the rules
// forbid, a big word that is not one plain word, a word fixed twice and a
// checklist entry naming an item the answer does not have. `hook` is the
// written line for the first seconds (or null): the one text Claude writes
// itself, bounded by the preset's words and characters, checked against the
// glossary like any text once placed.
export function decideAnswerSchemaFor(
  preset: Preset,
  transcript: Transcript,
  photoIds: readonly string[] = [],
  rules: DecideRules = NO_RULES,
) {
  const { maxWords, maxCharacters } = preset.pace.hook;
  // The hook's text: one line of plain words (no line break, no tag), at
  // most the preset's characters and words.
  const hookText = z
    .string()
    .min(1)
    .max(maxCharacters, { message: `a hook has at most ${maxCharacters} characters` })
    .regex(HOOK_TEXT, { message: "a hook is one line of plain text" })
    .refine((text) => /[\p{L}\p{N}]/u.test(stripHookStop(text)), {
      message: "a hook needs words",
    })
    .refine((text) => text.trim().split(/\s+/).length <= maxWords, {
      message: `a hook has at most ${maxWords} words`,
    });
  const rule = rules.requested ? z.enum(["keep", "forbid", "allow"]) : z.enum(["keep"]);
  const ids = transcript.words.map((word) => word.id);
  const order = new Map(ids.map((id, index) => [id, index]));
  const words = new Map(transcript.words.map((word) => [word.id, word]));
  const wordId = ids.length > 0 ? z.enum(ids as [string, ...string[]]) : z.never();
  const photoId = photoIds.length > 0 ? z.enum(photoIds as [string, ...string[]]) : z.never();
  const wish = z.enum(WISHES).optional();
  const phrase = { from: wordId, to: wordId };
  return z
    .strictObject({
      accents: z
        .array(z.strictObject({ ...phrase, title: z.boolean(), wish }))
        .max(MAX_ACCENTS, { message: `at most ${MAX_ACCENTS} accents` }),
      // Big words behind the speaker, each on its spoken word; the same
      // word may come back.
      big_words: z
        .array(z.strictObject({ word: wordId, wish }))
        .max(MAX_BIG_WORDS, { message: `at most ${MAX_BIG_WORDS} big words` }),
      // Each photo says why it is there: `match` (it shows what its
      // sentence says) or `mood` (it fits the reel's feel without showing it).
      photos: z
        .array(
          z.strictObject({ photo_id: photoId, ...phrase, reason: z.enum(PHOTO_REASONS), wish }),
        )
        .max(MAX_PHOTOS, { message: `at most ${MAX_PHOTOS} photos` }),
      transitions: z
        .array(
          z.strictObject({ kind: z.enum(TRANSITION_KINDS), ...phrase, key_from: wordId, wish }),
        )
        .max(MAX_TRANSITIONS, { message: `at most ${MAX_TRANSITIONS} transitions` }),
      word_fixes: z
        .array(z.strictObject({ word: wordId, text: z.string().min(1).max(60) }))
        .max(MAX_FIXES),
      // The written hook for the first seconds (never spoken), or none.
      hook: z.strictObject({ text: hookText }).nullable(),
      // What the owner asked for, each ask linked to the items fulfilling it.
      checklist: z
        .array(
          z.strictObject({
            ask: z.string().min(1).max(200),
            wants: z.string().min(1).max(200),
            fulfilled_by: z.array(z.string().regex(ITEM_REF)).max(10),
            // Plain words for the owner when nothing in the answer can do
            // the ask: why, and what they can do.
            why_not: z.string().min(1).max(300).optional(),
          }),
        )
        .max(rules.requested ? MAX_ASKS : 0, {
          message: rules.requested
            ? `at most ${MAX_ASKS} asks`
            : "the checklist stays empty without a request",
        }),
      behind_rules: z.strictObject({ photos: rule, big_word: rule }),
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
      answer.transitions.forEach((item, index) => {
        const key = order.get(item.key_from)!;
        if (key < order.get(item.from)! || key > order.get(item.to)!) {
          ctx.addIssue({
            code: "custom",
            path: ["transitions", index, "key_from"],
            message: `key phrase starts on ${item.key_from}, outside ${item.from} to ${item.to}`,
          });
        }
      });
      // A wish forwards the owner's own placement words: none without a request.
      if (!rules.requested) {
        const wished: [string, { wish?: string }[]][] = [
          ...Object.entries(lists),
          ["big_words", answer.big_words],
        ];
        for (const [name, list] of wished) {
          list.forEach((item, index) => {
            if (item.wish === undefined) return;
            ctx.addIssue({
              code: "custom",
              path: [name, index, "wish"],
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
      if (forbid.bigWord && answer.big_words.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["big_words"],
          message: "big words are switched off for this reel by the owner; leave them out",
        });
      }
      answer.big_words.forEach((big, index) => {
        const text = cleanWord(words.get(big.word)?.text ?? "", preset);
        if (!BEHIND_WORD.test(text)) {
          ctx.addIssue({
            code: "custom",
            path: ["big_words", index, "word"],
            message: `${big.word} (${JSON.stringify(text)}) is not one plain word of at most 24 letters`,
          });
        }
      });
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
        big_words: answer.big_words.length,
        photos: answer.photos.length,
        transitions: answer.transitions.length,
        word_fixes: answer.word_fixes.length,
      };
      answer.checklist.forEach((entry, index) => {
        for (const ref of entry.fulfilled_by) {
          const list = /^(\w+)\[(\d+)\]$/.exec(ref);
          // `hook` links the hook whether the answer writes one or takes it out.
          const exists = list
            ? Number(list[2]) < (sizes[list[1]!] ?? 0)
            : ref === "behind_rules" || ref === "hook";
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

// The answer's JSON Schema, the structured output the worker's AI runner asks
// for: real `enum` lists, every object closed (`additionalProperties: false`),
// refs inlined. Draft-07 (kept from the Claude Code CLI, whose validator
// rejected draft 2020-12; the runner leaves the `$schema` line and the length
// bounds out of what it sends, and Zod checks them). The worker doctor's
// `ai structured call` sends this schema in one real call.
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
  if (!result.success) return { ok: false, reasons: issueReasons(json, result.error.issues) };
  const { hook } = result.data;
  return {
    ok: true,
    answer: { ...result.data, hook: hook ? { text: stripHookStop(hook.text) } : null },
  };
}

// The answer placed over the current version by the layout engine
// (`placeEdit`) as a full edit, parsed with the decide limits and the
// refinement (ids used once, nothing ending before it starts, the behind
// lengths), with the engine's record of what it moved, shrank, wrapped,
// retimed or dropped. The items the answer's checklist names are
// placed first, and the engine makes room for them. Also returned: the
// answer's extras left out and the sentences with room for their kind (the
// editorial round's input). The current version's masks and photos are not carried over:
// the worker's cut-out step names them again for the new behind track. A
// parse failure here is an engine bug, never the answer's.
export function editFromAnswer(
  current: Edit,
  answer: EngineInput & { checklist?: readonly { fulfilled_by: readonly string[] }[] },
  preset: Preset,
  transcript: Transcript,
  headTrack: HeadTrack,
  measurer: Measurer,
  // The footage's background map, sampled: the engine keeps every text
  // readable over it. Without it nothing is measured.
  backgrounds?: Backgrounds,
  // The library photos' ratios and edge luminances, by id (`PlaceOptions.photos`).
  photos?: ReadonlyMap<string, PhotoLook>,
):
  | { ok: true; edit: Edit; record: EngineNote[]; unplaced: UnplacedItem[]; free: FreeSentence[] }
  | { ok: false; reasons: string[] } {
  const inputs = { ...current.inputs };
  delete inputs.masks;
  delete inputs.photos;
  const requested = [...new Set((answer.checklist ?? []).flatMap((entry) => entry.fulfilled_by))];
  const { tracks, record, unplaced, free } = placeEdit(
    current,
    answer,
    transcript,
    headTrack,
    preset,
    measurer,
    {
      requested,
      ...(backgrounds ? { backgrounds } : {}),
      ...(photos ? { photos } : {}),
    },
  );
  const json = {
    format: 1,
    preset: preset.id,
    duration: current.duration,
    inputs,
    tracks,
  };
  const parsed = parseEdit(json, preset, transcript, {
    duration: current.duration,
    bounds: preset.safe,
    behindLengths: true,
  });
  return parsed.ok ? { ok: true, edit: parsed.edit, record, unplaced, free } : parsed;
}

export interface DecideCounts {
  accents: number;
  transitions: number;
  title: boolean;
  hook: boolean;
  wordsFixed: number;
  behindPhotos: number;
  behindWords: number;
}

// What the step line names: accent overlays (the title apart), transitions,
// whether there is a title and a hook, and captions whose text differs from their words.
export function decideCounts(edit: Edit, transcript: Transcript, preset: Preset): DecideCounts {
  const { overlays, transitions, captions } = edit.tracks;
  const behind = edit.tracks.behind ?? [];
  return {
    behindPhotos: behind.filter((item) => item.kind === "photo").length,
    behindWords: behind.filter((item) => item.kind === "word").length,
    accents: overlays.filter((item) => item.kind === "accent" && item.id !== "title").length,
    transitions: transitions.length,
    title: overlays.some((item) => item.id === "title"),
    hook: overlays.some((item) => item.kind === "hook"),
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
