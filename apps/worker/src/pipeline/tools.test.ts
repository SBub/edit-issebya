import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hyperframesEnv, toolPaths } from "./tools.ts";

describe("toolPaths", () => {
  it("finds ffprobe beside an absolute ffmpeg", () => {
    expect(toolPaths({ FFMPEG_PATH: "/usr/local/bin/ffmpeg" })).toMatchObject({
      ffmpeg: "/usr/local/bin/ffmpeg",
      ffprobe: "/usr/local/bin/ffprobe",
    });
  });

  it("uses PATH for both when FFMPEG_PATH is unset or bare", () => {
    expect(toolPaths({})).toMatchObject({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" });
    expect(toolPaths({ FFMPEG_PATH: " ffmpeg " })).toMatchObject({ ffprobe: "ffprobe" });
  });

  it("runs the installed HyperFrames entry with this Node", () => {
    const [node, entry] = toolPaths({}).hyperframes;
    expect(node).toBe(process.execPath);
    expect(entry).toMatch(/hyperframes[/\\]bin[/\\]hyperframes\.mjs$/);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the resolved package entry
    expect(existsSync(entry)).toBe(true);
  });
});

describe("hyperframesEnv", () => {
  it("forces telemetry off", () => {
    expect(hyperframesEnv({ HYPERFRAMES_NO_TELEMETRY: "0", A: "b" })).toEqual({
      HYPERFRAMES_NO_TELEMETRY: "1",
      A: "b",
    });
  });

  it("points HyperFrames at the worker's ffmpeg when it is configured by path", () => {
    const tools = toolPaths({ FFMPEG_PATH: "/opt/ffmpeg/bin/ffmpeg" });
    expect(hyperframesEnv({ HYPERFRAMES_NO_TELEMETRY: "0" }, tools)).toEqual({
      HYPERFRAMES_NO_TELEMETRY: "1",
      HYPERFRAMES_FFMPEG_PATH: "/opt/ffmpeg/bin/ffmpeg",
      HYPERFRAMES_FFPROBE_PATH: "/opt/ffmpeg/bin/ffprobe",
    });
  });

  it("leaves a bare ffmpeg to PATH", () => {
    expect(hyperframesEnv({}, toolPaths({}))).toEqual({ HYPERFRAMES_NO_TELEMETRY: "1" });
  });
});
