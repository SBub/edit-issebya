// The footage check with the real ffprobe (Verification 1): generated clips
// and the committed ones, each through the pipeline runner on a folder fake.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeStorage } from "@edit-issebya/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FootageRefusedError, causeOf } from "../failures.ts";
import { TEST_JOB, recordingSteps, stepContext } from "../recording-steps.ts";
import { checkFootage } from "./check-footage.ts";
import { runPipeline } from "./run-pipeline.ts";
import { CLIP, REAL_TOOLS, ffmpeg } from "./tools-test-support.ts";

const SOURCE_KEY = `reels/${TEST_JOB.reel_id}/source/original.mp4`;
const CHECK_FIXTURES = new URL("../../../../fixtures/footage-check/", import.meta.url);

let dir: string;
let runs = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "check-footage-tools-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// The refusal message, or null when the clip is accepted.
async function verdict(path: string): Promise<string | null> {
  const root = join(dir, `run-${++runs}`);
  const scratch = join(root, "scratch");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
  await mkdir(scratch, { recursive: true });
  const storage = fakeStorage({ root: join(root, "store"), uploadUrlBase: "" });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a generated or committed clip
  await storage.put(SOURCE_KEY, new Uint8Array(await readFile(path)));
  const error = await runPipeline({
    ctx: stepContext(recordingSteps(SOURCE_KEY).steps),
    storage,
    keyPrefix: "",
    scratchDir: scratch,
    tools: REAL_TOOLS,
    pipeline: [checkFootage],
  }).then(
    () => null,
    (caught: unknown) => caught,
  );
  if (error === null) return null;
  const refused = causeOf(error, FootageRefusedError);
  if (!refused) throw error;
  return refused.message;
}

const sine = (seconds: number) => ["-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`];
const color = (size: string, seconds: number) => [
  "-f",
  "lavfi",
  "-i",
  `color=c=gray:s=${size}:r=1:d=${seconds}`,
];
const encode = ["-c:v", "libx264", "-pix_fmt", "yuv420p"];

async function clip(name: string, args: string[]): Promise<string> {
  const path = join(dir, name);
  await ffmpeg([...args, path]);
  return path;
}

// A landscape encode carrying rotation 90: ffmpeg 6+ takes it as an input
// option on a stream copy; older builds take the legacy rotate tag.
async function rotatedPortrait(): Promise<string> {
  const stored = await clip("stored-landscape.mp4", [
    ...color("320x180", 2),
    ...sine(2),
    ...encode,
    "-c:a",
    "aac",
    "-shortest",
  ]);
  const path = join(dir, "rotated.mp4");
  try {
    await ffmpeg(["-display_rotation:v:0", "90", "-i", stored, "-c", "copy", path]);
  } catch {
    await ffmpeg(["-i", stored, "-c", "copy", "-metadata:s:v:0", "rotate=90", path]);
  }
  return path;
}

describe("check_footage with the real ffprobe", () => {
  it("refuses a 100-second portrait clip as too long", async () => {
    const path = await clip("long.mp4", [
      ...color("90x160", 100),
      ...sine(100),
      ...encode,
      "-c:a",
      "aac",
      "-shortest",
    ]);
    expect(await verdict(path)).toBe(
      "This clip is 1 minute 40 seconds; the studio takes up to 1 minute 30 seconds.",
    );
  });

  it("refuses a landscape clip", async () => {
    const path = await clip("landscape.mp4", [
      ...color("160x90", 2),
      ...sine(2),
      ...encode,
      "-c:a",
      "aac",
      "-shortest",
    ]);
    expect(await verdict(path)).toBe(
      "This clip is landscape (160 x 90); the studio takes vertical footage only.",
    );
  });

  it("refuses a portrait clip without sound", async () => {
    const path = await clip("silent.mp4", [...color("90x160", 2), ...encode]);
    expect(await verdict(path)).toBe("This clip has no sound; the studio needs the voice.");
  });

  it("accepts a portrait clip stored landscape with rotation 90", async () => {
    expect(await verdict(await rotatedPortrait())).toBeNull();
  });

  it("refuses a text file named .mp4 as not a video", async () => {
    const path = join(dir, "notes.mp4");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    await writeFile(path, "these are notes, not a video\n");
    expect(await verdict(path)).toBe("This file is not a video the studio can read.");
  });

  it("accepts the committed short-speech clip", async () => {
    expect(await verdict(CLIP)).toBeNull();
  });

  it("refuses the committed landscape fixture with its recorded message", async () => {
    const manifest = JSON.parse(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed manifest
      await readFile(new URL("manifest.json", CHECK_FIXTURES), "utf8"),
    ) as { clips: { file: string; refusal: string }[] };
    const landscape = manifest.clips.find((entry) => entry.file === "landscape.mp4")!;
    expect(await verdict(new URL(landscape.file, CHECK_FIXTURES).pathname)).toBe(landscape.refusal);
  });
});
