// What the audio says about a transcript's gaps, shared by retime (which never
// cuts a possible missed word) and transcribe's re-listen (which hears it
// again): the gaps between the words, the clip's speech level, and the
// stretches of sustained speech-level sound inside a gap. Pure.
import { loudRuns } from "./envelope.ts";
import type { Word } from "./transcript.ts";

// The three values this listening depends on (retime's preset holds them
// under these names; re-listen passes its own).
export interface SpeechSettings {
  envelopeFrameSeconds: number;
  // A possible missed word: sound in a transcript gap no more than this many dB
  // under the clip's speech level...
  missedSpeechBelowSpeechDb: number;
  // ...for at least this long without a break.
  missedSpeechSeconds: number;
}

export type Run = [number, number];

// Float slack when a time sits on a frame point.
export const EPSILON = 1e-9;

export const length = (run: Run) => run[1] - run[0];

// The transcript's gaps on [0, clipEnd]: before the first word, between
// neighbouring words (from the latest word end so far to the next start),
// after the last word. `join` is i for the gap between word i and word i + 1,
// null for the two at the clip's ends.
interface Gap {
  run: Run;
  join: number | null;
}

export function gapsOf(words: readonly Word[], clipEnd: number): Gap[] {
  const clamp = (t: number) => Math.min(Math.max(t, 0), clipEnd);
  const gaps: Gap[] = [];
  const lead = clamp(words[0]!.start);
  if (lead > 0) gaps.push({ run: [0, lead], join: null });
  let reach = clamp(words[0]!.end);
  words.slice(1).forEach((word, join) => {
    const start = clamp(word.start);
    if (start > reach) gaps.push({ run: [reach, start], join });
    reach = Math.max(reach, clamp(word.end));
  });
  if (clipEnd > reach) gaps.push({ run: [reach, clipEnd], join: null });
  return gaps;
}

// The clip's speech level: the median level of the envelope frames that lie
// whole inside a word's span. Null when no frame does.
export function speechLevel(
  words: readonly Word[],
  envelope: readonly number[],
  settings: SpeechSettings,
): number | null {
  const step = settings.envelopeFrameSeconds;
  const spoken = new Set<number>();
  for (const word of words) {
    const first = Math.max(Math.ceil(word.start / step - EPSILON), 0);
    const end = Math.min(Math.floor(word.end / step + EPSILON), envelope.length);
    for (let frame = first; frame < end; frame += 1) spoken.add(frame);
  }
  const levels = [...spoken].map((frame) => envelope[frame]!).sort((a, b) => a - b);
  return levels.length === 0 ? null : levels[Math.floor(levels.length / 2)]!;
}

// The level a sound must reach to count as speech: the speech level less
// missedSpeechBelowSpeechDb. Null when the clip has no speech level.
export function speechThreshold(
  words: readonly Word[],
  envelope: readonly number[],
  settings: SpeechSettings,
): number | null {
  const level = speechLevel(words, envelope, settings);
  return level === null ? null : level - settings.missedSpeechBelowSpeechDb;
}

// The parts of the frame-aligned `runs` inside [from, to], whole envelope
// frames only.
export function framesWithin(runs: readonly Run[], [from, to]: Run, step: number): Run[] {
  const first = Math.ceil(from / step - EPSILON) * step;
  const last = Math.floor(to / step + EPSILON) * step;
  return runs
    .map(([a, b]): Run => [Math.max(a, first), Math.min(b, last)])
    .filter(([a, b]) => b > a + EPSILON);
}

// The possible missed words inside one gap: every unbroken run of frames at
// speech level (in `loud`) at least missedSpeechSeconds long. A shorter burst
// (a breath, a click, a movement) is not one.
function missedIn(gap: Run, loud: readonly Run[], settings: SpeechSettings): Run[] {
  return framesWithin(loud, gap, settings.envelopeFrameSeconds).filter(
    (run) => length(run) >= settings.missedSpeechSeconds - EPSILON,
  );
}

// `gap` without the `kept` stretches inside it (in order).
export function without(gap: Run, kept: readonly Run[]): Run[] {
  const parts: Run[] = [];
  let from = gap[0];
  for (const [a, b] of kept) {
    if (a > from + EPSILON) parts.push([from, a]);
    from = b;
  }
  if (gap[1] > from + EPSILON) parts.push([from, gap[1]]);
  return parts;
}

// The pauses: the transcript decides, the audio only holds back a possible
// missed word. Every gap of the transcript is a pause, whatever its loudness,
// except the stretches of sustained speech-level sound inside it (`missed`),
// which split it into the pauses before and after them. Nothing inside a
// word's span, start to end, is ever a pause. `joins[i]` is the longest pause
// between word i and word i + 1, null when there is none.
export function pausesOf(
  words: readonly Word[],
  envelope: readonly number[],
  clipEnd: number,
  settings: SpeechSettings,
): { runs: Run[]; joins: (Run | null)[]; missed: Run[] } {
  const threshold = speechThreshold(words, envelope, settings);
  const loud =
    threshold === null ? [] : loudRuns(envelope, threshold, settings.envelopeFrameSeconds);
  const runs: Run[] = [];
  const missed: Run[] = [];
  const joins: (Run | null)[] = words.slice(1).map(() => null);
  for (const gap of gapsOf(words, clipEnd)) {
    const kept = missedIn(gap.run, loud, settings);
    const pauses = without(gap.run, kept);
    missed.push(...kept);
    runs.push(...pauses);
    if (gap.join === null) continue;
    joins[gap.join] = pauses.reduce<Run | null>(
      (best, run) => (best && length(best) >= length(run) ? best : run),
      null,
    );
  }
  return { runs, joins, missed };
}

// The clip's end for the planner: its length, or its audio's when longer.
export function clipEndOf(
  envelope: readonly number[],
  durationSeconds: number,
  settings: SpeechSettings,
): number {
  return Math.max(durationSeconds, envelope.length * settings.envelopeFrameSeconds);
}

// The possible missed words of a clip (pure), as [start, end] original
// seconds: what pause cutting keeps inside the transcript's gaps (pausesOf).
export function missedSpeech({
  words,
  envelope,
  durationSeconds,
  settings,
}: {
  words: readonly Word[];
  envelope: readonly number[];
  durationSeconds: number;
  settings: SpeechSettings;
}): Run[] {
  if (words.length === 0) return [];
  const clipEnd = clipEndOf(envelope, durationSeconds, settings);
  return pausesOf(words, envelope, clipEnd, settings).missed;
}
