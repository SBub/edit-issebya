import { describe, expect, it } from "vitest";
import type { LabelledPick } from "./curator-score.ts";
import {
  COLUMNS,
  NO_COUNTS,
  addCounts,
  itemMatches,
  prf,
  scoreListItems,
  scoreRun,
  sumRuns,
} from "./curator-score.ts";
import type { OwnerMark } from "./owner-marks.ts";
import { labelPick } from "./label.ts";

const accent = (from: number, to: number) => ({ component: "accent" as const, span: { from, to } });
const markOf = (component: OwnerMark["component"], from: number, to: number): OwnerMark => ({
  component,
  span: { from, to },
});

// A pick with the label the code gives it against these marks.
function labelled(pick: OwnerMark, marks: OwnerMark[]): LabelledPick {
  return { pick, label: labelPick(pick, marks, []) };
}

describe("precision, recall and F1", () => {
  it("takes the ratios of the summed counts", () => {
    const value = prf({ picks: 4, good: 3, marks: 5, matched: 2 });
    expect(value.precision).toBeCloseTo(0.75);
    expect(value.recall).toBeCloseTo(0.4);
    expect(value.f1).toBeCloseTo((2 * 0.75 * 0.4) / 1.15);
  });

  it("is 0 with picks and no hit, and 0 with marks and no pick", () => {
    expect(prf({ picks: 2, good: 0, marks: 3, matched: 0 })).toEqual({
      precision: 0,
      recall: 0,
      f1: 0,
    });
    expect(prf({ picks: 0, good: 0, marks: 3, matched: 0 })).toEqual({
      precision: 0,
      recall: 0,
      f1: 0,
    });
  });

  it("is null when there is nothing to score", () => {
    expect(prf(NO_COUNTS)).toEqual({ precision: null, recall: null, f1: null });
  });
});

describe("scoring one answer", () => {
  it("counts a good pick and a matched mark per component, and leaves the rest out", () => {
    const marks = [markOf("accent", 0, 1), markOf("bigword", 9, 9)];
    const picks = [accent(0, 1), accent(5, 5)].map((pick) => labelled(pick, marks));
    const score = scoreRun(picks, marks);
    expect(score.byComponent.accent).toEqual({ picks: 2, good: 1, marks: 1, matched: 1 });
    expect(score.byComponent.bigword).toEqual({ picks: 0, good: 0, marks: 1, matched: 0 });
    expect(score.byComponent.question).toEqual(NO_COUNTS);
    expect(score.overall).toEqual({ picks: 2, good: 1, marks: 2, matched: 1 });
  });

  it("matches a list by its items, like the labels do", () => {
    const list: OwnerMark = {
      component: "list",
      span: { from: 0, to: 9 },
      items: [
        { from: 0, to: 2 },
        { from: 5, to: 9 },
      ],
    };
    const pick = {
      component: "list" as const,
      span: { from: 0, to: 9 },
      items: [
        { from: 0, to: 2 },
        { from: 5, to: 9 },
      ],
    };
    const score = scoreRun([labelled(pick, [list])], [list]);
    expect(score.byComponent.list).toEqual({ picks: 1, good: 1, marks: 1, matched: 1 });
  });

  it("scores nothing for the hook (it is not among the marks)", () => {
    const score = scoreRun([], []);
    expect(score.overall).toEqual(NO_COUNTS);
  });

  it("scores a visual like any other pick, by the words it covers", () => {
    const marks = [markOf("visual", 2, 5)];
    const picks = [markOf("visual", 3, 5), markOf("visual", 9, 9)].map((pick) =>
      labelled(pick, marks),
    );
    expect(scoreRun(picks, marks).byComponent.visual).toEqual({
      picks: 2,
      good: 1,
      marks: 1,
      matched: 1,
    });
  });

  it("scores an answer with no picks as every owner mark missed", () => {
    const score = scoreRun([], [markOf("accent", 0, 1), markOf("visual", 4, 4)]);
    expect(score.overall).toEqual({ picks: 0, good: 0, marks: 2, matched: 0 });
    expect(prf(score.overall).f1).toBe(0);
  });
});

