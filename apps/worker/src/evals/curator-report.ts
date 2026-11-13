import { type Component, COMPONENTS } from "./owner-marks.ts";
import { type Label, type Why } from "./label.ts";
import { type Approval, type Prf, type RunScore, approvalRate, prf } from "./curator-score.ts";
import { STYLE, escapeHtml, percent } from "./report.ts";

// THE CURATOR REPORT: one self-contained HTML page (no script, no outside file):
// the tables by component, by reel and the judge's approval, the failed runs,
// and per reel the owner's marks beside each run's picks.

export interface ReportPick {
  component: Component;
  words: string;
  label: Label;
  why: Why;
  verdict: "approve" | "reject" | null;
}

export interface ReportRun {
  repeat: number;
  failed?: string[];
  picks: ReportPick[];
  score?: RunScore;
  judge?: { judged: number; approved: number } | { failed: string[] } | null;
}

export interface CuratorReport {
  startedAt: string;
  curator: { id: string; label: string; file?: string };
  judge: { id: string; label: string; file?: string };
  decideModel: string;
  judgeModel: string;
  repeats: number;
  datasetRevision: number;
  experimentId: string;
  overall: RunScore;
  approval: Approval;
  cases: {
    reel: string;
    versionNumber: number;
    notes: string[];
    intensity: string;
    targetPicks: number;
    marks: { component: Component; words: string }[];
    runs: ReportRun[];
    score: RunScore;
    approval: Approval;
  }[];
  skipped: { reel: string; reason: string }[];
}

const pct = (value: number | null) => percent(value);
const num = (value: number | null) => (value === null ? "n/a" : value.toFixed(3));

function table(head: string[], rows: string[][], rowHead = true): string {
  return [
    '<div class="scroll"><table>',
    `<thead><tr>${head.map((cell) => `<th scope="col">${cell}</th>`).join("")}</tr></thead>`,
    `<tbody>${rows
      .map(
        (cells) =>
          `<tr>${cells
            .map((cell, at) =>
              rowHead && at === 0 ? `<th scope="row">${cell}</th>` : `<td>${cell}</td>`,
            )
            .join("")}</tr>`,
      )
      .join("")}</tbody>`,
    "</table></div>",
  ].join("\n");
}

function scoreCells(
  counts: { picks: number; good: number; marks: number; matched: number },
  value: Prf,
) {
  return [
    pct(value.precision),
    pct(value.recall),
    num(value.f1),
    `${counts.good} of ${counts.picks}`,
    `${counts.matched} of ${counts.marks}`,
  ];
}

function runRange(runs: readonly ReportRun[]): string {
  const f1s = runs
    .flatMap((run) => (run.score ? [prf(run.score.overall).f1] : []))
    .filter((value): value is number => value !== null);
  if (f1s.length === 0) return "n/a";
  const min = Math.min(...f1s);
  const max = Math.max(...f1s);
  return min === max ? min.toFixed(3) : `${min.toFixed(3)} to ${max.toFixed(3)}`;
}

function pickList(picks: readonly ReportPick[]): string {
  if (picks.length === 0) return '<span class="dim">no picks</span>';
  return `<ul>${picks
    .map(
      (pick) =>
        `<li>${pick.component}: ${escapeHtml(pick.words)} <span class="dim">(${pick.label}, ${pick.why}${pick.verdict ? `, judge ${pick.verdict}` : ""})</span></li>`,
    )
    .join("")}</ul>`;
}

function marksList(marks: readonly { component: Component; words: string }[]): string {
  if (marks.length === 0) return '<span class="dim">no marks</span>';
  return `<ul>${marks
    .map((mark) => `<li>${mark.component}: ${escapeHtml(mark.words)}</li>`)
    .join("")}</ul>`;
}

