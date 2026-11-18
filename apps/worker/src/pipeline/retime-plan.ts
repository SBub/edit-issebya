import { loudRuns } from "./envelope.ts";
import type { RetimeSettings } from "./retime-preset.ts";
import {
  EPSILON,
  type Run,
  clipEndOf,
  framesWithin,
  gapsOf,
  length,
  pausesOf,
  speechLevel,
  speechThreshold,
  without,
} from "./speech-gaps.ts";
import { type Transcript, type Word, remapTranscript } from "./transcript.ts";

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

// Whether the video frame [frame, frame + 1] is quiet: every envelope frame
// that touches it is at least gapQuietBelowSpeechDb under the clip's speech
// level. A frame past the audio's end is quiet (nothing sounds there); with
// audio but no speech level to hold it against, no frame is.
function quietFrame(
  frame: number,
  envelope: readonly number[],
  level: number | null,
  settings: RetimeSettings,
): boolean {
  const step = settings.envelopeFrameSeconds;
  const first = Math.max(Math.floor(frame / settings.frameRate / step + EPSILON), 0);
  const end = Math.min(
    Math.ceil((frame + 1) / settings.frameRate / step - EPSILON),
    envelope.length,
  );
  if (first >= end) return true;
  if (level === null) return false;
  const limit = level - settings.gapQuietBelowSpeechDb;
  for (let index = first; index < end; index += 1) {
    if (envelope[index]! > limit) return false;
  }
  return true;
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

// The retime plan (pure), from the transcript first: every word is kept from
// its start to its end, and the pauses are the transcript's gaps, less any
// possible missed word the audio shows inside them (pausesOf). Words in
// phrases split at pauses; slow phrases (few words per second, a drawn-out
// word, a long pause after) play at the slow speed, the rest at the base
// speed. Every boundary is a frame point strictly inside a pause, never inside
// a word; short pauses get their middle frame slowed when that frame is quiet;
// when maxPauseSeconds is a number, every pause is shortened to it.
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

  // 1. The pauses, and the one between each pair of words.
  const audioEnd = envelope.length * settings.envelopeFrameSeconds;
  const clipEnd = clipEndOf(envelope, durationSeconds, settings);
  const { runs, joins } = pausesOf(words, envelope, clipEnd, settings);

  // 2. Phrases: words split at pauses long enough that hold a frame point.
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

  // 5. Short pauses between words: the middle frame plays at gapRate, but
  // only a quiet one. A pause is a gap of the transcript whatever its loudness,
  // so the frame may hold voiced sound (the end of one word running into the
  // next), and a rate under 1x drops the pitch of what it plays: on a voice
  // that is a short deep blip. A frame that is not quiet keeps its speed, and
  // the gap stays as short as it was spoken.
  const level = speechLevel(words, envelope, settings);
  for (const run of joins) {
    if (!run) continue;
    const frame = wholeFrame(run, fps);
    if (frame === null) continue;
    if (length(run) / speedAt(pieces, frame) >= settings.minGapAfterSeconds) continue;
    if (!quietFrame(frame, envelope, level, settings)) continue;
    pieces = setSpeed(pieces, frame, frame + 1, settings.gapRate);
  }

  // 6. Pause cutting: each pause longer than maxPauseSeconds (retimed) keeps
  // that much. A pause between words or kept sounds loses whole frames around its middle;
  // the one from the clip's start, or the one reaching the audio's end, loses
  // the part away from the speech, to the clip's own start or end. Every cut point is a
  // frame point strictly inside the pause, never inside a word, so the end
  // fade falls on the pause too.
  if (settings.maxPauseSeconds !== null) {
    for (const run of runs) {
      const leading = run[0] <= EPSILON;
      const trailing = run[1] >= audioEnd - EPSILON;
      if (leading && trailing) continue;
      const { first: lowest, last: highest } = frameRange(run, fps);
      const at = leading ? highest : trailing ? lowest : Math.round(((run[0] + run[1]) / 2) * fps);
      const kept =
        settings.maxPauseSeconds * speedAt(pieces, Math.min(Math.max(at, 0), endFrame - 1));
      if (length(run) <= kept) continue;
      let cutFrom: number;
      let cutTo: number;
      if (leading) {
        cutFrom = 0;
        cutTo = Math.min(Math.round((run[1] - kept) * fps), highest);
      } else if (trailing) {
        cutFrom = Math.max(Math.round((run[0] + kept) * fps), lowest);
        cutTo = endFrame;
      } else {
        const removed = Math.round((length(run) - kept) * fps);
        cutFrom = Math.max(Math.round(((run[0] + run[1]) / 2) * fps - removed / 2), lowest);
        cutTo = Math.min(cutFrom + removed, highest);
      }
      if (cutFrom < cutTo && (cutFrom > 0 || cutTo < endFrame)) {
        pieces = cut(pieces, cutFrom, cutTo);
      }
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

// The re-check after retiming (pure): the pauses still longer than
// maxPauseSeconds plus a frame on the retimed timeline, as [start, end]
// retimed seconds. Two kinds: a pause of the transcript the plan could not
// shorten, and a stretch inside the words' spans with no frame at speech
// level (a word whose span holds a pause, such as one the aligner could not
// spell), which retime never cuts. None when pause cutting is off.
export function pausesLeft({
  plan,
  words,
  envelope,
  durationSeconds,
  settings,
}: {
  plan: RetimePlan;
  words: readonly Word[];
  envelope: readonly number[];
  durationSeconds: number;
  settings: RetimeSettings;
}): Run[] {
  if (settings.maxPauseSeconds === null || words.length === 0) return [];
  const step = settings.envelopeFrameSeconds;
  const clipEnd = clipEndOf(envelope, durationSeconds, settings);
  const { runs } = pausesOf(words, envelope, clipEnd, settings);
  const threshold = speechThreshold(words, envelope, settings);
  const loud = threshold === null ? [] : loudRuns(envelope, threshold, step);
  // What is not a gap is inside the words' spans; what is not loud is quiet.
  const audio: Run = [0, envelope.length * step];
  const gaps = gapsOf(words, clipEnd).map((gap) => gap.run);
  const quiet = threshold === null ? [] : without(audio, loud);
  const inWords = without([0, clipEnd], gaps).flatMap((span) => framesWithin(quiet, span, step));
  const limit = settings.maxPauseSeconds + 1 / settings.frameRate;
  return [...runs, ...inWords]
    .map(([a, b]): Run => [remapTime(plan, a), remapTime(plan, b)])
    .filter((run) => length(run) > limit + EPSILON)
    .sort((a, b) => a[0] - b[0]);
}

// The retimed transcript (pure): every word time through the plan. Cuts lie
// strictly inside pauses, so no word time falls inside a cut; ids, texts and
// order stay, starts never decrease, no word ends before it starts, and no
// time passes the clip's end once rounded to the millisecond.
export function retimeTranscript({
  transcript,
  plan,
}: {
  transcript: Transcript;
  plan: RetimePlan;
}): Transcript {
  const end = Math.floor(plan.durationSeconds * 1000) / 1000;
  return remapTranscript(transcript, (t) => Math.min(remapTime(plan, t), end));
}
