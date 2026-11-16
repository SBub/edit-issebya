import { existsSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolPaths } from "../pipeline/tools.ts";
import { ffmpegFrameProgress, parseRenderProgress } from "../progress-parsers.ts";
import { spawnChild } from "../step-runner.ts";
import {
  DOUBLE_SHARES,
  FAKE_RENDER,
  LAYER_SETTINGS,
  RENDER_SETTINGS,
  STUB_EXPORT,
  ffmpegPassCall,
  layerArgs,
  layerCall,
  renderArgs,
  renderCall,
  renderDoubled,
  renderEnv,
  renderScratchEnv,
  runLanes,
  withChromeTmp,
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
      chromeTmp: "/tmp/hf-AbCdEf",
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

  it("keeps HyperFrames' frame cache and history inside the render folder, Chrome's TMPDIR at the short folder", () => {
    const call = renderCall({
      tools: TOOLS,
      dir: "/scratch/job/render-x",
      chromeTmp: "/tmp/hf-AbCdEf",
      projectDir: "/scratch/job/render-x/project",
      output: "/scratch/job/render-x/export.mp4",
      env: { TMPDIR: "/var/tmp", HYPERFRAMES_HISTORY_ROOT: "/home/h" },
    });
    expect(call.env).toMatchObject({
      HYPERFRAMES_EXTRACT_CACHE_DIR: "/scratch/job/render-x/frames-cache",
      HYPERFRAMES_HISTORY_ROOT: "/scratch/job/render-x/hyperframes-history",
      TMPDIR: "/tmp/hf-AbCdEf",
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
        chromeTmp: "/tmp/hf-AbCdEf",
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
      chromeTmp: "/tmp/hf-AbCdEf",
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

// The socket limit: a Unix socket path (sun_path) holds at most 107 characters.
// Chrome's singleton socket sits under its TMPDIR, in a folder named after
// org.chromium.Chromium plus six random characters, and is called
// SingletonSocket.
const SOCKET_LIMIT = 107;
const CHROME_SOCKET = join("org.chromium.Chromium.XXXXXX", "SingletonSocket");
// compose.yaml's WORKER_SCRATCH_DIR, a job id (a UUID, 36 characters), and the
// render's folder name from runRender's mkdtemp(join(scratchDir, "render-")).
const COMPOSE_SCRATCH = "/scratch";
const JOB_ID = "8ce14781-bdb2-4251-9eb8-12db7eceea6e";
const RENDER_FOLDER = "render-XXXXXX";

describe("Chrome's socket path", () => {
  it("fits the limit under the short folder the container gives Chrome", () => {
    expect(JOB_ID).toHaveLength(36);
    const socket = join("/tmp", "hf-XXXXXX", CHROME_SOCKET);
    expect(socket.length).toBeLessThanOrEqual(SOCKET_LIMIT);
  });

  it("is over the limit under the job scratch folder (the bug this guards)", () => {
    const socket = join(COMPOSE_SCRATCH, JOB_ID, RENDER_FOLDER, "tmp", CHROME_SOCKET);
    expect(socket.length).toBeGreaterThan(SOCKET_LIMIT);
  });

  it("fits for the folder withChromeTmp makes on this machine", async () => {
    await withChromeTmp(async (dir) => {
      expect(join(dir, CHROME_SOCKET).length).toBeLessThanOrEqual(SOCKET_LIMIT);
    });
  });
});

describe("withChromeTmp", () => {
  it("gives a folder for the call and removes it after success", async () => {
    let seen = "";
    const result = await withChromeTmp(async (dir) => {
      seen = dir;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's own temp folder
      await writeFile(join(dir, "profile"), "x");
      return 7;
    });
    expect(result).toBe(7);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's own temp folder
    expect(existsSync(seen)).toBe(false);
  });

  it("removes the folder after a failure and rethrows it", async () => {
    let seen = "";
    await expect(
      withChromeTmp(async (dir) => {
        seen = dir;
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's own temp folder
        await writeFile(join(dir, "profile"), "x");
        throw new Error("render failed");
      }),
    ).rejects.toThrow("render failed");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's own temp folder
    expect(existsSync(seen)).toBe(false);
  });

  it("removes the folder after a cancel (an abort) and rethrows it", async () => {
    let seen = "";
    const cancelled = new DOMException("cancelled", "AbortError");
    await expect(
      withChromeTmp(async (dir) => {
        seen = dir;
        throw cancelled;
      }),
    ).rejects.toBe(cancelled);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's own temp folder
    expect(existsSync(seen)).toBe(false);
  });
});

describe("LAYER_SETTINGS", () => {
  it("is two front workers, one for the behind layer and the sound page, the sound at 1 fps", () => {
    expect(LAYER_SETTINGS).toEqual({
      frontWorkers: 2,
      behindWorkers: 1,
      soundWorkers: 1,
      soundFps: 1,
    });
  });
});

describe("layerArgs", () => {
  it("renders a picture layer as PNG frames with the export's settings and its own workers", () => {
    expect(
      layerArgs({ layer: "front", projectDir: "/s/front/project", output: "/s/front/frames" }),
    ).toEqual([
      "render",
      "/s/front/project",
      "-o",
      "/s/front/frames",
      "--quality",
      "delivery",
      "--workers",
      "2",
      "--no-browser-gpu",
      "--sdr",
      "--format",
      "png-sequence",
    ]);
    const behind = layerArgs({ layer: "behind", projectDir: "/p", output: "/o" });
    expect(behind.slice(5)).toEqual([
      "delivery",
      "--workers",
      "1",
      "--no-browser-gpu",
      "--sdr",
      "--format",
      "png-sequence",
    ]);
  });

  it("renders the sound page as an MP4 at 1 fps with one worker", () => {
    expect(
      layerArgs({ layer: "sound", projectDir: "/s/sound/project", output: "/s/sound/sound.mp4" }),
    ).toEqual([
      "render",
      "/s/sound/project",
      "-o",
      "/s/sound/sound.mp4",
      "--quality",
      "delivery",
      "--workers",
      "1",
      "--no-browser-gpu",
      "--sdr",
      "--format",
      "mp4",
      "--fps",
      "1",
    ]);
  });

  it("never asks for a GPU mode", () => {
    for (const layer of ["front", "behind", "sound"] as const) {
      const args = layerArgs({ layer, projectDir: "/p", output: "/o" });
      expect(args).not.toContain("--gpu");
      expect(args).not.toContain("--browser-gpu");
    }
  });
});

describe("layerCall", () => {
  const stop = new AbortController().signal;
  const call = (env: NodeJS.ProcessEnv) =>
    layerCall({
      tools: TOOLS,
      layer: "front",
      dir: "/scratch/job/render-x/front",
      chromeTmp: "/tmp/hf-AbCdEf",
      projectDir: "/scratch/job/render-x/front/project",
      output: "/scratch/job/render-x/front/frames",
      progress: parseRenderProgress,
      signal: stop,
      env,
    });

  it("runs the installed HyperFrames with the layer's own folders, tree memory, progress and signal", () => {
    const made = call({ PRODUCER_AUDIO_GAIN: "2", HYPERFRAMES_STDOUT_IS_TTY: "1", TMPDIR: "/var" });
    expect(made.file).toBe("/usr/bin/node");
    expect(made.args).toEqual([
      "/hf/bin/hyperframes.mjs",
      ...layerArgs({
        layer: "front",
        projectDir: "/scratch/job/render-x/front/project",
        output: "/scratch/job/render-x/front/frames",
      }),
    ]);
    expect(made.env).toEqual({
      HYPERFRAMES_NO_TELEMETRY: "1",
      HYPERFRAMES_EXTRACT_CACHE_DIR: "/scratch/job/render-x/front/frames-cache",
      HYPERFRAMES_HISTORY_ROOT: "/scratch/job/render-x/front/hyperframes-history",
      TMPDIR: "/tmp/hf-AbCdEf",
    });
    expect(made.sampleGroupMemory).toBe(true);
    expect(made.progress).toBe(parseRenderProgress);
    expect(made.signal).toBe(stop);
  });

  it("is the double's layer part under the render double", () => {
    expect(renderDoubled({ E2E_MOCK_RENDER: "true" })).toBe(true);
    for (const flag of [undefined, "", "1", "TRUE"]) {
      expect(renderDoubled({ E2E_MOCK_RENDER: flag })).toBe(false);
    }
    expect(call({ E2E_MOCK_RENDER: "true" })).toEqual({
      file: process.execPath,
      args: [FAKE_RENDER, "layer", "0.45", "/scratch/job/render-x/front/frames"],
      env: { E2E_MOCK_RENDER: "true" },
      sampleGroupMemory: true,
      progress: parseRenderProgress,
      signal: stop,
    });
  });
});

describe("ffmpegPassCall", () => {
  const progress = ffmpegFrameProgress(81);
  const pass = (part: "footage" | "composite", env: NodeJS.ProcessEnv) =>
    ffmpegPassCall({
      tools: TOOLS,
      args: ["-i", "/in.mp4", "/out.mp4"],
      output: "/out.mp4",
      frames: 81,
      part,
      progress,
      env,
    });

  it("runs ffmpeg with the given arguments and its progress", () => {
    expect(pass("composite", { PATH: "/bin" })).toEqual({
      file: "ffmpeg",
      args: ["-i", "/in.mp4", "/out.mp4"],
      env: { PATH: "/bin" },
      progress,
      signal: undefined,
    });
  });

  it("is the double's ffmpeg part under the render double: the stub for the composite alone", () => {
    const env = { E2E_MOCK_RENDER: "true" };
    expect(pass("composite", env).args).toEqual([
      FAKE_RENDER,
      "ffmpeg",
      "0.55",
      "81",
      STUB_EXPORT,
      "/out.mp4",
    ]);
    expect(pass("footage", env).args).toEqual([
      FAKE_RENDER,
      "ffmpeg",
      "0.3",
      "81",
      "-",
      "/out.mp4",
    ]);
    expect(pass("footage", env).file).toBe(process.execPath);
  });
});

describe("DOUBLE_SHARES", () => {
  it("adds up to the whole: each lane inside the front layer's share, then the composite", () => {
    const { front, sound, behind, footage, composite } = DOUBLE_SHARES;
    expect(front + composite).toBeCloseTo(1);
    expect(sound + behind).toBeLessThanOrEqual(front);
    expect(footage).toBeLessThanOrEqual(front);
  });
});

describe("runLanes", () => {
  it("runs the lanes at the same time and resolves when all have", async () => {
    const order: string[] = [];
    const lane = (name: string, ms: number) => async () => {
      order.push(`${name} starts`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(`${name} ends`);
    };
    await runLanes([lane("a", 30), lane("b", 5)]);
    expect(order).toEqual(["a starts", "b starts", "b ends", "a ends"]);
  });

  it("aborts the others with the first failure and throws it once every lane has ended", async () => {
    const ended: string[] = [];
    const failure = new Error("front failed");
    const waits = (name: string) => (signal: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          // Ends a moment after the abort, as a killed process does.
          setTimeout(() => {
            ended.push(name);
            reject(signal.reason);
          }, 20);
        });
      });
    const fails = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw failure;
    };
    await expect(runLanes([waits("sound"), fails, waits("footage")])).rejects.toBe(failure);
    expect(ended.sort()).toEqual(["footage", "sound"]);
  });

  it("throws the first failure when a second lane fails on its own", async () => {
    const first = new Error("first");
    await expect(
      runLanes([
        async () => {
          throw first;
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          throw new Error("second");
        },
      ]),
    ).rejects.toBe(first);
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
        chromeTmp: dir,
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

  const doubled = (args: string[], seconds = "0") =>
    spawnChild(
      {
        file: process.execPath,
        args: [FAKE_RENDER, ...args],
        env: { ...process.env, E2E_MOCK_RENDER: "true", E2E_MOCK_RENDER_SECONDS: seconds },
      },
      new AbortController().signal,
      () => {},
    );

  it(
    "plays a layer page: the progress lines, then frames or the sound MP4",
    { timeout: 20_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "fake-render-"));
      try {
        const frames = join(dir, "front", "frames");
        const page = await doubled(["layer", "0.45", frames]);
        expect(page.code).toBe(0);
        const values = page.stdout.split("\n").map(parseRenderProgress);
        expect(values.filter((value) => value !== null).length).toBeGreaterThan(1);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
        expect((await stat(join(frames, "frame_000001.png"))).isFile()).toBe(true);
        const sound = join(dir, "sound.mp4");
        expect((await doubled(["layer", "0.15", sound])).code).toBe(0);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
        expect((await stat(sound)).isFile()).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "plays an ffmpeg pass: frame reports up to the total, the end, then its file",
    { timeout: 20_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "fake-render-"));
      try {
        const output = join(dir, "export.mp4");
        const pass = await doubled(["ffmpeg", "0.55", "81", STUB_EXPORT, output]);
        expect(pass.code).toBe(0);
        const lines = pass.stdout.trim().split("\n");
        expect(lines.at(-1)).toBe("progress=end");
        const values = lines.map(ffmpegFrameProgress(81));
        expect(values).toEqual([...values].sort((a, b) => a! - b!));
        expect(values.at(-2)).toBe(100);
        expect(values).toHaveLength(21);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
        expect((await stat(output)).size).toBe((await stat(STUB_EXPORT)).size);
        const placeholder = join(dir, "footage.mkv");
        expect((await doubled(["ffmpeg", "0.3", "80", "-", placeholder])).code).toBe(0);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
        expect((await stat(placeholder)).size).toBeGreaterThan(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it("spreads a part over its share of the seconds", { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "fake-render-"));
    try {
      const started = performance.now();
      // Half of 2 seconds.
      expect((await doubled(["ffmpeg", "0.5", "81", "-", join(dir, "pass")], "2")).code).toBe(0);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThan(900);
      expect(elapsed).toBeLessThan(8000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a part with missing or malformed arguments", { timeout: 20_000 }, async () => {
    expect((await doubled(["layer", "0.45"])).code).toBe(2);
    expect((await doubled(["layer", "half", "/nonexistent/out"])).code).toBe(2);
    expect((await doubled(["ffmpeg", "0.5", "81", "-"])).code).toBe(2);
    expect((await doubled(["ffmpeg", "0.5", "many", "-", "/nonexistent/out"])).code).toBe(2);
    expect((await doubled([STUB_EXPORT])).code).toBe(2);
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
