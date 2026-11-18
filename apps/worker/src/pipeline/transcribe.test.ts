import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALIGN_SETTINGS } from "./align.ts";
import { TRANSCRIBE_SETTINGS, alignArgs, transcribeArgs } from "./transcribe.ts";

const WORKER_PACKAGE = JSON.parse(
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own package.json
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { dependencies: Record<string, string> };

describe("transcribe settings", () => {
  it("name the exact HyperFrames version the worker pins", () => {
    expect(WORKER_PACKAGE.dependencies.hyperframes).toMatch(/^\d+\.\d+\.\d+$/);
    expect(TRANSCRIBE_SETTINGS.hyperframes).toBe(WORKER_PACKAGE.dependencies.hyperframes);
  });
});

describe("transcribeArgs", () => {
  it("always asks whisper small in English for JSON into the step's folder", () => {
    expect(
      transcribeArgs("/job/converted.mp4", "/job/transcribe/hyperframes", TRANSCRIBE_SETTINGS),
    ).toEqual([
      "transcribe",
      "/job/converted.mp4",
      "--engine",
      "whisper",
      "--model",
      "small",
      "--language",
      "en",
      "--json",
      "--dir",
      "/job/transcribe/hyperframes",
    ]);
  });
});

describe("alignArgs", () => {
  it("runs the worker's aligner entry on the footage with Whisper's words", () => {
    const args = alignArgs(
      {
        footage: "/job/converted.mp4",
        words: "/job/heard.json",
        output: "/job/aligned.json",
        threads: 8,
      },
      "/models/wav2vec2.onnx",
      { ffmpeg: "/bin/ffmpeg" },
    );
    expect(args[0]).toMatch(/apps\/worker\/src\/pipeline\/align-entry\.ts$/);
    expect(args.slice(1)).toEqual([
      "--input",
      "/job/converted.mp4",
      "--words",
      "/job/heard.json",
      "--output",
      "/job/aligned.json",
      "--threads",
      "8",
      "--model",
      "/models/wav2vec2.onnx",
      "--ffmpeg",
      "/bin/ffmpeg",
    ]);
  });

  it("puts the aligner's settings in transcribe's fingerprint", () => {
    expect(TRANSCRIBE_SETTINGS.align).toBe(ALIGN_SETTINGS);
  });
});
