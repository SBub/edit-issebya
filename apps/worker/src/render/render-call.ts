import { fileURLToPath } from "node:url";
import type { ToolCall } from "../step-runner.ts";
import { type ToolPaths, hyperframesEnv } from "../pipeline/tools.ts";

// The export's render settings. The platforms recompress every upload, so a
// cleaner source (`delivery` quality) keeps text edges and the cut-out's
// outline sharper after their pass. Software mode with three workers is faster
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
// voice keeps its own level whatever the shell says.
export function renderEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(hyperframesEnv(env)).filter(([name]) => !name.startsWith("PRODUCER_")),
  );
}

// The render as one tool call, with the whole process tree's memory sampled
// (HyperFrames runs Chrome workers and an encoder). Under E2E_MOCK_RENDER set
// to exactly "true" it is a copy of the stub MP4 through the same step runner,
// so specs need no Chrome render.
export function renderCall({
  tools,
  projectDir,
  output,
  range,
  env = process.env,
}: {
  tools: ToolPaths;
  projectDir: string;
  output: string;
  range?: RenderRange;
  env?: NodeJS.ProcessEnv;
}): ToolCall {
  if (env.E2E_MOCK_RENDER === "true") {
    return { file: "/bin/cp", args: [STUB_EXPORT, output], sampleGroupMemory: true };
  }
  return {
    file: tools.hyperframes[0],
    args: [tools.hyperframes[1], ...renderArgs({ projectDir, output, range })],
    env: renderEnv(env),
    sampleGroupMemory: true,
  };
}
