import { describe, expect, it } from "vitest";
import {
  REMOVE_BACKGROUND_SETTINGS,
  parseRemoveBackgroundResult,
  removeBackgroundArgs,
} from "./remove-background.ts";
import { HYPERFRAMES_VERSION } from "./tools.ts";

describe(removeBackgroundArgs.name, () => {
  it("runs remove-background on the input with device, quality and a JSON result", () => {
    expect(
      removeBackgroundArgs("/in/source.mp4", "/out/subject.part.webm", REMOVE_BACKGROUND_SETTINGS),
    ).toEqual([
      "remove-background",
      "/in/source.mp4",
      "-o",
      "/out/subject.part.webm",
      "--device",
      "auto",
      "--quality",
      "balanced",
      "--json",
    ]);
  });

  it("pins the HyperFrames version in the settings, so an upgrade re-runs the step", () => {
    expect(REMOVE_BACKGROUND_SETTINGS).toEqual({
      device: "auto",
      quality: "balanced",
      hyperframes: HYPERFRAMES_VERSION,
    });
  });
});

describe(parseRemoveBackgroundResult.name, () => {
  it("reads the last JSON line", () => {
    const stdout = [
      "loading model",
      JSON.stringify({
        ok: true,
        outputPath: "/out/subject.part.webm",
        framesProcessed: 1500,
        durationSeconds: 407.2,
        avgMsPerFrame: 271.5,
        provider: "coreml",
        format: "webm",
      }),
      "",
    ].join("\n");
    expect(parseRemoveBackgroundResult(stdout)).toEqual({
      framesProcessed: 1500,
      provider: "coreml",
    });
  });

  it("throws on a failure result even with exit 0", () => {
    expect(() =>
      parseRemoveBackgroundResult('{"ok":false,"error":{"code":"runtime_error","message":"x"}}\n'),
    ).toThrow(/did not succeed/);
  });

  it("throws on zero frames", () => {
    expect(() => parseRemoveBackgroundResult('{"ok":true,"framesProcessed":0}')).toThrow(
      /did not succeed/,
    );
  });

  it("throws on output that is not JSON", () => {
    expect(() => parseRemoveBackgroundResult("Removed background from 12 frames\n")).toThrow(
      /no JSON result/,
    );
    expect(() => parseRemoveBackgroundResult("")).toThrow(/no JSON result/);
  });
});
