import { describe, expect, it } from "vitest";
import { EXPORT_FPS, clipFrames, reelFrames } from "./span-frames.ts";

describe("reelFrames", () => {
  it("counts every started frame", () => {
    expect(EXPORT_FPS).toBe(30);
    expect(reelFrames(2.69)).toBe(81);
    expect(reelFrames(32.667)).toBe(981);
    expect(reelFrames(3)).toBe(90);
    expect(reelFrames(1 / 30)).toBe(1);
  });
});

describe("clipFrames", () => {
  it("puts a clip on frames ceil(start x 30) to ceil(end x 30) - 1", () => {
    // A span on whole frames: 15 to 45, 30 frames, none held.
    expect(clipFrames({ start: 0.5, end: 1.5 }, 900)).toEqual({
      first: 15,
      last: 44,
      count: 30,
      extracted: 30,
      held: [],
    });
  });

  it("holds the last frame of a span on screen one frame longer than it extracts", () => {
    // Measured on a real export: frames 481 to 533 (53 frames), 1.734 s x 30 =
    // 52.02 rounds to 52 extracted frames, so frame 533 repeats frame 532.
    expect(clipFrames({ start: 16.033, end: 17.767 }, 980)).toEqual({
      first: 481,
      last: 533,
      count: 53,
      extracted: 52,
      held: [533],
    });
  });

  it("holds nothing when the millisecond rounding goes the other way", () => {
    // 16.067 to 17.733: frames 483 to 531, 49 frames, 1.666 s x 30 = 49.98
    // rounds to 50 extracted: more than it shows, nothing held.
    const frames = clipFrames({ start: 16.067, end: 17.733 }, 980);
    expect(frames).toMatchObject({ first: 483, last: 531, count: 49, extracted: 50, held: [] });
  });

  it("starts a span on the first frame at or after its start", () => {
    // 481 / 30 = 16.0333..., written 16.033: frame 481.
    expect(clipFrames({ start: 16.033, end: 18 }, 980).first).toBe(481);
    // 482 / 30 = 16.0666..., written 16.067: a hair after the boundary, frame 483.
    expect(clipFrames({ start: 16.067, end: 18 }, 980).first).toBe(483);
    expect(clipFrames({ start: 0.95, end: 3 }, 900).first).toBe(29);
  });

  it("never runs past the reel's last frame", () => {
    const frames = clipFrames({ start: 2, end: 2.69 }, reelFrames(2.69));
    expect(frames.last).toBe(80);
    expect(frames.count).toBe(21);
  });

  it("covers the whole reel for the footage clip, and extracts round(duration x 30)", () => {
    // 2.69 s: 81 output frames, 80.7 rounds to 81 extracted.
    expect(clipFrames({ start: 0, end: 2.69 }, 81)).toMatchObject({
      first: 0,
      last: 80,
      count: 81,
      extracted: 81,
      held: [],
    });
    // 2.68 s: 81 output frames (80.4 started), 80 extracted: the last is held.
    expect(clipFrames({ start: 0, end: 2.68 }, reelFrames(2.68))).toMatchObject({
      count: 81,
      extracted: 80,
      held: [80],
    });
  });

  it("extracts at least one frame", () => {
    expect(clipFrames({ start: 1, end: 1.01 }, 900).extracted).toBe(1);
  });
});
