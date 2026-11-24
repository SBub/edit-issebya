import { COLUMNS, type ColumnKey, type RunScore, prf, sumRuns } from "./curator-score.ts";

// THE COMPARISON TABLE (app_docs/evals.md, "The comparison table"): one row per
// prompt, one column per component plus the overall F1. Each cell is the mean over the repeats and the spread (lowest to
// highest repeat). A repeat is one curator run of every reel, pooled.

// One curator run of one reel as the table reads it. A run with no valid
// answer scores as an answer with no picks (`ok` false): it stays in every
// denominator, and the table counts it.
export interface ScoredRun {
  repeat: number;
  ok: boolean;
  score: RunScore;
}

export interface PromptId {
  id: string;
  label: string;
}

// The mean and the lowest and highest value over the repeats; null when no repeat had one.
export interface Stat {
  mean: number | null;
  min: number | null;
  max: number | null;
}

export interface PromptSummary {
  prompt: PromptId;
  repeats: number;
  // Curator runs with a valid answer, and all that were asked.
  runs: { ok: number; total: number };
  // The F1 of each column.
  f1: Record<ColumnKey, Stat>;
}

function statOf(values: readonly (number | null)[]): Stat {
  const found = values.filter((value): value is number => value !== null);
  if (found.length === 0) return { mean: null, min: null, max: null };
  return {
    mean: found.reduce((a, b) => a + b, 0) / found.length,
    min: Math.min(...found),
    max: Math.max(...found),
  };
}

// The summary of one prompt's runs: `reels` holds every reel's runs, in order of repeat.
export function summarizePrompt(
  prompt: PromptId,
  repeats: number,
  reels: readonly (readonly ScoredRun[])[],
): PromptSummary {
  const all = reels.flat();
  const perRepeat = Array.from({ length: repeats }, (_, at) => {
    const runs = all.filter((run) => run.repeat === at + 1);
    return sumRuns(runs.map((run) => run.score));
  });
  const f1 = Object.fromEntries(
    COLUMNS.map((column) => [
      column.key,
      statOf(perRepeat.map((score) => prf(column.counts(score)).f1)),
    ]),
  ) as Record<ColumnKey, Stat>;
  return {
    prompt,
    repeats,
    runs: { ok: all.filter((run) => run.ok).length, total: all.length },
    f1,
  };
}

// A cell: the mean, and the spread when the repeats differ.
export function statText(stat: Stat): string {
  if (stat.mean === null || stat.min === null || stat.max === null) return "n/a";
  const show = (value: number) => value.toFixed(2);
  const mean = show(stat.mean);
  return show(stat.min) === show(stat.max) ? mean : `${mean} (${show(stat.min)}-${show(stat.max)})`;
}

// The header and the rows of the table as text cells, shared by the console and the report.
export function tableCells(summaries: readonly PromptSummary[]): {
  head: string[];
  rows: string[][];
} {
  return {
    head: ["Prompt", "Runs ok", ...COLUMNS.map((column) => column.title)],
    rows: summaries.map((summary) => [
      `${summary.prompt.id} (${summary.prompt.label})`,
      `${summary.runs.ok}/${summary.runs.total}`,
      ...COLUMNS.map((column) => statText(summary.f1[column.key])),
    ]),
  };
}

// The table for the console: columns padded to their widest cell.
export function renderTableText(summaries: readonly PromptSummary[]): string[] {
  const { head, rows } = tableCells(summaries);
  const widths = head.map((cell, at) =>
    Math.max(cell.length, ...rows.map((row) => row[at]!.length)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, at) => cell.padEnd(widths[at]!))
      .join("  ")
      .trimEnd();
  return [line(head), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)];
}
