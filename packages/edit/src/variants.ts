import type { EngineComponent } from "./engine-note.ts";
import type { ZoneName } from "./engine-zones.ts";

// The variant entries (`specs/layout-engine.md`, "Variants as data" and
// "Writing a variant"): what the engine cannot compute, as data. No pixel
// positions, and no size of the variant's own: a text names a style of the
// style table below, and the style carries the base size. The picker
// (`variant-picker.ts`) chooses an entry for each pick; the placer
// (`engine-place.ts`) reads its zones, style and layer. Adding an entry is a
// line here and in the picker, never an engine change.

type Hex = `#${string}`;
type Ratio = `${number}/${number}`;
type Role = "primary" | "secondary";

// The span a variant's element takes from its words (or from its window).
export type Timing =
  | { option: "words" }
  | { option: "words-lead"; lead: number; minimum: number }
  | { option: "words-min-max"; minimum: number; maximum: number }
  | { option: "words-entrance"; entrance: number }
  | { option: "window"; from: number; to: number }
  // Captions keep their own grouping (the spec's timing column for CAPTION).
  | { option: "caption-groups" };

// The entry's zones, best first: at least one, each a name of the zone table.
export type Zones = readonly [ZoneName, ...ZoneName[]];

interface Common {
  component: EngineComponent;
  variant: `${string}/${string}`; // `<component>/<name>`
  zones: Zones;
  timing: Timing;
  hides: boolean; // its words leave the captions while it shows
}

// A text style: a font role, a colour and a base size (owner decision
// 2026-11-09, after a visual comparison of the size rules on real frames). The
// base is the style's typography, not a layout number: the placer never sets a
// text above it and shrinks from it when space is short, down to the global
// minimum. `largest-fit` is the one exception, the big word's: the largest
// size that fits its zone, bounded by rule 6 (the head hides at most 30%).
export interface TextStyle {
  font: Role;
  color: Hex;
  base: number | "largest-fit";
}

const WHITE: Hex = "#FFFFFF";

// The style table: today's values (`preset.fonts[].size`, 110 and 50). Two
// variants that name the same style get the same base by construction. A
// variant that wants another size names another style here: that is a
// typography decision, taken once, not a field of the entry.
export const STYLES = {
  // Accents, questions, the hook and a list's key phrase.
  accent: { font: "primary", color: WHITE, base: 110 },
  // Captions and a list's lead-in.
  caption: { font: "secondary", color: WHITE, base: 50 },
  // The big word behind the speaker: as large as its zone allows.
  bigWord: { font: "primary", color: WHITE, base: "largest-fit" },
} satisfies Record<string, TextStyle>;

// A text: its style (font, colour, base size). Text is `front` or `behind`.
export interface TextVariant extends Common {
  layer: "front" | "behind";
  type: "text";
  style: TextStyle;
  levels?: never;
  aspect?: never;
  width?: never;
}

// One level of a stack (LIST): its role, its style, and for the number its
// ratio to the key level (the number's size is the key's times the ratio, so
// its style's base is not read).
export type Level =
  { role: "number"; style: TextStyle; ratio: number } | { role: "lead" | "key"; style: TextStyle };

// A stack: one stacked text, its levels in order. No style of its own.
export interface StackVariant extends Common {
  layer: "front";
  type: "text";
  levels: readonly Level[];
  style?: never;
  aspect?: never;
  width?: never;
}

// A box: a stroke, no fill, a full width as a share of the frame at an aspect.
export interface BoxVariant extends Common {
  layer: "front";
  type: "box";
  style: { stroke: { color: Hex; px: number } };
  aspect: Ratio;
  width: Ratio;
  levels?: never;
}

export type Variant = TextVariant | StackVariant | BoxVariant;

// The seven entries, keyed by their name. `satisfies` checks each one against
// `Variant` (a wrong field or an unknown zone name fails typecheck).
export const VARIANTS = {
  "hook/written-line": {
    component: "HOOK",
    variant: "hook/written-line",
    layer: "front",
    type: "text",
    style: STYLES.accent,
    zones: ["upper-third", "anywhere-in-safe-zone"],
    timing: { option: "window", from: 0.2, to: 3 },
    hides: false, // nobody says it
  },
  "accent/above-head": {
    component: "ACCENT",
    variant: "accent/above-head",
    layer: "front",
    type: "text",
    style: STYLES.accent,
    zones: ["above-head", "upper-third", "anywhere-in-safe-zone"],
    timing: { option: "words" },
    hides: true,
  },
  "question/as-accent": {
    component: "QUESTION",
    variant: "question/as-accent",
    layer: "front",
    type: "text",
    style: STYLES.accent,
    zones: ["above-head", "upper-third", "anywhere-in-safe-zone"],
    timing: { option: "words" },
    hides: true,
  },
  "bigword/behind": {
    component: "BIGWORD",
    variant: "bigword/behind",
    layer: "behind",
    type: "text",
    style: STYLES.bigWord,
    zones: ["head-top"],
    timing: { option: "words-lead", lead: 0.2, minimum: 1.5 },
    hides: true,
  },
  "visual/card": {
    component: "VISUAL",
    variant: "visual/card",
    layer: "front",
    type: "box",
    style: { stroke: { color: WHITE, px: 8 } },
    zones: ["corner", "beside-face"],
    timing: { option: "words-min-max", minimum: 1, maximum: 2 },
    hides: false,
    aspect: "4/5",
    width: "1/3",
  },
  "list/numbered": {
    component: "LIST",
    variant: "list/numbered",
    layer: "front",
    type: "text",
    levels: [
      { role: "number", style: STYLES.accent, ratio: 300 / 110 },
      { role: "lead", style: STYLES.caption },
      { role: "key", style: STYLES.accent },
    ],
    zones: ["upper-third", "anywhere-in-safe-zone"],
    timing: { option: "words-entrance", entrance: 0.3 },
    hides: true,
  },
  "caption/default": {
    component: "CAPTION",
    variant: "caption/default",
    layer: "front",
    type: "text",
    style: STYLES.caption,
    zones: ["beside-face", "below-face", "caption-line", "anywhere-in-safe-zone"],
    timing: { option: "caption-groups" },
    hides: false, // the captions are the words; nothing leaves them
  },
} satisfies Record<string, Variant>;
