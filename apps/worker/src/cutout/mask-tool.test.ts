import { describe, expect, it } from "vitest";
import { MODNET_ENTRY, maskDoubleArgs, maskToolArgs, maskToolCall } from "./mask-tool.ts";
import { modnetModelPath } from "./modnet-model.ts";

const tools = {
  ffmpeg: "/opt/ffmpeg",
  ffprobe: "/opt/ffprobe",
  hyperframes: ["node", "hf.mjs"] as [string, string],
};
const span = {
  input: "/s/footage.mp4",
  start: 5.1,
  end: 7.9667,
  cropTop: 266,
  output: "/s/fp.mp4",
};
const MODEL = "/models/modnet.onnx";

describe("the mask tool", () => {
  it("runs the MODNet entry with this Node, the span to the millisecond, its crop, the model and ffmpeg", () => {
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
      "--crop-top",
      "266",
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

  it("finds the committed model", () => {
    const call = maskToolCall(span, { tools, env: {}, exists: () => true });
    expect(call.args).toContain(modnetModelPath());
  });

  it("says how to restore a missing model, before spawning", () => {
    expect(() => maskToolCall(span, { tools, env: {}, model: MODEL, exists: () => false })).toThrow(
      "cutout: MODNet model missing at /models/modnet.onnx, restore it with git checkout -- apps/worker/models/modnet_int8_13.onnx",
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
      ).toThrow(/MODNet model missing/);
    }
  });
});
