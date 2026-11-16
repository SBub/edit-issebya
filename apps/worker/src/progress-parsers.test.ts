import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  type ProgressParser,
  ffmpegFrameProgress,
  parseCutoutProgress,
  parsePersonMaskProgress,
  parseRenderProgress,
  weightedParts,
  weightedProgress,
} from "./progress-parsers.ts";

// Real stdout, captured on the committed clips: the worker's U2Net entry on
// the person clip's 16 samples in one chunk, a full `hyperframes render` and
// the cut-out's MODNet entry on one second of the person clip.
async function sample(name: string): Promise<string[]> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed samples
  const text = await readFile(new URL(`progress-testdata/${name}`, import.meta.url), "utf8");
  return text.split("\n");
}

function values(lines: string[], parse: ProgressParser): number[] {
  return lines.map(parse).filter((value): value is number => value !== null);
}

describe.each([
  ["person-mask.txt", parsePersonMaskProgress],
  ["render.txt", parseRenderProgress],
  ["cutout.txt", parseCutoutProgress],
])("%s", (name, parse) => {
  it("gives rising values from the tool's own progress lines", async () => {
    const found = values(await sample(name), parse);
    expect(new Set(found).size).toBeGreaterThan(1);
    for (let i = 1; i < found.length; i += 1) {
      expect(found[i]).toBeGreaterThanOrEqual(found[i - 1]!);
    }
    // The tool's last report stops short of 100; the step's finish() writes it.
    expect(found.at(-1)).toBeGreaterThanOrEqual(95);
    expect(found.at(-1)).toBeLessThanOrEqual(100);
  });

  it("ignores every other line of the sample", async () => {
    const lines = await sample(name);
    const progressLines = lines.filter((line) => line.trim().startsWith("@hf-progress "));
    expect(values(lines, parse)).toHaveLength(progressLines.length);
  });
});

describe("parseRenderProgress", () => {
  it("reads pct, clamped and rounded", () => {
    expect(parseRenderProgress('@hf-progress {"code":"capture","pct":42}')).toBe(42);
    expect(parseRenderProgress('  @hf-progress {"pct":41.6}')).toBe(42);
    expect(parseRenderProgress('@hf-progress {"pct":140}')).toBe(100);
    expect(parseRenderProgress('@hf-progress {"pct":-3}')).toBe(0);
  });

  it("gives null for other lines and malformed JSON", () => {
    expect(parseRenderProgress("  ██░░  10%  Extracting video frames")).toBeNull();
    expect(parseRenderProgress("@hf-progress {not json")).toBeNull();
    expect(parseRenderProgress('@hf-progress {"code":"compile"}')).toBeNull();
    expect(parseRenderProgress('@hf-progress {"pct":"50"}')).toBeNull();
    expect(parseRenderProgress("@hf-progress null")).toBeNull();
    expect(parseRenderProgress("")).toBeNull();
  });
});

describe("weightedProgress", () => {
  const line = (pct: number) => `@hf-progress {"index":0,"total":10,"pct":${pct}}`;

  it("counts each part by its weight, in turn or at the same time", () => {
    // In turn: the first part is 40% of the step.
    const [first, second] = weightedProgress(parseCutoutProgress, [4, 6]);
    expect(first!(line(0))).toBe(0);
    expect(first!(line(50))).toBe(20);
    expect(first!(line(100))).toBe(40);
    expect(second!(line(50))).toBe(70);
    expect(second!(line(100))).toBe(100);

    // At the same time: each line gives the step's total so far.
    const [a, b, c] = weightedProgress(parseCutoutProgress, [1, 1, 2]);
    expect(a!(line(100))).toBe(25);
    expect(c!(line(50))).toBe(50);
    expect(b!(line(20))).toBe(55);
    expect(c!(line(100))).toBe(80);
    expect(b!(line(100))).toBe(100);
  });

  it("never goes back, and reads only its own call's lines", () => {
    const [a, b] = weightedProgress(parseCutoutProgress, [1, 1]);
    expect(a!(line(60))).toBe(30);
    // A lower report of the same part changes nothing.
    expect(a!(line(40))).toBe(30);
    expect(b!("modnet: decoding failed")).toBeNull();
    expect(b!(line(10))).toBe(35);
  });
});

describe("ffmpegFrameProgress", () => {
  // What `ffmpeg -progress pipe:1` prints for one report.
  const REPORT = [
    "frame=245",
    "fps=61.20",
    "stream_0_0_q=15.0",
    "bitrate=17320.1kbits/s",
    "total_size=17694768",
    "out_time_us=8166667",
    "out_time=00:00:08.166667",
    "dup_frames=0",
    "drop_frames=0",
    "speed=2.04x",
    "progress=continue",
  ];

  it("reads the share of the frames written, from the frame line alone", () => {
    const parse = ffmpegFrameProgress(980);
    expect(REPORT.map(parse)).toEqual([25, ...REPORT.slice(1).map(() => null)]);
    expect(parse("frame=0")).toBe(0);
    expect(parse("frame=  490")).toBe(50);
    expect(parse("frame=980")).toBe(100);
  });

  it("never passes 100, and ends at 100", () => {
    const parse = ffmpegFrameProgress(80);
    expect(parse("frame=81")).toBe(100);
    expect(parse("progress=end")).toBe(100);
  });

  it("gives null for anything else, and for a total it cannot divide by", () => {
    const parse = ffmpegFrameProgress(980);
    expect(parse("frame=N/A")).toBeNull();
    expect(parse('@hf-progress {"pct":50}')).toBeNull();
    expect(parse("")).toBeNull();
    expect(ffmpegFrameProgress(0)("frame=10")).toBeNull();
    expect(ffmpegFrameProgress(Number.NaN)("frame=10")).toBeNull();
    expect(ffmpegFrameProgress(0)("progress=end")).toBe(100);
  });
});

describe("weightedParts", () => {
  const hf = (pct: number) => `@hf-progress {"pct":${pct}}`;

  it("gives each part its own parser and its weight of the one percentage", () => {
    const [page, pass] = weightedParts([parseRenderProgress, ffmpegFrameProgress(200)], [1, 3]);
    expect(page!(hf(100))).toBe(25);
    // Each reads only its own tool's lines.
    expect(page!("frame=100")).toBeNull();
    expect(pass!(hf(50))).toBeNull();
    expect(pass!("frame=100")).toBe(63);
    expect(pass!("progress=end")).toBe(100);
  });

  it("counts a part of no weight for nothing", () => {
    const [a, off, b] = weightedParts(
      [parseRenderProgress, parseRenderProgress, parseRenderProgress],
      [1, 0, 1],
    );
    expect(a!(hf(100))).toBe(50);
    expect(off!(hf(100))).toBe(50);
    expect(b!(hf(100))).toBe(100);
  });
});
