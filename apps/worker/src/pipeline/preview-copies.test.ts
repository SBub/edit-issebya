import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolCall } from "../step-runner.ts";
import { PREVIEW_SETTINGS, footagePreviewArgs, previewCopies } from "./preview-copies.ts";

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

describe("previewCopies", () => {
  it("reads the retimed footage only and makes the footage copy only", async () => {
    expect(previewCopies.version).toBe(2);
    expect(previewCopies.outputs).toEqual([{ file: "footage-preview.mp4", retention: "kept" }]);
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
      expect(calls).toHaveLength(1);
      expect(calls[0]!.file).toBe("ffmpeg");
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      expect((await readdir(dir)).sort()).toEqual(["footage-preview.mp4"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
