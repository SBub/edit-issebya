import type { EngineComponent } from "./engine-note.ts";
import type { ZoneName } from "./engine-zones.ts";

// The variant entries (`specs/layout-engine.md`, "Variants as data" and
// "Writing a variant"): what the engine cannot compute, as data. No sizes, no
// pixel positions. The picker (`variant-picker.ts`) chooses an entry for each
// pick; the placer (not yet) reads its zones, timing and layer. Adding an entry
// is a line here and in the picker, never an engine change.

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

export interface TextStyle {
  font: Role;
  color: Hex;
}

// A text: a font role and a colour, no size. Text is `front` or `behind`.
export interface TextVariant extends Common {
  layer: "front" | "behind";
  type: "text";
  style: TextStyle;
  levels?: never;
  aspect?: never;
  width?: never;
}

// One level of a stack (LIST): its role, its style, and for the number its
// ratio to the key level.
export type Level =
  | { role: "number"; font: Role; color: Hex; ratio: number }
  | { role: "lead" | "key"; font: Role; color: Hex };

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

const WHITE: Hex = "#FFFFFF";

// The seven entries, keyed by their name. `satisfies` checks each one against
// `Variant` (a wrong field or an unknown zone name fails typecheck).
export const VARIANTS = {
  "hook/written-line": {
    component: "HOOK",
    variant: "hook/written-line",
    layer: "front",
    type: "text",
    style: { font: "primary", color: WHITE },
    zones: ["upper-third", "anywhere-in-safe-zone"],
    timing: { option: "window", from: 0.2, to: 3 },
    hides: false, // nobody says it
  },
  "accent/above-head": {
    component: "ACCENT",
    variant: "accent/above-head",
    layer: "front",
    type: "text",
    style: { font: "primary", color: WHITE },
    zones: ["above-head", "upper-third", "anywhere-in-safe-zone"],
    timing: { option: "words" },
    hides: true,
  },
  "question/as-accent": {
    component: "QUESTION",
    variant: "question/as-accent",
    layer: "front",
    type: "text",
    style: { font: "primary", color: WHITE },
    zones: ["above-head", "upper-third", "anywhere-in-safe-zone"],
    timing: { option: "words" },
    hides: true,
  },
  "bigword/behind": {
    component: "BIGWORD",
    variant: "bigword/behind",
    layer: "behind",
    type: "text",
    style: { font: "primary", color: WHITE },
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
      { role: "number", font: "primary", color: WHITE, ratio: 300 / 110 },
      { role: "lead", font: "secondary", color: WHITE },
      { role: "key", font: "primary", color: WHITE },
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
    style: { font: "secondary", color: WHITE },
    zones: ["beside-face", "below-face", "caption-line", "anywhere-in-safe-zone"],
    timing: { option: "caption-groups" },
    hides: false, // the captions are the words; nothing leaves them
  },
} satisfies Record<string, Variant>;
