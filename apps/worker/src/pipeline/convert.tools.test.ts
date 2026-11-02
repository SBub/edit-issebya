import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONVERT_SETTINGS, convert } from "./convert.ts";
import { isHdr, isVariableFrameRate, parseProbe, probeArgs } from "./probe.ts";
import {
  CLIP,
  REAL_TOOLS,
  ffmpeg,
  keyframeTimes,
  realTool,
  videoStream,
} from "./tools-test-support.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "convert-tools-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function converted(source: string, name: string): Promise<string> {
  const stepDir = join(dir, name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
  await mkdir(stepDir);
  await convert.run({
    tool: realTool,
    tools: REAL_TOOLS,
    dir: stepDir,
    files: { source },
    settings: CONVERT_SETTINGS,
    signal: new AbortController().signal,
  });
  return join(stepDir, "converted.mp4");
}

async function probe(path: string) {
  return parseProbe(await realTool({ file: REAL_TOOLS.ffprobe, args: probeArgs(path) }));
}

describe("convert with the real ffmpeg", () => {
  it("makes H.264 at a constant 30 fps with a keyframe every second", async () => {
    const out = await converted(CLIP, "clip");
    const video = await videoStream(out);
    expect(video).toMatchObject({
      codec_name: "h264",
      r_frame_rate: "30/1",
      avg_frame_rate: "30/1",
    });
    const keys = await keyframeTimes(out);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    keys.slice(1).forEach((time, index) => {
      expect(time - keys[index]!).toBeCloseTo(1, 2);
    });
    expect((await probe(out)).audio?.codec).toBe("aac");
  });

  it("tone-maps HLG footage to SDR BT.709", async () => {
    const hdr = join(dir, "hlg.mov");
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=320x568:r=30",
      "-f",
      "lavfi",
      "-i",
      "sine=f=440:r=48000",
      "-t",
      "2",
      // Frame properties, not encoder flags: ffmpeg 8 tags the stream from them.
      "-vf",
      ["setparams=color_primaries=bt2020", "color_trc=arib-std-b67", "colorspace=bt2020nc"].join(
        ":",
      ) + ",format=yuv420p10le",
      "-c:v",
      "libx265",
      "-x265-params",
      "log-level=error",
      "-c:a",
      "aac",
      hdr,
    ]);
    expect(isHdr(await probe(hdr))).toBe(true);
    const out = await converted(hdr, "hlg");
    expect((await videoStream(out)).color_transfer).toBe("bt709");
    expect(isHdr(await probe(out))).toBe(false);
  });

  it("makes variable frame rate footage a steady 30 fps", async () => {
    const parts = [24, 60].map((rate) => join(dir, `part-${rate}.mp4`));
    for (const [index, rate] of [24, 60].entries()) {
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        `testsrc2=s=320x568:r=${rate}`,
        "-t",
        "1",
        "-c:v",
        "libx264",
        parts[index]!,
      ]);
    }
    const vfr = join(dir, "vfr.mp4");
    await ffmpeg([
      "-i",
      parts[0]!,
      "-i",
      parts[1]!,
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1:a=0[v]",
      "-map",
      "[v]",
      "-fps_mode",
      "vfr",
      "-c:v",
      "libx264",
      vfr,
    ]);
    expect(isVariableFrameRate(await probe(vfr))).toBe(true);
    const video = await videoStream(await converted(vfr, "vfr"));
    expect(video).toMatchObject({ r_frame_rate: "30/1", avg_frame_rate: "30/1" });
  });
});
