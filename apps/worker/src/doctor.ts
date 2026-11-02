// Checks this machine can run jobs, in eight lines: Supabase, R2 read and write
// (a probe object put, read back and deleted under `<R2_KEY_PREFIX>doctor/`),
// ffmpeg and the filters and codecs the pipeline needs, HyperFrames, one
// structured Claude Code call, and the scratch folder (exists or can be
// created, never created here). Prints one line per check; exits 1 when any
// failed.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { keyPrefix } from "@edit-issebya/storage";
import { aiRunner } from "./ai.ts";
import { scratchDirOf, workerConfig } from "./config.ts";
import { runDoctor } from "./doctor-checks.ts";
import { hyperframesEnv, toolPaths } from "./pipeline/tools.ts";
import { scratchDirState } from "./scratch.ts";
import { workerStorage } from "./storage.ts";
import { workerSupabase } from "./supabase.ts";

const run = promisify(execFile);

const { lines, exitCode } = await runDoctor({
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
  async scratchDir() {
    const dir = scratchDirOf(process.env);
    return { dir, state: await scratchDirState(dir) };
  },
});

for (const line of lines) console.log(line);
process.exit(exitCode);
