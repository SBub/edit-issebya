import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ToolCall } from "../step-runner.ts";
import type { ToolPaths } from "../pipeline/tools.ts";

// Bumped by hand with MASK_TOOL_SOURCE_SHA256 whenever vseg.swift changes:
// every mask's fingerprint names it, so a new tool makes new masks.
export const MASK_TOOL_VERSION = 1;
// The SHA-256 of tools/vseg/vseg.swift this version was made from;
// mask-tool.test.ts fails when the file and this hash differ.
export const MASK_TOOL_SOURCE_SHA256 =
  "e7fa9c7ace2a56932fc91c7e60317b0177dbd308c4814df6394a4202c415fc27";

export const VSEG_SOURCE = fileURLToPath(new URL("../../tools/vseg/vseg.swift", import.meta.url));
// Built by `yarn workspace @edit-issebya/worker build:vseg`, gitignored.
const VSEG_BINARY = fileURLToPath(new URL("../../tools/vseg/.build/vseg", import.meta.url));

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

// `vseg`'s arguments, exactly.
export function maskToolArgs({ input, start, end, output }: MaskSpanCall): string[] {
  return ["--input", input, "--start", seconds(start), "--end", seconds(end), "--output", output];
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
  platform?: NodeJS.Platform;
  binary?: string;
  exists?: (path: string) => boolean;
}

// One span's mask as a tool call: `vseg` (Apple Vision person segmentation,
// accurate), on macOS only and never with a fallback model. Under
// E2E_MOCK_MASK set to exactly "true" it is the double, a black mask made by
// ffmpeg through the same step runner, so specs run anywhere.
export function maskToolCall(
  span: MaskSpanCall,
  {
    tools,
    env = process.env,
    platform = process.platform,
    binary = VSEG_BINARY,
    exists = existsSync,
  }: MaskToolOptions,
): ToolCall {
  if (env.E2E_MOCK_MASK === "true") {
    return { file: tools.ffmpeg, args: maskDoubleArgs(span) };
  }
  if (platform !== "darwin") {
    throw new Error(
      `cutout: the mask tool runs on macOS only (Apple Vision); this worker runs on ${platform}`,
    );
  }
  if (!exists(binary)) {
    throw new Error(
      "cutout: mask tool not built, run yarn workspace @edit-issebya/worker build:vseg",
    );
  }
  return { file: binary, args: maskToolArgs(span) };
}
