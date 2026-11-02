import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
  PERSON_MASK_ENTRY,
  PERSON_MASK_SETTINGS,
  parsePersonMaskResult,
  personMaskArgs,
} from "./person-mask.ts";
import { HYPERFRAMES_VERSION } from "./tools.ts";

describe(personMaskArgs.name, () => {
  it("passes the entry the input, output, device and quality, as the CLI takes them", () => {
    expect(personMaskArgs("/in/samples.mp4", "/out/mask.part.webm", PERSON_MASK_SETTINGS)).toEqual([
      "/in/samples.mp4",
      "-o",
      "/out/mask.part.webm",
      "--device",
      "auto",
      "--quality",
      "balanced",
    ]);
  });

  it("names the worker's own entry, which exists", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own entry file
    expect(existsSync(PERSON_MASK_ENTRY)).toBe(true);
  });

  it("pins the HyperFrames version in the settings, so an upgrade re-runs head_track", () => {
    expect(PERSON_MASK_SETTINGS).toEqual({
      device: "auto",
      quality: "balanced",
      hyperframes: HYPERFRAMES_VERSION,
    });
  });
});

describe(parsePersonMaskResult.name, () => {
  it("reads the last JSON line", () => {
    const stdout = [
      "loading model",
      JSON.stringify({
        ok: true,
        outputPath: "/out/mask.part.webm",
        framesProcessed: 1500,
        durationSeconds: 407.2,
        avgMsPerFrame: 271.5,
        provider: "coreml",
        format: "webm",
      }),
      "",
    ].join("\n");
    expect(parsePersonMaskResult(stdout)).toEqual({
      framesProcessed: 1500,
      provider: "coreml",
    });
  });

  it("throws on a failure result even with exit 0", () => {
    expect(() =>
      parsePersonMaskResult('{"ok":false,"error":{"code":"runtime_error","message":"x"}}\n'),
    ).toThrow(/did not succeed/);
  });

  it("throws on zero frames", () => {
    expect(() => parsePersonMaskResult('{"ok":true,"framesProcessed":0}')).toThrow(
      /did not succeed/,
    );
  });

  it("throws on output that is not JSON", () => {
    expect(() => parsePersonMaskResult("Removed background from 12 frames\n")).toThrow(
      /no JSON result/,
    );
    expect(() => parsePersonMaskResult("")).toThrow(/no JSON result/);
  });
});
