import type { Label, Source, Why } from "./label.ts";
import { COMPONENTS, type Component } from "./owner-marks.ts";

// THE SCORE: how often the judge's verdict says what the code label says. A
// good pick should be approved, a bad one rejected.

// One pick the judge gave a verdict for, with everything the report shows.
export interface JudgedPick {
  // The labelled reel (the dataset item's reel id) and the curator run judged.
  reel: string;
  run: string;
  id: string;
  component: Component;
  words: string;
  label: Label;
  why: Why;
  sources: Source[];
  verdict: "approve" | "reject";
  reason: string;
  better: string | null;
}

// The confusion table of a set of picks: the judge's verdict against the
// owner's label (through the code), and how many agree.
export interface Tally {
  total: number;
  agree: number;
  approveGood: number;
  approveBad: number;
  rejectGood: number;
  rejectBad: number;
}

export function agrees(pick: Pick<JudgedPick, "label" | "verdict">): boolean {
  return (pick.verdict === "approve") === (pick.label === "good");
}

export function tally(picks: readonly Pick<JudgedPick, "label" | "verdict">[]): Tally {
  const count = (verdict: string, label: Label) =>
    picks.filter((pick) => pick.verdict === verdict && pick.label === label).length;
  const approveGood = count("approve", "good");
  const rejectBad = count("reject", "bad");
  return {
    total: picks.length,
    agree: approveGood + rejectBad,
    approveGood,
    approveBad: count("approve", "bad"),
    rejectGood: count("reject", "good"),
    rejectBad,
  };
}

// The agreement of a tally, 0 to 1; null when it holds no pick.
export function agreement(of: Pick<Tally, "agree" | "total">): number | null {
  return of.total === 0 ? null : of.agree / of.total;
}

export interface Score {
  overall: Tally;
  // Every scored component, in the fixed order, even with no pick.
  byComponent: { component: Component; tally: Tally }[];
  // Every reel that has a judged pick, in first-seen order.
  byReel: { reel: string; tally: Tally }[];
}

export function score(picks: readonly JudgedPick[]): Score {
  const reels = [...new Set(picks.map((pick) => pick.reel))];
  return {
    overall: tally(picks),
    byComponent: COMPONENTS.map((component) => ({
      component,
      tally: tally(picks.filter((pick) => pick.component === component)),
    })),
    byReel: reels.map((reel) => ({
      reel,
      tally: tally(picks.filter((pick) => pick.reel === reel)),
    })),
  };
}
