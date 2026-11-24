import {
  type ComponentPick,
  COMPONENTS,
  type Component,
  type OwnerMark,
  type Span,
} from "./owner-marks.ts";
import { type Labelled, matchesMark, overlap } from "./label.ts";

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
  // Every component pooled; a list is one pick and one mark.
  overall: Counts;
  byComponent: Record<Component, Counts>;
  // The lists' items, pooled over the lists: picks and marks are items.
  listItems: Counts;
}

// How alike two items are: the words they share over all the words the two
// cover (0 to 1).
function fitOf(mine: Span, theirs: Span): number {
  const shared = overlap(mine, theirs);
  return shared / (mine.to - mine.from + theirs.to - theirs.from + 2 - shared);
}

// An item of the curator's list matches an owner item when the words they
// share are at least half of all the words the two cover together. So "lack of
// knowledge" is matched by "lack of knowledge" or "of knowledge", never by the
// whole sentence that holds it: the owner's item is the short phrase that names it.
export function itemMatches(mine: Span, theirs: Span): boolean {
  return fitOf(mine, theirs) >= 0.5;
}

// The list items of an answer against the owner's: every item of every list.
// Only a pair that `itemMatches` is made, the best fit (most alike, by shared
// words over words covered) first, an item in one pair only. A curator item no
// owner item took is a wrong pick (precision), an owner item no curator item
// took is missed (recall). An owner list of `sections` (whole passages) is
// left out: the curator never produces a passage as a list item.
export function scoreListItems(
  picks: readonly ComponentPick[],
  marks: readonly OwnerMark[],
): Counts {
  const itemsOf = (list: readonly OwnerMark[]) =>
    list
      .filter((one) => one.component === "list" && one.level !== "sections")
      .flatMap((one) => one.items ?? [one.span]);
  const mine = itemsOf(picks);
  const theirs = itemsOf(marks);
  const pairs = theirs
    .flatMap((owner, at) => mine.map((item, with_) => ({ at, with_, fit: fitOf(item, owner) })))
    .filter((pair) => pair.fit >= 0.5)
    .sort((a, b) => b.fit - a.fit || a.at - b.at || a.with_ - b.with_);
  const takenOwner = new Set<number>();
  const takenMine = new Set<number>();
  for (const pair of pairs) {
    if (takenOwner.has(pair.at) || takenMine.has(pair.with_)) continue;
    takenOwner.add(pair.at);
    takenMine.add(pair.with_);
  }
  const matched = takenOwner.size;
  return { picks: mine.length, good: matched, marks: theirs.length, matched };
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
  return {
    overall,
    byComponent,
    listItems: scoreListItems(
      picks.map((one) => one.pick),
      marks,
    ),
  };
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
    listItems: runs.reduce((total, run) => addCounts(total, run.listItems), NO_COUNTS),
  };
}

// THE COLUMNS of the comparison table, the PostHog scorers and the report: one
// entry each, in order. A new component (a SECTION) is its entry in
// `COMPONENTS` and one entry here (and its owner marks and picks where they
// are read); the table, the scorers and the report follow.
export type ColumnKey = "overall" | Component;

export interface Column {
  key: ColumnKey;
  // The table's and the report's heading.
  title: string;
  // The PostHog scorer: its name and what it measures.
  scorer: string;
  description: string;
  // The counts of one run's score this column's F1 is taken from.
  counts: (score: RunScore) => Counts;
}

const componentColumn = (
  key: Component,
  title: string,
  what: string,
  counts: (score: RunScore) => Counts = (score) => score.byComponent[key],
): Column => ({
  key,
  title,
  scorer: `curator_f1_${key}`,
  description: `F1 of the components curator's ${what} against the owner's, 0 to 1 per labelled reel.`,
  counts,
});

export const COLUMNS: readonly Column[] = [
  {
    key: "overall",
    title: "Overall F1",
    scorer: "curator_f1_overall",
    description:
      "F1 of the components curator's picks against the owner's marks (every component pooled, a list counted as one pick, visuals included), 0 to 1 per labelled reel.",
    counts: (score) => score.overall,
  },
  componentColumn("accent", "accent", "accent picks"),
  componentColumn("bigword", "bigword", "big word picks"),
  componentColumn("list", "list (items)", "list items", (score) => score.listItems),
  componentColumn("question", "question", "question picks"),
  componentColumn("visual", "visual", "visual picks"),
];
