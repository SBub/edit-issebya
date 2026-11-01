import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { headTrack } from "./head-track-step.ts";
import type { HeadSample } from "./head-track.ts";
import { previewCopies } from "./preview-copies.ts";
import { removeBackground } from "./remove-background.ts";
import { PERSON_CLIP, REAL_TOOLS, rgbaFrame, realTool, videoFormat } from "./tools-test-support.ts";

// The person clip stands in for retime's source.mp4 (already H.264 30 fps
// 1080x1920); each step runs directly, reading the one before it.
let dir: string;
let source: string;
const signal = new AbortController().signal;

async function stepDir(name: string): Promise<string> {
  const path = join(dir, name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
  await mkdir(path, { recursive: true });
  return path;
}

async function expectAlpha(path: string) {
  const format = await videoFormat(path);
  expect(format.codec_name).toBe("vp9");
  expect(format.alphaMode).toBe("1");
  const frame = await rgbaFrame(path, 2);
  const alphas = new Set<number>();
  for (let at = 3; at < frame.length; at += 4) alphas.add(frame[at]!);
  expect(alphas.has(0)).toBe(true);
  expect(alphas.has(255)).toBe(true);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "background-tools-"));
  source = join(dir, "source.mp4");
  // A copy: the committed clip is never handed to a tool that writes.
  await copyFile(PERSON_CLIP, source);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("background, head and previews with the real tools", () => {
  let subject: string;

  it("cuts the speaker out as VP9 with alpha", async () => {
    const out = await stepDir("remove_background");
    await removeBackground.run({
      tool: realTool,
      tools: REAL_TOOLS,
      dir: out,
      files: { "source.mp4": source },
      settings: removeBackground.settings,
      signal,
    });
    subject = join(out, "subject.webm");
    await expectAlpha(subject);
  });

  it("tracks the head in most samples, inside the frame", async () => {
    const out = await stepDir("head_track");
    const { what } = await headTrack.run({
      tool: realTool,
      tools: REAL_TOOLS,
      dir: out,
      files: { "subject.webm": subject },
      settings: headTrack.settings,
      signal,
    });
    expect(what).toMatch(/^head tracked, \d+ samples, \d+ without a head$/);
    const samples = JSON.parse(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      await readFile(join(out, "head-track.json"), "utf8"),
    ) as HeadSample[];
    const found = samples.filter((sample) => sample !== null);
    expect(samples.length).toBeGreaterThan(0);
    expect(found.length / samples.length).toBeGreaterThanOrEqual(0.8);
    for (const sample of found) {
      expect(sample.cx).toBeGreaterThanOrEqual(0);
      expect(sample.cx).toBeLessThan(1080);
    }
  });

  it("makes 540x960 previews at the clip's length, the cut-out keeping alpha", async () => {
    const out = await stepDir("preview_copies");
    await previewCopies.run({
      tool: realTool,
      tools: REAL_TOOLS,
      dir: out,
      files: { "source.mp4": source, "subject.webm": subject },
      settings: previewCopies.settings,
      signal,
    });
    const clip = await videoFormat(PERSON_CLIP);
    for (const file of ["preview-source.mp4", "preview-subject.webm"]) {
      const format = await videoFormat(join(out, file));
      expect(format, file).toMatchObject({ width: 540, height: 960 });
      expect(Math.abs(format.durationSeconds - clip.durationSeconds), file).toBeLessThanOrEqual(
        1 / 30,
      );
    }
    await expectAlpha(join(out, "preview-subject.webm"));
  });
});
