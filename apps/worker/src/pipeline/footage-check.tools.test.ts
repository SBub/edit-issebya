// `test:tools` only: the real ffprobe on clips made here with ffmpeg's lavfi
// sources, and on the committed clips. Never reads short-person.mp4.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FootageRefused } from "../failure.ts";
import { NOT_A_VIDEO, NO_SOUND, checkFootage } from "./footage-check.ts";
import { CLIP, REAL_TOOLS, ffmpeg, realTool } from "./tools-test-support.ts";

const LANDSCAPE = new URL("../../../../fixtures/footage/landscape.mp4", import.meta.url).pathname;

let dir: string;

// A tiny clip: test pattern video, optionally a tone.
async function clip(
  name: string,
  { size, seconds, sound = true }: { size: string; seconds: number; sound?: boolean },
): Promise<string> {
  const path = join(dir, name);
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${size}:rate=15:duration=${seconds}`,
    ...(sound ? ["-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`] : []),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    ...(sound ? ["-c:a", "aac", "-shortest"] : []),
    path,
  ]);
  return path;
}

async function verdict(path: string): Promise<string> {
  try {
    const { what } = await checkFootage({ tool: realTool, tools: REAL_TOOLS, path });
    return `accepted: ${what}`;
  } catch (error) {
    if (error instanceof FootageRefused) return error.message;
    throw error;
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "footage-check-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("checkFootage with the real ffprobe", () => {
  it("refuses a 100-second portrait clip as too long", async () => {
    const path = await clip("long.mp4", { size: "90x160", seconds: 100 });
    expect(await verdict(path)).toBe(
      "This clip is 1 minute 40 seconds; the studio takes up to 1 minute 30 seconds.",
    );
  });

  it("refuses a landscape clip", async () => {
    const path = await clip("landscape.mp4", { size: "160x90", seconds: 2 });
    expect(await verdict(path)).toBe(
      "This clip is 160 x 90, not vertical. The studio takes vertical clips only.",
    );
  });

  it("refuses a portrait clip without sound", async () => {
    const path = await clip("silent.mp4", { size: "90x160", seconds: 2, sound: false });
    expect(await verdict(path)).toBe(NO_SOUND);
  });

  it("accepts a landscape clip whose display matrix turns it portrait", async () => {
    const stored = await clip("stored-landscape.mp4", { size: "160x90", seconds: 2 });
    const rotated = join(dir, "rotated.mp4");
    await ffmpeg(["-display_rotation", "90", "-i", stored, "-c", "copy", rotated]);
    expect(await verdict(rotated)).toBe("accepted: footage checked, 0:02, 90 x 160");
  });

  it("refuses a renamed text file as not a video", async () => {
    const path = join(dir, "notes.mp4");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    await writeFile(path, "shopping list: eggs, milk\n");
    expect(await verdict(path)).toBe(NOT_A_VIDEO);
  });

  it("accepts the committed speech clip and refuses the committed landscape clip", async () => {
    expect(await verdict(CLIP)).toMatch(/^accepted: footage checked, 0:03, 720 x 1280$/);
    expect(await verdict(LANDSCAPE)).toBe(
      "This clip is 320 x 180, not vertical. The studio takes vertical clips only.",
    );
  });
});
