import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type RetimePlan,
  missedSpeech,
  pausesLeft,
  planRetime,
  remapTime,
  retimeTranscript,
  speechLevel,
} from "./retime-plan.ts";
import { RETIME_PRESET, type RetimeSettings } from "./retime-preset.ts";
import { type Word, normaliseHyperframes } from "./transcript.ts";

const FPS = RETIME_PRESET.frameRate;
const FRAME = 1 / FPS;
const EPSILON = 1e-6;

interface Input {
  words: Word[];
  envelope: number[];
  durationSeconds: number;
}

// A synthetic envelope: room noise (-70 dB) in the given quiet runs, speech
// (-20 dB) everywhere else, or the given level over [from, to].
function envelopeWith(
  durationSeconds: number,
  silent: [number, number][],
  levels: { from: number; to: number; db: number }[] = [],
): number[] {
  const step = RETIME_PRESET.envelopeFrameSeconds;
  return Array.from({ length: Math.round(durationSeconds / step) }, (_, index) => {
    const t = index * step;
    const level = levels.find(({ from, to }) => t >= from - EPSILON && t + step <= to + EPSILON);
    if (level) return level.db;
    return silent.some(([a, b]) => t >= a - EPSILON && t + step <= b + EPSILON) ? -70 : -20;
  });
}

// Words and the clip's length, the audio quiet exactly in the transcript's gaps.
function clip(raw: { text: string; start: number; end: number }[], durationSeconds: number): Input {
  const words = normaliseHyperframes(raw).words;
  return {
    words,
    envelope: envelopeWith(durationSeconds, gapsOf(words, durationSeconds)),
    durationSeconds,
  };
}

// Words evenly spread over [from, to], their joins without gaps.
function spoken(
  texts: string[],
  from: number,
  to: number,
): { text: string; start: number; end: number }[] {
  const each = (to - from) / texts.length;
  return texts.map((text, index) => ({
    text,
    start: from + index * each,
    end: from + (index + 1) * each,
  }));
}

// 6 s: a 0.2 s lead, a fast phrase, a 0.2 s gap, a slow phrase holding a 50 ms
// gap, a 0.5 s pause, a fast phrase, 1 s after the last word.
const SYNTHETIC: Input = clip(
  [
    ...spoken(["one", "two", "three", "four", "five"], 0.2, 1.0),
    ...spoken(["slow"], 1.2, 2.0),
    ...spoken(["and", "steady"], 2.05, 3.0),
    ...spoken(["six", "seven", "eight", "nine", "ten", "eleven"], 3.5, 5.0),
  ],
  6,
);

const REFERENCE_DIR = new URL("testdata/rethink-work/", import.meta.url);
function reference<T>(name: string): T {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a committed test fixture
  return JSON.parse(readFileSync(new URL(name, REFERENCE_DIR), "utf8")) as T;
}
const REFERENCE_ENVELOPE = reference<number[]>("envelope-1x.json");
const REFERENCE: Input = {
  words: normaliseHyperframes(reference("transcript-1x.json")).words,
  envelope: REFERENCE_ENVELOPE,
  durationSeconds: REFERENCE_ENVELOPE.length * RETIME_PRESET.envelopeFrameSeconds,
};

// The transcript's gaps, worked out on their own: before the first word,
// between words (after the latest end so far), after the last.
function gapsOf(words: readonly Word[], durationSeconds: number): [number, number][] {
  const runs: [number, number][] = [];
  const [first, ...rest] = words;
  if (first!.start > 0) runs.push([0, first!.start]);
  let reach = first!.end;
  for (const word of rest) {
    if (word.start > reach) runs.push([reach, word.start]);
    reach = Math.max(reach, word.end);
  }
  if (durationSeconds > reach) runs.push([reach, durationSeconds]);
  return runs;
}

// Where a cut or a speed boundary may fall: inside a transcript gap.
function pausesOf(input: Input): [number, number][] {
  return gapsOf(input.words, input.durationSeconds);
}

function inside(t: number, runs: [number, number][]): [number, number] | undefined {
  return runs.find(([a, b]) => t >= a - EPSILON && t <= b + EPSILON);
}

// Neighbouring segments with original time removed between them.
function cutsOf(plan: RetimePlan) {
  return boundaries(plan).filter(({ before, after }) => after.orig[0] > before.orig[1] + EPSILON);
}

