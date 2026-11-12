import { type JudgedPick, type Tally, agreement, agrees, score } from "./score.ts";

// THE REPORT: one self-contained HTML page (no script, no outside file) with
// the agreement tables and every pick the judge and the owner disagree on.

export interface ReportInput {
  startedAt: string;
  // `reel-components-judge@v3`, its label, and the model that judged.
  judgePrompt: string;
  judgeLabel: string;
  // The draft's file name, when the judge is a draft.
  judgeFile?: string;
  model: string;
  datasetRevision: number;
  curatorPrompts: string[];
  // The PostHog offline experiment the run was uploaded as.
  experimentId: string;
  picks: JudgedPick[];
  // The judge calls whose answer stayed invalid after the retry.
  failures: { reel: string; run: string; reasons: string[] }[];
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}

export function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function tallyRow(name: string, of: Tally): string {
  const cells = [
    percent(agreement(of)),
    `${of.agree} of ${of.total}`,
    of.approveGood,
    of.rejectBad,
    of.approveBad,
    of.rejectGood,
  ];
  return `<tr><th scope="row">${escapeHtml(name)}</th>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
}

function tallyTable(caption: string, first: string, rows: readonly [string, Tally][]): string {
  const head = [
    first,
    "Agreement",
    "Picks",
    "Approve, good",
    "Reject, bad",
    "Approve, bad",
    "Reject, good",
  ];
  return [
    `<h2>${escapeHtml(caption)}</h2>`,
    '<div class="scroll"><table>',
    `<thead><tr>${head.map((cell) => `<th scope="col">${cell}</th>`).join("")}</tr></thead>`,
    `<tbody>${rows.map(([name, of]) => tallyRow(name, of)).join("")}</tbody>`,
    "</table></div>",
  ].join("\n");
}

function confusionTable(of: Tally): string {
  return [
    "<h2>Confusion</h2>",
    '<div class="scroll"><table class="narrow">',
    '<thead><tr><th></th><th scope="col">Owner good</th><th scope="col">Owner bad</th></tr></thead>',
    "<tbody>",
    `<tr><th scope="row">Judge approve</th><td>${of.approveGood}</td><td class="off">${of.approveBad}</td></tr>`,
    `<tr><th scope="row">Judge reject</th><td class="off">${of.rejectGood}</td><td>${of.rejectBad}</td></tr>`,
    "</tbody></table></div>",
  ].join("\n");
}

function disagreementRow(pick: JudgedPick): string {
  const cells = [
    `${escapeHtml(pick.reel)}<br><span class="dim">${escapeHtml(pick.run)}</span>`,
    pick.component,
    escapeHtml(pick.words),
    `${pick.label}<br><span class="dim">${pick.why}, ${pick.source}</span>`,
    pick.verdict,
    escapeHtml(pick.reason),
    pick.better === null ? '<span class="dim">none</span>' : escapeHtml(pick.better),
  ];
  return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
}

const STYLE = `
:root { --bg: #fbfaf7; --ink: #1d1c1a; --dim: #6b6862; --line: #dedad2; --card: #ffffff; --off: #b3261e; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #161513; --ink: #ecebe7; --dim: #9d9a93; --line: #34322e; --card: #1f1e1b; --off: #f2867d; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--ink);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 32px 0 8px; }
.meta, .dim { color: var(--dim); }
.meta { margin: 0 0 16px; font-size: 13px; }
.big { font-size: 40px; font-weight: 650; font-variant-numeric: tabular-nums; margin: 8px 0 0; }
.scroll { overflow-x: auto; background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
table.narrow { width: auto; }
th, td { text-align: left; vertical-align: top; padding: 8px 12px; border-bottom: 1px solid var(--line); }
tbody tr:last-child > * { border-bottom: 0; }
thead th { font-size: 12px; font-weight: 600; color: var(--dim); white-space: nowrap; }
td.off { color: var(--off); font-weight: 600; }
ul { margin: 0; padding-left: 20px; }
`;

// The whole page. Every text that came from a transcript or from the judge is
// escaped: none of it can become markup.
export function renderReport(input: ReportInput): string {
  const scored = score(input.picks);
  const off = input.picks.filter((pick) => !agrees(pick));
  const meta = [
    `Judge ${input.judgePrompt} (label ${input.judgeLabel}${input.judgeFile ? `, file ${input.judgeFile}` : ""}) on ${input.model}`,
    `curator ${input.curatorPrompts.join(", ") || "none"}`,
    `dataset revision ${input.datasetRevision}`,
    `experiment ${input.experimentId}`,
    input.startedAt,
  ];
  const failures =
    input.failures.length === 0
      ? ""
      : [
          "<h2>Judge calls with no valid answer</h2>",
          "<ul>",
          ...input.failures.map(
            (failure) =>
              `<li>${escapeHtml(failure.reel)}, ${escapeHtml(failure.run)}: ${escapeHtml(failure.reasons.join("; "))}</li>`,
          ),
          "</ul>",
        ].join("\n");
  const disagreements =
    off.length === 0
      ? "<p>None: the judge agrees with every label.</p>"
      : [
          '<div class="scroll"><table>',
          `<thead><tr>${["Reel, run", "Component", "Words", "Code label", "Judge", "Reason", "Better"].map((cell) => `<th scope="col">${cell}</th>`).join("")}</tr></thead>`,
          `<tbody>${off.map(disagreementRow).join("\n")}</tbody>`,
          "</table></div>",
        ].join("\n");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    "<title>Components judge eval</title>",
    `<style>${STYLE}</style>`,
    "</head>",
    "<body><main>",
    "<h1>Components judge eval</h1>",
    `<p class="meta">${meta.map(escapeHtml).join(" · ")}</p>`,
    `<p class="big">${percent(agreement(scored.overall))}</p>`,
    `<p class="meta">judge and owner agree on ${scored.overall.agree} of ${scored.overall.total} picks</p>`,
    confusionTable(scored.overall),
    tallyTable("By source", "Source", [
      ["Owner marks", scored.bySource.owner],
      ["Curator picks", scored.bySource.curator],
    ]),
    tallyTable(
      "By component",
      "Component",
      scored.byComponent.map(({ component, tally }) => [component, tally]),
    ),
    tallyTable(
      "By reel",
      "Reel",
      scored.byReel.map(({ reel, tally }) => [reel, tally]),
    ),
    failures,
    `<h2>Disagreements (${off.length})</h2>`,
    disagreements,
    "</main></body>",
    "</html>",
    "",
  ].join("\n");
}
