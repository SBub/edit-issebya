import { describe, expect, it } from "vitest";
import { type ScoredRun, renderTableText, statText, summarizePrompt } from "./compare-table.ts";
import { type LabelledPick, scoreRun } from "./curator-score.ts";
import type { OwnerMark } from "./owner-marks.ts";
import { labelPick } from "./label.ts";

const marks: OwnerMark[] = [
  { component: "accent", span: { from: 0, to: 1 } },
  { component: "bigword", span: { from: 5, to: 5 } },
];

// A run whose picks are the given marks (so good) or nothing (a failed run).
function run(repeat: number, answered: OwnerMark[] | null): ScoredRun {
  const picks: LabelledPick[] = (answered ?? []).map((pick) => ({
    pick,
    label: labelPick(pick, marks, []),
  }));
  return {
    repeat,
    ok: answered !== null,
    score: scoreRun(picks, marks),
  };
}

const PROMPT = { id: "reel-components@v12", label: "production" };

describe("a prompt's row", () => {
  it("takes the mean and the lowest to highest of each column over the repeats", () => {
    const summary = summarizePrompt(PROMPT, 2, [[run(1, marks), run(2, [marks[0]!])]]);
    // Repeat 1 finds both marks (F1 1), repeat 2 one of the two (precision 1, recall 0.5).
    expect(summary.f1.overall.max).toBe(1);
    expect(summary.f1.overall.min).toBeCloseTo(2 / 3);
    expect(summary.f1.overall.mean).toBeCloseTo((1 + 2 / 3) / 2);
    expect(summary.f1.accent).toEqual({ mean: 1, min: 1, max: 1 });
    expect(summary.f1.bigword).toEqual({ mean: 0.5, min: 0, max: 1 });
    expect(summary.f1.list).toEqual({ mean: null, min: null, max: null });
    expect(summary.runs).toEqual({ ok: 2, total: 2 });
  });

  it("keeps a failed run in the denominators: its marks are missed, and it is counted", () => {
    const summary = summarizePrompt(PROMPT, 2, [[run(1, marks), run(2, null)]]);
    expect(summary.runs).toEqual({ ok: 1, total: 2 });
    expect(summary.f1.overall).toEqual({ mean: 0.5, min: 0, max: 1 });
  });

  it("pools the reels of each repeat before the ratio", () => {
    const summary = summarizePrompt(PROMPT, 1, [[run(1, marks)], [run(1, [])]]);
    // 2 of 4 owner marks matched over two reels, every pick good.
    expect(summary.f1.overall.mean).toBeCloseTo((2 * 1 * 0.5) / 1.5);
  });
});

describe("the table", () => {
  it("shows the mean and the spread, or n/a", () => {
    expect(statText({ mean: 0.5, min: 0.25, max: 0.75 })).toBe("0.50 (0.25-0.75)");
    expect(statText({ mean: 0.5, min: 0.5, max: 0.5 })).toBe("0.50");
    expect(statText({ mean: null, min: null, max: null })).toBe("n/a");
  });

  it("has a row per prompt and a column per component and the run counts", () => {
    const base = summarizePrompt(PROMPT, 1, [[run(1, marks), run(1, null)].slice(0, 1)]);
    const draft = summarizePrompt({ id: "draft:abc", label: "draft" }, 1, [[run(1, null)]]);
    const [head, rule, ...rows] = renderTableText([base, draft]);
    expect(head!.split(/ {2,}/)).toEqual([
      "Prompt",
      "Runs ok",
      "Overall F1",
      "accent",
      "bigword",
      "list (items)",
      "question",
      "visual",
    ]);
    expect(rule).toMatch(/^-+ +-+/);
    expect(rows[0]).toContain("reel-components@v12 (production)");
    expect(rows[0]).toContain("1/1");
    expect(rows[1]).toContain("draft:abc (draft)");
    expect(rows[1]).toContain("0/1");
  });
});
