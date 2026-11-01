import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeStorage } from "@edit-issebya/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_JOB, recordingSteps, stepContext } from "../recording-steps.ts";
import { fingerprintsFor } from "./definition.ts";
import { cacheKey } from "./fingerprint.ts";
import type { HeadSample } from "./head-track.ts";
import { parseProbe, probeArgs } from "./probe.ts";
import { runPipeline } from "./run-pipeline.ts";
import {
  PERSON_CLIP,
  REAL_TOOLS,
  decodeFrameRgba,
  realTool,
  videoStream,
} from "./tools-test-support.ts";

const SOURCE_KEY = `reels/${TEST_JOB.reel_id}/source/original.mp4`;

let dir: string;
let local: (step: string, file: string) => Promise<string>;

async function duration(path: string): Promise<number> {
  return parseProbe(await realTool({ file: REAL_TOOLS.ffprobe, args: probeArgs(path) }))
    .durationSeconds;
}

// VP9 with alpha, and a middle frame with both fully clear and fully opaque pixels.
async function expectAlpha(path: string) {
  const stream = await videoStream(path);
  expect(stream.codec_name).toBe("vp9");
  const alphaMode = stream.tags?.alpha_mode ?? stream.tags?.ALPHA_MODE;
  expect(alphaMode === "1" || stream.pix_fmt === "yuva420p").toBe(true);
  const frame = await decodeFrameRgba(path, (await duration(path)) / 2);
  const alphas = new Set<number>();
  for (let at = 3; at < frame.length; at += 4) alphas.add(frame[at]!);
  expect(alphas.has(0)).toBe(true);
  expect(alphas.has(255)).toBe(true);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cutout-tools-"));
  const storage = fakeStorage({ root: join(dir, "store"), uploadUrlBase: "" });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed clip, read only
  await storage.put(SOURCE_KEY, new Uint8Array(await readFile(PERSON_CLIP)));
  const scratch = join(dir, "scratch");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
  await mkdir(scratch);
  const { steps, calls } = recordingSteps(SOURCE_KEY);
  await runPipeline({
    ctx: stepContext(steps),
    storage,
    keyPrefix: "",
    scratchDir: scratch,
    tools: REAL_TOOLS,
  });
  expect(calls.filter((call) => call.call === "done")).toHaveLength(6);
  for (const call of calls) if (call.call === "done") console.log(call.summary);

  const head = await storage.head(SOURCE_KEY);
  const fp = fingerprintsFor({ etag: head!.etag!, bytes: head!.bytes });
  local = async (step, file) => {
    const path = join(dir, `${step}-${file}`);
    expect(await storage.getFile(cacheKey("", step, fp[step]!, file), path)).toBe(true);
    return path;
  };
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the cut-out steps on the person clip with the real tools", () => {
  it("removes the background into VP9 with alpha", async () => {
    await expectAlpha(await local("remove_background", "subject.webm"));
  });

  it("tracks the head four times a second inside the frame", async () => {
    const source = await local("retime", "source.mp4");
    const { width } = await videoStream(source);
    const track = JSON.parse(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      await readFile(await local("head_track", "head-track.json"), "utf8"),
    ) as HeadSample[];
    const subjectSeconds = await duration(await local("remove_background", "subject.webm"));
    expect(Math.abs(track.length - subjectSeconds * 4)).toBeLessThanOrEqual(1);
    const found = track.filter((sample) => sample !== null);
    expect(found.length).toBeGreaterThanOrEqual(0.8 * track.length);
    for (const sample of found) {
      expect(sample.cx).toBeGreaterThanOrEqual(0);
      expect(sample.cx).toBeLessThan(width);
    }
  });

  it("makes small preview copies with the source's timing, the cut-out keeping alpha", async () => {
    const source = await local("retime", "source.mp4");
    const footage = await local("preview_copies", "preview.mp4");
    const subject = await local("preview_copies", "preview-subject.webm");
    const sourceSeconds = await duration(source);
    for (const path of [footage, subject]) {
      expect(await videoStream(path)).toMatchObject({ width: 540, height: 960 });
      expect(Math.abs((await duration(path)) - sourceSeconds)).toBeLessThanOrEqual(1 / 30 + 1e-6);
    }
    await expectAlpha(subject);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    const bytes = (await stat(footage)).size + (await stat(subject)).size;
    const megabitsPerSecond = (bytes * 8) / sourceSeconds / 1e6;
    console.log(
      `previews: ${(bytes / 1e6).toFixed(2)} MB for ${sourceSeconds.toFixed(2)} s, ${megabitsPerSecond.toFixed(2)} Mbit/s`,
    );
    // Twice the 18 MB per 50 s target: guards against a full-size copy.
    expect(megabitsPerSecond).toBeLessThan(5.8);
  });
});
