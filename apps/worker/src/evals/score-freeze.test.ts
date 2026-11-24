import { describe, expect, it } from "vitest";
import { COLUMNS, type LabelledPick, prf, scoreRun, sumRuns } from "./curator-score.ts";
import { labelPick } from "./label.ts";
import type { ComponentPick, OwnerMark } from "./owner-marks.ts";

// THE EVAL SCORING FREEZE (app_docs/component-template.md, step 0): a fixed
// owner's marks and curator picks (word indexes only, no prompt wording, no
// network) through the labels, the per-run score and every column of the
// comparison table, saved byte for byte. Step 5 (the evals' table) must leave
// this file unchanged. A deliberate change to the scoring is a decision:
// refresh it with `yarn workspace @edit-issebya/worker vitest run -u score-freeze`.

const span = (from: number, to: number) => ({ from, to });
const mark = (
  component: OwnerMark["component"],
  from: number,
  to: number,
  items?: [number, number][],
): OwnerMark => ({
  component,
  span: span(from, to),
  ...(items ? { items: items.map(([a, b]) => span(a, b)) } : {}),
});
const pick = (
  component: ComponentPick["component"],
  from: number,
  to: number,
  items?: [number, number][],
): ComponentPick => mark(component, from, to, items);

// Two labelled reels. Each has hits, misses, extras and a pick in the owner's
// setup span (`nothing`), for every component and a list with items.
const REELS: { marks: OwnerMark[]; picks: ComponentPick[]; nothing: ReturnType<typeof span>[] }[] =
  [
    {
      marks: [
        mark("accent", 3, 4),
        mark("accent", 20, 22),
        mark("bigword", 30, 30),
        mark("question", 40, 47),
        mark("visual", 50, 58),
        mark("list", 60, 80, [
          [60, 64],
          [66, 70],
          [72, 80],
        ]),
      ],
      picks: [
        pick("accent", 3, 4),
        pick("accent", 21, 21),
        pick("accent", 90, 91),
        pick("bigword", 30, 31),
        pick("bigword", 55, 55),
        pick("question", 40, 47),
        pick("visual", 50, 58),
        pick("visual", 100, 105),
        pick("list", 60, 80, [
          [60, 64],
          [66, 70],
          [72, 80],
        ]),
        pick("accent", 1, 1),
      ],
      nothing: [span(0, 2)],
    },
    {
      marks: [
        mark("accent", 10, 12),
        mark("bigword", 15, 15),
        mark("question", 25, 30),
        mark("list", 40, 60, [
          [40, 45],
          [50, 60],
        ]),
      ],
      picks: [
        pick("accent", 10, 12),
        pick("bigword", 15, 15),
        pick("question", 70, 75),
        pick("list", 40, 60, [[41, 44]]),
        pick("list", 80, 95, [
          [80, 85],
          [90, 95],
        ]),
      ],
      nothing: [],
    },
  ];

describe("eval scoring freeze", () => {
  it("scores the fixed reels to the same counts, F1 and labels in every column", async () => {
    const runs = REELS.map(({ marks, picks, nothing }) => {
      const labelled: LabelledPick[] = picks.map((one) => ({
        pick: one,
        label: labelPick(one, marks, nothing),
      }));
      return { labelled, score: scoreRun(labelled, marks) };
    });
    const total = sumRuns(runs.map((run) => run.score));
    const out = {
      labels: runs.map((run) => run.labelled.map((one) => one.label)),
      perRun: runs.map((run) => run.score),
      total,
      columns: COLUMNS.map((column) => {
        const counts = column.counts(total);
        return {
          key: column.key,
          title: column.title,
          scorer: column.scorer,
          counts,
          prf: prf(counts),
          perRun: runs.map((run) => prf(column.counts(run.score))),
        };
      }),
    };
    await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot(
      "./testdata/score-freeze.json",
    );
    expect(COLUMNS.map((column) => column.key)).toEqual([
      "overall",
      "accent",
      "bigword",
      "list",
      "question",
      "visual",
    ]);
  });
});
