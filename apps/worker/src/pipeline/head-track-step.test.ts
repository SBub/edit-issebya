import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePersonMaskProgress } from "../progress-parsers.ts";
import type { ToolCall } from "../step-runner.ts";
import { HEAD_TRACK_SETTINGS, frameBytes } from "./head-track.ts";
import {
  HEAD_TRACK_STEP_SETTINGS,
  headTrack,
  headTrackDecodeArgs,
  headTrackSampleArgs,
} from "./head-track-step.ts";
import { PERSON_MASK_ENTRY, PERSON_MASK_SETTINGS } from "./person-mask.ts";

function option(args: string[], name: string): string {
  return args[args.indexOf(name) + 1]!;
}

describe("headTrackSampleArgs", () => {
  it("keeps one frame per sample at 270x480, losslessly, without audio", () => {
    expect(headTrackSampleArgs("/in/source.mp4", "/out/samples.mp4", HEAD_TRACK_SETTINGS)).toEqual([
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-i",
      "/in/source.mp4",
      "-an",
      "-vf",
      "fps=4,scale=270:480",
      "-c:v",
      "libx264",
      "-crf",
      "0",
      "-pix_fmt",
      "yuv444p",
      "/out/samples.mp4",
    ]);
  });
});

describe("headTrackDecodeArgs", () => {
  it("decodes with libvpx-vp9 (alpha kept) to raw RGBA at 4 fps and 270x480", () => {
    const args = headTrackDecodeArgs("/in/mask.webm", "/out/frames.rgba", HEAD_TRACK_SETTINGS);
    expect(args).toEqual([
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-c:v",
      "libvpx-vp9",
      "-i",
      "/in/mask.webm",
      "-an",
      "-vf",
      "fps=4,scale=270:480",
      "-pix_fmt",
      "rgba",
      "-f",
      "rawvideo",
      "/out/frames.rgba",
    ]);
    expect(args.indexOf("libvpx-vp9")).toBeLessThan(args.indexOf("-i"));
  });
});

describe("headTrack", () => {
  it("is the head_track step, reading the retimed footage and keeping its JSON", () => {
    expect(headTrack.name).toBe("head_track");
    expect(headTrack.version).toBe(2);
    expect(headTrack.settings).toEqual({ ...HEAD_TRACK_SETTINGS, mask: PERSON_MASK_SETTINGS });
    expect(headTrack.outputs).toEqual([{ file: "head-track.json", retention: "kept" }]);
    expect(
      headTrack.inputs({ etag: "e", bytes: 1 }, { retime: "fp" }).map((input) => input.ref),
    ).toEqual([{ step: "retime", fingerprint: "fp", file: "source.mp4" }]);
  });

  it("samples, masks and decodes in order, then deletes every scratch file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "head-track-step-"));
    try {
      const calls: ToolCall[] = [];
      const ok = JSON.stringify({ ok: true, framesProcessed: 2, provider: "cpu" });
      const { what } = await headTrack.run({
        tool: async (call) => {
          calls.push(call);
          if (call.file === "/node") {
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
            await writeFile(option(call.args, "-o"), "mask");
            return `${ok}\n`;
          }
          // Two transparent frames from the decode, a placeholder from the sample.
          const out = call.args.at(-1)!;
          const bytes = out.endsWith(".rgba")
            ? new Uint8Array(2 * frameBytes(HEAD_TRACK_SETTINGS))
            : "x";
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
          await writeFile(out, bytes);
          return "";
        },
        tools: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", hyperframes: ["/node", "/hf.mjs"] },
        dir,
        files: { "source.mp4": "/in/source.mp4" },
        settings: HEAD_TRACK_STEP_SETTINGS,
        signal: new AbortController().signal,
      });

      expect(calls).toHaveLength(3);
      const samples = join(dir, "samples.mp4");
      const mask = join(dir, "mask.part.webm");
      expect(calls[0]).toMatchObject({
        file: "ffmpeg",
        args: headTrackSampleArgs("/in/source.mp4", samples, HEAD_TRACK_SETTINGS),
      });
      expect(calls[1]!.file).toBe("/node");
      expect(calls[1]!.args).toEqual([
        PERSON_MASK_ENTRY,
        samples,
        "-o",
        mask,
        "--device",
        "auto",
        "--quality",
        "balanced",
      ]);
      expect(calls[1]!.args).not.toContain("/hf.mjs");
      expect(calls[1]!.progress).toBe(parsePersonMaskProgress);
      expect(calls[1]!.env?.HYPERFRAMES_NO_TELEMETRY).toBe("1");
      expect(calls[2]).toMatchObject({
        file: "ffmpeg",
        args: headTrackDecodeArgs(mask, join(dir, "frames.rgba"), HEAD_TRACK_SETTINGS),
      });

      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      expect(await readdir(dir)).toEqual(["head-track.json"]);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      expect(JSON.parse(await readFile(join(dir, "head-track.json"), "utf8"))).toEqual([
        null,
        null,
      ]);
      expect(what).toMatch(/head/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails on a mask that did not succeed, leaving no scratch file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "head-track-step-"));
    try {
      await expect(
        headTrack.run({
          tool: async (call) => {
            if (call.file === "/node") return '{"ok":false}\n';
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
            await writeFile(call.args.at(-1)!, "x");
            return "";
          },
          tools: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", hyperframes: ["/node", "/hf.mjs"] },
          dir,
          files: { "source.mp4": "/in/source.mp4" },
          settings: HEAD_TRACK_STEP_SETTINGS,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/head_track: person mask: HyperFrames did not succeed/);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