function boundaries(plan: RetimePlan) {
  return plan.segments.slice(1).map((segment, index) => ({
    before: plan.segments[index]!,
    after: segment,
  }));
}

// The original time the plan removes: before its first piece, between pieces,
// after its last.
function removedOf(plan: RetimePlan, input: Input): [number, number][] {
  const end = Math.round(input.durationSeconds * FPS) / FPS;
  return [
    [0, plan.segments[0]!.orig[0]] as [number, number],
    ...cutsOf(plan).map(({ before, after }): [number, number] => [before.orig[1], after.orig[0]]),
    [plan.segments.at(-1)!.orig[1], end] as [number, number],
  ].filter(([a, b]) => b - a > EPSILON);
}

// The sustained speech-level sound inside the transcript's gaps, worked out on
// its own frame by frame: runs of missedSpeechSeconds or more of frames no
// more than missedSpeechBelowSpeechDb under the median level inside the words.
function sustainedSpeech(input: Input, settings: RetimeSettings): [number, number][] {
  const step = settings.envelopeFrameSeconds;
  const within = (index: number, [a, b]: [number, number]) =>
    index * step >= a - EPSILON && (index + 1) * step <= b + EPSILON;
  const spoken = input.envelope
    .filter((_, index) => input.words.some((word) => within(index, [word.start, word.end])))
    .sort((a, b) => a - b);
  if (spoken.length === 0) return [];
  const level = spoken[Math.floor(spoken.length / 2)]! - settings.missedSpeechBelowSpeechDb;
  const found: [number, number][] = [];
  for (const gap of pausesOf(input)) {
    let count = 0;
    for (let index = 0; index <= input.envelope.length; index += 1) {
      const loud =
        index < input.envelope.length && within(index, gap) && input.envelope[index]! >= level;
      if (loud) count += 1;
      else {
        if (count * step >= settings.missedSpeechSeconds - EPSILON) {
          found.push([(index - count) * step, index * step]);
        }
        count = 0;
      }
    }
  }
  return found;
}

// Pause cutting off: the clip keeps all of its time.
const UNCUT: RetimeSettings = { ...RETIME_PRESET, maxPauseSeconds: null };

const onFrame = (t: number) => Math.abs(t * FPS - Math.round(t * FPS)) < EPSILON;

function expectValid(plan: RetimePlan, input: Input, settings = RETIME_PRESET) {
  const runs = pausesOf(input);
  for (const { before, after } of boundaries(plan)) {
    expect(after.orig[0]).toBeGreaterThanOrEqual(before.orig[1] - EPSILON);
    expect(after.new[0]).toBeCloseTo(before.new[1], 9);
    // Every boundary (both sides of a cut) inside a pause, on a frame point.
    for (const t of [before.orig[1], after.orig[0]]) {
      expect(inside(t, runs), `boundary ${t}`).toBeDefined();
      expect(onFrame(t)).toBe(true);
    }
    // A base/slow speed boundary only in a pause long enough to stay one.
    const speeds = new Set([before.speed, after.speed]);
    if (speeds.has(settings.baseSpeed) && speeds.has(settings.slowSpeed)) {
      const run = inside(before.orig[1], runs)!;
      expect(run[1] - run[0]).toBeGreaterThanOrEqual(settings.minGapAfterSeconds);
    }
  }
  for (const segment of plan.segments) {
    expect(segment.new[1] - segment.new[0]).toBeCloseTo(
      (segment.orig[1] - segment.orig[0]) / segment.speed,
      9,
    );
  }
  // Removed time lies inside one transcript gap and holds no sustained
  // speech-level sound: no word loses any of its span, no possible missed
  // word is removed.
  const sustained = sustainedSpeech(input, settings);
  for (const [a, b] of removedOf(plan, input)) {
    const run = inside(a, runs);
    expect(run, `removed [${a}, ${b}]`).toBeDefined();
    expect(b).toBeLessThanOrEqual(run![1] + EPSILON);
    for (const word of input.words) {
      expect(b <= word.start + EPSILON || a >= word.end - EPSILON, `${word.text} cut`).toBe(true);
    }
    for (const [from, to] of sustained) {
      expect(b <= from + EPSILON || a >= to - EPSILON, `removed [${a}, ${b}] has speech`).toBe(
        true,
      );
    }
  }
  // Word times keep their order and every id.
  expectOrdered(retimedWords(plan, input), input.words, plan);
}

