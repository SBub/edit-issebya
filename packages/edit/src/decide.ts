import { z } from "zod";
import type { Backgrounds } from "./background.ts";
import { type EngineNote, type FreeSentence, type UnplacedItem, placeEdit } from "./engine.ts";
import type { EngineInput } from "./engine-input.ts";
import type { HeadTrack } from "./head-track.ts";
import { wordsText } from "./layout.ts";
import type { Measurer } from "./measure.ts";
import { type Preset, cleanWord } from "./preset.ts";
import { BEHIND_WORD, type Edit, issueReasons, parseEdit } from "./schema.ts";
import type { Transcript } from "./transcript.ts";

// The reel's stored behind forbids: photos or big words switched off by an
// earlier owner request (`reels.no_photos`, `reels.no_big_word`). A new answer
// never sets or lifts one; it only has to respect them.
export interface BehindForbid {
  photos: boolean;
  bigWord: boolean;
}

// The forbids in force for one decide run.
export interface DecideRules {
  forbid: BehindForbid;
}

export const NO_RULES: DecideRules = {
  forbid: { photos: false, bigWord: false },
};

// The transition kinds a new answer may pick: a list only (`numbered`, the
// LIST component). Older versions keep the kinds they were saved with.
export const NEW_TRANSITION_KINDS = ["numbered"] as const;

// No count cap on any list here: how many of each the editor picks is its
// choice. A limit is added only when a real case shows the need, derived from
// that case.
// The hook's text: no line break and nothing that could leave its tag (a
// plain pattern, so a provider's JSON Schema validator reads it as is). The
// same plain-line rule for a visual's description.
const HOOK_TEXT = /^[^\n\r<>]+$/;
// A visual's description: a short plain phrase, at most this many words.
const VISUAL_WORDS = 8;

// The hook as placed and saved: its final full stops and ellipses (".",
// "...", "…", with any spaces after them) taken off, since a hook reads like
// a post and never ends with a dot; "?" and "!" stay, and so does a dot
// inside. Applied to every hook the answer writes, the owner's exact words too.
export function stripHookStop(text: string): string {
  return text.replace(/[\s.…]+$/u, "");
}

// The written hook's text, the same rules for the hook call's answer and for
// the components' answer's hook: one line of plain words (no line break, no
// tag), at most the preset's characters and words, with at least one letter
// or digit once the final stop is taken off.
function hookTextSchemaFor(preset: Preset) {
  const { maxWords, maxCharacters } = preset.pace.hook;
  return z
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
}

// The hook call's answer (HOOK, its own call): `{ "text": "..." }` and
// nothing else, the text checked by `hookTextSchemaFor`.
export function hookAnswerSchemaFor(preset: Preset) {
  return z.strictObject({ text: hookTextSchemaFor(preset) });
}

// The hook answer's JSON Schema, the structured output of the hook call (the
// same draft-07 form as `decideJsonSchema`).
export function hookJsonSchema(preset: Preset): Record<string, unknown> {
  return z.toJSONSchema(hookAnswerSchemaFor(preset), {
    target: "draft-07",
    io: "output",
    reused: "inline",
  }) as Record<string, unknown>;
}

// The hook answer checked again by Zod, with readable reasons; the text is
// returned as it is placed (`stripHookStop`), never refused for a final dot.
export function parseHookAnswer(
  json: unknown,
  preset: Preset,
): { ok: true; text: string } | { ok: false; reasons: string[] } {
  const result = hookAnswerSchemaFor(preset).safeParse(json);
  if (!result.success) return { ok: false, reasons: issueReasons(json, result.error.issues) };
  return { ok: true, text: stripHookStop(result.data.text) };
}

// A visual's description: what the frame would show, in a few plain words. It
// is never shown on screen; the schema, not the layout, checks its length.
function visualDescriptionSchema() {
  return z
    .string()
    .min(1)
    .max(80, { message: "a visual description has at most 80 characters" })
    .regex(HOOK_TEXT, { message: "a visual description is one line of plain text" })
    .refine((text) => /[\p{L}\p{N}]/u.test(text), { message: "a visual description needs words" })
    .refine((text) => text.trim().split(/\s+/).length <= VISUAL_WORDS, {
      message: `a visual description has at most ${VISUAL_WORDS} words`,
    });
}

