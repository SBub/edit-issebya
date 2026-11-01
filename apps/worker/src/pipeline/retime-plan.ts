import { silentRuns } from "./envelope.ts";
import type { RetimeSettings } from "./retime-preset.ts";
import type { Word } from "./transcript.ts";

// One piece of the original clip at one speed: `orig` on the original
// timeline, `new` on the retimed one (seconds).
export interface RetimeSegment {
  orig: [number, number];
  speed: number;
  new: [number, number];
}

export interface RetimePlan {
  segments: RetimeSegment[];
  // The retimed clip's length.
  durationSeconds: number;
}

// Frame-exact pieces while planning: [first frame, end frame, speed].
type Piece = [number, number, number];
type Run = [number, number];

// Float slack when a time sits on a frame point.
const EPSILON = 1e-9;

function frameRange(run: Run, fps: number): { first: number; last: number } {
  return {
    first: Math.floor(run[0] * fps + EPSILON) + 1,
    last: Math.ceil(run[1] * fps - EPSILON) - 1,
  };
}

// The frame point nearest the run's middle strictly inside it; null when none.
function boundaryFrame(run: Run, fps: number): number | null {
  const { first, last } = frameRange(run, fps);
  if (first > last) return null;
  const middle = Math.round(((run[0] + run[1]) / 2) * fps);
  return Math.min(Math.max(middle, first), last);
}

// The whole frame [k, k + 1] inside the run nearest its middle; null when none.
function wholeFrame(run: Run, fps: number): number | null {
  const first = Math.ceil(run[0] * fps - EPSILON);
  const last = Math.floor(run[1] * fps + EPSILON) - 1;
  if (first > last) return null;
  const middle = Math.round(((run[0] + run[1]) / 2) * fps - 0.5);
  return Math.min(Math.max(middle, first), last);
}

const length = (run: Run) => run[1] - run[0];

// For each pair of neighbouring words, the longest silent run between them (its
// middle after the first word's middle and up to the second's); null when none.
function joinRuns(words: readonly Word[], runs: readonly Run[]): (Run | null)[] {
  const middles = words.map((word) => (word.start + word.end) / 2);
  return words.slice(1).map((_, index) => {
    const after = middles[index]!;
    const before = middles[index + 1]!;
    let best: Run | null = null;
    for (const run of runs) {
      const middle = (run[0] + run[1]) / 2;
      if (middle > after && middle <= before && (!best || length(run) > length(best))) best = run;
    }
    return best;
  });
}

function speedAt(pieces: readonly Piece[], frame: number): number {
  const piece = pieces.find(([a, b]) => frame >= a && frame < b) ?? pieces.at(-1);
  return piece![2];
}

// Splits the pieces so [from, to) has its own speed.
function setSpeed(pieces: Piece[], from: number, to: number, speed: number): Piece[] {
  const out: Piece[] = [];
  for (const [a, b, s] of pieces) {
    if (b <= from || a >= to) {
      out.push([a, b, s]);
      continue;
    }
    if (a < from) out.push([a, from, s]);
    out.push([Math.max(a, from), Math.min(b, to), speed]);
    if (b > to) out.push([to, b, s]);
  }
  return out;
}

// Removes [from, to) from the pieces.
function cut(pieces: Piece[], from: number, to: number): Piece[] {
  const out: Piece[] = [];
  for (const [a, b, s] of pieces) {
    if (a < from) out.push([a, Math.min(b, from), s]);
    if (b > to) out.push([Math.max(a, to), b, s]);
  }
  return out;
}

// Neighbouring pieces at one speed become one.
function merge(pieces: readonly Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const piece of pieces) {
    if (piece[1] <= piece[0]) continue;
    const last = out.at(-1);
    if (last && last[1] === piece[0] && last[2] === piece[2]) last[1] = piece[1];
    else out.push([...piece]);
  }
  return out;
}

