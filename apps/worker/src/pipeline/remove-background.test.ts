import { describe, expect, it } from "vitest";
import { REMOVE_BACKGROUND_SETTINGS, removeBackgroundArgs } from "./remove-background.ts";
import { HYPERFRAMES_VERSION } from "./tools.ts";

describe("removeBackgroundArgs", () => {
  it("asks HyperFrames for a WebM cut-out with its device, quality and JSON answer", () => {
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

  it("carries the installed HyperFrames version in its settings", () => {
    expect(REMOVE_BACKGROUND_SETTINGS.hyperframes).toBe(HYPERFRAMES_VERSION);
  });
});
