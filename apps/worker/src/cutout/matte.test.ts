import { describe, expect, it } from "vitest";
import {
  MATTE_SETTINGS,
  TemporalMedian,
  decodeArgs,
  encodeArgs,
  matteToGray,
  modelInput,
  onFrameGrid,
  parseFrameRate,
  spanFrames,
  workingSize,
} from "./matte.ts";

describe("workingSize", () => {
  it("scales the short side to 512 and rounds both sides down to multiples of 32", () => {
    expect(workingSize(1080, 1920)).toEqual({ width: 512, height: 896 });
    expect(workingSize(720, 1280)).toEqual({ width: 512, height: 896 });
    expect(workingSize(1920, 1080)).toEqual({ width: 896, height: 512 });
    expect(workingSize(300, 400)).toEqual({ width: 512, height: 672 });
  });

  it("keeps a frame whose sides straddle the reference, as MODNet does", () => {
    expect(workingSize(500, 900)).toEqual({ width: 480, height: 896 });
    expect(workingSize(512, 512)).toEqual({ width: 512, height: 512 });
  });

  it("is MODNet's reference size in the settings", () => {
    expect(MATTE_SETTINGS).toMatchObject({ size: 512, smoothing: "median3", provider: "cpu" });
  });
});

describe("modelInput", () => {
  it("is planar RGB from -1 to 1", () => {
    // Two pixels: red with a mid blue, then cyan.
    const rgb = Uint8Array.from([255, 0, 127.5, 0, 255, 255]);
    const out = modelInput(rgb, 2, 1);
    expect(Array.from(out).map((v) => Number(v.toFixed(3)))).toEqual([1, -1, -1, 1, -0.004, 1]);
  });
});

describe("matteToGray", () => {
  it("clamps and rounds to 0 to 255", () => {
    expect(Array.from(matteToGray(Float32Array.from([-0.2, 0, 0.5, 1, 1.4])))).toEqual([
      0, 0, 128, 255, 255,
    ]);
  });
});

describe("TemporalMedian", () => {
  const frames = (...values: number[][]) => values.map((v) => Uint8Array.from(v));

  it("gives each frame the median of it and its neighbours, one frame late", () => {
    const smoother = new TemporalMedian();
    const [a, b, c, d] = frames([0, 10], [255, 10], [0, 200], [0, 210]);
    expect(smoother.push(a!)).toBeNull();
    // First frame: its missing neighbour is itself.
    expect(Array.from(smoother.push(b!)!)).toEqual([0, 10]);
    // A one-frame flash is removed; a lasting change is kept.
    expect(Array.from(smoother.push(c!)!)).toEqual([0, 10]);
    expect(Array.from(smoother.push(d!)!)).toEqual([0, 200]);
    expect(Array.from(smoother.flush()!)).toEqual([0, 210]);
    expect(smoother.flush()).toBeNull();
  });

  it("passes a single frame through", () => {
    const smoother = new TemporalMedian();
    expect(smoother.push(Uint8Array.from([7]))).toBeNull();
    expect(Array.from(smoother.flush()!)).toEqual([7]);
  });
});

describe("span frames", () => {
  it("counts the span's frames like the old mask tool, at least one", () => {
    expect(spanFrames(0.5, 3.5, 30)).toBe(90);
    expect(spanFrames(5.1, 7.967, 30)).toBe(86);
    expect(spanFrames(1, 1.01, 30)).toBe(1);
  });

  it("snaps an edge given to the millisecond onto the frame it names", () => {
    expect(onFrameGrid(7.967, 30)).toBeCloseTo(239 / 30, 9);
    expect(onFrameGrid(7.95, 30)).toBe(7.95);
  });
});

describe("the ffmpeg calls", () => {
  it("decodes exactly the span's frames to RGB at the working size, seeking a quarter frame early", () => {
    expect(
      decodeArgs({ input: "/f.mp4", start: 5.1, frames: 86, fps: 30, width: 512, height: 896 }),
    ).toEqual([
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-ss",
      "5.091667",
      "-i",
      "/f.mp4",
      "-an",
      "-sn",
      "-frames:v",
      "86",
      "-fps_mode",
      "passthrough",
      "-vf",
      "scale=512:896:flags=area,format=rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ]);
    expect(
      decodeArgs({ input: "/f.mp4", start: 0, frames: 30, fps: 30, width: 512, height: 896 }),
    ).toContain("0.000000");
  });

  it("encodes gray mattes as the footage-sized, video-range BT.709 H.264 mask", () => {
    const args = encodeArgs({
      output: "/o.mp4.part",
      rate: "30/1",
      matte: { width: 512, height: 896 },
      footage: { width: 1080, height: 1920 },
    });
    expect(args.slice(args.indexOf("-f"), args.indexOf("pipe:0") + 1)).toEqual([
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-s",
      "512x896",
      "-framerate",
      "30/1",
      "-i",
      "pipe:0",
    ]);
    const filters = args[args.indexOf("-vf") + 1]!.split(",").map((part) => part.split(":"));
    expect(filters).toEqual([
      ["scale=1080", "1920", "flags=bicubic", "in_range=full", "out_range=limited"],
      ["format=yuv420p"],
      ["setparams=range=tv", "color_primaries=bt709", "color_trc=bt709", "colorspace=bt709"],
    ]);
    expect(args).toEqual(
      expect.arrayContaining(["libx264", "high", "-g", "30", "mp4", "/o.mp4.part"]),
    );
    expect(args.at(-1)).toBe("/o.mp4.part");
  });

  it("reads ffprobe's frame rates", () => {
    expect(parseFrameRate("30/1")).toBe(30);
    expect(parseFrameRate("30000/1001")).toBeCloseTo(29.97, 2);
    expect(parseFrameRate("25")).toBe(25);
    expect(parseFrameRate("0/0")).toBeNull();
    expect(parseFrameRate("")).toBeNull();
  });
});
