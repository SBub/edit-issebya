import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join } from "node:path";

type Env = Record<string, string | undefined>;

const require = createRequire(import.meta.url);
const HYPERFRAMES_PACKAGE = require.resolve("hyperframes/package.json");

// The exact HyperFrames version installed (pinned in apps/worker/package.json):
// a transcribe setting, since another version may hear other words.
export const HYPERFRAMES_VERSION: string = (
  require("hyperframes/package.json") as { version: string }
).version;

// The tools the fixed steps run. HyperFrames is the installed package's own
// entry run by this Node, never through npx or yarn dlx.
export interface ToolPaths {
  ffmpeg: string;
  ffprobe: string;
  // `[node, <package>/bin/hyperframes.mjs]`: the file and the first argument.
  hyperframes: [string, string];
}

export function toolPaths(env: Env = process.env): ToolPaths {
  const ffmpeg = env.FFMPEG_PATH?.trim() || "ffmpeg";
  // ffprobe ships beside ffmpeg; a bare name resolves through PATH like ffmpeg.
  const ffprobe = isAbsolute(ffmpeg)
    ? join(dirname(ffmpeg), basename(ffmpeg).replace(/ffmpeg/, "ffprobe"))
    : "ffprobe";
  return {
    ffmpeg,
    ffprobe,
    hyperframes: [process.execPath, join(dirname(HYPERFRAMES_PACKAGE), "bin", "hyperframes.mjs")],
  };
}

// The environment HyperFrames always runs with: telemetry off, whatever the
// file or the shell says, and the worker's own ffmpeg when it is configured by
// path (HyperFrames requires a configured path to exist; a bare name is left
// to PATH).
export function hyperframesEnv(
  env: NodeJS.ProcessEnv = process.env,
  tools?: ToolPaths,
): NodeJS.ProcessEnv {
  const ffmpeg =
    tools && isAbsolute(tools.ffmpeg)
      ? { HYPERFRAMES_FFMPEG_PATH: tools.ffmpeg, HYPERFRAMES_FFPROBE_PATH: tools.ffprobe }
      : {};
  return { ...env, ...ffmpeg, HYPERFRAMES_NO_TELEMETRY: "1" };
}
