import { describe, expect, it } from "vitest";
import {
  REMOVE_BACKGROUND_SETTINGS,
  parseRemoveBackgroundResult,
  removeBackgroundArgs,
} from "./remove-background.ts";

const RESULT = {
  ok: true,
  outputPath: "/tmp/job/remove_background/subject.part.webm",
  framesProcessed: 120,
  durationSeconds: 41.3,
  avgMsPerFrame: 344.2,
  provider: "coreml",
  format: "webm",
};

describe("removeBackgroundArgs", () => {
  it("asks HyperFrames for a WebM cut-out with a JSON result", () => {
    expect(
      removeBackgroundArgs("in/source.mp4", "out/subject.part.webm", REMOVE_BACKGROUND_SETTINGS),
    ).toEqual([
      "remove-background",
      "in/source.mp4",
      "-o",
      "out/subject.part.webm",
      "--device",
      "auto",
      "--quality",
      "balanced",
      "--json",
    ]);
  });
});

describe("the remove-background result", () => {
  it("reads the JSON line after other output", () => {
    const stdout = `Downloading model...\n{"progress": 1}\n${JSON.stringify(RESULT)}\n`;
    expect(parseRemoveBackgroundResult(stdout)).toEqual({
      framesProcessed: 120,
      provider: "coreml",
    });
  });

  it("rejects a failure, another format and no JSON at all", () => {
    expect(() =>
      parseRemoveBackgroundResult(JSON.stringify({ ok: false, error: { code: "runtime_error" } })),
    ).toThrow(/did not succeed/);
    expect(() => parseRemoveBackgroundResult(JSON.stringify({ ...RESULT, format: "mov" }))).toThrow(
      "remove-background wrote mov, not webm",
    );
    expect(() => parseRemoveBackgroundResult("Removed background from 120 frames\n")).toThrow(
      "remove-background printed no JSON result",
    );
    expect(() =>
      parseRemoveBackgroundResult(JSON.stringify({ ...RESULT, provider: undefined })),
    ).toThrow(/no framesProcessed or provider/);
  });
});
