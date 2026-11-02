import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { silentRuns } from "./envelope.ts";
import { type RetimePlan, planRetime, remapTime } from "./retime-plan.ts";
import { RETIME_PRESET, type RetimeSettings } from "./retime-preset.ts";
import { type Word, normaliseHyperframes, remapTranscript } from "./transcript.ts";

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

function boundaries(plan: RetimePlan) {
  return plan.segments.slice(1).map((segment, index) => ({
    before: plan.segments[index]!,
    after: segment,
  }));
}

function expectValid(plan: RetimePlan, input: typeof SYNTHETIC, settings = RETIME_PRESET) {
  const runs = runsOf(input.envelope, settings);
  const end = Math.round(input.durationSeconds * FPS) / FPS;
  // Tiles [0, end] in order, gaps only where a cut removed time.
  expect(plan.segments[0]!.orig[0]).toBe(0);
  expect(plan.segments.at(-1)!.orig[1]).toBeCloseTo(end, 9);
  for (const { before, after } of boundaries(plan)) {
    expect(after.orig[0]).toBeGreaterThanOrEqual(before.orig[1] - EPSILON);
    expect(after.new[0]).toBeCloseTo(before.new[1], 9);
    // Every boundary (both sides of a cut) inside a silent run, on a frame point.
    for (const t of [before.orig[1], after.orig[0]]) {
      expect(inside(t, runs), `boundary ${t}`).toBeDefined();
      expect(Math.abs(t * FPS - Math.round(t * FPS))).toBeLessThan(EPSILON);
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
  // Word times keep their order and every id.
  const retimed = remapTranscript({ words: input.words as Word[] }, (t) => remapTime(plan, t));
  expect(retimed.words.map((word) => word.id)).toEqual(input.words.map((word) => word.id));
  let previous = 0;
  for (const word of retimed.words) {
    expect(word.start).toBeGreaterThanOrEqual(previous);
    expect(word.end).toBeGreaterThanOrEqual(word.start);
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
    expect(speedAt(5.5)).toBe(1.05);
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
      const plan = planRetime({ ...input, settings: RETIME_PRESET });
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

  it("cuts a 1.2 s pause to 0.4 s inside the pause", () => {
    const settings = { ...RETIME_PRESET, maxPauseSeconds: 0.4 };
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
    const cuts = boundaries(plan).filter(
      ({ before, after }) => after.orig[0] > before.orig[1] + EPSILON,
    );
    expect(cuts).toHaveLength(1);
    const [{ before, after }] = cuts as [(typeof cuts)[number]];
    expect(before.orig[1]).toBeGreaterThan(1.2);
    expect(after.orig[0]).toBeLessThan(2.4);
    const pause = remapTime(plan, 2.4) - remapTime(plan, 1.2);
    expect(Math.abs(pause - 0.4)).toBeLessThanOrEqual(FRAME);
    // A time inside the cut maps to the cut point.
    expect(remapTime(plan, 1.8)).toBeCloseTo(before.new[1], 9);
  });

  it("keeps every rule on the rethink-work reference", () => {
    const plan = planRetime({ ...REFERENCE, settings: RETIME_PRESET });
    expectValid(plan, REFERENCE);
    const speeds = new Set(plan.segments.map((segment) => segment.speed));
    expect(speeds).toEqual(new Set([1.05, 1.1, 0.6]));
    // The recording is 52.01 s; at 1.05x to 1.1x it comes out between the two.
    expect(plan.durationSeconds).toBeGreaterThan(52 / 1.1);
    expect(plan.durationSeconds).toBeLessThan(52 / 1.05 + 1);
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
