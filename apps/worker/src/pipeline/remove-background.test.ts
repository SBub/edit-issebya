import { describe, expect, it } from "vitest";
import {
  removeBackground,
  REMOVE_BACKGROUND_SETTINGS,
  removeBackgroundArgs,
} from "./remove-background.ts";
import { HYPERFRAMES_VERSION } from "./tools.ts";

describe("removeBackgroundArgs", () => {
  it("asks HyperFrames for a WebM cut-out on the auto device at balanced quality", () => {
    expect(
      removeBackgroundArgs(
        "/job/inputs/retime/source.mp4",
        "/job/remove_background/subject.part.webm",
        REMOVE_BACKGROUND_SETTINGS,
      ),
    ).toEqual([
      "remove-background",
      "/job/inputs/retime/source.mp4",
      "-o",
      "/job/remove_background/subject.part.webm",
      "--device",
      "auto",
      "--quality",
      "balanced",
      "--json",
    ]);
  });
});

describe("removeBackground", () => {
  it("declares the HyperFrames version, which stands for its model", () => {
    expect(REMOVE_BACKGROUND_SETTINGS.hyperframes).toBe(HYPERFRAMES_VERSION);
  });

  it("reads the retimed footage", () => {
    const source = { etag: "e", bytes: 1 };
    expect(removeBackground.inputs(source, { retime: "abc" })).toEqual([
      { ref: { step: "retime", fingerprint: "abc", file: "source.mp4" }, as: "source.mp4" },
    ]);
  });
});
