import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolCall } from "../step-runner.ts";
import {
  PREVIEW_SETTINGS,
  footagePreviewArgs,
  framesArgs,
  previewCopies,
  thumbnailArgs,
} from "./preview-copies.ts";

describe("footagePreviewArgs", () => {
  it("encodes a 540x960 H.264 copy with the source's frame timing", () => {
    expect(footagePreviewArgs("/in/source.mp4", "/out/f.part.mp4", PREVIEW_SETTINGS)).toEqual([
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-i",
      "/in/source.mp4",
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-vf",
      "scale=540:960",
      "-fps_mode",
      "passthrough",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-b:v",
      "1200k",
      "-maxrate",
      "1500k",
      "-bufsize",
      "3000k",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "30",
      "-keyint_min",
      "30",
      "-sc_threshold",
      "0",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      "/out/f.part.mp4",
    ]);
  });
});

describe("thumbnailArgs", () => {
  it("picks one representative frame at tile size, no audio", () => {
    expect(thumbnailArgs("/in/source.mp4", "/out/t.part.jpg", PREVIEW_SETTINGS)).toEqual([
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-i",
      "/in/source.mp4",
      "-map",
      "0:v:0",
      "-an",
      "-vf",
      "thumbnail=30,scale=270:480",
      "-frames:v",
      "1",
      "-q:v",
      "4",
      "/out/t.part.jpg",
    ]);
  });
});

describe("framesArgs", () => {
  it("tiles one small frame every two seconds into one row, built from the settings", () => {
    expect(framesArgs("/in/source.mp4", "/out/f.part.jpg", PREVIEW_SETTINGS)).toEqual([
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-i",
      "/in/source.mp4",
      "-map",
      "0:v:0",
      "-an",
      "-vf",
      "fps=1/2,scale=90:160,tile=32x1",
      "-frames:v",
      "1",
      "-q:v",
      "5",
      "/out/f.part.jpg",
    ]);
    const other = {
      ...PREVIEW_SETTINGS,
      frames: { everySeconds: 1, columns: 8, width: 45, height: 80, quality: 3 },
    };
    expect(framesArgs("/i", "/o", other)).toContain("fps=1/1,scale=45:80,tile=8x1");
  });
});

describe("previewCopies", () => {
  it("reads the retimed footage only and makes the footage copy, thumbnail and frames, all kept", async () => {
    expect(previewCopies.version).toBe(3);
    expect(previewCopies.outputs).toEqual([
      { file: "footage-preview.mp4", retention: "kept" },
      { file: "thumbnail.jpg", retention: "kept" },
      { file: "frames.jpg", retention: "kept" },
    ]);
    expect(
      previewCopies.inputs({ etag: "e", bytes: 1 }, { retime: "fp" }).map((input) => input.ref),
    ).toEqual([{ step: "retime", fingerprint: "fp", file: "source.mp4" }]);
    expect(PREVIEW_SETTINGS).not.toHaveProperty("subject");

    const dir = await mkdtemp(join(tmpdir(), "preview-copies-"));
    try {
      const calls: ToolCall[] = [];
      await previewCopies.run({
        tool: async (call) => {
          calls.push(call);
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
          await writeFile(call.args.at(-1)!, "copy");
          return "";
        },
        tools: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", hyperframes: ["/node", "/hf.mjs"] },
        dir,
        files: { "source.mp4": "/in/source.mp4" },
        settings: PREVIEW_SETTINGS,
        signal: new AbortController().signal,
      });
      expect(calls).toHaveLength(3);
      for (const call of calls) expect(call.file).toBe("ffmpeg");
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      expect((await readdir(dir)).sort()).toEqual([
        "footage-preview.mp4",
        "frames.jpg",
        "thumbnail.jpg",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
