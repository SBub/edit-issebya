// `test:tools` only: the real ffprobe and ffmpeg on the committed photos
// (fixtures/photos/, made by scripts/make-test-photos.sh).
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REAL_TOOLS, realTool } from "../pipeline/tools-test-support.ts";
import {
  LARGE_LONG_SIDE,
  THUMBNAIL_LONG_SIDE,
  fitWithin,
  parsePhotoProbe,
  photoImageArgs,
  photoProbeArgs,
} from "./photo-images.ts";

const run = promisify(execFile);
const PHOTOS = new URL("../../../../fixtures/photos/", import.meta.url);

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "photo-images-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function sizeOf(path: string): Promise<{ width: number; height: number }> {
  const { stdout } = await run(REAL_TOOLS.ffprobe, [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    path,
  ]);
  const stream = (JSON.parse(stdout) as { streams: { width: number; height: number }[] })
    .streams[0]!;
  return { width: stream.width, height: stream.height };
}

// The mean PSNR in dB between two pictures of one size.
async function psnr(a: string, b: string): Promise<number> {
  const { stderr } = await run(REAL_TOOLS.ffmpeg, [
    "-hide_banner",
    "-i",
    a,
    "-i",
    b,
    "-lavfi",
    "psnr",
    "-f",
    "null",
    "-",
  ]);
  return Number(/average:([\d.]+)/.exec(stderr)?.[1] ?? 0);
}

describe("photo images on the real tools", () => {
  for (const name of ["sample.jpg", "sample.heic"]) {
    it(`makes a 480-pixel thumbnail and the large copy of ${name}`, async () => {
      const input = new URL(name, PHOTOS).pathname;
      const probe = parsePhotoProbe(
        await realTool({ file: REAL_TOOLS.ffprobe, args: photoProbeArgs(input) }),
      );
      expect({ width: probe.width, height: probe.height }).toEqual({ width: 1200, height: 900 });
      const thumbnail = join(dir, `${name}-thumbnail.jpg`);
      const large = join(dir, `${name}-large.jpg`);
      const small = fitWithin(probe.width, probe.height, THUMBNAIL_LONG_SIDE);
      const big = fitWithin(probe.width, probe.height, LARGE_LONG_SIDE);
      await realTool({
        file: REAL_TOOLS.ffmpeg,
        args: photoImageArgs(input, probe, small, thumbnail),
      });
      await realTool({ file: REAL_TOOLS.ffmpeg, args: photoImageArgs(input, probe, big, large) });
      expect(await sizeOf(thumbnail)).toEqual({ width: 480, height: 360 });
      expect(await sizeOf(large)).toEqual({ width: 1200, height: 900 });
    });
  }

  it("puts the HEIC's tiles together into the same picture as the JPEG", async () => {
    // A single tile scaled up would differ far more (under 10 dB).
    expect(
      await psnr(join(dir, "sample.heic-thumbnail.jpg"), join(dir, "sample.jpg-thumbnail.jpg")),
    ).toBeGreaterThan(35);
  });
});
