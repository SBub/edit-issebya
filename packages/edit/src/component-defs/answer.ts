import { z } from "zod";
import type { Preset } from "../preset.ts";
import type { Anchor, BehindItem, OverlayItem, TransitionItem } from "../schema.ts";
import type { Transcript } from "../transcript.ts";

// What a component adds to the curator's answer (the AI call that reads the transcript), and what
// the rest of the code reads back from it. The stored names (`accents`, `big_words`) are written
// once here and in the subclasses, beside the component they belong to.

// A line of plain text: no line break and nothing that could leave its tag (a plain pattern, so a
// provider's JSON Schema validator reads it as is). The hook's text and a visual's description.
export const PLAIN_LINE = /^[^\n\r<>]+$/;

// A word the transcript has, as the answer names it (by id).
type Word = Transcript["words"][number];

// What a component's check and schema need to know about the reel.
export interface AnswerContext {
  preset: Preset;
  ids: readonly string[];
  // A word id's place in the transcript.
  order: ReadonlyMap<string, number>;
  words: ReadonlyMap<string, Word>;
  // One of the transcript's word ids (nothing at all for a reel with no words).
  wordId: z.ZodType<string>;
}

// One thing wrong with an answer: where, and why.
export interface Problem {
  path: (string | number)[];
  message: string;
}

// The answer's own part of a component: the field the AI fills (a list of its picks), the start of
// the engine's item id for its n-th pick, and the schema of one pick.
export interface AnswerField<F extends string = string, Item = unknown> {
  field: F;
  itemId: string;
  schema(ctx: AnswerContext): z.ZodType<Item[]>;
  // A fresh answer with no pick of this component.
  empty(): Item[];
}

// A pick that sits over the words `from` to `to`; the plain case, plus what a component adds
// (`extra`, for example a description).
export function phraseAnswer<
  F extends string,
  Extra extends Record<string, z.ZodType> = Record<never, never>,
>(
  field: F,
  itemId: string,
  extra?: (ctx: AnswerContext) => Extra,
): AnswerField<F, { from: string; to: string } & { [K in keyof Extra]: z.output<Extra[K]> }> {
  return {
    field,
    itemId,
    // The cast: TypeScript cannot follow the spread of a generic `extra` into the output type. The
    // class that calls this states its pick's type, and that is checked against `Extra` there.
    schema: (ctx) =>
      z.array(
        z.strictObject({ from: ctx.wordId, to: ctx.wordId, ...extra?.(ctx) }),
      ) as unknown as z.ZodType<never>,
    empty: () => [],
  };
}

// One pick of an answer, as the trace and the evals read it: its place in the answer
// (`accents[2]`), the id the engine places it under, and the words it sits on.
export interface Pick {
  ref: string;
  item: string;
  from: string;
  to: string;
  // A VISUAL's description (what it would show).
  description?: string;
  // A LIST item's list and its place in it (both from 0).
  list?: number;
  position?: number;
  // The hook's line (it sits on no words: `from` and `to` are empty).
  text?: string;
}

// The words of a pick, as spoken, for the trace.
export type Say = (from: string, to: string) => string;

// A stored item of any track a component can own.
export type Placed = OverlayItem | BehindItem | TransitionItem;

// An item as far as its place in the transcript goes.
export interface Timed {
  id: string;
  start: Anchor;
  end: Anchor;
}

// What reading a saved version back into an answer needs.
export interface ReadBackContext {
  transcript: Transcript;
  preset: Preset;
  // The words an item sits on: from its start word to its end word.
  under(item: Timed): string[];
  // The first and last of some word ids.
  ends(ids: readonly string[]): { from: string; to: string };
}
