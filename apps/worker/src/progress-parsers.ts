// Reads a long step's progress from its tool's own output, one line at a time.
// HyperFrames 0.8.222's `hyperframes render`, with stdout not a terminal,
// prints one `@hf-progress {...,"pct":N}` line per progress report; the
// worker's own person mask entry (head_track) and the cut-out's MODNet entry
// print the same line shape for each frame. Every other line, and a line whose JSON does not parse, gives null.
export type ProgressParser = (line: string) => number | null;

const PREFIX = "@hf-progress ";

const hfProgress: ProgressParser = (line) => {
  const text = line.trim();
  if (!text.startsWith(PREFIX)) return null;
  let report: unknown;
  try {
    report = JSON.parse(text.slice(PREFIX.length));
  } catch {
    return null;
  }
  const pct = (report as { pct?: unknown } | null)?.pct;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
  return Math.round(Math.min(100, Math.max(0, pct)));
};

// Each step names its own parser, so either can follow its tool later.
export const parseRenderProgress: ProgressParser = hfProgress;
export const parsePersonMaskProgress: ProgressParser = hfProgress;
export const parseCutoutProgress: ProgressParser = hfProgress;

// A parser for one part of a step made of several tool calls: the call's own
// 0 to 100 mapped onto `from` to `to` of the step (the cut-out's spans, each
// weighted by its length), so the step's progress keeps rising.
export function partProgress(parser: ProgressParser, from: number, to: number): ProgressParser {
  return (line) => {
    const pct = parser(line);
    return pct === null ? null : Math.round(from + ((to - from) * pct) / 100);
  };
}