// The page. Every text from a transcript or from a model is escaped.
export function renderCuratorReport(report: CuratorReport): string {
  const overall = prf(report.overall.overall);
  const approval = approvalRate(report.approval);
  const meta = [
    `Curator ${report.curator.id} (label ${report.curator.label}${report.curator.file ? `, file ${report.curator.file}` : ""}) on ${report.decideModel}`,
    `judge ${report.judge.id} (label ${report.judge.label}${report.judge.file ? `, file ${report.judge.file}` : ""}) on ${report.judgeModel}`,
    `${report.repeats} ${report.repeats === 1 ? "run" : "runs"} per reel`,
    `dataset revision ${report.datasetRevision}`,
    `experiment ${report.experimentId}`,
    report.startedAt,
  ];
  const byComponent = [
    ["Overall", report.overall.overall, overall] as const,
    ...COMPONENTS.map((component) => {
      const counts = report.overall.byComponent[component];
      return [component, counts, prf(counts)] as const;
    }),
  ].map(([name, counts, value]) => [name, ...scoreCells(counts, value)]);
  const byReel = report.cases.map((reel) => {
    const value = prf(reel.score.overall);
    return [
      `${escapeHtml(reel.reel)} v${reel.versionNumber}`,
      num(value.f1),
      pct(value.precision),
      pct(value.recall),
      pct(approvalRate(reel.approval)),
      runRange(reel.runs),
      `${reel.runs.filter((run) => !run.failed).length} of ${reel.runs.length}`,
    ];
  });
  const failures = report.cases.flatMap((reel) =>
    reel.runs
      .filter((run) => run.failed)
      .map(
        (run) =>
          `<li>${escapeHtml(reel.reel)}, run ${run.repeat}: ${escapeHtml((run.failed ?? []).join("; "))}</li>`,
      ),
  );
  const judgeFailures = report.cases.flatMap((reel) =>
    reel.runs.flatMap((run) =>
      run.judge && "failed" in run.judge
        ? [
            `<li>${escapeHtml(reel.reel)}, run ${run.repeat}: ${escapeHtml(run.judge.failed.join("; "))}</li>`,
          ]
        : [],
    ),
  );
  const side = report.cases.map((reel) => {
    const head = ["Owner marks", ...reel.runs.map((run) => `Curator run ${run.repeat}`)];
    const cells = [
      marksList(reel.marks),
      ...reel.runs.map((run) =>
        run.failed ? `<span class="dim">no valid answer</span>` : pickList(run.picks),
      ),
    ];
    const notes =
      reel.notes.length === 0
        ? ""
        : `<ul class="dim">${reel.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>`;
    return [
      `<h2>${escapeHtml(reel.reel)}, version ${reel.versionNumber}</h2>`,
      `<p class="meta">intensity ${escapeHtml(reel.intensity)}, target ${reel.targetPicks} picks</p>`,
      notes,
      `<div class="scroll side"><table class="sides"><thead><tr>${head.map((cell) => `<th scope="col">${cell}</th>`).join("")}</tr></thead>`,
      `<tbody><tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr></tbody></table></div>`,
    ].join("\n");
  });
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    "<title>Components curator eval</title>",
    `<style>${STYLE}${SIDE_STYLE}</style>`,
    "</head>",
    "<body><main>",
    "<h1>Components curator eval</h1>",
    `<p class="meta">${meta.map(escapeHtml).join(" · ")}</p>`,
    `<p class="big">F1 ${num(overall.f1)}</p>`,
    `<p class="meta">precision ${pct(overall.precision)}, recall ${pct(overall.recall)}; judge approval ${pct(approval)} (${report.approval.approved} of ${report.approval.judged} distinct picks)</p>`,
    "<h2>By component</h2>",
    table(["Component", "Precision", "Recall", "F1", "Good picks", "Matched marks"], byComponent),
    "<h2>By reel</h2>",
    table(
      ["Reel", "F1", "Precision", "Recall", "Judge approval", "F1 per run", "Runs answered"],
      byReel,
    ),
    report.skipped.length === 0
      ? ""
      : `<h2>Skipped reels</h2><ul>${report.skipped
          .map((item) => `<li>${escapeHtml(item.reel)}: ${escapeHtml(item.reason)}</li>`)
          .join("")}</ul>`,
    failures.length === 0
      ? ""
      : `<h2>Curator calls with no valid answer</h2><ul>${failures.join("")}</ul>`,
    judgeFailures.length === 0
      ? ""
      : `<h2>Judge calls with no valid answer</h2><ul>${judgeFailures.join("")}</ul>`,
    "<h2>Owner marks and curator picks</h2>",
    side.join("\n"),
    "</main></body>",
    "</html>",
    "",
  ].join("\n");
}

const SIDE_STYLE = `
table.sides { width: 100%; }
table.sides td, table.sides th { width: 25%; }
.side ul { list-style: none; padding-left: 0; }
.side li { margin: 0 0 6px; }
`;
