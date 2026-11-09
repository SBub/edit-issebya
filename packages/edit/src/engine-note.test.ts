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

// Every placer action and the outcome it is recorded as. The type makes the
// table total: a new action fails to compile until it is named here.
const OUTCOME: Record<PlaceAction, EngineOutcome> = {
  moved: "moved",
  shrunk: "shrunk",
  wrapped: "wrapped",
  retimed: "retimed",
  "covers-face": "covers-face",
  "low-contrast": "placed",
  "kept-overlapping": "kept-overlapping",
  "clamped-to-end": "retimed",
  "moved-off-cut": "retimed",
  "text-from-words": "placed",
  dropped: "dropped",
};

const accent: EngineElement = { component: "ACCENT", start: 3.2, end: 4.1 };
const caption: EngineElement = { component: "CAPTION", start: 2, end: 2.5 };
const elements = new Map<string, EngineElement>([
  ["accent-1", accent],
  ["accent-2", { component: "ACCENT", start: 5, end: 6 }],
  ["cw0", caption],
  ["cw1", { component: "CAPTION", start: 2.5, end: 3 }],
]);
const captions = new Set(["cw0", "cw1"]);
// The picked entries the notes name (one per component, as the picker gives).
const PICKED: PickedVariants = new Map<EngineComponent, Variant>([
  ["ACCENT", VARIANTS["accent/above-head"]],
  ["CAPTION", VARIANTS["caption/default"]],
]);
const recordOf = (
  notes: readonly RecordNote[],
  els: ReadonlyMap<string, EngineElement>,
  shown: readonly string[],
  caps: ReadonlySet<string>,
) => toEngineRecord(notes, els, shown, caps, PICKED);

const note = (action: PlaceAction, extra: Partial<PlaceNote> = {}): PlaceNote => ({
  item: "accent-1",
  action,
  rule: "caption-spot",
  reason: `the ${action} note`,
  ...extra,
});

describe("toEngineRecord", () => {
  for (const [action, outcome] of Object.entries(OUTCOME)) {
    it(`records the placer's ${action} as ${outcome}`, () => {
      const [written] = recordOf([note(action as PlaceAction)], elements, [], captions);
      expect(written).toEqual({
        item: "accent-1",
        component: "ACCENT",
        variant: "accent/above-head",
        start: 3.2,
        end: 4.1,
        rule: "zone",
        outcome,
        blockers: action === "covers-face" ? [{ kind: "face" }] : [],
        reason: `the ${action} note`,
      });
    });
  }

  it("maps the placer's rule names to the record's vocabulary", () => {
    const rules: [string, string][] = [
      ["caption-min", "timing"],
      ["visual-time", "timing"],
      ["hook-time", "timing"],
      ["transition-min", "timing"],
      ["hidden-footage", "hidden-footage"],
      ["same-text", "same-text"],
      ["caption-spot", "zone"],
      ["big-word-size", "size"],
      ["visual-size", "size"],
      ["visual-face", "face"],
      ["all-picks", "text-overlap"],
      ["transition-text", "text"],
      ["contrast-spot", "contrast"],
      ["contrast-stay", "contrast"],
    ];
    const records = recordOf(
      rules.map(([rule]) => note("moved", { rule })),
      elements,
      [],
      captions,
    );
    expect(records.map((entry) => entry.rule)).toEqual(rules.map(([, mapped]) => mapped));
  });

  it("throws on a rule the record does not name", () => {
    expect(() =>
      recordOf([note("moved", { rule: "no-such-rule" })], elements, [], captions),
    ).toThrow(/unknown rule no-such-rule/);
  });

  it("throws on a note for an element it does not know", () => {
    expect(() => recordOf([note("moved", { item: "nobody" })], elements, [], captions)).toThrow(
      /no element nobody/,
    );
  });

  it("writes the names a kept-overlapping note sits over as blockers, captions by kind", () => {
    const [written] = recordOf(
      [note("kept-overlapping", { with: ["accent-2", "cw1"] })],
      elements,
      [],
      captions,
    );
    expect(written!.blockers).toEqual([
      { kind: "item", id: "accent-2" },
      { kind: "caption", id: "cw1" },
    ]);
  });

  it("writes a covers-face note for each caption of its block, each blocked by the face", () => {
    const records = recordOf(
      [
        note("covers-face", {
          item: "cw0",
          rule: "caption-face",
          reason: "the block",
          with: ["cw1"],
        }),
      ],
      elements,
      [],
      captions,
    );
    expect(records.map((entry) => [entry.item, entry.outcome, entry.blockers])).toEqual([
      ["cw0", "covers-face", [{ kind: "face" }]],
      ["cw1", "covers-face", [{ kind: "face" }]],
    ]);
    expect(records[1]!.component).toBe("CAPTION");
    expect(records[1]!.variant).toBe("caption/default");
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
    const records = recordOf([ready], elements, ["accent-1", "accent-2"], captions);
    expect(records).toEqual([
      ready,
      expect.objectContaining({ item: "accent-2", outcome: "placed" }),
    ]);
  });

  it("gives every shown element with no note a placed note, and no other", () => {
    const records = recordOf(
      [note("moved", { item: "accent-1" })],
      elements,
      ["accent-1", "accent-2"],
      captions,
    );
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
      captions,
    );
    expect(records.map((entry) => entry.outcome)).toEqual(["dropped", "retimed"]);
  });

  it("names each note's variant after the entry its component was picked with", () => {
    const other = { ...VARIANTS["accent/above-head"], variant: "accent/other" } as const;
    const [written] = toEngineRecord(
      [note("moved")],
      elements,
      [],
      captions,
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
        captions,
        new Map<EngineComponent, Variant>([["CAPTION", VARIANTS["caption/default"]]]),
      ),
    ).toThrow(/no picked variant for ACCENT/);
  });
});