function retimedWords(plan: RetimePlan, input: Input) {
  return retimeTranscript({ transcript: { words: input.words }, plan }).words;
}

function expectOrdered(retimed: readonly Word[], words: readonly Word[], plan: RetimePlan) {
  expect(retimed.map((word) => word.id)).toEqual(words.map((word) => word.id));
  let previous = 0;
  for (const word of retimed) {
    expect(word.start).toBeGreaterThanOrEqual(previous);
    expect(word.end).toBeGreaterThanOrEqual(word.start);
    expect(word.end).toBeLessThanOrEqual(plan.durationSeconds + EPSILON);
    previous = word.start;
  }
}

describe("planRetime", () => {
  it("keeps every boundary in a pause on the synthetic clip", () => {
    const plan = planRetime({ ...SYNTHETIC, settings: RETIME_PRESET });
    expectValid(plan, SYNTHETIC);
    for (const { before } of boundaries(plan)) {
      const t = before.orig[1];
      expect(SYNTHETIC.words.some((w) => t > w.start + EPSILON && t < w.end - EPSILON)).toBe(false);
    }
  });

  it("plays the slow phrase at the slow speed and the rest at the base speed", () => {
    const plan = planRetime({ ...SYNTHETIC, settings: RETIME_PRESET });
    const speedAt = (t: number) =>
      plan.segments.find((segment) => t >= segment.orig[0] && t < segment.orig[1])!.speed;
    expect(speedAt(0.5)).toBe(1.05);
    expect(speedAt(1.5)).toBe(1.1);
    expect(speedAt(2.5)).toBe(1.1);
    expect(speedAt(4.2)).toBe(1.05);
    expect(speedAt(5.2)).toBe(1.05);
  });

  it("slows the quiet middle frame of a short pause, and only that frame", () => {
    const plan = planRetime({ ...SYNTHETIC, settings: RETIME_PRESET });
    const slowed = plan.segments.filter((segment) => segment.speed === RETIME_PRESET.gapRate);
    expect(slowed).toHaveLength(1);
    expect(slowed[0]!.orig[0]).toBeCloseTo(2.0, 9);
    expect(slowed[0]!.orig[1]).toBeCloseTo(2.0 + FRAME, 9);
  });

  // SYNTHETIC with its 50 ms gap (2.0 to 2.05 s, its middle frame 2.0 to
  // 2.033 s) at the given level; speech is at -20 dB.
  const gapAt = (levels: { from: number; to: number; db: number }[]): Input => ({
    ...SYNTHETIC,
    envelope: envelopeWith(6, gapsOf(SYNTHETIC.words, 6), levels),
  });
  const slowedIn = (input: Input, settings = RETIME_PRESET) =>
    planRetime({ ...input, settings }).segments.filter(
      (segment) => segment.speed === settings.gapRate,
    );

  it("never slows a voiced middle frame: it keeps its phrase's speed", () => {
    // The end of "slow" runs into "and": the gap is 5 dB under the speech level.
    const voiced = gapAt([{ from: 2.0, to: 2.05, db: -25 }]);
    const plan = planRetime({ ...voiced, settings: RETIME_PRESET });
    expectValid(plan, voiced);
    expect(plan.segments.some((segment) => segment.speed < 1)).toBe(false);
    const at = plan.segments.find((segment) => segment.orig[0] <= 2.0 && segment.orig[1] > 2.03)!;
    expect(at.speed).toBe(RETIME_PRESET.slowSpeed);
    // Nothing else changes: the plan is the quiet clip's without the slowed
    // frame, shorter by what the slowing added.
    const quiet = planRetime({ ...SYNTHETIC, settings: RETIME_PRESET });
    expect(quiet.durationSeconds - plan.durationSeconds).toBeCloseTo(
      FRAME / RETIME_PRESET.gapRate - FRAME / RETIME_PRESET.slowSpeed,
      9,
    );
  });

  it("takes a frame for quiet at gapQuietBelowSpeechDb under the speech level, not above", () => {
    expect(RETIME_PRESET.gapQuietBelowSpeechDb).toBe(20);
    // -40 dB is 20 dB under the speech level: quiet. One dB louder is not.
    expect(slowedIn(gapAt([{ from: 2.0, to: 2.05, db: -40 }]))).toHaveLength(1);
    expect(slowedIn(gapAt([{ from: 2.0, to: 2.05, db: -39 }]))).toHaveLength(0);
    // The setting moves the line.
    const strict = { ...RETIME_PRESET, gapQuietBelowSpeechDb: 30 };
    expect(slowedIn(gapAt([{ from: 2.0, to: 2.05, db: -40 }]), strict)).toHaveLength(0);
    expect(slowedIn(gapAt([{ from: 2.0, to: 2.05, db: -50 }]), strict)).toHaveLength(1);
  });

  it("does not slow a frame that is quiet only in part", () => {
    // 10 ms of sound at speech level inside the frame (2.02 to 2.03 s).
    expect(slowedIn(gapAt([{ from: 2.02, to: 2.03, db: -20 }]))).toHaveLength(0);
    // The same sound after the frame's end (2.04 to 2.05 s) does not count.
    expect(slowedIn(gapAt([{ from: 2.04, to: 2.05, db: -20 }]))).toHaveLength(1);
  });

  it("leaves a short pause without a whole frame alone", () => {
    const input = clip(
      [...spoken(["a", "b", "c"], 0, 1.01), ...spoken(["d", "e", "f"], 1.05, 2.0)],
      2,
    );
    const plan = planRetime({ ...input, settings: RETIME_PRESET });
    expect(plan.segments).toEqual([{ orig: [0, 2], speed: 1.05, new: [0, 2 / 1.05] }]);
  });

  it("plays the whole clip at the base speed without a pause long enough", () => {
    const input = clip(spoken(["a", "b", "c", "d", "e", "f", "g", "h"], 0, 2), 2);
    const plan = planRetime({ ...input, settings: RETIME_PRESET });
    expect(plan.segments).toEqual([{ orig: [0, 2], speed: 1.05, new: [0, 2 / 1.05] }]);
  });

  it("removes no time with pause cutting off", () => {
    for (const input of [SYNTHETIC, REFERENCE]) {
      const plan = planRetime({ ...input, settings: UNCUT });
      expect(plan.segments[0]!.orig[0]).toBe(0);
      expect(plan.segments.at(-1)!.orig[1]).toBeCloseTo(
        Math.round(input.durationSeconds * FPS) / FPS,
        9,
      );
      plan.segments.slice(1).forEach((segment, index) => {
        expect(segment.orig[0]).toBeCloseTo(plan.segments[index]!.orig[1], 9);
      });
      const total = plan.segments.reduce(
        (sum, segment) => sum + (segment.orig[1] - segment.orig[0]) / segment.speed,
        0,
      );
      expect(plan.durationSeconds).toBeCloseTo(total, 9);
    }
  });

  it("cuts pauses to 0.3 s by default", () => {
    expect(RETIME_PRESET.maxPauseSeconds).toBe(0.3);
  });

  it("cuts a 1.2 s pause between words to 0.3 s inside the pause", () => {
    const input = clip(
      [
        ...spoken(["one", "two", "three", "four", "five"], 0.2, 1.2),
        ...spoken(["six", "seven", "eight", "nine", "ten"], 2.4, 3.4),
      ],
      3.6,
    );
    const plan = planRetime({ ...input, settings: RETIME_PRESET });
    expectValid(plan, input);
    const cuts = cutsOf(plan);
    expect(cuts).toHaveLength(1);
    const [{ before, after }] = cuts as [(typeof cuts)[number]];
    expect(before.orig[1]).toBeGreaterThan(1.2);
    expect(after.orig[0]).toBeLessThan(2.4);
    const pause = remapTime(plan, 2.4) - remapTime(plan, 1.2);
    expect(Math.abs(pause - 0.3)).toBeLessThanOrEqual(FRAME);
    // A time inside the cut maps to the cut point.
    expect(remapTime(plan, 1.8)).toBeCloseTo(before.new[1], 9);
  });

  it("keeps every rule on the rethink-work reference", () => {
    const uncut = planRetime({ ...REFERENCE, settings: UNCUT });
    expectValid(uncut, REFERENCE, UNCUT);
    const speeds = new Set(uncut.segments.map((segment) => segment.speed));
    // Its six short gaps between words are not quiet (five at the speech level
    // or above it, one 19.9 dB under it), so no middle frame is slowed.
    expect(speeds).toEqual(new Set([1.05, 1.1]));
    const loose = { ...UNCUT, gapQuietBelowSpeechDb: 19 };
    const slowed = planRetime({ ...REFERENCE, settings: loose }).segments.filter(
      (segment) => segment.speed === 0.6,
    );
    expect(slowed).toHaveLength(1);
    expect(slowed[0]!.orig[0]).toBeCloseTo(41 / 30, 9);
    // The recording is 52.01 s; at 1.05x to 1.1x it comes out between the two.
    expect(uncut.durationSeconds).toBeGreaterThan(52 / 1.1);
    expect(uncut.durationSeconds).toBeLessThan(52 / 1.05 + 1);
    // Its gaps between words are short: the default cuts little, and
    // keeps every word whole.
    const cut = planRetime({ ...REFERENCE, settings: RETIME_PRESET });
    expectValid(cut, REFERENCE);
    expect(uncut.durationSeconds - cut.durationSeconds).toBeLessThan(1);
  });

  it("cuts a pause at a slow to base speed boundary, both sides in the pause", () => {
    // SYNTHETIC's 0.5 s pause after the slow phrase: 0.45 s once sped up.
    const plan = planRetime({ ...SYNTHETIC, settings: RETIME_PRESET });
    const cuts = cutsOf(plan);
    expect(cuts).toHaveLength(1);
    const [{ before, after }] = cuts as [(typeof cuts)[number]];
    expect(before.speed).toBe(RETIME_PRESET.slowSpeed);
    expect(after.speed).toBe(RETIME_PRESET.baseSpeed);
    expect(before.orig[1]).toBeGreaterThan(3.0);
    expect(after.orig[0]).toBeLessThan(3.5);
    const pause = remapTime(plan, 3.5) - remapTime(plan, 3.0);
    expect(Math.abs(pause - 0.3)).toBeLessThanOrEqual(FRAME);
  });

  it("keeps a short lead before the first word whole", () => {
    const plan = planRetime({ ...SYNTHETIC, settings: RETIME_PRESET });
    expect(plan.segments[0]!.orig[0]).toBe(0);
  });

  it("trims a long lead and tail to 0.3 s next to the first and last word", () => {
    const input = clip(spoken(["one", "two", "three", "four", "five"], 1.5, 2.5), 5);
    const plan = planRetime({ ...input, settings: RETIME_PRESET });
    expectValid(plan, input);
    expect(cutsOf(plan)).toHaveLength(0);
    const start = plan.segments[0]!.orig[0];
    const end = plan.segments.at(-1)!.orig[1];
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(1.5);
    expect(end).toBeGreaterThan(2.5);
    expect(end).toBeLessThan(5);
    const map = (t: number) => remapTime(plan, t);
    expect(Math.abs(map(1.5) - 0.3)).toBeLessThanOrEqual(FRAME);
    expect(Math.abs(plan.durationSeconds - map(2.5) - 0.3)).toBeLessThanOrEqual(FRAME);
    // Times before the trim map to the start, after it to the end.
    expect(map(0.2)).toBe(0);
    expect(map(4.5)).toBe(plan.durationSeconds);
    expect(retimedWords(plan, input)[0]!.start).toBeCloseTo(map(1.5), 3);
  });

  it("never cuts inside a word, however quiet the word is", () => {
    // Like the owner's "publicly": its ending at -55 dB, in a quiet room
    // (-70 dB), with a 1 s silent gap after it.
    const words = normaliseHyperframes([
      { text: "share", start: 0, end: 0.4 },
      { text: "publicly", start: 0.4, end: 1.3 },
      { text: "on", start: 2.3, end: 2.5 },
    ]).words;
    const input: Input = {
      words,
      envelope: envelopeWith(2.5, [[1.3, 2.3]], [{ from: 0.9, to: 1.3, db: -55 }]),
      durationSeconds: 2.5,
    };
    const plan = planRetime({ ...input, settings: RETIME_PRESET });
    expectValid(plan, input);
    const map = (t: number) => remapTime(plan, t);
    const retimed = retimedWords(plan, input);
    expect(retimed[1]!.end - retimed[1]!.start).toBeCloseTo((1.3 - 0.4) / 1.1, 2);
    // Only the gap after it is a pause, cut to 0.3 s.
    expect(Math.abs(map(2.3) - map(1.3) - 0.3)).toBeLessThanOrEqual(FRAME);
  });

  // The owner's piece by piece recording: speech at -11 dB, 3 s between two
  // pieces at -31 dB (room, breathing) with the given sounds in it.
  function pieces(sounds: { from: number; to: number; db: number }[]): Input {
    const words = normaliseHyperframes([
      ...spoken(["one", "two", "three"], 0, 1),
      ...spoken(["four", "five", "six"], 4, 5),
    ]).words;
    return {
      words,
      envelope: envelopeWith(
        5,
        [],
        [
          ...sounds,
          { from: 0, to: 1, db: -11 },
          { from: 1, to: 4, db: -31 },
          { from: 4, to: 5, db: -11 },
        ],
      ),
      durationSeconds: 5,
    };
  }

  it("cuts a long noisy pause to 0.3 s, whatever its loudness", () => {
    // Bursts of 50 ms at -8 dB (a click, a movement) and a 0.2 s breath at
    // speech level: none lasts long enough to be a word.
    const input = pieces([
      { from: 1.5, to: 1.55, db: -8 },
      { from: 2.2, to: 2.4, db: -11 },
      { from: 3.3, to: 3.35, db: -8 },
    ]);
    expect(missedSpeech({ ...input, settings: RETIME_PRESET })).toEqual([]);
    const plan = planRetime({ ...input, settings: RETIME_PRESET });
    expectValid(plan, input);
    expect(cutsOf(plan)).toHaveLength(1);
    const pause = remapTime(plan, 4) - remapTime(plan, 1);
    expect(Math.abs(pause - 0.3)).toBeLessThanOrEqual(FRAME);
    expect(pausesLeft({ plan, ...input, settings: RETIME_PRESET })).toEqual([]);
  });

  it("keeps 0.5 s of speech-level sound in a pause and cuts around it", () => {
    // A word the transcript missed: 0.5 s at -15 dB, within 10 dB of the speech.
    const input = pieces([{ from: 2.2, to: 2.7, db: -15 }]);
    const missed = missedSpeech({ ...input, settings: RETIME_PRESET });
    expect(missed).toHaveLength(1);
    expect(missed[0]![0]).toBeCloseTo(2.2, 9);
    expect(missed[0]![1]).toBeCloseTo(2.7, 9);
    const plan = planRetime({ ...input, settings: RETIME_PRESET });
    expectValid(plan, input);
    // The pause before it and the one after are each cut to 0.3 s; the sound
    // itself plays whole, about half of a kept pause on each side of it.
    const cuts = cutsOf(plan);
    expect(cuts).toHaveLength(2);
    expect(cuts[0]!.after.orig[0]).toBeLessThan(2.2 - 0.1);
    expect(cuts[1]!.before.orig[1]).toBeGreaterThan(2.7 + 0.1);
    const map = (t: number) => remapTime(plan, t);
    expect(Math.abs(map(2.2) - map(1) - 0.3)).toBeLessThanOrEqual(FRAME);
    expect(Math.abs(map(4) - map(2.7) - 0.3)).toBeLessThanOrEqual(FRAME);
    const speed = plan.segments.find((segment) => segment.orig[0] <= 2.2 && segment.orig[1] >= 2.7);
    expect(speed).toBeDefined();
    expect(map(2.7) - map(2.2)).toBeCloseTo(0.5 / speed!.speed, 9);
  });

  it("does not take a sound quieter than speech for a missed word", () => {
    // 0.5 s at -25 dB, 14 dB under the speech: part of the pause.
    const input = pieces([{ from: 2.2, to: 2.7, db: -25 }]);
    expect(missedSpeech({ ...input, settings: RETIME_PRESET })).toEqual([]);
    const plan = planRetime({ ...input, settings: RETIME_PRESET });
    expectValid(plan, input);
    expect(cutsOf(plan)).toHaveLength(1);
  });

  it("removes nothing from a gap that is speech-level sound throughout", () => {
    // Speech throughout at -20 dB, the 0.5 s gap included: all of the gap is
    // sustained speech-level sound, so nothing is removed.
    const input: Input = {
      words: normaliseHyperframes([...spoken(["a", "b"], 0, 1), ...spoken(["c", "d"], 1.5, 2)])
        .words,
      envelope: envelopeWith(2, []),
      durationSeconds: 2,
    };
    const plan = planRetime({ ...input, settings: RETIME_PRESET });
    expect(removedOf(plan, input)).toEqual([]);
  });

  it("finds no pause between overlapping words", () => {
    // Whisper places "inside" within "long": no gap between them, and the
    // quiet under "long" is not a pause.
    const words = normaliseHyperframes([
      { text: "long", start: 0, end: 2 },
      { text: "inside", start: 0.5, end: 1 },
      { text: "after", start: 1.5, end: 2.2 },
    ]).words;
    const input: Input = { words, envelope: envelopeWith(2.2, [[0.2, 1.4]]), durationSeconds: 2.2 };
    const plan = planRetime({ ...input, settings: RETIME_PRESET });
    expectValid(plan, input);
    expect(removedOf(plan, input)).toEqual([]);
  });

  it("maps every word time through the plan, unchanged otherwise", () => {
    const plan = planRetime({ ...SYNTHETIC, settings: RETIME_PRESET });
    const words = retimedWords(plan, SYNTHETIC);
    words.forEach((word, index) => {
      const original = SYNTHETIC.words[index]!;
      expect(word.text).toBe(original.text);
      expect(word.start).toBeCloseTo(remapTime(plan, original.start), 3);
      expect(word.end).toBeCloseTo(remapTime(plan, original.end), 3);
    });
  });

  it("refuses an empty transcript", () => {
    expect(() =>
      planRetime({ words: [], envelope: [], durationSeconds: 1, settings: RETIME_PRESET }),
    ).toThrow("retime: the transcript has no words");
  });
});

