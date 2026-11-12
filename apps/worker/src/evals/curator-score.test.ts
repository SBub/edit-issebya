import { describe, expect, it } from "vitest";
import type { LabelledPick } from "./curator-score.ts";
import { NO_COUNTS, addCounts, approvalRate, prf, scoreRun, sumRuns } from "./curator-score.ts";
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

  it("scores nothing for visuals or the hook (they are not among the marks)", () => {
    const score = scoreRun([], []);
    expect(score.overall).toEqual(NO_COUNTS);
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

  it("reads the judge's approval rate over the judged picks", () => {
    expect(approvalRate({ judged: 4, approved: 3 })).toBeCloseTo(0.75);
    expect(approvalRate({ judged: 0, approved: 0 })).toBeNull();
    expect(addCounts(NO_COUNTS, NO_COUNTS)).toEqual(NO_COUNTS);
  });
});
