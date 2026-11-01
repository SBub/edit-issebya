import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PipelineStep } from "./definition.ts";
import type { HeadSample } from "./head-track.ts";
import { headTrack } from "./head-track-step.ts";
import { previewCopies } from "./preview-copies.ts";
import { removeBackground } from "./remove-background.ts";
import {
  PERSON_CLIP,
  REAL_TOOLS,
  decodeFrameRgba,
  formatDuration,
  realTool,
  streamInfo,
} from "./tools-test-support.ts";
import { hyperframesEnv } from "./tools.ts";

// The cut-out steps on the person clip (read only), with the real HyperFrames
// and ffmpeg, run directly in order: remove_background, head_track,
// preview_copies.
let dir: string;
let subject: string;
let headTrackJson: string;
let footagePreview: string;
let subjectPreview: string;

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
  dir = await mkdtemp(join(tmpdir(), "cutout-tools-"));
  subject = join(await runStep(removeBackground, { "source.mp4": PERSON_CLIP }), "subject.webm");
  headTrackJson = join(await runStep(headTrack, { "subject.webm": subject }), "head-track.json");
  const previews = await runStep(previewCopies, {
    "source.mp4": PERSON_CLIP,
    "subject.webm": subject,
  });
  footagePreview = join(previews, "footage-preview.mp4");
  subjectPreview = join(previews, "subject-preview.webm");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// VP9 with alpha: the alpha_mode tag, or yuva420p when decoded by libvpx.
async function expectAlpha(path: string) {
  const info = await streamInfo(path);
  expect(info.codec_name).toBe("vp9");
  const tags = info.tags ?? {};
  const alphaMode = tags.ALPHA_MODE ?? tags.alpha_mode;
  expect(alphaMode === "1" || info.pix_fmt === "yuva420p", JSON.stringify(info)).toBe(true);
  const frame = await decodeFrameRgba(path, 2, 270, 480);
  const alphas = new Set<number>();
  for (let index = 3; index < frame.length; index += 4) alphas.add(frame[index]!);
  expect(alphas.has(0)).toBe(true);
  expect(alphas.has(255)).toBe(true);
}

describe("remove_background", () => {
  it("cuts the speaker out to VP9 with alpha, on HyperFrames' u2net_human_seg", async () => {
    await expectAlpha(subject);
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
});

describe("head_track", () => {
  it("finds a head in most samples, one every 0.25 s, inside the frame", async () => {
    const samples = JSON.parse(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      await readFile(headTrackJson, "utf8"),
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
});

describe("preview_copies", () => {
  it("makes 540x960 copies as long as the source, the cut-out keeping its alpha", async () => {
    const source = await formatDuration(PERSON_CLIP);
    for (const path of [footagePreview, subjectPreview]) {
      expect(await streamInfo(path)).toMatchObject({ width: 540, height: 960 });
      expect(Math.abs((await formatDuration(path)) - source)).toBeLessThanOrEqual(1 / 30);
    }
    expect((await streamInfo(footagePreview)).codec_name).toBe("h264");
    await expectAlpha(subjectPreview);
  });
});
