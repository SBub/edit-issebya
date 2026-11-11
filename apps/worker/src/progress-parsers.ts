// Reads a long step's progress from its tool's own output, one line at a time.
// HyperFrames 0.8.222's `hyperframes render`, with stdout not a terminal,
// prints one `@hf-progress {...,"pct":N}` line per progress report; the
// worker's own U2Net entry (head_track's person mask) and the cut-out's MODNet
// entry print the same line shape for each frame. Every other line, and a line whose JSON does not parse, gives null.
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

// One parser per part of a step made of several tool calls that may run at
// the same time (the cut-out's spans, the head track's chunks): each reads its
// own call's 0 to 100, and gives the step's progress, every part counted by
// its weight (a span's length, a chunk's samples) at the furthest it has
// reported. So the step's progress keeps
// rising, whichever calls are running.
export function weightedProgress(
  parser: ProgressParser,
  weights: readonly number[],
): ProgressParser[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const done = weights.map(() => 0);
  return weights.map((_, index) => (line) => {
    const pct = parser(line);
    if (pct === null) return null;
    done[index] = Math.max(done[index]!, pct);
    if (!(total > 0)) return pct;
    return Math.round(done.reduce((sum, part, at) => sum + part * weights[at]!, 0) / total);
  });
}
