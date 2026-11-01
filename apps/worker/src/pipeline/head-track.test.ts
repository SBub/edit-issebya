import { describe, expect, it } from "vitest";
import { headTrackDecodeArgs } from "./head-track-step.ts";
import {
  HEAD_TRACK_SETTINGS,
  type HeadSample,
  headSample,
  headTrackWhat,
  trackHead,
} from "./head-track.ts";

const W = HEAD_TRACK_SETTINGS.analysisWidth;
const H = HEAD_TRACK_SETTINGS.analysisHeight;

function emptyFrame(): Uint8Array {
  return new Uint8Array(W * H * 4);
}

function setAlpha(frame: Uint8Array, x: number, y: number, alpha = 255) {
  frame[(y * W + x) * 4 + 3] = alpha;
}

// A filled ellipse, fully opaque, on a transparent frame.
function ellipse(cx0: number, cy0: number, rx: number, ry: number, frame = emptyFrame()) {
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (((x - cx0) / rx) ** 2 + ((y - cy0) / ry) ** 2 <= 1) setAlpha(frame, x, y);
    }
  }
  return frame;
}

const CX0 = 135;
const CY0 = 200;
const RX = 40;
const RY = 55;

describe("headSample", () => {
  it("finds an ellipse's top, centre and width in 1080x1920 pixels", () => {
    const sample = headSample(ellipse(CX0, CY0, RX, RY), 3)!;
    const top = CY0 - RY;
    // The median of the 30 band rows below the top.
    const dy = top + 35 - CY0;
    const width = 4 * 2 * Math.floor(RX * Math.sqrt(1 - (dy / RY) ** 2));
    expect(sample.t).toBe(0.75);
    expect(Math.abs(sample.head_top - top * 4)).toBeLessThanOrEqual(4);
    expect(Math.abs(sample.cx - CX0 * 4)).toBeLessThanOrEqual(4);
    expect(Math.abs(sample.head_w - width)).toBeLessThanOrEqual(4);
  });

  it("gives null for an empty frame", () => {
    expect(headSample(emptyFrame(), 0)).toBeNull();
  });

  it("ignores a row with fewer opaque pixels than minRowPixels", () => {
    const frame = ellipse(CX0, CY0, RX, RY);
    for (const x of [10, 11, 12]) setAlpha(frame, x, 20);
    expect(headSample(frame, 0)).toEqual(headSample(ellipse(CX0, CY0, RX, RY), 0));
  });

  it("gives null when the band below the top has no opaque pixel", () => {
    const frame = emptyFrame();
    for (let x = 100; x < 110; x += 1) setAlpha(frame, x, 50);
    expect(headSample(frame, 0)).toBeNull();
  });

  it("counts alpha exactly at the threshold as transparent", () => {
    const withAlpha = (alpha: number) => {
      const frame = ellipse(CX0, CY0, RX, RY);
      for (let at = 3; at < frame.length; at += 4) if (frame[at]) frame[at] = alpha;
      return frame;
    };
    expect(headSample(withAlpha(128), 0)).toBeNull();
    expect(headSample(withAlpha(129), 0)).toEqual(headSample(ellipse(CX0, CY0, RX, RY), 0));
  });

  it("cuts the band at the bottom of the frame", () => {
    const frame = emptyFrame();
    for (let y = H - 25; y < H; y += 1) for (let x = 100; x < 120; x += 1) setAlpha(frame, x, y);
    expect(headSample(frame, 0)).toMatchObject({ head_top: (H - 25) * 4, head_w: 19 * 4 });
  });

  it("drops a sample outside the bounds, keeping it with none set", () => {
    const frame = ellipse(CX0, CY0, RX, RY);
    const sample = headSample(frame, 0)!;
    expect(sample).not.toBeNull();
    const withBounds = (bounds: Partial<typeof HEAD_TRACK_SETTINGS.bounds>) => ({
      ...HEAD_TRACK_SETTINGS,
      bounds: { ...HEAD_TRACK_SETTINGS.bounds, ...bounds },
    });
    expect(headSample(frame, 0, withBounds({ minHeadTop: sample.head_top + 1 }))).toBeNull();
    expect(headSample(frame, 0, withBounds({ maxHeadWidth: sample.head_w - 1 }))).toBeNull();
    expect(headSample(frame, 0, withBounds({ minHeadWidth: sample.head_w + 1 }))).toBeNull();
    expect(headSample(frame, 0, withBounds({ maxHeadWidth: sample.head_w }))).toEqual(sample);
  });

  it("throws on a frame of the wrong length", () => {
    expect(() => headSample(new Uint8Array(10), 0)).toThrow(/10 bytes/);
  });
});

describe("trackHead", () => {
  it("samples every frame at 4 per second", () => {
    const head = ellipse(CX0, CY0, RX, RY);
    const samples = trackHead([head, emptyFrame(), head]);
    expect(samples.map((sample) => sample?.t ?? null)).toEqual([0, null, 0.5]);
    expect(samples[1]).toBeNull();
    expect({ ...samples[2], t: 0 }).toEqual({ ...samples[0], t: 0 });
  });

  it("throws when a frame has the wrong length", () => {
    expect(() => trackHead([emptyFrame(), new Uint8Array(4)])).toThrow();
  });
});

describe("headTrackWhat", () => {
  it("counts the samples and those without a head", () => {
    const samples: HeadSample[] = Array.from({ length: 197 }, (_, index) =>
      index < 3 ? null : { t: index / 4, head_top: 400, cx: 540, head_w: 300 },
    );
    expect(headTrackWhat(samples)).toBe("head tracked, 197 samples, 3 without a head");
    expect(headTrackWhat([null])).toBe("head tracked, 1 sample, 1 without a head");
  });
});

describe("headTrackDecodeArgs", () => {
  it("decodes with libvpx-vp9 before the input, to raw RGBA at 4 fps and 270x480", () => {
    const args = headTrackDecodeArgs("in.webm", "frames.rgba", HEAD_TRACK_SETTINGS);
    expect(args.indexOf("-c:v")).toBeLessThan(args.indexOf("-i"));
    expect(args[args.indexOf("-c:v") + 1]).toBe("libvpx-vp9");
    expect(args[args.indexOf("-vf") + 1]).toBe("fps=4,scale=270:480");
    expect(args[args.indexOf("-pix_fmt") + 1]).toBe("rgba");
    expect(args[args.indexOf("-f") + 1]).toBe("rawvideo");
    expect(args.at(-1)).toBe("frames.rgba");
  });
});
