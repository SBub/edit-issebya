import { type ComponentPick, COMPONENTS, type Component, type OwnerMark } from "./owner-marks.ts";
import { type Labelled, matchesMark } from "./label.ts";

// THE CURATOR SCORE (app_docs/evals.md, "The curator eval"): a curator answer's
// picks against the owner's marks, by code. Counts are summed first and the
// ratios taken last, so a reel with two runs weighs two runs' picks and marks.

// The counts of one scope (a component, a reel, a set of runs).
export interface Counts {
  // Curator picks, and those labelled good.
  picks: number;
  good: number;
  // Owner marks, and those a curator pick matches.
  marks: number;
  matched: number;
}

export const NO_COUNTS: Counts = { picks: 0, good: 0, marks: 0, matched: 0 };

export function addCounts(a: Counts, b: Counts): Counts {
  return {
    picks: a.picks + b.picks,
    good: a.good + b.good,
    marks: a.marks + b.marks,
    matched: a.matched + b.matched,
  };
}

// Precision: good picks over all picks. Recall: matched marks over all marks.
// With no picks precision is 0 (when there are marks to find); with no marks
// recall is 0 (when there are picks). Both null only when there is nothing to
// score. F1 is the harmonic mean of the two, null when both are null.
export interface Prf {
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export function prf(counts: Counts): Prf {
  if (counts.picks === 0 && counts.marks === 0) return { precision: null, recall: null, f1: null };
  const precision = counts.picks === 0 ? 0 : counts.good / counts.picks;
  const recall = counts.marks === 0 ? 0 : counts.matched / counts.marks;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

// One curator pick with its code label.
export interface LabelledPick {
  pick: ComponentPick;
  label: Labelled;
}

export interface RunScore {
  overall: Counts;
  byComponent: Record<Component, Counts>;
}

function blank(): Record<Component, Counts> {
  return Object.fromEntries(COMPONENTS.map((component) => [component, NO_COUNTS])) as Record<
    Component,
    Counts
  >;
}

// One answer's counts: a pick is good when labelled good; a mark is matched
// when some pick of its component covers it (`matchesMark`, the labels' rule).
// Visuals and the hook are not in the picks or the marks, so they are not scored.
export function scoreRun(picks: readonly LabelledPick[], marks: readonly OwnerMark[]): RunScore {
  const byComponent = blank();
  for (const component of COMPONENTS) {
    const own = picks.filter((one) => one.pick.component === component);
    const owned = marks.filter((mark) => mark.component === component);
    byComponent[component] = {
      picks: own.length,
      good: own.filter((one) => one.label.label === "good").length,
      marks: owned.length,
      matched: owned.filter((mark) => picks.some((one) => matchesMark(one.pick, mark))).length,
    };
  }
  const overall = Object.values(byComponent).reduce(addCounts, NO_COUNTS);
  return { overall, byComponent };
}

// The counts of several runs of one scope, summed by component too.
export function sumRuns(runs: readonly RunScore[]): RunScore {
  const byComponent = blank();
  for (const component of COMPONENTS) {
    byComponent[component] = runs.reduce(
      (total, run) => addCounts(total, run.byComponent[component]),
      NO_COUNTS,
    );
  }
  return {
    overall: runs.reduce((total, run) => addCounts(total, run.overall), NO_COUNTS),
    byComponent,
  };
}

// The judge's approval of a set of picks: approved over judged.
export interface Approval {
  judged: number;
  approved: number;
}

export const NO_APPROVAL: Approval = { judged: 0, approved: 0 };

export function approvalRate(approval: Approval): number | null {
  return approval.judged === 0 ? null : approval.approved / approval.judged;
}
