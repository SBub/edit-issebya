// The engine record's note (`specs/layout-engine.md`, "What the engine
// records"): what the engine did to one element, in one shape, saved with the
// version (`versions.engine_record`) and read by the trace, the checks and the
// worker's log line. Nothing reads any other shape.
//
// The placer (`engine-place.ts`) writes this shape itself for the components it
// places (the hook, accents, questions and LIST stacks, build steps 6 and 7).
// The engine's other code paths still place with their own notes (`PlaceNote`,
// actions as they were); `toEngineRecord` turns those into this shape at the
// end of `placeEdit` and passes the placer's through, until the placer replaces
// the per-kind code (build steps 8 to 10 of the spec). A note's variant is the
// name of the entry its component was picked with (`variant-picker.ts`).

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
  | "no-spot"
  // Transitional: a text placed over other text or at the same time as another
  // pick. Text over text becomes a hard rule (spec rule 5); this value goes
  // with that change (build steps 5 and 10).
  | "kept-overlapping";

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

// The engine's own action while it places (the names the placer code uses).
export type PlaceAction =
  | "moved"
  | "shrunk"
  | "wrapped"
  | "retimed"
  // A front pick or caption placed over the face because no spot off the face
  // was free (the reason says so).
  | "covers-face"
  // A text that stays in place, plain, below its contrast threshold: no free
  // place nearby reads, and no shadow or colour is ever added for it.
  | "low-contrast"
  // A pick placed over other text, or at the same time as another pick, kept
  // as it is (the reason says what it sits over).
  | "kept-overlapping"
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

// One note as the placer writes it. `with` names the other items it relates
// to: the texts a kept-overlapping item sits over, a caption block's other
// captions under the face.
export interface PlaceNote {
  item: string;
  action: PlaceAction;
  rule: string;
  reason: string;
  with?: string[];
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
  shrunk: "shrunk",
  wrapped: "wrapped",
  retimed: "retimed",
  "covers-face": "covers-face",
  // The element stays where it was placed, nothing given up in its place: the
  // reason carries the warning.
  "low-contrast": "placed",
  "kept-overlapping": "kept-overlapping",
  "clamped-to-end": "retimed",
  "moved-off-cut": "retimed",
  "text-from-words": "placed",
  dropped: "dropped",
};

// The placer's rule names, in the record's vocabulary. A rule the table does
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
  "all-picks": "text-overlap",
  "transition-text": "text",
  "contrast-spot": "contrast",
  "contrast-stay": "contrast",
  "caption-spot": "zone",
  "big-word-spot": "zone",
  "caption-size": "size",
  "big-word-size": "size",
  "visual-size": "size",
  "caption-face": "face",
  "visual-face": "face",
};

const seconds = (t: number) => `${t.toFixed(2)} s`;

// The record: the placer's notes as they are; one note per old-shape note (a
// covers-face note names each caption it covers, one note each); then a
// `placed` note for every shown element that no note names, so a reader sees
// what was placed, not only what moved.
export function toEngineRecord(
  notes: readonly RecordNote[],
  elements: ReadonlyMap<string, EngineElement>,
  shown: readonly string[],
  captionIds: ReadonlySet<string>,
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
  const write = (
    id: string,
    note: { rule: string; reason: string },
    outcome: EngineOutcome,
    blockers: Blocker[],
  ) => {
    const at = elementOf(id);
    out.push({
      item: id,
      component: at.component,
      variant: variantNameOf(at.component),
      start: at.start,
      end: at.end,
      rule: note.rule,
      outcome,
      blockers,
      reason: note.reason,
    });
    noted.add(id);
  };
  for (const note of notes) {
    if ("outcome" in note) {
      out.push(note);
      noted.add(note.item);
      continue;
    }
    const rule = RULE_OF[note.rule];
    if (rule === undefined) throw new Error(`engine record: unknown rule ${note.rule}`);
    const outcome = OUTCOME_OF[note.action];
    if (note.action === "covers-face") {
      for (const id of [note.item, ...(note.with ?? [])]) {
        write(id, { rule, reason: note.reason }, outcome, [{ kind: "face" }]);
      }
      continue;
    }
    const blockers = (note.with ?? []).map((id): Blocker =>
      captionIds.has(id) ? { kind: "caption", id } : { kind: "item", id },
    );
    write(note.item, { rule, reason: note.reason }, outcome, blockers);
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
