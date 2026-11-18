// `test:tools` only: the real ffprobe and ffmpeg on the committed photos
// (fixtures/photos/, made by scripts/make-test-photos.sh), and on turned
// copies of them made here: the JPEG with an EXIF Orientation tag written in,
// the tiled HEIC with its `irot` box changed. No real photo is used.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REAL_TOOLS, realTool } from "../pipeline/tools-test-support.ts";
import { readHeifTurn } from "./heif-turn.ts";
import {
  LARGE_LONG_SIDE,
  PROBE_STDOUT_BYTES,
  type PhotoProbe,
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

// The probe and both copies, as the step makes them.
async function images(input: string, name: string) {
  const json = await realTool({ file: REAL_TOOLS.ffprobe, args: photoProbeArgs(input) });
  const probe: PhotoProbe = parsePhotoProbe(json, await readHeifTurn(input));
  const thumbnail = join(dir, `${name}-thumbnail.jpg`);
  const large = join(dir, `${name}-large.jpg`);
  const small = fitWithin(probe.width, probe.height, THUMBNAIL_LONG_SIDE);
  const big = fitWithin(probe.width, probe.height, LARGE_LONG_SIDE);
  await realTool({ file: REAL_TOOLS.ffmpeg, args: photoImageArgs(input, probe, small, thumbnail) });
  await realTool({ file: REAL_TOOLS.ffmpeg, args: photoImageArgs(input, probe, big, large) });
  return { json, probe, thumbnail, large };
}

// The Orientation tag a viewer would turn the file by once more (none, or 1,
// on an upright copy).
async function orientationOf(path: string): Promise<number> {
  const { stdout } = await run(REAL_TOOLS.ffprobe, [
    "-v",
    "error",
    "-print_format",
    "json",
    "-read_intervals",
    "%+#1",
    "-show_entries",
    "frame_tags=Orientation",
    path,
  ]);
  const frames = (JSON.parse(stdout) as { frames?: { tags?: { Orientation?: string } }[] }).frames;
  return Number(frames?.[0]?.tags?.Orientation ?? 1);
}

// The JPEG with an EXIF block that holds only the Orientation tag, put right
// after the start marker.
function withOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 1, 0x12, 0, 3, 0, 0, 0, 1];
  const body = Buffer.concat([
    Buffer.from("Exif\0\0", "latin1"),
    Buffer.from([...tiff, 0, orientation, 0, 0, 0, 0, 0, 0]),
  ]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), head, body, jpeg.subarray(2)]);
}

// What a viewer does for each Orientation value, written with ffmpeg's
// numbered transpose directions (the step's own filters use the names).
const UPRIGHT: Record<number, string> = {
  1: "null",
  2: "hflip",
  3: "hflip,vflip",
  4: "vflip",
  5: "transpose=0",
  6: "transpose=1",
  7: "transpose=3",
  8: "transpose=2",
};

// The committed JPEG turned as `orientation` asks, at thumbnail size: what
// the thumbnail of a file with that tag must show.
async function expected(orientation: number): Promise<string> {
  const path = join(dir, `expected-${orientation}.png`);
  const size = orientation >= 5 ? "360:480" : "480:360";
  await run(REAL_TOOLS.ffmpeg, [
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-noautorotate",
    "-i",
    new URL("sample.jpg", PHOTOS).pathname,
    "-vf",
    `${UPRIGHT[orientation]},scale=${size}`,
    path,
  ]);
  return path;
}

// The upright size and the turn of a picture stored 1200x900, by the
// Orientation value its turn is the same as.
const TURNED = {
  3: { width: 1200, height: 900, rotation: 180 },
  6: { width: 900, height: 1200, rotation: 90 },
  8: { width: 900, height: 1200, rotation: 270 },
} as const;

describe("photo images on the real tools", () => {
  for (const name of ["sample.jpg", "sample.heic"]) {
    it(`makes a 480-pixel thumbnail and the large copy of ${name}`, async () => {
      const { probe, thumbnail, large } = await images(new URL(name, PHOTOS).pathname, name);
      expect(probe).toMatchObject({ width: 1200, height: 900, mirrored: false, rotation: 0 });
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

  it("probes a tile grid in a few KB, far under the call's cap", async () => {
    const { json, probe } = await images(new URL("sample.heic", PHOTOS).pathname, "cap");
    expect(probe.source.kind).toBe("grid");
    expect(Buffer.byteLength(json)).toBeLessThan(4096);
    expect(PROBE_STDOUT_BYTES).toBeGreaterThan(1000 * Buffer.byteLength(json));
  });

  for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`makes upright copies of a JPEG with EXIF Orientation ${orientation}`, async () => {
      const input = join(dir, `orientation-${orientation}.jpg`);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
      const jpeg = await readFile(new URL("sample.jpg", PHOTOS));
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      await writeFile(input, withOrientation(jpeg, orientation));
      const { probe, thumbnail, large } = await images(input, `orientation-${orientation}`);
      const portrait = orientation >= 5;
      expect({ width: probe.width, height: probe.height }).toEqual(
        portrait ? { width: 900, height: 1200 } : { width: 1200, height: 900 },
      );
      expect(await sizeOf(thumbnail)).toEqual(
        portrait ? { width: 360, height: 480 } : { width: 480, height: 360 },
      );
      expect(await sizeOf(large)).toEqual({ width: probe.width, height: probe.height });
      // Upright pixels (turned the wrong way, or twice, is under 15 dB), and
      // no tag left that would turn them once more.
      expect(await psnr(thumbnail, await expected(orientation))).toBeGreaterThan(30);
      expect(await orientationOf(thumbnail)).toBe(1);
      expect(await orientationOf(large)).toBe(1);
    });
  }

  // ffmpeg cannot write a tiled HEIC, so the committed one (made by `sips`,
  // its `irot` box saying no turn) gets the turn an iPhone held upright
  // writes (3 quarter turns anticlockwise) and the opposite one.
  for (const [quarters, orientation] of [
    [3, 6],
    [1, 8],
    [2, 3],
  ] as const) {
    it(`makes upright copies of a tiled HEIC turned ${quarters} quarters`, async () => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
      const heic = await readFile(new URL("sample.heic", PHOTOS));
      const at = heic.indexOf("irot", 0, "latin1");
      expect(at).toBeGreaterThan(0);
      expect(heic.indexOf("irot", at + 4, "latin1")).toBe(-1);
      expect(heic[at + 4]).toBe(0);
      heic[at + 4] = quarters;
      const input = join(dir, `turned-${quarters}.heic`);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      await writeFile(input, heic);
      const { probe, thumbnail } = await images(input, `turned-${quarters}`);
      expect(probe.source.kind).toBe("grid");
      expect(probe).toMatchObject({ ...TURNED[orientation], mirrored: false });
      expect(await psnr(thumbnail, await expected(orientation))).toBeGreaterThan(30);
      expect(await orientationOf(thumbnail)).toBe(1);
    });
  }
});
