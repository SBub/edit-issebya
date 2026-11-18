import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXPORT_FPS } from "@edit-issebya/edit";
import { type ProgressParser, parseRenderProgress } from "../progress-parsers.ts";
import type { ToolCall } from "../step-runner.ts";
import { type ToolPaths, hyperframesEnv } from "../pipeline/tools.ts";

// The export's render settings. The platforms recompress every upload, so a
// cleaner source (`delivery` quality) keeps text edges sharper after their
// pass. Software mode with three workers is faster
// on the worker's machine than the GPU mode with one, and runs the same on a
// machine without a graphics chip: never `--gpu`, never `--browser-gpu`.
// `--sdr`: always SDR output, what the platforms show (convert already made
// the footage SDR).
export const RENDER_SETTINGS = {
  quality: "delivery",
  workers: 3,
  browserGpu: false,
  sdr: true,
} as const;

// The composite export's three pages (app_docs/export.md). The front layer
// takes two workers, not three: the pages run next to each other, and with
// three the tree's peak memory was at the single call's level (5.4 to 5.8 GB);
// with two it is about 4.3 GB for 0 to 9 s of wall time. The behind layer is
// mostly still frames HyperFrames reuses, and the sound page draws nothing:
// one worker each. The sound page runs at a whole rate of 1 to 30 fps
// (soundPageFps).
export const LAYER_SETTINGS = {
  frontWorkers: 2,
  behindWorkers: 1,
  soundWorkers: 1,
} as const;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

// The sound page's frame rate for a reel of `frames` export frames: the lowest
// whole rate whose frames end exactly at `frames / 30` seconds, 30 / gcd(frames, 30)
// (10 for 1683 frames, 2 for 3045, 30 for 1013). Two things hold the rule:
// - HyperFrames mixes the sound from the page's elements whatever the rate, and
//   pads its mix to the page's last frame. The page's `frames / gcd` frames at
//   this rate last exactly `frames / 30` seconds, so the mix ends where the
//   single call's does, the AAC encoder ends its stream at the same sample,
//   and the first `soundPackets(frames)` packets, the last one included, are
//   the single call's bytes: the packet-count cut (soundCutArgs) stays exact.
//   At a plain 1 fps the mix ran on to the next whole second, and the packet
//   holding the reel's end could be encoded differently.
// - The rate must be a whole number, never a fraction. HyperFrames writes a
//   fractional rate (190/187 for 1683 frames) at timescale 90000, reads the
//   file back at another rate (317/12) and trims the sound to the length that
//   rate gives the page's frames (2.158 s of 56.1 s).
// The page draws nothing: it renders at about 20 page frames a second.
export function soundPageFps(frames: number): string {
  return String(EXPORT_FPS / gcd(frames, EXPORT_FPS));
}

export type RenderLayer = "behind" | "front" | "sound";

// `hyperframes render`'s arguments for one layer page, exactly: the picture
// layers as PNG frames with alpha into the folder `output`, the sound page as
// an MP4 whose pictures are never used.
export function layerArgs({
  layer,
  projectDir,
  output,
  frames,
}: {
  layer: RenderLayer;
  projectDir: string;
  output: string;
  // The reel's export frames (`reelFrames`): the sound page's rate.
  frames: number;
}): string[] {
  const workers = {
    front: LAYER_SETTINGS.frontWorkers,
    behind: LAYER_SETTINGS.behindWorkers,
    sound: LAYER_SETTINGS.soundWorkers,
  }[layer];
  return [
    "render",
    projectDir,
    "-o",
    output,
    "--quality",
    RENDER_SETTINGS.quality,
    "--workers",
    String(workers),
    "--no-browser-gpu",
    "--sdr",
    "--format",
    layer === "sound" ? "mp4" : "png-sequence",
    ...(layer === "sound" ? ["--fps", soundPageFps(frames)] : []),
  ];
}

