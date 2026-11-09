import { describe, expect, it } from "vitest";
import {
  type EngineComponent,
  type EngineElement,
  type EngineNote,
  type EngineOutcome,
  type PlaceAction,
  type PlaceNote,
  type RecordNote,
  toEngineRecord,
} from "./engine-note.ts";
import type { PickedVariants } from "./variant-picker.ts";
import { VARIANTS, type Variant } from "./variants.ts";

// Every engine action outside the placer and the outcome it is recorded as.
// The type makes the table total: a new action fails to compile until it is
// named here.
const OUTCOME: Record<PlaceAction, EngineOutcome> = {
  moved: "moved",
  retimed: "retimed",
  "low-contrast": "placed",
  "clamped-to-end": "retimed",
  "moved-off-cut": "retimed",
  "text-from-words": "placed",
  dropped: "dropped",
};

const accent: EngineElement = { component: "ACCENT", start: 3.2, end: 4.1 };
const elements = new Map<string, EngineElement>([
  ["accent-1", accent],
  ["accent-2", { component: "ACCENT", start: 5, end: 6 }],
  ["cw0", { component: "CAPTION", start: 2, end: 2.5 }],
]);
// The picked entries the notes name (one per component, as the picker gives).
const PICKED: PickedVariants = new Map<EngineComponent, Variant>([
  ["ACCENT", VARIANTS["accent/above-head"]],
  ["CAPTION", VARIANTS["caption/default"]],
]);
const recordOf = (
  notes: readonly RecordNote[],
  els: ReadonlyMap<string, EngineElement>,
  shown: readonly string[],
) => toEngineRecord(notes, els, shown, PICKED);

const note = (action: PlaceAction, extra: Partial<PlaceNote> = {}): PlaceNote => ({
  item: "accent-1",
  action,
  rule: "contrast-spot",
  reason: `the ${action} note`,
  ...extra,
});

describe("toEngineRecord", () => {
  for (const [action, outcome] of Object.entries(OUTCOME)) {
    it(`records the engine's ${action} as ${outcome}`, () => {
      const [written] = recordOf([note(action as PlaceAction)], elements, []);
      expect(written).toEqual({
        item: "accent-1",
        component: "ACCENT",
        variant: "accent/above-head",
        start: 3.2,
        end: 4.1,
        rule: "contrast",
        outcome,
        blockers: [],
        reason: `the ${action} note`,
      });
    });
  }

  it("maps the engine's rule names to the record's vocabulary", () => {
    const rules: [string, string][] = [
      ["caption-min", "timing"],
      ["visual-time", "timing"],
      ["hook-time", "timing"],
      ["transition-min", "timing"],
      ["hidden-footage", "hidden-footage"],
      ["same-text", "same-text"],
      ["transition-text", "text"],
      ["contrast-spot", "contrast"],
      ["contrast-stay", "contrast"],
    ];
    const records = recordOf(
      rules.map(([rule]) => note("moved", { rule })),
      elements,
      [],
    );
    expect(records.map((entry) => entry.rule)).toEqual(rules.map(([, mapped]) => mapped));
  });

  it("throws on a rule the record does not name", () => {
    for (const rule of ["no-such-rule", "all-picks", "caption-spot", "caption-face"]) {
      expect(() => recordOf([note("moved", { rule })], elements, [])).toThrow(
        `unknown rule ${rule}`,
      );
    }
  });

  it("throws on a note for an element it does not know", () => {
    expect(() => recordOf([note("moved", { item: "nobody" })], elements, [])).toThrow(
      /no element nobody/,
    );
  });

  it("passes a note already in the record's shape through as it is, and writes no placed note for its item", () => {
    const ready: EngineNote = {
      item: "accent-1",
      component: "ACCENT",
      variant: "accent/above-head",
      start: 3.2,
      end: 4.1,
      rule: "size",
      outcome: "shrunk",
      blockers: [{ kind: "item", id: "hook" }],
      zone: "above-head",
      size: 89,
      lines: 3,
      cost: 20,
      reason: "the placer's own words",
    };
    const records = recordOf([ready], elements, ["accent-1", "accent-2"]);
    expect(records).toEqual([
      ready,
      expect.objectContaining({ item: "accent-2", outcome: "placed" }),
    ]);
  });

  it("gives every shown element with no note a placed note, and no other", () => {
    const records = recordOf([note("moved", { item: "accent-1" })], elements, [
      "accent-1",
      "accent-2",
    ]);
    expect(records.map((entry) => [entry.item, entry.outcome])).toEqual([
      ["accent-1", "moved"],
      ["accent-2", "placed"],
    ]);
    expect(records[1]).toMatchObject({
      rule: "zone",
      blockers: [],
      start: 5,
      end: 6,
      reason: "accent-2 (accent) is placed from 5.00 s to 6.00 s, nothing given up",
    });
  });

  it("keeps the notes in the order the placer wrote them", () => {
    const records = recordOf(
      [note("dropped", { item: "accent-2" }), note("retimed")],
      elements,
      [],
    );
    expect(records.map((entry) => entry.outcome)).toEqual(["dropped", "retimed"]);
  });

  it("names each note's variant after the entry its component was picked with", () => {
    const other = { ...VARIANTS["accent/above-head"], variant: "accent/other" } as const;
    const [written] = toEngineRecord(
      [note("moved")],
      elements,
      [],
      new Map<EngineComponent, Variant>([["ACCENT", other]]),
    );
    expect(written!.variant).toBe("accent/other");
  });

  it("throws when a component has no picked entry", () => {
    expect(() =>
      toEngineRecord(
        [note("moved")],
        elements,
        [],
        new Map<EngineComponent, Variant>([["CAPTION", VARIANTS["caption/default"]]]),
      ),
    ).toThrow(/no picked variant for ACCENT/);
  });
});