const col = (score: Parameters<(typeof COLUMNS)[number]["counts"]>[0], key: string) =>
  COLUMNS.find((column) => column.key === key)!.counts(score);
const listCol = (score: Parameters<(typeof COLUMNS)[number]["counts"]>[0]) => col(score, "list");

const listOf = (...items: [number, number][]): OwnerMark => ({
  component: "list",
  span: { from: items[0]![0], to: items.at(-1)![1] },
  items: items.map(([from, to]) => ({ from, to })),
});

describe("the list item score", () => {
  it("matches an item by half of the words the two cover together", () => {
    expect(itemMatches({ from: 4, to: 6 }, { from: 5, to: 6 })).toBe(true);
    expect(itemMatches({ from: 0, to: 9 }, { from: 4, to: 5 })).toBe(false);
    expect(itemMatches({ from: 0, to: 1 }, { from: 5, to: 6 })).toBe(false);
  });

  it("counts every item of every list: matched, extra and missed", () => {
    const owner = [listOf([0, 0], [3, 3], [6, 6]), listOf([20, 21], [25, 25])];
    const mine = [listOf([0, 0], [3, 3]), listOf([40, 41])];
    expect(scoreListItems(mine, owner)).toEqual({ picks: 3, good: 2, marks: 5, matched: 2 });
  });

  it("gives an item to one owner item only", () => {
    const owner = [listOf([0, 1], [2, 3])];
    expect(scoreListItems([listOf([0, 3])], owner)).toEqual({
      picks: 1,
      good: 1,
      marks: 2,
      matched: 1,
    });
    expect(scoreListItems([listOf([0, 9])], owner)).toEqual({
      picks: 1,
      good: 0,
      marks: 2,
      matched: 0,
    });
  });

  it("does not let a long item block the exact one", () => {
    const owner = [listOf([5, 7])];
    const mine = [listOf([0, 19], [5, 7])];
    expect(scoreListItems(mine, owner)).toEqual({ picks: 2, good: 1, marks: 1, matched: 1 });
  });

  it("leaves an owner list of sections out", () => {
    const sections: OwnerMark = { ...listOf([0, 9], [10, 19]), level: "sections" };
    expect(scoreListItems([listOf([0, 9])], [sections])).toEqual({
      picks: 1,
      good: 0,
      marks: 0,
      matched: 0,
    });
  });

  it("counts nothing without lists, and ignores the other components", () => {
    expect(scoreListItems([accent(0, 1)], [markOf("accent", 0, 1)])).toEqual(NO_COUNTS);
  });

  it("is the list column of a run, summed over runs, beside the whole-list counts", () => {
    const owner = [listOf([0, 0], [3, 3])];
    const run = scoreRun([labelled(listOf([0, 0], [3, 3]), owner)], owner);
    const twice = sumRuns([run, run]);
    expect(listCol(twice)).toEqual({ picks: 4, good: 4, marks: 4, matched: 4 });
    expect(col(twice, "overall")).toEqual({ picks: 2, good: 2, marks: 2, matched: 2 });
    expect(col(twice, "accent")).toEqual(NO_COUNTS);
  });

  it("has one table column per component, after the overall one", () => {
    expect(COLUMNS.map((column) => column.key)).toEqual([
      "overall",
      "accent",
      "bigword",
      "list",
      "question",
      "visual",
    ]);
    expect(COLUMNS.map((column) => column.scorer)[0]).toBe("curator_f1_overall");
  });
});

describe("pooling runs", () => {
  it("sums the counts of runs before the ratio is taken", () => {
    const marks = [markOf("accent", 0, 1)];
    const hit = scoreRun([labelled(accent(0, 1), marks)], marks);
    const miss = scoreRun([labelled(accent(7, 7), marks)], marks);
    const pooled = sumRuns([hit, miss]);
    expect(pooled.overall).toEqual({ picks: 2, good: 1, marks: 2, matched: 1 });
    expect(prf(pooled.overall).precision).toBeCloseTo(0.5);
    expect(pooled.byComponent.accent).toEqual(pooled.overall);
  });

  it("adds counts", () => {
    expect(addCounts(NO_COUNTS, NO_COUNTS)).toEqual(NO_COUNTS);
  });
});
