import { z } from "zod";
import { itemTimes } from "./anchors.ts";
import type { Preset } from "./preset.ts";
import { type Transcript, type Word, wordIndex } from "./transcript.ts";

// A word anchor: the word's start or end, with a small lead or lag in seconds.
const wordAnchor = z.strictObject({
  word: z.string().min(1),
  edge: z.enum(["start", "end"]).optional(),
  offset: z.number().min(-0.5).max(0.5).optional(),
});
// A time in seconds, only where nobody speaks.
const timeAnchor = z.strictObject({ at: z.number().min(0) });
const anchor = z.union([wordAnchor, timeAnchor]);

// What may follow the generated declarations in an inline style: no quote,
// backslash, angle bracket or brace, so it cannot leave the attribute.
const CUSTOM = /^[A-Za-z0-9 :;.,#%()_+*!'/-]*$/;
export const custom = z
  .string()
  .max(500)
  .regex(
    CUSTOM,
    "custom style may only use letters, digits, spaces and : ; . , # % ( ) _ + * ! ' / -",
  )
  .refine((value) => !/url\(/i.test(value), "custom style may not use url(");

const style = z.strictObject({
  // A preset colour key or #RRGGBB.
  color: z.string().min(1).optional(),
  size: z.number().positive().max(400).optional(),
  position: z.strictObject({ x: z.number(), y: z.number() }).optional(),
  // A preset font key.
  font: z.string().min(1).optional(),
});

// Also the element id in the page and the timeline's selector.
export const itemId = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/, "id must be lower-case letters, digits, _ or -");

const base = {
  id: itemId,
  start: anchor,
  end: anchor,
  style: style.optional(),
  custom: custom.optional(),
};

const span = z.strictObject(base);
const caption = z.strictObject({
  ...base,
  text: z.string().min(1).max(200),
  // The words it shows.
  words: z.array(z.string().min(1)).optional(),
});
const overlay = z.strictObject({ ...base, text: z.string().min(1).max(200) });
const transition = z.strictObject({
  ...base,
  type: z.string().min(1),
  text: z.string().min(1).max(300).optional(),
});
const sound = z.strictObject({
  ...base,
  sound: z.string().min(1),
  gainDb: z.number().min(-60).max(12).optional(),
});

const fingerprint = z.string().regex(/^[0-9a-f]{64}$/, "a fingerprint is 64 lower-case hex digits");

const edit = z.strictObject({
  format: z.literal(1),
  // The fingerprints of the steps that produced the edit's inputs.
  inputs: z.strictObject({
    footage: fingerprint,
    transcript: fingerprint,
    cutout: fingerprint,
    headTrack: fingerprint,
  }),
  tracks: z.strictObject({
    footage: z.array(span).max(1),
    cutout: z.array(span).max(1),
    captions: z.array(caption),
    overlays: z.array(overlay),
    transitions: z.array(transition),
    sounds: z.array(sound),
  }),
});

export type Edit = z.infer<typeof edit>;
export type Anchor = z.infer<typeof anchor>;
export type Track = keyof Edit["tracks"];
export type Item = Edit["tracks"][Track][number];

export const TRACKS: readonly Track[] = [
  "footage",
  "cutout",
  "captions",
  "overlays",
  "transitions",
  "sounds",
];

export interface EditContext {
  transcript: Transcript;
  preset: Preset;
}

export const HEX = /^#[0-9A-Fa-f]{6}$/;

// The edit format alone, with no transcript or preset: what a JSON Schema for
// the decide step starts from.
export function editJsonSchemaBase() {
  return edit;
}

function anchorWords(item: Item): string[] {
  const ids: string[] = [];
  for (const point of [item.start, item.end]) if ("word" in point) ids.push(point.word);
  if ("words" in item && item.words) ids.push(...item.words);
  return ids;
}

// The word an `{ at }` time falls strictly inside (a word's own start or end
// is a boundary, allowed).
function spokenAt(at: number, words: Word[]): Word | undefined {
  return words.find((word) => word.start < at && at < word.end);
}

// The edit checked against one transcript and one preset: every word anchor
// names a word, every font, colour, sound and transition is the preset's,
// every item ends after it starts, a time anchor is never inside a spoken
// word, and item ids are unique.
export function editSchema({ transcript, preset }: EditContext) {
  const words = wordIndex(transcript);
  return edit.superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const track of TRACKS) {
      const items: Item[] = value.tracks[track];
      for (const [index, item] of items.entries()) {
        const path = ["tracks", track, index];
        const issue = (message: string) => ctx.addIssue({ code: "custom", message, path });
        if (seen.has(item.id)) issue("duplicate item id");
        seen.add(item.id);
        let known = true;
        for (const id of anchorWords(item)) {
          if (!words.has(id)) {
            issue(`unknown word ${id}`);
            known = false;
          }
        }
        for (const point of [item.start, item.end]) {
          if (!("at" in point)) continue;
          const inside = spokenAt(point.at, transcript.words);
          if (inside) issue(`time ${point.at} falls inside the spoken word ${inside.id}`);
        }
        if (known) {
          const { start, end } = itemTimes(item, words);
          if (!(end > start)) issue(`ends at ${end}, not after its start ${start}`);
        }
        const font = item.style?.font;
        if (font !== undefined && !(font in preset.fonts)) {
          issue(`font "${font}" is not in the preset`);
        }
        const color = item.style?.color;
        if (color !== undefined && !HEX.test(color) && !(color in preset.colors)) {
          issue(`colour "${color}" is neither #RRGGBB nor in the preset`);
        }
        if ("sound" in item && !(item.sound in preset.sounds)) {
          issue(`sound "${item.sound}" is not in the preset`);
        }
        if ("type" in item && !preset.transitions.includes(item.type)) {
          issue(`transition "${item.type}" is not in the preset`);
        }
      }
    }
  });
}

// `<item id>: <rule>` for an issue inside an item, else `<path>: <rule>`.
function describe(input: unknown, issue: z.core.$ZodIssue): string {
  const [first, track, index] = issue.path;
  if (first === "tracks" && typeof track === "string" && typeof index === "number") {
    const tracks = (input as { tracks?: Record<string, unknown> }).tracks;
    const items = tracks?.[track];
    const id = Array.isArray(items)
      ? (items[index] as { id?: unknown } | undefined)?.id
      : undefined;
    if (typeof id === "string") return `${id}: ${issue.message}`;
  }
  return `${issue.path.length > 0 ? issue.path.join(".") : "edit"}: ${issue.message}`;
}

// The typed edit, or an error listing every issue (one per line).
export function parseEdit(json: unknown, context: EditContext): Edit {
  const input = typeof json === "string" ? (JSON.parse(json) as unknown) : json;
  const result = editSchema(context).safeParse(input);
  if (result.success) return result.data;
  const lines = result.error.issues.map((issue) => describe(input, issue));
  throw new Error(`invalid edit:\n${lines.join("\n")}`);
}