// The share of E2E_MOCK_RENDER_SECONDS each part of the composite's double
// takes. The lanes run next to each other (front; sound then behind; the
// footage pass), then the composite: 0.45 + 0.55 is the whole.
export const DOUBLE_SHARES = {
  front: 0.45,
  sound: 0.15,
  behind: 0.3,
  footage: 0.3,
  composite: 0.55,
} as const;

// The small committed MP4 the render double copies (E2E_MOCK_RENDER=true).
export const STUB_EXPORT = fileURLToPath(
  new URL("../../../../fixtures/render/stub-export.mp4", import.meta.url),
);

// The render double's process: replays a real render's progress lines, then
// copies the stub.
export const FAKE_RENDER = fileURLToPath(new URL("./fake-render.ts", import.meta.url));

// Seconds of the composition to render; only the tools test passes one.
export interface RenderRange {
  start: number;
  end: number;
}

// `hyperframes render`'s arguments, exactly.
export function renderArgs({
  projectDir,
  output,
  range,
}: {
  projectDir: string;
  output: string;
  range?: RenderRange;
}): string[] {
  return [
    "render",
    projectDir,
    "-o",
    output,
    "--quality",
    RENDER_SETTINGS.quality,
    "--workers",
    String(RENDER_SETTINGS.workers),
    "--no-browser-gpu",
    "--sdr",
    ...(range ? ["--start", String(range.start), "--end", String(range.end)] : []),
  ];
}

// HyperFrames' environment without any PRODUCER_* variable: its audio mix
// stays at unity gain (PRODUCER_AUDIO_GAIN would scale the whole mix), so the
// voice keeps its own level whatever the shell says. Without
// HYPERFRAMES_STDOUT_IS_TTY too: set to 1 it silences the `@hf-progress`
// lines the step reads its progress from.
export function renderEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(hyperframesEnv(env)).filter(
      ([name]) => !name.startsWith("PRODUCER_") && name !== "HYPERFRAMES_STDOUT_IS_TTY",
    ),
  );
}

// Where a render's HyperFrames keeps what it leaves behind, all inside the
// render's own folder (so inside the job's scratch folder, which is removed
// after the job): the extract (frame) cache and its history. `hyperframes
// clean` is never run: on 0.8.222 it also sweeps the default history root and
// the shared caches of other projects. TMPDIR is not here: see withChromeTmp.
export function renderScratchEnv(dir: string): Record<string, string> {
  return {
    HYPERFRAMES_EXTRACT_CACHE_DIR: join(dir, "frames-cache"),
    HYPERFRAMES_HISTORY_ROOT: join(dir, "hyperframes-history"),
  };
}

// Chrome's temporary folder: a short folder of its own under the system temp
// folder (`/tmp` in the container), never under the render's folder. Chrome
// listens on a Unix socket at `<TMPDIR>/org.chromium.Chromium.XXXXXX/
// SingletonSocket`, and a Unix socket path holds at most 107 characters
// (sun_path). Under the job scratch folder (`/scratch/<job id>/render-XXXXXX/tmp`)
// that path is 108 characters and Chrome aborts before rendering. The folder is
// removed after the call, whatever happened. Frames and the MP4 stay in the
// render's folder; Chrome's own profile (and its disk cache) is the only large
// thing that lands here.
export async function withChromeTmp<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hf-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Whether the render double stands in for the real tools.
export function renderDoubled(env: NodeJS.ProcessEnv): boolean {
  return env.E2E_MOCK_RENDER === "true";
}

