import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { silentRuns } from "./envelope.ts";
import { type RetimePlan, planRetime, remapTime, retimeTranscript } from "./retime-plan.ts";
import { RETIME_PRESET, type RetimeSettings } from "./retime-preset.ts";
import { type Word, normaliseHyperframes } from "./transcript.ts";

const FPS = RETIME_PRESET.frameRate;
const FRAME = 1 / FPS;
const EPSILON = 1e-6;

// A synthetic envelope: speech (-20 dB) everywhere but the given silent runs.
function envelopeWith(durationSeconds: number, silent: [number, number][]): number[] {
  const step = RETIME_PRESET.envelopeFrameSeconds;
  return Array.from({ length: Math.round(durationSeconds / step) }, (_, index) => {
    const t = index * step;
    return silent.some(([a, b]) => t >= a - EPSILON && t + step <= b + EPSILON) ? -60 : -20;
  });
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

// 6 s: a fast phrase, a 0.2 s gap, a slow phrase holding a 50 ms gap, a
// 0.5 s pause, a fast phrase, trailing silence.
const SYNTHETIC_SILENCE: [number, number][] = [
  [0, 0.2],
  [1.0, 1.2],
  [2.0, 2.05],
  [3.0, 3.5],
  [5.0, 6.0],
];
const SYNTHETIC_WORDS = normaliseHyperframes([
  ...spoken(["one", "two", "three", "four", "five"], 0.2, 1.0),
  ...spoken(["slow"], 1.2, 2.0),
  ...spoken(["and", "steady"], 2.05, 3.0),
  ...spoken(["six", "seven", "eight", "nine", "ten", "eleven"], 3.5, 5.0),
]).words;
const SYNTHETIC = {
  words: SYNTHETIC_WORDS,
  envelope: envelopeWith(6, SYNTHETIC_SILENCE),
  durationSeconds: 6,
};

const REFERENCE_DIR = new URL("testdata/rethink-work/", import.meta.url);
function reference<T>(name: string): T {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a committed test fixture
  return JSON.parse(readFileSync(new URL(name, REFERENCE_DIR), "utf8")) as T;
}
const REFERENCE_ENVELOPE = reference<number[]>("envelope-1x.json");
const REFERENCE = {
  words: normaliseHyperframes(reference("transcript-1x.json")).words,
  envelope: REFERENCE_ENVELOPE,
  durationSeconds: REFERENCE_ENVELOPE.length * RETIME_PRESET.envelopeFrameSeconds,
};

function runsOf(envelope: number[], settings: RetimeSettings = RETIME_PRESET) {
  return silentRuns(envelope, settings.silenceDb, settings.envelopeFrameSeconds);
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

// Pause cutting off: the clip keeps all of its time.
const UNCUT: RetimeSettings = { ...RETIME_PRESET, maxPauseSeconds: null };

const onFrame = (t: number) => Math.abs(t * FPS - Math.round(t * FPS)) < EPSILON;

function expectValid(plan: RetimePlan, input: typeof SYNTHETIC, settings = RETIME_PRESET) {
  const runs = runsOf(input.envelope, settings);
  const end = Math.round(input.durationSeconds * FPS) / FPS;
  // Tiles [0, end] in order, gaps only where a cut removed time; a trimmed
  // start or end is a frame point inside the edge's silent run.
  const start = plan.segments[0]!.orig[0];
  if (start !== 0) {
    expect(inside(start, runs)?.[0], `start ${start}`).toBeCloseTo(0, 9);
    expect(onFrame(start)).toBe(true);
  }
  const last = plan.segments.at(-1)!.orig[1];
  if (Math.abs(last - end) > EPSILON) {
    expect(inside(last, runs)?.[1], `end ${last}`).toBeCloseTo(runs.at(-1)![1], 9);
    expect(onFrame(last)).toBe(true);
  }
  for (const { before, after } of boundaries(plan)) {
    expect(after.orig[0]).toBeGreaterThanOrEqual(before.orig[1] - EPSILON);
    expect(after.new[0]).toBeCloseTo(before.new[1], 9);
    // Every boundary (both sides of a cut) inside a silent run, on a frame point.
    for (const t of [before.orig[1], after.orig[0]]) {
      expect(inside(t, runs), `boundary ${t}`).toBeDefined();
      expect(onFrame(t)).toBe(true);
    }
    // A base/slow speed boundary only in a gap long enough to stay a gap.
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
  // Removed original time is silent audio: each removed span inside one silent
  // run (word intervals are not consulted).
  const removed: [number, number][] = [
    [0, plan.segments[0]!.orig[0]],
    ...cutsOf(plan).map(({ before, after }): [number, number] => [before.orig[1], after.orig[0]]),
    [plan.segments.at(-1)!.orig[1], end],
  ];
  for (const [a, b] of removed) {
    if (b - a < EPSILON) continue;
    const run = inside(a, runs);
    expect(run, `removed [${a}, ${b}]`).toBeDefined();
    expect(b).toBeLessThanOrEqual(Math.max(run![1], end) + EPSILON);
  }
  // Word times keep their order and every id.
  expectOrdered(retimedWords(plan, input, settings), input.words, plan);
}

function retimedWords(plan: RetimePlan, input: typeof SYNTHETIC, settings = RETIME_PRESET) {
  return retimeTranscript({
    transcript: { words: input.words as Word[] },
    plan,
    envelope: input.envelope,
    settings,
  }).words;
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
  it("keeps every boundary in silence on the synthetic clip", () => {
    const plan = planRetime({ ...SYNTHETIC, settings: RETIME_PRESET });
    expectValid(plan, SYNTHETIC);
    // No boundary falls inside a word.
    for (const { before } of boundaries(plan)) {
      const t = before.orig[1];
      expect(SYNTHETIC_WORDS.some((w) => t > w.start + EPSILON && t < w.end - EPSILON)).toBe(false);
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

  it("slows the silent middle frame of a short gap, and only that frame", () => {
    const plan = planRetime({ ...SYNTHETIC, settings: RETIME_PRESET });
    const slowed = plan.segments.filter((segment) => segment.speed === RETIME_PRESET.gapRate);
    expect(slowed).toHaveLength(1);
    expect(slowed[0]!.orig[0]).toBeCloseTo(2.0, 9);
    expect(slowed[0]!.orig[1]).toBeCloseTo(2.0 + FRAME, 9);
  });

  it("leaves a short gap without a whole frame alone", () => {
    const words = normaliseHyperframes([
      ...spoken(["a", "b", "c"], 0, 1.01),
      ...spoken(["d", "e", "f"], 1.05, 2.0),
    ]).words;
    const plan = planRetime({
      words,
      envelope: envelopeWith(2, [[1.01, 1.05]]),
      durationSeconds: 2,
      settings: RETIME_PRESET,
    });
    expect(plan.segments).toEqual([{ orig: [0, 2], speed: 1.05, new: [0, 2 / 1.05] }]);
  });

  it("plays the whole clip at the base speed without a gap long enough", () => {
    const words = normaliseHyperframes(
      spoken(["a", "b", "c", "d", "e", "f", "g", "h"], 0, 2),
    ).words;
    const plan = planRetime({
      words,
      envelope: envelopeWith(2, []),
      durationSeconds: 2,
      settings: RETIME_PRESET,
    });
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

  it("cuts a 1.2 s pause to 0.3 s inside the pause", () => {
    const settings = RETIME_PRESET;
    const input = {
      words: normaliseHyperframes([
        ...spoken(["one", "two", "three", "four", "five"], 0.2, 1.2),
        ...spoken(["six", "seven", "eight", "nine", "ten"], 2.4, 3.4),
      ]).words,
      envelope: envelopeWith(4, [
        [0, 0.2],
        [1.2, 2.4],
        [3.4, 4],
      ]),
      durationSeconds: 4,
    };
    const plan = planRetime({ ...input, settings });
    expectValid(plan, input, settings);
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
    expect(speeds).toEqual(new Set([1.05, 1.1, 0.6]));
    // The recording is 52.01 s; at 1.05x to 1.1x it comes out between the two.
    expect(uncut.durationSeconds).toBeGreaterThan(52 / 1.1);
    expect(uncut.durationSeconds).toBeLessThan(52 / 1.05 + 1);
    // Its longest silence is 0.31 s, so the default cuts nothing there.
    expect(planRetime({ ...REFERENCE, settings: RETIME_PRESET })).toEqual(uncut);
  });

  it("cuts a pause at a slow to base speed boundary, both sides in silence", () => {
    // SYNTHETIC's 0.5 s pause after the slow phrase: 0.45 s once sped up.
    const plan = planRetime({ ...SYNTHETIC, settings: RETIME_PRESET });
    expectValid(plan, SYNTHETIC);
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

  it("keeps a short leading silence and the short gap's slowed frame", () => {
    const plan = planRetime({ ...SYNTHETIC, settings: RETIME_PRESET });
    // 0.2 s before the first word stays whole.
    expect(plan.segments[0]!.orig[0]).toBe(0);
    const slowed = plan.segments.filter((segment) => segment.speed === RETIME_PRESET.gapRate);
    expect(slowed).toHaveLength(1);
    expect(slowed[0]!.orig[0]).toBeCloseTo(2.0, 9);
  });

  it("trims a long leading and trailing silence to 0.3 s next to the speech", () => {
    const input = {
      words: normaliseHyperframes(spoken(["one", "two", "three", "four", "five"], 1.5, 2.5)).words,
      envelope: envelopeWith(5, [
        [0, 1.5],
        [2.5, 5],
      ]),
      durationSeconds: 5,
    };
    const plan = planRetime({ ...input, settings: RETIME_PRESET });
    expectValid(plan, input);
    expect(cutsOf(plan)).toHaveLength(0);
    const start = plan.segments[0]!.orig[0];
    const end = plan.segments.at(-1)!.orig[1];
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(1.5);
    expect(end).toBeGreaterThan(2.5);
    expect(end).toBeLessThan(5);
    // 0.3 s of silence before the first word and after the last, give or take a frame.
    const map = (t: number) => remapTime(plan, t);
    expect(Math.abs(map(1.5) - 0.3)).toBeLessThanOrEqual(FRAME);
    expect(Math.abs(plan.durationSeconds - map(2.5) - 0.3)).toBeLessThanOrEqual(FRAME);
    // Times before the trim map to the start, after it to the end.
    expect(map(0.2)).toBe(0);
    expect(map(4.5)).toBe(plan.durationSeconds);
    const retimed = retimedWords(plan, input);
    expect(retimed[0]!.start).toBeCloseTo(map(1.5), 3);
  });

  // Like IMG_2013: whisper pins the first word at 0 across 3 s of leading
  // silence and spreads the opening words over it, and starts a word 0.6 s
  // into a 1.2 s pause.
  const PINNED = {
    words: normaliseHyperframes([
      { text: "there", start: 0, end: 1.02 },
      { text: "are", start: 1.02, end: 1.62 },
      { text: "two", start: 1.63, end: 2.24 },
      { text: "hardest", start: 2.92, end: 3.67 },
      ...spoken(["things", "in", "life"], 3.67, 5.5),
      { text: "patience", start: 6.1, end: 6.9 },
      ...spoken(["and", "time"], 6.9, 7.5),
    ]).words,
    envelope: envelopeWith(8, [
      [0, 3.2],
      [5.5, 6.7],
      [7.5, 8],
    ]),
    durationSeconds: 8,
  };

  it("cuts by the audio, not the word intervals: leading silence and a pause", () => {
    const plan = planRetime({ ...PINNED, settings: RETIME_PRESET });
    expectValid(plan, PINNED);
    const map = (t: number) => remapTime(plan, t);
    // The leading 3.2 s keep 0.3 s before the speech, the first word ignored.
    expect(plan.segments[0]!.orig[0]).toBeGreaterThan(2.5);
    expect(Math.abs(map(3.2) - 0.3)).toBeLessThanOrEqual(FRAME);
    // The pause is cut around its own middle, under "patience" (6.1).
    const cuts = cutsOf(plan);
    expect(cuts).toHaveLength(1);
    const [{ before, after }] = cuts as [(typeof cuts)[number]];
    expect(before.orig[1]).toBeGreaterThan(5.5);
    expect(after.orig[0]).toBeGreaterThan(6.1);
    expect(after.orig[0]).toBeLessThan(6.7);
    expect(Math.abs(map(6.7) - map(5.5) - 0.3)).toBeLessThanOrEqual(FRAME);
  });

  it("starts each word pinned in silence at the speech onset, a frame apart", () => {
    const plan = planRetime({ ...PINNED, settings: RETIME_PRESET });
    const words = retimedWords(plan, PINNED);
    expectOrdered(words, PINNED.words, plan);
    const map = (t: number) => remapTime(plan, t);
    const onset = map(3.2);
    const [there, are, two, hardest, things] = words as [Word, Word, Word, Word, Word];
    expect(there.start).toBeCloseTo(onset, 3);
    expect(are.start).toBeCloseTo(onset + FRAME, 2);
    expect(two.start).toBeCloseTo(onset + 2 * FRAME, 2);
    expect(hardest.start).toBeCloseTo(onset + 3 * FRAME, 2);
    // Ends inside the removed silence map to the cut point; a moved word lasts a frame.
    expect(there.end).toBeCloseTo(there.start + FRAME, 2);
    expect(hardest.end).toBeCloseTo(map(3.67), 3);
    // A word starting in speech is not moved.
    expect(things.start).toBeCloseTo(map(3.67), 3);
  });

  it("moves a word start inside a removed pause to the speech onset", () => {
    const plan = planRetime({ ...PINNED, settings: RETIME_PRESET });
    const patience = retimedWords(plan, PINNED).find((word) => word.text === "patience")!;
    expect(patience.start).toBeCloseTo(remapTime(plan, 6.7), 3);
    expect(patience.end).toBeCloseTo(remapTime(plan, 6.9), 3);
  });

  it("moves a word start inside the kept part of a pause to the speech onset", () => {
    // A 0.25 s pause (under the limit, never cut), the next word starting 0.1 s into it.
    const input = {
      words: normaliseHyperframes([
        ...spoken(["one", "two", "three"], 0, 1),
        ...spoken(["four", "five"], 1.1, 2),
      ]).words,
      envelope: envelopeWith(2, [[1, 1.25]]),
      durationSeconds: 2,
    };
    const plan = planRetime({ ...input, settings: RETIME_PRESET });
    expect(cutsOf(plan)).toHaveLength(0);
    const words = retimedWords(plan, input);
    expectOrdered(words, input.words, plan);
    expect(words[3]!.start).toBeCloseTo(remapTime(plan, 1.25), 3);
    expect(words[3]!.end).toBeCloseTo(remapTime(plan, 1.55), 3);
  });

  it("keeps a word start in the trailing silence, inside the clip", () => {
    const input = {
      words: normaliseHyperframes([
        ...spoken(["one", "two"], 0.2, 1),
        { text: "three", start: 1.2, end: 2.5 },
      ]).words,
      envelope: envelopeWith(3, [
        [0, 0.2],
        [1, 3],
      ]),
      durationSeconds: 3,
    };
    const plan = planRetime({ ...input, settings: RETIME_PRESET });
    expectValid(plan, input);
    expect(Math.abs(plan.durationSeconds - remapTime(plan, 1) - 0.3)).toBeLessThanOrEqual(FRAME);
    const words = retimedWords(plan, input);
    expect(words[2]!.start).toBeCloseTo(remapTime(plan, 1.2), 3);
    expect(words[2]!.end).toBeCloseTo(plan.durationSeconds, 3);
  });

  it("leaves a clip silent throughout whole", () => {
    const input = {
      words: normaliseHyperframes(spoken(["quiet", "words"], 0.5, 1.5)).words,
      envelope: envelopeWith(2, [[0, 2]]),
      durationSeconds: 2,
    };
    const plan = planRetime({ ...input, settings: RETIME_PRESET });
    expect(plan.segments[0]!.orig[0]).toBe(0);
    expect(plan.segments.at(-1)!.orig[1]).toBeCloseTo(2, 9);
  });

  it("cuts silence after a noisy clip start as a pause, keeping both edges", () => {
    const input = {
      words: normaliseHyperframes(spoken(["one", "two", "three"], 1.5, 2.5)).words,
      // Room noise in the first 0.1 s and the last 0.1 s.
      envelope: envelopeWith(4, [
        [0.1, 1.5],
        [2.5, 3.9],
      ]),
      durationSeconds: 4,
    };
    const plan = planRetime({ ...input, settings: RETIME_PRESET });
    expectValid(plan, input);
    expect(plan.segments[0]!.orig[0]).toBe(0);
    expect(plan.segments.at(-1)!.orig[1]).toBeCloseTo(4, 9);
    expect(cutsOf(plan)).toHaveLength(2);
  });

  it("refuses an empty transcript", () => {
    expect(() =>
      planRetime({ words: [], envelope: [], durationSeconds: 1, settings: RETIME_PRESET }),
    ).toThrow("retime: the transcript has no words");
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
