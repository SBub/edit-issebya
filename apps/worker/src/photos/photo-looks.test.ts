import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Storage, fakeStorage } from "@edit-issebya/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolCall } from "../step-runner.ts";
import { edgeLuminance, photoEdgeArgs, photoLooks } from "./photo-looks.ts";
import type { LibraryPhoto } from "./photo-store.ts";

// One 8x8 RGB frame: `edge` on the border, `inside` within it.
function frame(edge: number, inside: number): Uint8Array {
  const bytes = new Uint8Array(8 * 8 * 3);
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const border = row === 0 || row === 7 || col === 0 || col === 7;
      bytes.fill(border ? edge : inside, (row * 8 + col) * 3, (row * 8 + col) * 3 + 3);
    }
  }
  return bytes;
}

describe("edgeLuminance", () => {
  it("reads the border only, as WCAG luminance", () => {
    expect(edgeLuminance(frame(255, 0))).toBe(1);
    expect(edgeLuminance(frame(0, 255))).toBe(0);
    // sRGB 128 grey: about 0.216.
    expect(edgeLuminance(frame(128, 0))).toBeCloseTo(0.216, 2);
  });

  it("refuses anything but one 8x8 frame", () => {
    expect(() => edgeLuminance(new Uint8Array(10))).toThrow(/not one 8x8 RGB frame/);
  });
});

describe("photoEdgeArgs", () => {
  it("scales one frame down to the grid as raw RGB", () => {
    expect(photoEdgeArgs("in.jpg", "out.rgb")).toEqual([
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-i",
      "in.jpg",
      "-frames:v",
      "1",
      "-vf",
      "scale=8:8:flags=area,format=rgb24",
      "-f",
      "rawvideo",
      "out.rgb",
    ]);
  });
});

describe("photoLooks", () => {
  let root: string;
  let dir: string;
  let storage: Storage;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "looks-storage-"));
    dir = await mkdtemp(join(tmpdir(), "looks-scratch-"));
    storage = fakeStorage({ root, uploadUrlBase: "" });
    await storage.put("dev/library/a/thumbnail.jpg", new TextEncoder().encode("jpeg"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });

  const photo = (id: string, more: Partial<LibraryPhoto>): LibraryPhoto => ({
    id,
    description: "",
    tags: [],
    large_key: `dev/library/${id}/large.jpg`,
    ...more,
  });

  it("gives each photo its ratio and its edge, leaving out what it cannot read", async () => {
    const calls: ToolCall[] = [];
    const tool = async (call: ToolCall) => {
      calls.push(call);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's scratch folder
      await writeFile(call.args.at(-1)!, frame(255, 0));
      return "";
    };
    const looks = await photoLooks({
      library: [
        photo("a", { width: 4000, height: 3000, thumbnail_key: "dev/library/a/thumbnail.jpg" }),
        // Its thumbnail is missing: the ratio only.
        photo("b", { width: 3000, height: 4000, thumbnail_key: "dev/library/b/thumbnail.jpg" }),
        // A test library row: nothing known.
        photo("c", {}),
      ],
      storage,
      tool,
      ffmpeg: "ffmpeg",
      dir,
      signal: new AbortController().signal,
    });
    expect(looks).toEqual(
      new Map([
        ["a", { aspect: 4 / 3, edge: 1 }],
        ["b", { aspect: 0.75 }],
      ]),
    );
    expect(calls.map((call) => call.file)).toEqual(["ffmpeg"]);
  });

  it("goes on without the edge when ffmpeg fails, and stops on a cancel", async () => {
    const library = [photo("a", { thumbnail_key: "dev/library/a/thumbnail.jpg" })];
    const failing = async () => {
      throw new Error("ffmpeg exited 1");
    };
    const signal = new AbortController().signal;
    expect(
      await photoLooks({ library, storage, tool: failing, ffmpeg: "ffmpeg", dir, signal }),
    ).toEqual(new Map());
    const cancel = new AbortController();
    cancel.abort();
    await expect(
      photoLooks({ library, storage, tool: failing, ffmpeg: "ffmpeg", dir, signal: cancel.signal }),
    ).rejects.toThrow();
  });
});
