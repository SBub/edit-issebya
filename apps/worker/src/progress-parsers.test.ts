import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  type ProgressParser,
  parseRemoveBackgroundProgress,
  parseRenderProgress,
} from "./progress-parsers.ts";

// Real HyperFrames 0.8.222 stdout, captured on the committed clips: the
// worker's remove-background entry and a full `hyperframes render`.
async function sample(name: string): Promise<string[]> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed samples
  const text = await readFile(new URL(`progress-testdata/${name}`, import.meta.url), "utf8");
  return text.split("\n");
}

function values(lines: string[], parse: ProgressParser): number[] {
  return lines.map(parse).filter((value): value is number => value !== null);
}

describe.each([
  ["remove-background.txt", parseRemoveBackgroundProgress],
  ["render.txt", parseRenderProgress],
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
