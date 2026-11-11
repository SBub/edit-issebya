import { describe, expect, it } from "vitest";
import type { HeadTrack } from "@edit-issebya/edit";
import { CROP_RULE, spanCropTop } from "./crop.ts";
import { MATTE_SETTINGS } from "./matte.ts";

const head = (t: number, head_top: number, head_w = 360) => ({ t, head_top, cx: 540, head_w });
// One sample every 0.25 s from 0 to 4 s, the head's top at 600.
const steady = (): HeadTrack => Array.from({ length: 17 }, (_, index) => head(index * 0.25, 600));

describe("spanCropTop", () => {
  it("is the span's highest person top minus half its widest head", () => {
    const track = steady();
    track[5] = head(1.25, 560);
    track[6] = head(1.5, 580, 400);
    // 560 - 0.5 * 400.
    expect(spanCropTop(track, { start: 1, end: 2 })).toBe(360);
    // The high sample is outside this span, and outside its reach.
    expect(spanCropTop(track, { start: 2.5, end: 3.5 })).toBe(420);
  });

  it("counts the samples a quarter second around the span, whose edges lie between two", () => {
    const track = steady();
    track[4] = head(1, 500);
    expect(spanCropTop(track, { start: 1.2, end: 2 })).toBe(320);
    expect(spanCropTop(track, { start: 1.3, end: 2 })).toBe(420);
    track[9] = head(2.25, 480);
    expect(spanCropTop(track, { start: 1.3, end: 2 })).toBe(300);
  });

  it("is no crop without a head track", () => {
    expect(spanCropTop(null, { start: 1, end: 2 })).toBe(0);
    expect(spanCropTop([], { start: 1, end: 2 })).toBe(0);
  });

  it("is no crop when a sample of the span has no head, or the span has no sample", () => {
    const track = steady();
    track[6] = null;
    expect(spanCropTop(track, { start: 1, end: 2 })).toBe(0);
    // The headless sample is at 1.5 s: a span clear of it is cropped.
    expect(spanCropTop(track, { start: 2, end: 3 })).toBe(420);
    expect(spanCropTop(track, { start: 20, end: 21 })).toBe(0);
    expect(spanCropTop([null, null, null, null, null], { start: 0, end: 1 })).toBe(0);
  });

  it("never goes above the frame: a head near the top is not cropped", () => {
    const track = steady().map((sample) => sample && { ...sample, head_top: 150 });
    expect(spanCropTop(track, { start: 1, end: 2 })).toBe(0);
    const nearer = steady().map((sample) => sample && { ...sample, head_top: 181.5 });
    expect(spanCropTop(nearer, { start: 1, end: 2 })).toBe(1);
  });

  it("is named in the matte settings, so a new rule is a new mask", () => {
    expect(MATTE_SETTINGS.crop).toBe(CROP_RULE.id);
    expect(CROP_RULE).toMatchObject({ marginHeadWidths: 0.5, reachSeconds: 0.25 });
  });
});
