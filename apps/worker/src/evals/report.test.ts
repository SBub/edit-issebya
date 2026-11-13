import { describe, expect, it } from "vitest";
import { type ReportInput, renderReport } from "./report.ts";
import { type JudgedPick, agreement, score, tally } from "./score.ts";

const pick = (
  label: "good" | "bad",
  verdict: "approve" | "reject",
  more: Partial<JudgedPick> = {},
): JudgedPick => ({
  reel: "aaaaaaaa",
  run: "aaaaaaaa v2 reel-components@v7",
  id: "p1",
  component: "accent",
  words: "work to live",
  label,
  why: label === "good" ? "match" : "extra",
  source: "curator",
  verdict,
  reason: "a reason",
  better: null,
  ...more,
});

const PICKS: JudgedPick[] = [
  pick("good", "approve"),
  pick("good", "reject", { id: "p2", words: "the <b>owner's</b> mark", reason: "too & plain" }),
  pick("bad", "approve", { id: "p3", component: "bigword", words: "live", why: "wrong-component" }),
  pick("bad", "reject", { id: "p4", component: "list", reel: "bbbbbbbb", better: "fair pay" }),
  pick("bad", "reject", { id: "p5", component: "list", reel: "bbbbbbbb" }),
];

describe("the score", () => {
  it("splits the owner's marks and the curator's picks, each with its own agreement", () => {
    const owner = [
      pick("good", "approve", { id: "o1", source: "owner", why: "owner" }),
      pick("good", "reject", { id: "o2", source: "owner", why: "owner" }),
    ];
    const scored = score([...owner, pick("bad", "reject")]);
    expect(scored.bySource.owner).toEqual(tally(owner));
    expect(agreement(scored.bySource.owner)).toBeCloseTo(0.5);
    expect(agreement(scored.bySource.curator)).toBe(1);
    expect(scored.overall.total).toBe(3);
    expect(agreement(score([]).bySource.owner)).toBeNull();
  });

  it("counts the confusion table and the agreement", () => {
    expect(tally(PICKS)).toEqual({
      total: 5,
      agree: 3,
      approveGood: 1,
      approveBad: 1,
      rejectGood: 1,
      rejectBad: 2,
    });
    expect(agreement(tally(PICKS))).toBeCloseTo(0.6);
    expect(agreement(tally([]))).toBeNull();
  });

  it("splits by component (every scored one, in order) and by reel", () => {
    const scored = score(PICKS);
    expect(scored.overall.agree).toBe(3);
    expect(
      scored.byComponent.map(({ component, tally: of }) => [component, of.agree, of.total]),
    ).toEqual([
      ["accent", 1, 2],
      ["bigword", 0, 1],
      ["list", 2, 2],
      ["question", 0, 0],
    ]);
    expect(scored.byReel.map(({ reel, tally: of }) => [reel, of.agree, of.total])).toEqual([
      ["aaaaaaaa", 1, 3],
      ["bbbbbbbb", 2, 2],
    ]);
  });
});

describe("the report", () => {
  const input: ReportInput = {
    startedAt: "2026-11-12T10:00:00.000Z",
    judgePrompt: "reel-components-judge@v1",
    judgeLabel: "production",
    model: "anthropic/claude-haiku-5.5",
    datasetRevision: 6,
    curatorPrompts: ["reel-components@v7"],
    experimentId: "experiment-id",
    picks: PICKS,
    failures: [{ reel: "cccccccc", run: "cccccccc v2", reasons: ['"p2" has no verdict'] }],
  };
  const html = renderReport(input);

  it("is one self-contained page with a light and a dark theme", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).not.toMatch(/<script|<link|src=|https?:/);
  });

  it("shows the agreement, the run's identity and the tables", () => {
    expect(html).toContain('<p class="big">60.0%</p>');
    expect(html).toContain("judge and owner agree on 3 of 5 picks");
    expect(html).toContain("Judge reel-components-judge@v1 (label production)");
    expect(html).toContain("curator reel-components@v7");
    expect(html).toContain("dataset revision 6");
    expect(html).toContain('<th scope="row">question</th><td>n/a</td><td>0 of 0</td>');
    expect(html).toContain('<th scope="row">bbbbbbbb</th><td>100.0%</td>');
    expect(html).toContain('<th scope="row">Judge approve</th><td>1</td><td class="off">1</td>');
    expect(html).toContain('<th scope="row">Owner marks</th><td>n/a</td><td>0 of 0</td>');
    expect(html).toContain('<th scope="row">Curator picks</th><td>60.0%</td><td>3 of 5</td>');
  });

  it("lists every disagreement, and only those, with the label, the verdict, the reason and better", () => {
    expect(html).toContain("<h2>Disagreements (2)</h2>");
    const rows = html.slice(html.indexOf("<h2>Disagreements")).match(/<tr><td>/g);
    expect(rows).toHaveLength(2);
    expect(html).toContain("<td>bigword</td><td>live</td>");
    expect(html).toContain('bad<br><span class="dim">wrong-component, curator</span>');
    expect(html).toContain("<td>approve</td><td>a reason</td>");
    expect(html).not.toContain("fair pay");
  });

  it("escapes every text from a transcript or from the judge", () => {
    expect(html).toContain("the &lt;b&gt;owner&#39;s&lt;/b&gt; mark");
    expect(html).toContain("too &amp; plain");
    expect(html).not.toContain("<b>owner");
  });

  it("names the judge calls that gave no valid answer", () => {
    expect(html).toContain("Judge calls with no valid answer");
    expect(html).toContain("cccccccc, cccccccc v2: &quot;p2&quot; has no verdict");
    expect(renderReport({ ...input, failures: [] })).not.toContain("no valid answer");
  });

  it("says so when the judge agrees with every label", () => {
    const agreed = renderReport({ ...input, picks: [PICKS[0]!] });
    expect(agreed).toContain("None: the judge agrees with every label.");
  });
});

describe("the report's judge line", () => {
  it("names a draft by its id and its file, a PostHog version by its label alone", () => {
    const draft = renderReport({
      startedAt: "2026-11-12T10:00:00.000Z",
      judgePrompt: "draft:ba7816bf8f01",
      judgeLabel: "draft",
      judgeFile: "judge-v9.txt",
      model: "anthropic/claude-haiku-5.5",
      datasetRevision: 6,
      curatorPrompts: [],
      experimentId: "experiment-id",
      picks: [],
      failures: [],
    });
    expect(draft).toContain(
      "Judge draft:ba7816bf8f01 (label draft, file judge-v9.txt) on anthropic/claude-haiku-5.5",
    );
  });
});
