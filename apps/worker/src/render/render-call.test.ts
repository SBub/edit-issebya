import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolPaths } from "../pipeline/tools.ts";
import { parseRenderProgress } from "../progress-parsers.ts";
import { spawnChild } from "../step-runner.ts";
import {
  FAKE_RENDER,
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
  it("turns telemetry off and drops every PRODUCER_ variable and the TTY flag", () => {
    const env = renderEnv({
      PATH: "/bin",
      PRODUCER_AUDIO_GAIN: "0.5",
      PRODUCER_OTHER: "x",
      HYPERFRAMES_NO_TELEMETRY: "0",
      // Set to 1 it would silence the @hf-progress lines.
      HYPERFRAMES_STDOUT_IS_TTY: "1",
    });
    expect(env).toEqual({ PATH: "/bin", HYPERFRAMES_NO_TELEMETRY: "1" });
  });
});

describe("renderCall", () => {
  it("runs the installed HyperFrames with group memory sampling and its progress", () => {
    const call = renderCall({
      tools: TOOLS,
      dir: "/s",
      projectDir: "/p",
      output: "/o.mp4",
      env: { PRODUCER_AUDIO_GAIN: "2", HYPERFRAMES_STDOUT_IS_TTY: "1" },
    });
    expect(call.progress).toBe(parseRenderProgress);
    expect(call.env).not.toHaveProperty("HYPERFRAMES_STDOUT_IS_TTY");
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
      expect(call.args[0]).toBe("/hf/bin/hyperframes.mjs");
    }
    const fake = renderCall({
      tools: TOOLS,
      dir: "/s",
      projectDir: "/p",
      output: "/o.mp4",
      env: { E2E_MOCK_RENDER: "true", E2E_MOCK_RENDER_SECONDS: "25" },
    });
    expect(fake).toEqual({
      file: process.execPath,
      args: [FAKE_RENDER, STUB_EXPORT, "/o.mp4"],
      env: { E2E_MOCK_RENDER: "true", E2E_MOCK_RENDER_SECONDS: "25" },
      sampleGroupMemory: true,
      progress: parseRenderProgress,
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the double's own file
    expect(existsSync(FAKE_RENDER)).toBe(true);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed stub
    expect(existsSync(STUB_EXPORT)).toBe(true);
  });
});

describe("the render double's process", () => {
  it("prints the sample's progress lines, then copies the stub", { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "fake-render-"));
    try {
      const output = join(dir, "export.mp4");
      const call = renderCall({
        tools: TOOLS,
        dir,
        projectDir: join(dir, "project"),
        output,
        env: { ...process.env, E2E_MOCK_RENDER: "true", E2E_MOCK_RENDER_SECONDS: "0" },
      });
      const lines: string[] = [];
      const run = await spawnChild(call, new AbortController().signal, (line) => lines.push(line));
      expect(run.code).toBe(0);
      const values = lines.map(parseRenderProgress).filter((value) => value !== null);
      expect(values.length).toBeGreaterThan(1);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      expect((await stat(output)).size).toBe((await stat(STUB_EXPORT)).size);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to run without E2E_MOCK_RENDER=true", { timeout: 20_000 }, async () => {
    const run = await spawnChild(
      { file: process.execPath, args: [FAKE_RENDER, STUB_EXPORT, "/nonexistent/out.mp4"] },
      new AbortController().signal,
      () => {},
    );
    expect(run.code).toBe(2);
  });
});
