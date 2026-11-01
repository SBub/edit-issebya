import { describe, expect, it } from "vitest";
import { headTrackDecodeArgs } from "./head-track-step.ts";
import {
  HEAD_TRACK_SETTINGS,
  type HeadTrackOptions,
  headSample,
  headTrack,
  headTrackWhat,
} from "./head-track.ts";

const W = HEAD_TRACK_SETTINGS.analysisWidth;
const H = HEAD_TRACK_SETTINGS.analysisHeight;
// 1080x1920 footage: four source pixels per analysis pixel on each axis.
const OPTIONS: HeadTrackOptions = { ...HEAD_TRACK_SETTINGS, scaleX: 4, scaleY: 4 };

function blank(): Uint8Array {
  return new Uint8Array(W * H * 4);
}

function paint(frame: Uint8Array, x: number, y: number, alpha = 255) {
  frame[(y * W + x) * 4 + 3] = alpha;
}

// An opaque ellipse on a transparent frame: centre x 135, top 100, semi-axes
// 30 across and 40 down.
const ELLIPSE = { cx: 135, cy: 140, a: 30, b: 40 };
function inEllipse(x: number, y: number): boolean {
  return ((x - ELLIPSE.cx) / ELLIPSE.a) ** 2 + ((y - ELLIPSE.cy) / ELLIPSE.b) ** 2 <= 1;
}
function ellipseFrame(): Uint8Array {
  const frame = blank();
  for (let y = 0; y < H; y += 1)
    for (let x = 0; x < W; x += 1) if (inEllipse(x, y)) paint(frame, x, y);
  return frame;
}

// The ellipse's width at a row, from its geometry.
function rowWidth(y: number): number {
  const half = Math.floor(ELLIPSE.a * Math.sqrt(1 - ((y - ELLIPSE.cy) / ELLIPSE.b) ** 2));
  return 2 * half;
}

describe("headSample", () => {
  it("finds the ellipse's top, centre and width in source pixels", () => {
    const sample = headSample(ellipseFrame(), 0, OPTIONS)!;
    expect(Math.abs(sample.head_top - 400)).toBeLessThanOrEqual(4);
    expect(Math.abs(sample.cx - 540)).toBeLessThanOrEqual(4);
    // The median width of the band rows (20 to 50 rows below the top).
    const top = sample.head_top / 4;
    const widths = Array.from({ length: 30 }, (_, row) => rowWidth(top + 20 + row)).sort(
      (p, q) => p - q,
    );
    expect(Math.abs(sample.head_w - widths[15]! * 4)).toBeLessThanOrEqual(4);
  });

  it("gives null for an empty frame", () => {
    expect(headSample(blank(), 0, OPTIONS)).toBeNull();
  });

  it("needs at least four opaque pixels in a row for the top", () => {
    const frame = blank();
    for (const x of [10, 11, 12]) paint(frame, x, 0);
    expect(headSample(frame, 0, OPTIONS)).toBeNull();
  });

  it("counts alpha exactly at the threshold as transparent", () => {
    const frame = blank();
    for (let y = 0; y < 60; y += 1) for (let x = 100; x < 110; x += 1) paint(frame, x, y, 128);
    expect(headSample(frame, 0, OPTIONS)).toBeNull();
    for (let y = 0; y < 60; y += 1) for (let x = 100; x < 110; x += 1) paint(frame, x, y, 129);
    expect(headSample(frame, 0, OPTIONS)).toEqual({ t: 0, head_top: 0, cx: 416, head_w: 36 });
  });

  it("gives null when nothing is opaque in the band below the top", () => {
    const frame = blank();
    for (let x = 0; x < 10; x += 1) paint(frame, x, H - 5);
    expect(headSample(frame, 0, OPTIONS)).toBeNull();
  });

  it("times a sample by its index and the sample rate", () => {
    expect(headSample(ellipseFrame(), 5, OPTIONS)?.t).toBe(1.25);
  });

  it("drops a sample outside a bound and keeps it with no bounds", () => {
    const frame = ellipseFrame();
    const sample = headSample(frame, 0, OPTIONS)!;
    const bounded = (bounds: Partial<HeadTrackOptions["bounds"]>) =>
      headSample(frame, 0, { ...OPTIONS, bounds: { ...OPTIONS.bounds, ...bounds } });
    expect(bounded({ minHeadTop: sample.head_top + 1 })).toBeNull();
    expect(bounded({ maxHeadWidth: sample.head_w - 1 })).toBeNull();
    expect(bounded({ minHeadWidth: sample.head_w + 1 })).toBeNull();
    expect(bounded({})).toEqual(sample);
  });

  it("refuses a frame of the wrong length", () => {
    expect(() => headSample(new Uint8Array(10), 3, OPTIONS)).toThrow(/frame 3 is 10 bytes/);
  });
});

describe("headTrack", () => {
  it("samples every frame in order", async () => {
    const track = await headTrack([ellipseFrame(), blank(), ellipseFrame()], OPTIONS);
    expect(track.map((sample) => sample?.t ?? null)).toEqual([0, null, 0.5]);
  });

  it("throws on a frame of the wrong length", async () => {
    await expect(headTrack([blank(), new Uint8Array(4)], OPTIONS)).rejects.toThrow(/frame 1/);
  });
});

describe("headTrackWhat", () => {
  it("counts samples and those without a head", () => {
    const sample = { t: 0, head_top: 400, cx: 540, head_w: 240 };
    expect(headTrackWhat([sample, null, sample])).toBe("head tracked, 3 samples, 1 without a head");
    expect(headTrackWhat([sample])).toBe("head tracked, 1 sample, 0 without a head");
  });
});

describe("headTrackDecodeArgs", () => {
  it("decodes with libvpx-vp9 to raw RGBA at the analysis size and rate", () => {
    const args = headTrackDecodeArgs("/job/subject.webm", "/job/frames.rgba", HEAD_TRACK_SETTINGS);
    expect(args[args.indexOf("-c:v") + 1]).toBe("libvpx-vp9");
    expect(args.indexOf("-c:v")).toBeLessThan(args.indexOf("-i"));
    expect(args[args.indexOf("-i") + 1]).toBe("/job/subject.webm");
    expect(args[args.indexOf("-vf") + 1]).toBe("fps=4,scale=270:480");
    expect(args.slice(-5)).toEqual(["-pix_fmt", "rgba", "-f", "rawvideo", "/job/frames.rgba"]);
  });
});
