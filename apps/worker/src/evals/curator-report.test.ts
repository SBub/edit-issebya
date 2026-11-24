import { describe, expect, it } from "vitest";
import { type CuratorReport, renderCuratorReport } from "./curator-report.ts";
import { scoreRun } from "./curator-score.ts";
import { summarizePrompt } from "./compare-table.ts";

const score = scoreRun([], [{ component: "accent", span: { from: 0, to: 1 } }]);

describe("the curator report", () => {
  it("shows the side-by-side owner marks and each run's picks, escaping every transcript word", () => {
    const report: CuratorReport = {
      startedAt: "2026-11-12T10:00:00.000Z",
      curator: { id: "draft:abcdef123456", label: "draft", file: "c.txt" },
      decideModel: "model-a",
      repeats: 1,
      datasetRevision: 6,
      experimentId: "exp-1",
      summary: summarizePrompt({ id: "draft:abcdef123456", label: "draft" }, 1, [
        [
          {
            repeat: 1,
            ok: true,
            score,
          },
        ],
      ]),
      overall: score,
      cases: [
        {
          reel: "aaaaaaaa",
          versionNumber: 2,
          notes: [],
          intensity: "intense",
          targetPicks: 3,
          marks: [{ component: "accent", words: "<b>work</b>" }],
          runs: [
            {
              repeat: 1,
              picks: [
                {
                  component: "accent",
                  words: "<i>live</i>",
                  label: "bad",
                  why: "extra",
                },
              ],
              score,
            },
          ],
          score,
        },
      ],
      skipped: [{ reel: "bbbbbbbb", reason: "no version" }],
    };
    const html = renderCuratorReport(report);
    expect(html).toContain("Owner marks");
    expect(html).toContain("Curator run 1");
    expect(html).toContain("&lt;b&gt;work&lt;/b&gt;");
    expect(html).toContain("&lt;i&gt;live&lt;/i&gt;");
    expect(html).not.toContain("judge");
    expect(html).toContain("Skipped reels");
    expect(html).toContain("Comparison table");
    expect(html).toContain("draft:abcdef123456 (draft)");
    expect(html).not.toContain("<script");
  });
});