describe("speechLevel", () => {
  it("is the median level inside the words' spans, the gaps left out", () => {
    // 1 s of words at -11 dB with a quieter 0.3 s inside them, 3 s of pause.
    const words = normaliseHyperframes(spoken(["one", "two", "three"], 0, 1)).words;
    const envelope = envelopeWith(
      4,
      [[1, 4]],
      [
        { from: 0, to: 0.7, db: -11 },
        { from: 0.7, to: 1, db: -30 },
      ],
    );
    expect(speechLevel(words, envelope, RETIME_PRESET)).toBe(-11);
  });

  it("is null when no frame lies inside a word", () => {
    const words = normaliseHyperframes([{ text: "a", start: 1, end: 1 }]).words;
    expect(speechLevel(words, envelopeWith(2, []), RETIME_PRESET)).toBeNull();
    expect(
      missedSpeech({
        words,
        envelope: envelopeWith(2, []),
        durationSeconds: 2,
        settings: RETIME_PRESET,
      }),
    ).toEqual([]);
  });
});

describe("pausesLeft", () => {
  it("finds no pause left when every pause was cut", () => {
    const plan = planRetime({ ...SYNTHETIC, settings: RETIME_PRESET });
    expect(pausesLeft({ plan, ...SYNTHETIC, settings: RETIME_PRESET })).toEqual([]);
  });

  it("names a quiet stretch inside a word's span, which retime never cuts", () => {
    // A word's span stretched over a pause: "Friction" from 0.1 s to 3 s, heard from 2.5 s.
    const words = normaliseHyperframes([
      { text: "Friction", start: 0.1, end: 3 },
      ...spoken(["is", "anything", "that", "slows", "you", "down"], 3, 6),
    ]).words;
    const input: Input = {
      words,
      envelope: envelopeWith(6, [[0, 2.5]]),
      durationSeconds: 6,
    };
    const plan = planRetime({ ...input, settings: RETIME_PRESET });
    expectValid(plan, input);
    const left = pausesLeft({ plan, ...input, settings: RETIME_PRESET });
    expect(left).toHaveLength(1);
    // The 2.4 s inside the word, at the slow speed.
    expect(left[0]![0]).toBeCloseTo(remapTime(plan, 0.1), 3);
    expect(left[0]![1]).toBeCloseTo(remapTime(plan, 2.5), 3);
  });

  it("reports nothing with pause cutting off", () => {
    const plan = planRetime({ ...SYNTHETIC, settings: UNCUT });
    expect(pausesLeft({ plan, ...SYNTHETIC, settings: UNCUT })).toEqual([]);
  });
});

describe("remapTime", () => {
  const plan: RetimePlan = {
    segments: [
      { orig: [0, 1], speed: 2, new: [0, 0.5] },
      { orig: [2, 3], speed: 1, new: [0.5, 1.5] },
    ],
    durationSeconds: 1.5,
  };

  it("maps through each segment, a cut to its point, past the end to the end", () => {
    expect(remapTime(plan, 0.5)).toBe(0.25);
    expect(remapTime(plan, 1.5)).toBe(0.5);
    expect(remapTime(plan, 2.5)).toBe(1);
    expect(remapTime(plan, 9)).toBe(1.5);
  });
});
