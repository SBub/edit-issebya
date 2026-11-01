import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ToolPaths } from "../pipeline/tools.ts";
import {
  RENDER_SETTINGS,
  STUB_EXPORT,
  renderArgs,
  renderCall,
  renderEnv,
  renderScratchEnv,
} from "./render-call.ts";

const TOOLS: ToolPaths = {
  ffmpeg: "ffmpeg",
  ffprobe: "ffprobe",
  hyperframes: ["/usr/bin/node", "/hf/bin/hyperframes.mjs"],
};

describe("RENDER_SETTINGS", () => {
  it("is delivery quality, three software workers, SDR", () => {
    expect(RENDER_SETTINGS).toEqual({
      quality: "delivery",
      workers: 3,
      browserGpu: false,
      sdr: true,
    });
  });
});

describe("renderArgs", () => {
  it("gives exactly the delivery, three-worker, software, SDR render", () => {
    expect(renderArgs({ projectDir: "/s/project", output: "/s/export.mp4" })).toEqual([
      "render",
      "/s/project",
      "-o",
      "/s/export.mp4",
      "--quality",
      "delivery",
      "--workers",
      "3",
      "--no-browser-gpu",
      "--sdr",
    ]);
  });

  it("never asks for a GPU mode", () => {
    const args = renderArgs({ projectDir: "/p", output: "/o.mp4" });
    expect(args).not.toContain("--gpu");
    expect(args).not.toContain("--browser-gpu");
  });

  it("adds the range only when given", () => {
    expect(
      renderArgs({ projectDir: "/p", output: "/o.mp4", range: { start: 0, end: 3 } }).slice(-4),
    ).toEqual(["--start", "0", "--end", "3"]);
  });
});

describe("renderEnv", () => {
  it("turns telemetry off and drops every PRODUCER_ variable", () => {
    const env = renderEnv({
      PATH: "/bin",
      PRODUCER_AUDIO_GAIN: "0.5",
      PRODUCER_OTHER: "x",
      HYPERFRAMES_NO_TELEMETRY: "0",
    });
    expect(env).toEqual({ PATH: "/bin", HYPERFRAMES_NO_TELEMETRY: "1" });
  });
});

describe("renderCall", () => {
  it("runs the installed HyperFrames with group memory sampling", () => {
    const call = renderCall({
      tools: TOOLS,
      dir: "/s",
      projectDir: "/p",
      output: "/o.mp4",
      env: { PRODUCER_AUDIO_GAIN: "2" },
    });
    expect(call.file).toBe("/usr/bin/node");
    expect(call.args).toEqual([
      "/hf/bin/hyperframes.mjs",
      ...renderArgs({ projectDir: "/p", output: "/o.mp4" }),
    ]);
    expect(call.env?.HYPERFRAMES_NO_TELEMETRY).toBe("1");
    expect(call.env).not.toHaveProperty("PRODUCER_AUDIO_GAIN");
    expect(call.sampleGroupMemory).toBe(true);
  });

  it("keeps HyperFrames' frame cache, history and temporary files inside the render folder", () => {
    const call = renderCall({
      tools: TOOLS,
      dir: "/scratch/job/render-x",
      projectDir: "/scratch/job/render-x/project",
      output: "/scratch/job/render-x/export.mp4",
      env: { TMPDIR: "/var/tmp", HYPERFRAMES_HISTORY_ROOT: "/home/h" },
    });
    expect(call.env).toMatchObject({
      HYPERFRAMES_EXTRACT_CACHE_DIR: "/scratch/job/render-x/frames-cache",
      HYPERFRAMES_HISTORY_ROOT: "/scratch/job/render-x/hyperframes-history",
      TMPDIR: "/scratch/job/render-x/tmp",
    });
    for (const path of Object.values(renderScratchEnv("/scratch/job/render-x"))) {
      expect(path.startsWith("/scratch/job/render-x/")).toBe(true);
    }
    expect(call.args).toEqual([
      "/hf/bin/hyperframes.mjs",
      ...renderArgs({
        projectDir: "/scratch/job/render-x/project",
        output: "/scratch/job/render-x/export.mp4",
      }),
    ]);
  });

  it("turns the double on only for exactly 'true'", () => {
    for (const flag of [undefined, "", "1", "TRUE", "yes"]) {
      const call = renderCall({
        tools: TOOLS,
        dir: "/s",
        projectDir: "/p",
        output: "/o.mp4",
        env: { E2E_MOCK_RENDER: flag },
      });
      expect(call.file).toBe("/usr/bin/node");
    }
    const fake = renderCall({
      tools: TOOLS,
      dir: "/s",
      projectDir: "/p",
      output: "/o.mp4",
      env: { E2E_MOCK_RENDER: "true" },
    });
    expect(fake).toEqual({
      file: "/bin/cp",
      args: [STUB_EXPORT, "/o.mp4"],
      sampleGroupMemory: true,
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed stub
    expect(existsSync(STUB_EXPORT)).toBe(true);
  });
});