// The decide step's answer, meaning only ("B strict"): Claude names words by
// their transcript ids, never a time, a position, a size or a spot. It is the
// layout engine's input (`EngineInput`) for the components: `accents`
// (ACCENT), `big_words` (BIGWORD), `visuals` (VISUAL: over its words, with a
// short description of what it would show), `transitions` (LIST, kind
// `numbered` only) and `word_fixes`. The written hook is not in it: its own
// call answers it (`hookAnswerSchemaFor`), and the decide step puts the text
// beside these components when it places them. Built per reel from its
// transcript. The refinement (dropped from the JSON Schema) refuses a phrase
// ending before it starts, a transition's key phrase starting outside its
// phrase, a big word that is not one or two plain words in a row, a word fixed
// twice, and a kind or item the reel's stored forbids rule out.
export function decideAnswerSchemaFor(
  preset: Preset,
  transcript: Transcript,
  rules: DecideRules = NO_RULES,
) {
  const ids = transcript.words.map((word) => word.id);
  const order = new Map(ids.map((id, index) => [id, index]));
  const words = new Map(transcript.words.map((word) => [word.id, word]));
  const wordId = ids.length > 0 ? z.enum(ids as [string, ...string[]]) : z.never();
  const phrase = { from: wordId, to: wordId };
  return z
    .strictObject({
      // ACCENT: a phrase worth stressing.
      accents: z.array(z.strictObject(phrase)),
      // BIGWORD: one or two consecutive plain words shown large behind the
      // speaker, from the first spoken word to the last (equal for one word);
      // the same word may come back.
      big_words: z.array(z.strictObject(phrase)),
      // VISUAL: an empty frame over its words, with what it would show.
      visuals: z.array(z.strictObject({ ...phrase, description: visualDescriptionSchema() })),
      // LIST: the numbered transitions only, each over its phrase.
      transitions: z.array(
        z.strictObject({
          kind: z.enum(NEW_TRANSITION_KINDS),
          ...phrase,
          key_from: wordId,
        }),
      ),
      word_fixes: z.array(z.strictObject({ word: wordId, text: z.string().min(1).max(60) })),
    })
    .superRefine((answer, ctx) => {
      const lists = {
        accents: answer.accents,
        visuals: answer.visuals,
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
      const forbid = rules.forbid;
      // A visual takes a photo's place, so the owner's switch-off covers it.
      if (forbid.photos && answer.visuals.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["visuals"],
          message: "photos and visuals are switched off for this reel by the owner; leave them out",
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
        const from = order.get(big.from)!;
        const to = order.get(big.to)!;
        if (to < from) {
          ctx.addIssue({
            code: "custom",
            path: ["big_words", index, "to"],
            message: `ends on ${big.to}, before it starts on ${big.from}`,
          });
          return;
        }
        if (to - from > 1) {
          ctx.addIssue({
            code: "custom",
            path: ["big_words", index, "to"],
            message: `${big.from} to ${big.to} spans ${to - from + 1} words; a big word is one or two consecutive words`,
          });
          return;
        }
        // Each word is checked on its own: one plain word of at most 24 letters.
        ids.slice(from, to + 1).forEach((id) => {
          const text = cleanWord(words.get(id)?.text ?? "", preset);
          if (!BEHIND_WORD.test(text)) {
            ctx.addIssue({
              code: "custom",
              path: ["big_words", index, "to"],
              message: `${id} (${JSON.stringify(text)}) is not one plain word of at most 24 letters`,
            });
          }
        });
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
    });
}

// The components' answer (no hook: see `hookAnswerSchemaFor`).
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
  rules: DecideRules = NO_RULES,
): Record<string, unknown> {
  return z.toJSONSchema(decideAnswerSchemaFor(preset, transcript, rules), {
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
  rules: DecideRules = NO_RULES,
): { ok: true; answer: DecideAnswer } | { ok: false; reasons: string[] } {
  const result = decideAnswerSchemaFor(preset, transcript, rules).safeParse(json);
  if (!result.success) return { ok: false, reasons: issueReasons(json, result.error.issues) };
  return { ok: true, answer: result.data };
}

// The answer placed over the current version by the layout engine
// (`placeEdit`) as a full edit, parsed with the decide limits and the
// refinement (ids used once, nothing ending before it starts, the behind
// lengths), with the engine's record of what it moved, shrank, wrapped,
// retimed or dropped. Also returned: the answer's extras left out and the
// sentences with room for their kind (the engine's own report, for the trace
// and tests; the worker no longer asks for a second answer on them). The
// current version's masks and photos are not carried over: the worker's
// cut-out step names them again for the new `behind` track. A parse failure
// here is an engine bug, never the answer's.
export function editFromAnswer(
  current: Edit,
  answer: EngineInput,
  preset: Preset,
  transcript: Transcript,
  headTrack: HeadTrack,
  measurer: Measurer,
  // The footage's background map, sampled: the engine keeps every text
  // readable over it. Without it nothing is measured.
  backgrounds?: Backgrounds,
  // The answer items the owner asked for, placed first and given room
  // (`PlaceOptions.requested`). The decide step passes none: a new answer
  // has no request.
  options: { requested?: readonly string[] } = {},
):
  | { ok: true; edit: Edit; record: EngineNote[]; unplaced: UnplacedItem[]; free: FreeSentence[] }
  | { ok: false; reasons: string[] } {
  const inputs = { ...current.inputs };
  delete inputs.masks;
  delete inputs.photos;
  const { tracks, record, unplaced, free } = placeEdit(
    current,
    answer,
    transcript,
    headTrack,
    preset,
    measurer,
    {
      ...(backgrounds ? { backgrounds } : {}),
      ...(options.requested ? { requested: options.requested } : {}),
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
  hook: boolean;
  wordsFixed: number;
  behindPhotos: number;
  behindVisuals: number;
  behindWords: number;
}

// What the step line names: accent overlays, transitions, whether there is a
// hook, the captions whose text differs from their words, and the behind items.
export function decideCounts(edit: Edit, transcript: Transcript, preset: Preset): DecideCounts {
  const { overlays, transitions, captions } = edit.tracks;
  const behind = edit.tracks.behind ?? [];
  return {
    behindPhotos: behind.filter((item) => item.kind === "photo").length,
    behindVisuals: behind.filter((item) => item.kind === "visual").length,
    behindWords: behind.filter((item) => item.kind === "word").length,
    accents: overlays.filter((item) => item.kind === "accent" && item.id !== "title").length,
    transitions: transitions.length,
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