// The retime plan (pure). Words in phrases split at silent gaps; slow phrases
// (few words per second, a drawn-out word, a long pause after) play at the slow
// speed, the rest at the base speed. Every boundary is a frame point strictly
// inside a silent run, never on a word join; short gaps get their silent middle
// frame slowed; pauses are cut only when maxPauseSeconds is a number.
export function planRetime({
  words,
  envelope,
  durationSeconds,
  settings,
}: {
  words: readonly Word[];
  envelope: readonly number[];
  durationSeconds: number;
  settings: RetimeSettings;
}): RetimePlan {
  if (words.length === 0) throw new Error("retime: the transcript has no words");
  const fps = settings.frameRate;
  const endFrame = Math.round(durationSeconds * fps);
  if (endFrame < 1) throw new Error(`retime: clip too short (${durationSeconds} s)`);

  // 1. Silent runs, and the one between each pair of words.
  const runs = silentRuns(envelope, settings.silenceDb, settings.envelopeFrameSeconds);
  const joins = joinRuns(words, runs);

  // 2. Phrases: words split at gaps long enough that hold a frame point.
  const separators = joins.map((run) => {
    if (!run || length(run) < settings.phraseGapSeconds) return null;
    const frame = boundaryFrame(run, fps);
    return frame !== null && frame > 0 && frame < endFrame ? { run, frame } : null;
  });
  interface Phrase {
    first: number;
    last: number;
    from: number;
    to: number;
  }
  const phrases: Phrase[] = [];
  let first = 0;
  let from = 0;
  separators.forEach((separator, join) => {
    if (!separator) return;
    phrases.push({ first, last: join, from, to: separator.frame });
    first = join + 1;
    from = separator.frame;
  });
  phrases.push({ first, last: words.length - 1, from, to: endFrame });

  // 3. Slow phrases, merged into stretches; a short stretch stays at base speed.
  const isSlow = (phrase: Phrase) => {
    const own = words.slice(phrase.first, phrase.last + 1);
    const span = own.at(-1)!.end - own[0]!.start;
    const perSecond = span > 0 ? own.length / span : Infinity;
    const drawnOut = own.some((word) => word.end - word.start > settings.drawnOutWordSeconds);
    const after = separators[phrase.last];
    const pauseAfter = after ? length(after.run) >= settings.longPauseSeconds : false;
    return perSecond < settings.slowWordsPerSecond || drawnOut || pauseAfter;
  };
  let pieces: Piece[] = [[0, endFrame, settings.baseSpeed]];
  let stretch = null as { from: number; to: number } | null;
  const closeStretch = () => {
    if (stretch && (stretch.to - stretch.from) / fps >= settings.minSlowStretchSeconds) {
      pieces = setSpeed(pieces, stretch.from, stretch.to, settings.slowSpeed);
    }
    stretch = null;
  };
  for (const phrase of phrases) {
    if (isSlow(phrase)) stretch = { from: stretch?.from ?? phrase.from, to: phrase.to };
    else closeStretch();
  }
  closeStretch();

  // 5. Short gaps between words: the silent middle frame plays at gapRate.
  for (const run of joins) {
    if (!run) continue;
    const frame = wholeFrame(run, fps);
    if (frame === null) continue;
    if (length(run) / speedAt(pieces, frame) >= settings.minGapAfterSeconds) continue;
    pieces = setSpeed(pieces, frame, frame + 1, settings.gapRate);
  }

  // 6. Pause cutting: a pause longer than maxPauseSeconds (retimed) loses its middle.
  if (settings.maxPauseSeconds !== null) {
    for (const run of joins) {
      if (!run) continue;
      const kept =
        settings.maxPauseSeconds * speedAt(pieces, Math.round(((run[0] + run[1]) / 2) * fps));
      if (length(run) <= kept) continue;
      // Whole frames removed around the middle, both cut points inside the run.
      const removed = Math.round((length(run) - kept) * fps);
      const { first: lowest, last: highest } = frameRange(run, fps);
      const cutFrom = Math.max(Math.round(((run[0] + run[1]) / 2) * fps - removed / 2), lowest);
      const cutTo = Math.min(cutFrom + removed, highest);
      if (cutFrom < cutTo) pieces = cut(pieces, cutFrom, cutTo);
    }
  }

  // 7. New times from exact lengths: the encode trims each audio piece to its video.
  let at = 0;
  const segments = merge(pieces).map(([a, b, speed]): RetimeSegment => {
    const start = at;
    at += (b - a) / fps / speed;
    return { orig: [a / fps, b / fps], speed, new: [start, at] };
  });
  return { segments, durationSeconds: at };
}

// An original time on the retimed timeline; a time inside a cut maps to the
// cut point, a time past the end to the end.
export function remapTime(plan: RetimePlan, t: number): number {
  for (const segment of plan.segments) {
    const [a, b] = segment.orig;
    if (t < a) return segment.new[0];
    if (t <= b) return segment.new[0] + (t - a) / segment.speed;
  }
  return plan.durationSeconds;
}
