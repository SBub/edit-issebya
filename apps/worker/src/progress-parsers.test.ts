import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  type ProgressParser,
  parseCutoutProgress,
  parsePersonMaskProgress,
  parseRenderProgress,
  weightedProgress,
} from "./progress-parsers.ts";

// Real stdout, captured on the committed clips: the worker's person mask entry
// (HyperFrames 0.8.222's removeBackground), a full `hyperframes render` and the
// cut-out's MODNet entry on one second of the person clip.
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
