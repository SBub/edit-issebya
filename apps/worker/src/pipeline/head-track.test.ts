import { describe, expect, it } from "vitest";
import {
  HEAD_TRACK_SETTINGS,
  type HeadSample,
  headSample,
  headTrackWhat,
  withinBounds,
} from "./head-track.ts";

const W = HEAD_TRACK_SETTINGS.analysisWidth;
const H = HEAD_TRACK_SETTINGS.analysisHeight;
const SCALE = HEAD_TRACK_SETTINGS.frameWidth / W;

function emptyFrame(): Uint8Array {
  return new Uint8Array(W * H * 4);
}

function setAlpha(frame: Uint8Array, x: number, y: number, alpha: number) {
  frame[(y * W + x) * 4 + 3] = alpha;
}

// An opaque ellipse (alpha 255) on a transparent frame.
function ellipse(cx: number, cy: number, rx: number, ry: number, frame = emptyFrame()) {
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) setAlpha(frame, x, y, 255);
    }
  }
  return frame;
}

// The ellipse's width at a row, in 1080x1920 pixels.
function widthAt(y: number, cy: number, rx: number, ry: number): number {
  return 2 * rx * Math.sqrt(1 - ((y - cy) / ry) ** 2) * SCALE;
}

describe("headSample", () => {
  it("finds an ellipse's top, centre and width in 1080x1920 coordinates", () => {
    const [cx, cy, rx, ry] = [135, 150, 40, 50];
    const sample = headSample(ellipse(cx, cy, rx, ry), 1.25, HEAD_TRACK_SETTINGS)!;
    expect(sample.t).toBe(1.25);
    expect(Math.abs(sample.head_top - (cy - ry) * SCALE)).toBeLessThanOrEqual(4);
    expect(Math.abs(sample.cx - cx * SCALE)).toBeLessThanOrEqual(4);
    // The median span of the band is its middle row's.
    const top = sample.head_top / SCALE;
    const middle = top + HEAD_TRACK_SETTINGS.widthBandStart + 15;
    // One analysis pixel per edge.
    expect(Math.abs(sample.head_w - widthAt(middle, cy, rx, ry))).toBeLessThanOrEqual(2 * SCALE);
  });

  it("gives null for a frame with no person", () => {
    expect(headSample(emptyFrame(), 0, HEAD_TRACK_SETTINGS)).toBeNull();
  });

  it("counts alpha exactly at the threshold as transparent", () => {
    const frame = emptyFrame();
    for (let y = 100; y < 200; y += 1)
      for (let x = 100; x < 150; x += 1) setAlpha(frame, x, y, 128);
    expect(headSample(frame, 0, HEAD_TRACK_SETTINGS)).toBeNull();
    setAlpha(frame, 0, 0, 129);
    // One opaque pixel is not a head top either.
    expect(headSample(frame, 0, HEAD_TRACK_SETTINGS)).toBeNull();
  });

  it("skips a top row with fewer than four opaque pixels", () => {
    const frame = ellipse(135, 150, 40, 50);
    for (let x = 10; x < 13; x += 1) setAlpha(frame, x, 20, 255);
    const sample = headSample(frame, 0, HEAD_TRACK_SETTINGS)!;
    expect(sample.head_top).toBeGreaterThan(90 * SCALE);
  });

  it("measures a head reaching the bottom edge in the clipped band", () => {
    const sample = headSample(ellipse(135, 470, 40, 30), 0, HEAD_TRACK_SETTINGS)!;
    expect(sample).not.toBeNull();
    expect(Math.abs(sample.head_top - 440 * SCALE)).toBeLessThanOrEqual(4);
    expect(Math.abs(sample.cx - 135 * SCALE)).toBeLessThanOrEqual(4);
  });

  it("gives null when nothing is opaque in the band below the top", () => {
    const frame = emptyFrame();
    for (let x = 100; x < 110; x += 1) setAlpha(frame, x, 300, 255);
    expect(headSample(frame, 0, HEAD_TRACK_SETTINGS)).toBeNull();
  });

  it("rounds t to two decimals", () => {
    expect(headSample(ellipse(135, 150, 40, 50), 0.1 + 0.2, HEAD_TRACK_SETTINGS)!.t).toBe(0.3);
  });

  it("throws on a buffer of the wrong length", () => {
    expect(() => headSample(new Uint8Array(10), 0, HEAD_TRACK_SETTINGS)).toThrow(/10 bytes/);
  });
});

describe("withinBounds", () => {
  const sample: HeadSample = { t: 1, head_top: 300, cx: 540, head_w: 200 };

  it("keeps every sample when no bound is set (the default)", () => {
    expect(withinBounds(sample, HEAD_TRACK_SETTINGS.bounds)).toBe(sample);
    expect(withinBounds(null, HEAD_TRACK_SETTINGS.bounds)).toBeNull();
  });

  it("drops a sample outside a set bound", () => {
    const none = { minHeadTop: null, minHeadWidth: null, maxHeadWidth: null };
    expect(withinBounds(sample, { ...none, minHeadTop: 380 })).toBeNull();
    expect(withinBounds(sample, { ...none, minHeadWidth: 220 })).toBeNull();
    expect(withinBounds(sample, { ...none, maxHeadWidth: 150 })).toBeNull();
    expect(withinBounds(sample, { minHeadTop: 300, minHeadWidth: 200, maxHeadWidth: 200 })).toBe(
      sample,
    );
  });
});

describe("headTrackWhat", () => {
  it("names the samples and those without a head", () => {
    const one: HeadSample = { t: 0, head_top: 400, cx: 540, head_w: 300 };
    expect(headTrackWhat([one, null, one])).toBe("head tracked, 3 samples, 1 without a head");
    expect(headTrackWhat([one])).toBe("head tracked, 1 sample, 0 without a head");
    expect(headTrackWhat([null, null])).toBe("head tracked, 2 samples, 2 without a head");
  });
});