// One layer page as a tool call: its own caches and history under `dir` (the
// layer's own folder), its own Chrome TMPDIR (a withChromeTmp folder of its
// own), the tree's memory sampled, its progress read by `progress` (the
// step's share of it). Under the render double it is the double's `layer`
// part: the progress lines, then a file where the output goes.
export function layerCall({
  tools,
  layer,
  dir,
  chromeTmp,
  projectDir,
  output,
  frames,
  progress,
  signal,
  env = process.env,
}: {
  tools: ToolPaths;
  layer: RenderLayer;
  dir: string;
  chromeTmp: string;
  projectDir: string;
  output: string;
  frames: number;
  progress: ProgressParser;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}): ToolCall {
  if (renderDoubled(env)) {
    return {
      file: process.execPath,
      args: [FAKE_RENDER, "layer", String(DOUBLE_SHARES[layer]), output],
      env: { ...env },
      sampleGroupMemory: true,
      progress,
      signal,
    };
  }
  return {
    file: tools.hyperframes[0],
    args: [tools.hyperframes[1], ...layerArgs({ layer, projectDir, output, frames })],
    env: { ...renderEnv(env), ...renderScratchEnv(dir), TMPDIR: chromeTmp },
    sampleGroupMemory: true,
    progress,
    signal,
  };
}

// An ffmpeg pass of the composite as a tool call, its progress read from
// `-progress pipe:1`. Under the render double it is the double's `ffmpeg`
// part: `frames` progress reports, then the stub MP4 (`stub` true, the
// composite itself) or a placeholder at `output`.
export function ffmpegPassCall({
  tools,
  args,
  output,
  frames,
  part,
  progress,
  signal,
  env = process.env,
}: {
  tools: ToolPaths;
  args: string[];
  output: string;
  frames: number;
  part: "footage" | "composite";
  progress: ProgressParser;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}): ToolCall {
  if (renderDoubled(env)) {
    return {
      file: process.execPath,
      args: [
        FAKE_RENDER,
        "ffmpeg",
        String(DOUBLE_SHARES[part]),
        String(frames),
        part === "composite" ? STUB_EXPORT : "-",
        output,
      ],
      env: { ...env },
      progress,
      signal,
    };
  }
  return { file: tools.ffmpeg, args, env: { ...env }, progress, signal };
}

// Runs the lanes at the same time and waits for every one of them. The first
// failure aborts the signal the lanes pass to their calls, so the others'
// processes are killed at once; it is thrown once all have ended, so no
// child is left running when the caller cleans up.
export async function runLanes(
  lanes: readonly ((signal: AbortSignal) => Promise<void>)[],
): Promise<void> {
  const stop = new AbortController();
  let failed: { error: unknown } | null = null;
  await Promise.all(
    lanes.map(async (lane) => {
      try {
        await lane(stop.signal);
      } catch (error) {
        if (failed) return;
        failed = { error };
        stop.abort(error);
      }
    }),
  );
  if (failed) throw (failed as { error: unknown }).error;
}

// The render as one tool call, with the whole process tree's memory sampled
// (HyperFrames runs Chrome workers and an encoder), its caches and history
// under `dir`, the render's own folder, Chrome's TMPDIR at `chromeTmp` (a short
// folder from withChromeTmp), and its progress read from HyperFrames'
// `@hf-progress` lines. Under E2E_MOCK_RENDER set to exactly
// "true" it is the render double through the same step runner (a real
// render's progress lines replayed over E2E_MOCK_RENDER_SECONDS, then a copy
// of the stub MP4), so specs need no Chrome render.
export function renderCall({
  tools,
  dir,
  chromeTmp,
  projectDir,
  output,
  range,
  env = process.env,
}: {
  tools: ToolPaths;
  dir: string;
  // The short folder Chrome uses as TMPDIR (withChromeTmp).
  chromeTmp: string;
  projectDir: string;
  output: string;
  range?: RenderRange;
  env?: NodeJS.ProcessEnv;
}): ToolCall {
  if (renderDoubled(env)) {
    return {
      file: process.execPath,
      args: [FAKE_RENDER, STUB_EXPORT, output],
      env: { ...env },
      sampleGroupMemory: true,
      progress: parseRenderProgress,
    };
  }
  return {
    file: tools.hyperframes[0],
    args: [tools.hyperframes[1], ...renderArgs({ projectDir, output, range })],
    env: { ...renderEnv(env), ...renderScratchEnv(dir), TMPDIR: chromeTmp },
    sampleGroupMemory: true,
    progress: parseRenderProgress,
  };
}
