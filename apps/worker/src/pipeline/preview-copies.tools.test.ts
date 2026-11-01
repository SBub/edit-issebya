import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_SETTINGS, previewCopies } from "./preview-copies.ts";
import { parseProbe, probeArgs } from "./probe.ts";
import {
  PERSON_CLIP,
  REAL_TOOLS,
  frameCount,
  personCutOut,
  rawAlphaFrame,
  realTool,
  streamTags,
  videoStream,
} from "./tools-test-support.ts";

// About 18 MB for 50 seconds, with room for a short clip's keyframe overhead.
const MAX_BYTES_PER_SECOND = ((18 * 1024 * 1024) / 50) * 1.5;

let dir: string;
let cutOut: string;
let stepDir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "preview-copies-tools-"));
  cutOut = await personCutOut(join(dir, "remove_background"));
  stepDir = join(dir, "preview_copies");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
  await mkdir(stepDir);
  await previewCopies.run({
    tool: realTool,
    tools: REAL_TOOLS,
    dir: stepDir,
    files: { "source.mp4": PERSON_CLIP, "subject.webm": cutOut },
    settings: PREVIEW_SETTINGS,
    signal: new AbortController().signal,
  });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("preview_copies with the real ffmpeg", () => {
  it("makes both copies at 540x960 with their sources' frames", async () => {
    const footage = join(stepDir, "footage.mp4");
    const subject = join(stepDir, "subject.webm");
    expect(await videoStream(footage)).toMatchObject({
      codec_name: "h264",
      width: 540,
      height: 960,
    });
    expect(await videoStream(subject)).toMatchObject({
      codec_name: "vp9",
      width: 540,
      height: 960,
    });
    expect(
      Math.abs((await frameCount(footage)) - (await frameCount(PERSON_CLIP))),
    ).toBeLessThanOrEqual(1);
    expect(Math.abs((await frameCount(subject)) - (await frameCount(cutOut)))).toBeLessThanOrEqual(
      1,
    );
  });

  it("keeps the cut-out's alpha", async () => {
    const subject = join(stepDir, "subject.webm");
    expect((await streamTags(subject)).alpha_mode).toBe("1");
    const plane = await rawAlphaFrame(subject, 2, 270, 480);
    expect(plane.includes(0)).toBe(true);
    expect(plane.includes(255)).toBe(true);
  });

  it("stays within the preview budget", async () => {
    const probe = parseProbe(
      await realTool({ file: REAL_TOOLS.ffprobe, args: probeArgs(PERSON_CLIP) }),
    );
    const bytes =
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      (await stat(join(stepDir, "footage.mp4"))).size +
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      (await stat(join(stepDir, "subject.webm"))).size;
    expect(bytes / probe.durationSeconds).toBeLessThan(MAX_BYTES_PER_SECOND);
  });
});
