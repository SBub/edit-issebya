import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ToolCall } from "../step-runner.ts";
import type { ToolPaths } from "../pipeline/tools.ts";
import { MODELS_INSTALL, modnetModelPath } from "./modnet-model.ts";

// The mask tool's code version, in every mask's fingerprint beside
// MATTE_SETTINGS (the model's SHA-256 among them). Bump it whenever
// modnet-entry.ts or matte.ts changes what a mask looks like. 1 was the
// Apple Vision tool (vseg); masks stored under it stay with the versions
// that name them.
export const MASK_TOOL_VERSION = 2;

// The worker's own MODNet entry, run by this Node.
export const MODNET_ENTRY = fileURLToPath(new URL("./modnet-entry.ts", import.meta.url));

export interface MaskSpanCall {
  // The full-size footage on disk.
  input: string;
  start: number;
  end: number;
  output: string;
}

function seconds(n: number): string {
  return n.toFixed(3);
}

// The entry's arguments, exactly: the span to the millisecond, the model and
// the two ffmpeg tools it runs.
export function maskToolArgs(
  { input, start, end, output }: MaskSpanCall,
  model: string,
  tools: Pick<ToolPaths, "ffmpeg" | "ffprobe">,
): string[] {
  return [
    MODNET_ENTRY,
    "--input",
    input,
    "--start",
    seconds(start),
    "--end",
    seconds(end),
    "--output",
    output,
    "--model",
    model,
    "--ffmpeg",
    tools.ffmpeg,
    "--ffprobe",
    tools.ffprobe,
  ];
}

// Every pixel black, in a format every player decodes.
const BLACK_FILL = ["drawbox=c=black:t=fill", "format=yuv420p"].join(",");

// The mask double's ffmpeg arguments: the span of the footage painted black
// (no person anywhere), so it has the footage's size and frame times.
export function maskDoubleArgs({ input, start, end, output }: MaskSpanCall): string[] {
  return [
    "-hide_banner",
    "-y",
    "-ss",
    seconds(start),
    "-i",
    input,
    "-t",
    seconds(end - start),
    "-an",
    "-vf",
    BLACK_FILL,
    "-c:v",
    "libx264",
    "-f",
    "mp4",
    output,
  ];
}

export interface MaskToolOptions {
  tools: ToolPaths;
  env?: NodeJS.ProcessEnv;
  model?: string;
  node?: string;
  exists?: (path: string) => boolean;
}

// One span's mask as a tool call: MODNet portrait matting through ONNX
// Runtime on the CPU (modnet-entry.ts), on any OS, never with a fallback
// model. Under E2E_MOCK_MASK set to exactly "true" it is the double, a black
// mask made by ffmpeg through the same step runner, so specs need no model.
export function maskToolCall(
  span: MaskSpanCall,
  {
    tools,
    env = process.env,
    model = modnetModelPath(env),
    node = process.execPath,
    exists = existsSync,
  }: MaskToolOptions,
): ToolCall {
  if (env.E2E_MOCK_MASK === "true") {
    return { file: tools.ffmpeg, args: maskDoubleArgs(span) };
  }
  if (!exists(model)) {
    throw new Error(`cutout: MODNet model not installed at ${model}, run ${MODELS_INSTALL}`);
  }
  return { file: node, args: maskToolArgs(span, model, tools) };
}
