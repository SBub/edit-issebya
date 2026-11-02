import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PipelineStep } from "./definition.ts";
import type { HeadSample } from "./head-track.ts";
import { headTrack } from "./head-track-step.ts";
import { previewCopies } from "./preview-copies.ts";
import {
  PERSON_CLIP,
  REAL_TOOLS,
  formatDuration,
  realTool,
  streamInfo,
} from "./tools-test-support.ts";
import { hyperframesEnv } from "./tools.ts";

// head_track and preview_copies on the person clip (read only, given to each
// step as its retimed footage), with the real HyperFrames and ffmpeg, run
// directly: head_track makes its own sampled person mask with HyperFrames'
// u2net, preview_copies the footage copy, its thumbnail and its frames sprite.
let dir: string;
let headTrackDir: string;
let footagePreview: string;
let previewsDir: string;

async function runStep(step: PipelineStep, files: Record<string, string>): Promise<string> {
  const stepDir = join(dir, step.name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
  await mkdir(stepDir);
  await step.run({
    tool: realTool,
    tools: REAL_TOOLS,
    dir: stepDir,
    files,
    settings: step.settings,
    signal: new AbortController().signal,
  });
  return stepDir;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "head-track-tools-"));
  headTrackDir = await runStep(headTrack, { "source.mp4": PERSON_CLIP });
  previewsDir = await runStep(previewCopies, { "source.mp4": PERSON_CLIP });
  footagePreview = join(previewsDir, "footage-preview.mp4");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("head_track", () => {
  it("masks with HyperFrames' u2net_human_seg", async () => {
    const [node, entry] = REAL_TOOLS.hyperframes;
    const info = JSON.parse(
      await realTool({
        file: node,
        args: [entry, "remove-background", "--info", "--json"],
        env: hyperframesEnv(),
      }),
    ) as { defaultModel: string };
    expect(info.defaultModel).toBe("u2net_human_seg");
  });

  it("finds a head in most samples, one every 0.25 s, inside the frame", async () => {
    const samples = JSON.parse(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      await readFile(join(headTrackDir, "head-track.json"), "utf8"),
    ) as (HeadSample | null)[];
    const duration = await formatDuration(PERSON_CLIP);
    expect(Math.abs(samples.length - duration / 0.25)).toBeLessThanOrEqual(1);
    const found = samples.filter((sample): sample is HeadSample => sample !== null);
    expect(found.length).toBeGreaterThanOrEqual(0.8 * samples.length);
    for (const sample of found) {
      expect(sample.cx).toBeGreaterThanOrEqual(0);
      expect(sample.cx).toBeLessThan(1080);
    }
  });

  it("keeps no mask, sample clip or raw frames", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect(await readdir(headTrackDir)).toEqual(["head-track.json"]);
  });
});

describe("preview_copies", () => {
  it("makes one 540x960 H.264 footage copy as long as the source", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect((await readdir(previewsDir)).sort()).toEqual([
      "footage-preview.mp4",
      "frames.jpg",
      "thumbnail.jpg",
    ]);
    const source = await formatDuration(PERSON_CLIP);
    expect(await streamInfo(footagePreview)).toMatchObject({
      width: 540,
      height: 960,
      codec_name: "h264",
    });
    expect(Math.abs((await formatDuration(footagePreview)) - source)).toBeLessThanOrEqual(1 / 30);
  });

  it("makes a 270x480 thumbnail and a one-row 32-frame sprite of 90x160 frames", async () => {
    expect(await streamInfo(join(previewsDir, "thumbnail.jpg"))).toMatchObject({
      width: 270,
      height: 480,
      codec_name: "mjpeg",
    });
    expect(await streamInfo(join(previewsDir, "frames.jpg"))).toMatchObject({
      width: 90 * 32,
      height: 160,
      codec_name: "mjpeg",
    });
  });
});
