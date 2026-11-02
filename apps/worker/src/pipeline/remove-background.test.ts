import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { parseRemoveBackgroundProgress } from "../progress-parsers.ts";
import type { ToolCall } from "../step-runner.ts";
import {
  REMOVE_BACKGROUND_ENTRY,
  REMOVE_BACKGROUND_SETTINGS,
  parseRemoveBackgroundResult,
  removeBackground,
  removeBackgroundArgs,
} from "./remove-background.ts";
import { HYPERFRAMES_VERSION } from "./tools.ts";

describe(removeBackgroundArgs.name, () => {
  it("passes the entry the input, output, device and quality, as the CLI takes them", () => {
    expect(
      removeBackgroundArgs("/in/source.mp4", "/out/subject.part.webm", REMOVE_BACKGROUND_SETTINGS),
    ).toEqual([
      "/in/source.mp4",
      "-o",
      "/out/subject.part.webm",
      "--device",
      "auto",
      "--quality",
      "balanced",
    ]);
  });

  it("runs the worker's own entry with this Node and reads its progress", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own entry file
    expect(existsSync(REMOVE_BACKGROUND_ENTRY)).toBe(true);
    const calls: ToolCall[] = [];
    const ok = JSON.stringify({ ok: true, framesProcessed: 3, provider: "cpu" });
    await expect(
      removeBackground.run({
        tool: async (call) => {
          calls.push(call);
          return `${ok}\n`;
        },
        tools: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", hyperframes: ["/node", "/hf.mjs"] },
        dir: "/nonexistent-scratch",
        files: { "source.mp4": "/in/source.mp4" },
        settings: REMOVE_BACKGROUND_SETTINGS,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/ENOENT/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("/node");
    expect(calls[0]!.args[0]).toBe(REMOVE_BACKGROUND_ENTRY);
    expect(calls[0]!.args).not.toContain("/hf.mjs");
    expect(calls[0]!.progress).toBe(parseRemoveBackgroundProgress);
    expect(calls[0]!.env?.HYPERFRAMES_NO_TELEMETRY).toBe("1");
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
