// Checks this machine can run jobs: Supabase, R2, ffmpeg and the filters and
// codecs the pipeline needs, HyperFrames, and one structured Claude Code call. Prints one line per check; exits 1 when any failed.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { aiRunner } from "./ai.ts";
import { workerConfig } from "./config.ts";
import { runDoctor } from "./doctor-checks.ts";
import { hyperframesEnv, toolPaths } from "./pipeline/tools.ts";
import { workerStorage } from "./storage.ts";
import { workerSupabase } from "./supabase.ts";

const run = promisify(execFile);

const { lines, exitCode } = await runDoctor({
  async supabase() {
    const { error } = await workerSupabase(workerConfig()).from("jobs").select("id").limit(1);
    if (error) throw new Error(error.message);
  },
  async r2() {
    await workerStorage().list(process.env.R2_KEY_PREFIX?.trim() ?? "");
  },
  async ffmpeg() {
    const { stdout } = await run(toolPaths().ffmpeg, ["-version"]);
    return stdout.split("\n")[0]?.replace(/^ffmpeg\s+/, "") ?? "";
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
});

for (const line of lines) console.log(line);
process.exit(exitCode);
