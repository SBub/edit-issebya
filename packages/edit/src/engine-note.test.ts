import { describe, expect, it } from "vitest";
import {
  type EngineElement,
  type EngineOutcome,
  type PlaceAction,
  type PlaceNote,
  toEngineRecord,
} from "./engine-note.ts";

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

const note = (action: PlaceAction, extra: Partial<PlaceNote> = {}): PlaceNote => ({
  item: "accent-1",
  action,
  rule: "accent-spot",
  reason: `the ${action} note`,
  ...extra,
});

describe("toEngineRecord", () => {
  for (const [action, outcome] of Object.entries(OUTCOME)) {
    it(`records the placer's ${action} as ${outcome}`, () => {
      const [written] = toEngineRecord([note(action as PlaceAction)], elements, [], captions);
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
      ["text-one-at-a-time", "timing"],
      ["hidden-footage", "hidden-footage"],
      ["same-text", "same-text"],
      ["caption-spot", "zone"],
      ["accent-size", "size"],
      ["hook-wrap", "size"],
      ["visual-face", "face"],
      ["all-picks", "text-overlap"],
      ["transition-text", "text"],
      ["contrast-spot", "contrast"],
      ["contrast-stay", "contrast"],
    ];
    const records = toEngineRecord(
      rules.map(([rule]) => note("moved", { rule })),
      elements,
      [],
      captions,
    );
    expect(records.map((entry) => entry.rule)).toEqual(rules.map(([, mapped]) => mapped));
  });

  it("throws on a rule the record does not name", () => {
    expect(() =>
      toEngineRecord([note("moved", { rule: "no-such-rule" })], elements, [], captions),
    ).toThrow(/unknown rule no-such-rule/);
  });

  it("throws on a note for an element it does not know", () => {
    expect(() =>
      toEngineRecord([note("moved", { item: "nobody" })], elements, [], captions),
    ).toThrow(/no element nobody/);
  });

  it("writes the names a kept-overlapping note sits over as blockers, captions by kind", () => {
    const [written] = toEngineRecord(
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
    const records = toEngineRecord(
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

  it("gives every shown element with no note a placed note, and no other", () => {
    const records = toEngineRecord(
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
    const records = toEngineRecord(
      [note("dropped", { item: "accent-2" }), note("retimed")],
      elements,
      [],
      captions,
    );
    expect(records.map((entry) => entry.outcome)).toEqual(["dropped", "retimed"]);
  });
});
