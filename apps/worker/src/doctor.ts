// Checks this machine can run jobs, one line each: Supabase, R2 read and write
// (a probe object put, read back and deleted under `<R2_KEY_PREFIX>doctor/`),
// ffmpeg and ffprobe 7 or newer with the filters and codecs the pipeline needs, HyperFrames, one
// structured Claude Code call, one image call, the cut-out's mask tool (built
// and run on one second of a sample), and the scratch folder (exists or can be
// created, never created here). Prints one line per check; exits 1 when any
// failed.
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { keyPrefix } from "@edit-issebya/storage";
import { aiRunner } from "./ai.ts";
import { scratchDirOf, workerConfig } from "./config.ts";
import { checkBridgeHealth } from "./bridge/client.ts";
import { maskToolCall } from "./cutout/mask-tool.ts";
import { runDoctor } from "./doctor-checks.ts";
import { hyperframesEnv, toolPaths } from "./pipeline/tools.ts";
import { scratchDirState } from "./scratch.ts";
import { workerStorage } from "./storage.ts";
import { workerSupabase } from "./supabase.ts";

const run = promisify(execFile);

// The 1-second sample the mask tool check masks.
const MASK_SAMPLE = fileURLToPath(
  new URL("../../../fixtures/footage/short-speech.mp4", import.meta.url),
);
const BUILD_VSEG = fileURLToPath(new URL("../scripts/build-vseg.sh", import.meta.url));

// With a bridge URL (the worker container) the checks run through the bridges
// on the Mac: their health is checked, and temp folders go in the scratch folder.
const claudeBridge = process.env.CLAUDE_BRIDGE_URL?.trim();
const cutoutBridge = process.env.VSEG_BRIDGE_URL?.trim();
const bridged = Boolean(claudeBridge || cutoutBridge);

const { lines, exitCode } = await runDoctor({
  workDir: () => (bridged ? scratchDirOf(process.env) : tmpdir()),
  bridges: {
    claude: claudeBridge ? () => checkBridgeHealth(claudeBridge) : undefined,
    cutout: cutoutBridge ? () => checkBridgeHealth(cutoutBridge) : undefined,
  },
  async supabase() {
    const { error } = await workerSupabase(workerConfig()).from("jobs").select("id").limit(1);
    if (error) throw new Error(error.message);
  },
  r2() {
    const prefix = keyPrefix(process.env);
    if (prefix === null) {
      throw new Error(
        `R2_KEY_PREFIX must be empty or lower-case segments each ending with "/", got ${process.env.R2_KEY_PREFIX}`,
      );
    }
    return { storage: workerStorage(), prefix };
  },
  async ffmpeg() {
    const { stdout } = await run(toolPaths().ffmpeg, ["-version"]);
    return stdout.split("\n")[0]?.replace(/^ffmpeg\s+/, "") ?? "";
  },
  async ffprobe() {
    const { stdout } = await run(toolPaths().ffprobe, ["-version"]);
    return stdout.split("\n")[0]?.replace(/^ffprobe\s+/, "") ?? "";
  },
  async ffmpegFilters() {
    const { stdout } = await run(toolPaths().ffmpeg, ["-hide_banner", "-filters"]);
    return stdout;
  },
  async ffmpegCodecs() {
    const ffmpeg = toolPaths().ffmpeg;
    const encoders = await run(ffmpeg, ["-hide_banner", "-encoders"]);
    const decoders = await run(ffmpeg, ["-hide_banner", "-decoders"]);
    return `${encoders.stdout}\n${decoders.stdout}`;
  },
  async hyperframes() {
    const [node, entry] = toolPaths().hyperframes;
    const { stdout } = await run(node, [entry, "--version"], { env: hyperframesEnv() });
    return stdout;
  },
  ai: () => aiRunner(process.env),
  maskTool: () => ({
    platform: process.platform,
    sample: MASK_SAMPLE,
    bridged: Boolean(cutoutBridge),
    build: cutoutBridge
      ? undefined
      : async () => {
          await run("bash", [BUILD_VSEG]);
        },
    async run(input, output) {
      const call = maskToolCall(
        { input, start: 0, end: 1, output },
        { tools: toolPaths(), env: { VSEG_BRIDGE_URL: cutoutBridge } },
      );
      await run(call.file, call.args);
    },
    async probe(file) {
      const { stdout } = await run(toolPaths().ffprobe, [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-count_frames",
        "-show_entries",
        "stream=codec_name,width,height,nb_read_frames",
        "-of",
        "json",
        file,
      ]);
      const stream = (
        JSON.parse(stdout) as {
          streams: { codec_name: string; width: number; height: number; nb_read_frames: string }[];
        }
      ).streams[0];
      if (!stream) throw new Error(`no video stream in ${file}`);
      return {
        codec: stream.codec_name,
        width: stream.width,
        height: stream.height,
        frames: Number(stream.nb_read_frames),
      };
    },
  }),
  async scratchDir() {
    const dir = scratchDirOf(process.env);
    return { dir, state: await scratchDirState(dir) };
  },
});

for (const line of lines) console.log(line);
process.exit(exitCode);
