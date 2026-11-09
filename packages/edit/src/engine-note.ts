// The engine record's note (`specs/layout-engine.md`, "What the engine
// records"): what the engine did to one element, in one shape, saved with the
// version (`versions.engine_record`) and read by the trace, the checks and the
// worker's log line. Nothing reads any other shape.
//
// The placer (`engine-place.ts`) writes this shape itself for every element it
// places (the hook, accents, questions, LIST stacks, the big word, the visual's
// card and the caption blocks). The engine's timing, same-text and text notes
// are still written as `PlaceNote` (an action and a rule name); `toEngineRecord`
// turns those into this shape at the end of `placeEdit` and passes the placer's
// through. A note's variant is the name of the entry its component was picked
// with (`variant-picker.ts`).

import type { PickedVariants } from "./variant-picker.ts";

export type EngineComponent =
  "HOOK" | "ACCENT" | "QUESTION" | "BIGWORD" | "VISUAL" | "LIST" | "CAPTION";

export type EngineOutcome =
  | "placed" // its first zone, full size, no cost
  | "moved" // a zone down the ranking
  | "shrunk" // below its full size
  | "wrapped" // more than one line
  | "covers-face"
  | "retimed" // clamped-to-end, moved-off-cut, trimmed by same-text
  | "dropped" // same-text left no word of its own
  // No legal spot: a component is left out; a caption block (never left out,
  // rule 3) is set over the texts on screen, inside the safe zone, its
  // blockers naming them (decision 19).
  | "no-spot";

// What took the space an element did not get.
export type Blocker =
  | { kind: "caption"; id: string }
  | { kind: "item"; id: string }
  | { kind: "face" }
  | { kind: "safe-zone"; edge: "left" | "right" | "top" | "bottom" }
  | { kind: "buttons" };

export interface EngineNote {
  item: string; // "hook", "accent-1", "question-2", "big-word-1", "visual-1", "transition-3", "w0012" (a caption)
  component: EngineComponent;
  variant: string; // the entry's name, "accent/above-head"
  start: number; // the placed span, seconds
  end: number;
  rule: string; // what the note is about: "zone", "size", "face", "safe-zone", "same-text", "timing", "hidden-footage", "no-spot"
  outcome: EngineOutcome;
  blockers: Blocker[]; // what took the space it did not get
  zone?: string; // the zone taken
  size?: number; // the size taken
  lines?: number;
  cost?: number; // the candidate's total cost
  reason: string; // plain words for people, with the text and times
}

// The engine's own action in a note outside the placer (timing, readability,
// a text's words, the same-text rule).
export type PlaceAction =
  | "moved"
  | "retimed"
  // A text that stays in place, plain, below its contrast threshold: no free
  // place nearby reads, and no shadow or colour is ever added for it.
  | "low-contrast"
  // A pick too close to the reel's end for its minimum, shown from earlier so
  // it still shows (its end is the reel's end).
  | "clamped-to-end"
  // A pick over hidden footage, shown at the next visible moment.
  | "moved-off-cut"
  // A transition or a list pick with no caption text of its own, shown with
  // the words of its phrase as its text.
  | "text-from-words"
  // A text pick every word of which another text pick (placed earlier) shows
  // already: dropped (rule `same-text`, the reason names both picks).
  | "dropped";

// One note as the engine writes it outside the placer.
export interface PlaceNote {
  item: string;
  action: PlaceAction;
  rule: string;
  reason: string;
}

// A note of either shape in the engine's record while it places: the placer's
// (already the record's shape) or an old code path's.
export type RecordNote = PlaceNote | EngineNote;

// What the adapter needs to know about an element to write its note.
export interface EngineElement {
  component: EngineComponent;
  start: number;
  end: number;
}

const OUTCOME_OF: Record<PlaceAction, EngineOutcome> = {
  moved: "moved",
  retimed: "retimed",
  // The element stays where it was placed, nothing given up in its place: the
  // reason carries the warning.
  "low-contrast": "placed",
  "clamped-to-end": "retimed",
  "moved-off-cut": "retimed",
  "text-from-words": "placed",
  dropped: "dropped",
};

// The engine's rule names, in the record's vocabulary. A rule the table does
// not know throws: a new rule is named here on purpose.
const RULE_OF: Record<string, string> = {
  "caption-min": "timing",
  "transition-min": "timing",
  "transition-time": "timing",
  "hook-time": "timing",
  "accent-time": "timing",
  "big-word-time": "timing",
  "visual-time": "timing",
  "hidden-footage": "hidden-footage",
  "same-text": "same-text",
  "transition-text": "text",
  "contrast-spot": "contrast",
  "contrast-stay": "contrast",
};

const seconds = (t: number) => `${t.toFixed(2)} s`;

// The record: the placer's notes as they are; one note per engine note; then a
// `placed` note for every shown element that no note names, so a reader sees
// what was placed, not only what moved.
export function toEngineRecord(
  notes: readonly RecordNote[],
  elements: ReadonlyMap<string, EngineElement>,
  shown: readonly string[],
  picked: PickedVariants,
): EngineNote[] {
  const out: EngineNote[] = [];
  const noted = new Set<string>();
  // The name of the entry the component was picked with.
  const variantNameOf = (component: EngineComponent): string => {
    const entry = picked.get(component);
    if (!entry) throw new Error(`engine record: no picked variant for ${component}`);
    return entry.variant;
  };
  const elementOf = (id: string): EngineElement => {
    const found = elements.get(id);
    if (!found) throw new Error(`engine record: no element ${id}`);
    return found;
  };
  for (const note of notes) {
    if ("outcome" in note) {
      out.push(note);
      noted.add(note.item);
      continue;
    }
    const rule = RULE_OF[note.rule];
    if (rule === undefined) throw new Error(`engine record: unknown rule ${note.rule}`);
    const at = elementOf(note.item);
    out.push({
      item: note.item,
      component: at.component,
      variant: variantNameOf(at.component),
      start: at.start,
      end: at.end,
      rule,
      outcome: OUTCOME_OF[note.action],
      blockers: [],
      reason: note.reason,
    });
    noted.add(note.item);
  }
  for (const id of shown) {
    if (noted.has(id)) continue;
    const at = elementOf(id);
    out.push({
      item: id,
      component: at.component,
      variant: variantNameOf(at.component),
      start: at.start,
      end: at.end,
      rule: "zone",
      outcome: "placed",
      blockers: [],
      reason: `${id} (${at.component.toLowerCase()}) is placed from ${seconds(at.start)} to ${seconds(at.end)}, nothing given up`,
    });
  }
  return out;
}
