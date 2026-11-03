import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MASK_TOOL_SOURCE_SHA256,
  VSEG_SOURCE,
  maskDoubleArgs,
  maskToolArgs,
  maskToolCall,
} from "./mask-tool.ts";

const tools = {
  ffmpeg: "/opt/ffmpeg",
  ffprobe: "/opt/ffprobe",
  hyperframes: ["node", "hf.mjs"] as [string, string],
};
const span = { input: "/s/footage.mp4", start: 5.1, end: 7.9667, output: "/s/fp.mp4" };

describe("the mask tool", () => {
  it("was hashed from the committed vseg.swift (bump MASK_TOOL_VERSION and the hash together)", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed tool source
    const hash = createHash("sha256").update(readFileSync(VSEG_SOURCE)).digest("hex");
    expect(hash, "vseg.swift changed: bump MASK_TOOL_VERSION and MASK_TOOL_SOURCE_SHA256").toBe(
      MASK_TOOL_SOURCE_SHA256,
    );
  });

  it("calls vseg with the span to the millisecond", () => {
    expect(maskToolArgs(span)).toEqual([
      "--input",
      "/s/footage.mp4",
      "--start",
      "5.100",
      "--end",
      "7.967",
      "--output",
      "/s/fp.mp4",
    ]);
    expect(
      maskToolCall(span, {
        tools,
        env: {},
        platform: "darwin",
        binary: "/b/vseg",
        exists: () => true,
      }),
    ).toEqual({ file: "/b/vseg", args: maskToolArgs(span) });
  });

  it("refuses off macOS with one line, before spawning", () => {
    expect(() =>
      maskToolCall(span, { tools, env: {}, platform: "linux", exists: () => true }),
    ).toThrow("cutout: the mask tool runs on macOS only (Apple Vision); this worker runs on linux");
  });

  it("says how to build a missing binary", () => {
    expect(() =>
      maskToolCall(span, { tools, env: {}, platform: "darwin", exists: () => false }),
    ).toThrow("cutout: mask tool not built, run yarn workspace @edit-issebya/worker build:vseg");
  });

  it("is the ffmpeg double only under E2E_MOCK_MASK set to exactly true, on any platform", () => {
    expect(
      maskToolCall(span, { tools, env: { E2E_MOCK_MASK: "true" }, platform: "linux" }),
    ).toEqual({
      file: "/opt/ffmpeg",
      args: maskDoubleArgs(span),
    });
    expect(maskDoubleArgs(span)).toEqual([
      "-hide_banner",
      "-y",
      "-ss",
      "5.100",
      "-i",
      "/s/footage.mp4",
      "-t",
      "2.867",
      "-an",
      "-vf",
      ["drawbox=c=black:t=fill", "format=yuv420p"].join(","),
      "-c:v",
      "libx264",
      "-f",
      "mp4",
      "/s/fp.mp4",
    ]);
    for (const value of ["1", "TRUE", "true "]) {
      expect(() =>
        maskToolCall(span, { tools, env: { E2E_MOCK_MASK: value }, platform: "linux" }),
      ).toThrow(/macOS only/);
    }
  });
});
