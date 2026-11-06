import { describe, expect, it } from "vitest";
import { MODNET_ENTRY, maskDoubleArgs, maskToolArgs, maskToolCall } from "./mask-tool.ts";

const tools = {
  ffmpeg: "/opt/ffmpeg",
  ffprobe: "/opt/ffprobe",
  hyperframes: ["node", "hf.mjs"] as [string, string],
};
const span = { input: "/s/footage.mp4", start: 5.1, end: 7.9667, output: "/s/fp.mp4" };
const MODEL = "/models/modnet.onnx";

describe("the mask tool", () => {
  it("runs the MODNet entry with this Node, the span to the millisecond, the model and ffmpeg", () => {
    expect(maskToolArgs(span, MODEL, tools)).toEqual([
      MODNET_ENTRY,
      "--input",
      "/s/footage.mp4",
      "--start",
      "5.100",
      "--end",
      "7.967",
      "--output",
      "/s/fp.mp4",
      "--model",
      MODEL,
      "--ffmpeg",
      "/opt/ffmpeg",
      "--ffprobe",
      "/opt/ffprobe",
    ]);
    expect(MODNET_ENTRY).toMatch(/cutout\/modnet-entry\.ts$/);
    expect(
      maskToolCall(span, { tools, env: {}, model: MODEL, node: "/bin/node", exists: () => true }),
    ).toEqual({ file: "/bin/node", args: maskToolArgs(span, MODEL, tools) });
  });

  it("finds the model under WORKER_MODELS_DIR", () => {
    const call = maskToolCall(span, {
      tools,
      env: { WORKER_MODELS_DIR: "/m" },
      exists: () => true,
    });
    expect(call.args).toContain("/m/modnet_photographic_portrait_matting.onnx");
  });

  it("says how to install a missing model, before spawning", () => {
    expect(() => maskToolCall(span, { tools, env: {}, model: MODEL, exists: () => false })).toThrow(
      "cutout: MODNet model not installed at /models/modnet.onnx, run yarn workspace @edit-issebya/worker models:install",
    );
  });

  it("is the ffmpeg double only under E2E_MOCK_MASK set to exactly true, without a model", () => {
    expect(
      maskToolCall(span, { tools, env: { E2E_MOCK_MASK: "true" }, exists: () => false }),
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
        maskToolCall(span, { tools, env: { E2E_MOCK_MASK: value }, exists: () => false }),
      ).toThrow(/MODNet model not installed/);
    }
  });
});
