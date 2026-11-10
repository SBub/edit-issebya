import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRenderProgress } from "../progress-parsers.ts";
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
  if (env.E2E_MOCK_RENDER === "true") {
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
