import { describe, expect, it } from "vitest";
import {
  HEAD_TRACK_SETTINGS,
  type HeadTrackSettings,
  frameBytes,
  headSample,
  trackHead,
} from "./head-sample.ts";
import { headTrackDecodeArgs } from "./head-track.ts";

const { analysisWidth: W, analysisHeight: H, scale: S } = HEAD_TRACK_SETTINGS;

function emptyFrame(): Uint8Array {
  return new Uint8Array(frameBytes(HEAD_TRACK_SETTINGS));
}

function setAlpha(frame: Uint8Array, x: number, y: number, alpha: number) {
  frame[(y * W + x) * 4 + 3] = alpha;
}

// An opaque ellipse in analysis pixels.
function ellipseFrame(cx: number, cy: number, rx: number, ry: number): Uint8Array {
  const frame = emptyFrame();
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) setAlpha(frame, x, y, 255);
    }
  }
  return frame;
}

function withBounds(bounds: Partial<HeadTrackSettings["bounds"]>): HeadTrackSettings {
  return { ...HEAD_TRACK_SETTINGS, bounds: { ...HEAD_TRACK_SETTINGS.bounds, ...bounds } };
}

describe("headSample", () => {
  const ellipse = ellipseFrame(135, 200, 40, 55);

  it("finds an ellipse's top, centre and width in 1080x1920 pixels", () => {
    const sample = headSample(ellipse, 0, HEAD_TRACK_SETTINGS)!;
    // The top row with four opaque pixels, a band 20 to 50 rows below it.
    const truthTop = (200 - 55) * S;
    const bandMiddle = 200 - 55 + 35;
    const truthWidth = 2 * 40 * Math.sqrt(1 - ((bandMiddle - 200) / 55) ** 2) * S;
    expect(Math.abs(sample.head_top - truthTop)).toBeLessThanOrEqual(4);
    expect(Math.abs(sample.cx - 135 * S)).toBeLessThanOrEqual(4);
    expect(Math.abs(sample.head_w - truthWidth)).toBeLessThanOrEqual(4);
    expect(sample.t).toBe(0);
  });

  it("finds no head in a transparent frame", () => {
    expect(headSample(emptyFrame(), 0, HEAD_TRACK_SETTINGS)).toBeNull();
  });

  it("needs four opaque pixels for a top, and alpha above 128", () => {
    const three = emptyFrame();
    for (const x of [100, 101, 102]) setAlpha(three, x, 10, 255);
    expect(headSample(three, 0, HEAD_TRACK_SETTINGS)).toBeNull();

    const half = ellipseFrame(135, 200, 40, 55);
    for (let index = 3; index < half.length; index += 4) if (half[index]) half[index] = 128;
    expect(headSample(half, 0, HEAD_TRACK_SETTINGS)).toBeNull();
  });

  it("finds no head when nothing is in the band below the top", () => {
    const line = emptyFrame();
    for (let x = 100; x < 140; x += 1) setAlpha(line, x, 10, 255);
    expect(headSample(line, 0, HEAD_TRACK_SETTINGS)).toBeNull();
  });

  it("keeps every sample with the default bounds and filters on each bound set", () => {
    const sample = headSample(ellipse, 0, HEAD_TRACK_SETTINGS)!;
    expect(headSample(ellipse, 0, withBounds({}))).toEqual(sample);
    expect(headSample(ellipse, 0, withBounds({ minHeadTop: sample.head_top + 1 }))).toBeNull();
    expect(headSample(ellipse, 0, withBounds({ minHeadTop: sample.head_top }))).toEqual(sample);
    expect(headSample(ellipse, 0, withBounds({ maxHeadWidth: sample.head_w - 1 }))).toBeNull();
    expect(headSample(ellipse, 0, withBounds({ minHeadWidth: sample.head_w + 1 }))).toBeNull();
    expect(
      headSample(
        ellipse,
        0,
        withBounds({ minHeadWidth: sample.head_w, maxHeadWidth: sample.head_w }),
      ),
    ).toEqual(sample);
  });

  it("times each sample at a quarter second, rounded to two decimals", () => {
    expect(headSample(ellipse, 7, HEAD_TRACK_SETTINGS)!.t).toBe(1.75);
    expect(headSample(ellipse, 1, { ...HEAD_TRACK_SETTINGS, samplesPerSecond: 3 })!.t).toBe(0.33);
  });

  it("rejects a frame of the wrong size", () => {
    expect(() => headSample(new Uint8Array(W * H * 4 - 1), 0, HEAD_TRACK_SETTINGS)).toThrow(
      /expected 518400/,
    );
  });
});

describe("trackHead", () => {
  it("samples every frame in order", () => {
    const track = trackHead([emptyFrame(), ellipseFrame(135, 200, 40, 55)], HEAD_TRACK_SETTINGS);
    expect(track).toHaveLength(2);
    expect(track[0]).toBeNull();
    expect(track[1]).toMatchObject({ t: 0.25, cx: 135 * S });
  });
});

describe("headTrackDecodeArgs", () => {
  it("decodes with libvpx-vp9 (keeping alpha) to raw RGBA at the analysis size and rate", () => {
    expect(headTrackDecodeArgs("subject.webm", "frames.rgba", HEAD_TRACK_SETTINGS)).toEqual([
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-c:v",
      "libvpx-vp9",
      "-i",
      "subject.webm",
      "-vf",
      "fps=4,scale=270:480",
      "-pix_fmt",
      "rgba",
      "-f",
      "rawvideo",
      "frames.rgba",
    ]);
  });
});
