import { describe, expect, it } from "vitest";
import { newThresholds, playedFraction, type ProgressPercent } from "./reel-progress";

describe("playedFraction", () => {
  it("is the current time over the duration", () => {
    expect(playedFraction(0, 10, 40)).toBe(0.25);
    expect(playedFraction(10, 20, 40)).toBe(0.5);
  });

  it("is 0 while the duration is unknown", () => {
    expect(playedFraction(0, 5, Number.NaN)).toBe(0);
    expect(playedFraction(0, 5, 0)).toBe(0);
    expect(playedFraction(0, 5, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("is 1 when the loop wraps from near the end back to the start", () => {
    expect(playedFraction(39.8, 0.1, 40)).toBe(1);
  });

  it("does not treat a jump back from the middle as the end", () => {
    expect(playedFraction(20, 2, 40)).toBe(0.05);
  });
});

describe("newThresholds", () => {
  const none = new Set<ProgressPercent>();

  it("returns every threshold reached and not yet sent, in order", () => {
    expect(newThresholds(0.1, none)).toEqual([]);
    expect(newThresholds(0.25, none)).toEqual([25]);
    expect(newThresholds(0.6, none)).toEqual([25, 50]);
    expect(newThresholds(1, none)).toEqual([25, 50, 100]);
  });

  it("never returns a threshold twice", () => {
    expect(newThresholds(0.3, new Set<ProgressPercent>([25]))).toEqual([]);
    expect(newThresholds(1, new Set<ProgressPercent>([25, 50]))).toEqual([100]);
    expect(newThresholds(1, new Set<ProgressPercent>([25, 50, 100]))).toEqual([]);
  });
});
