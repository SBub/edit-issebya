// reel_progress thresholds (see app_docs/analytics.md). A reel loops, so it
// never sends `ended` on its own: a jump from the last tenth back towards the
// start counts as reaching the end (100).

export const PROGRESS_PERCENTS = [25, 50, 100] as const;

export type ProgressPercent = (typeof PROGRESS_PERCENTS)[number];

// How close to the end (as a fraction of the duration) the previous time must
// be for a backwards jump to count as the loop wrapping.
const WRAP_FROM = 0.9;

/**
 * How far through the reel playback has got, from 0 to 1: 1 once the loop has
 * wrapped from near the end back to an earlier time, 0 while the duration is
 * unknown.
 */
export function playedFraction(
  previousTime: number,
  currentTime: number,
  duration: number,
): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  if (currentTime < previousTime && previousTime >= duration * WRAP_FROM) return 1;
  return Math.min(Math.max(currentTime / duration, 0), 1);
}

/** The thresholds the fraction has reached that have not been sent yet, in order. */
export function newThresholds(
  fraction: number,
  sent: ReadonlySet<ProgressPercent>,
): ProgressPercent[] {
  return PROGRESS_PERCENTS.filter((percent) => fraction >= percent / 100 && !sent.has(percent));
}
