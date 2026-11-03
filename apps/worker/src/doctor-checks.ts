import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Storage } from "@edit-issebya/storage";
import {
  ISSEBYA_PRESET,
  type Transcript,
  decideJsonSchema,
  parseDecideAnswer,
} from "@edit-issebya/edit";
import { type AiRunner, plainTool } from "./ai.ts";
import { describePrompt } from "./photos/describe-prompt.ts";
import { describeJsonSchema, parseDescribeAnswer } from "./photos/describe-schema.ts";

// The committed sample photo the image check sends (scripts/make-test-photos.sh).
const SAMPLE_PHOTO = new URL("../../../fixtures/photos/sample.jpg", import.meta.url).pathname;

// The describe_photo call on the sample photo: Claude Code allowed to read
// only `photo.jpg`, alone in a fresh folder, answering the describe schema.
async function aiImageCall(ai: AiRunner): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "doctor-photo-"));
  try {
    await copyFile(SAMPLE_PHOTO, join(dir, "photo.jpg"));
    const result = await ai.call(plainTool, {
      prompt: describePrompt(),
      schema: describeJsonSchema,
      cwd: dir,
      readFile: "photo.jpg",
    });
    if (result.kind !== "answer") throw new Error(result.reason);
    const parsed = parseDescribeAnswer(result.answer);
    if (!parsed.ok) throw new Error(`unexpected answer: ${parsed.reasons.join("; ")}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Each dependency is built inside its own check, so a missing variable fails
// that line only.
export interface DoctorDeps {
  supabase: () => Promise<void>;
  // The storage and its key prefix; the check lists, then puts, reads back and
  // deletes a probe object under `<prefix>doctor/`.
  r2: () => { storage: Pick<Storage, "list" | "put" | "get" | "delete">; prefix: string };
  // The first line of `ffmpeg -version` / `ffprobe -version`, the tool's name
  // dropped (`version 8.0.1 Copyright ...`).
  ffmpeg: () => Promise<string>;
  ffprobe: () => Promise<string>;
  // `ffmpeg -hide_banner -filters` output.
  ffmpegFilters: () => Promise<string>;
  // `ffmpeg -hide_banner -encoders` and `-decoders` output, joined.
  ffmpegCodecs: () => Promise<string>;
  // `hyperframes --version` output.
  hyperframes: () => Promise<string>;
  ai: () => AiRunner;
  // The cut-out's mask tool (vseg): the platform, its build, one run on a
  // 1-second sample (written to `output`), and ffprobe of a file.
  maskTool: () => MaskToolDeps;
  // The scratch folder and whether it exists or can be created (never created).
  scratchDir: () => Promise<{ dir: string; state: "exists" | "can be created" }>;
}

export interface MaskToolDeps {
  platform: NodeJS.Platform;
  build: () => Promise<void>;
  // The sample's first second masked into `output`.
  run: (output: string) => Promise<void>;
  probe: (file: string) => Promise<VideoProbe>;
  // The sample footage the run masks.
  sample: string;
}

export interface VideoProbe {
  codec: string;
  width: number;
  height: number;
  frames: number;
}

// vseg built, run on one second of the sample, its mask checked: H.264 at the
// sample's size, 30 frames give or take one. On another OS, one line.
async function maskToolCheck(deps: MaskToolDeps): Promise<string> {
  if (deps.platform !== "darwin") {
    throw new Error(
      `the mask tool runs on macOS only (Apple Vision); this worker runs on ${deps.platform}`,
    );
  }
  await deps.build();
  const dir = await mkdtemp(join(tmpdir(), "doctor-mask-"));
  try {
    const output = join(dir, "mask.mp4");
    const started = performance.now();
    await deps.run(output);
    const seconds = (performance.now() - started) / 1000;
    const [mask, sample] = [await deps.probe(output), await deps.probe(deps.sample)];
    if (mask.codec !== "h264") throw new Error(`mask is ${mask.codec}, not h264`);
    if (mask.width !== sample.width || mask.height !== sample.height) {
      throw new Error(
        `mask is ${mask.width}x${mask.height}, the footage ${sample.width}x${sample.height}`,
      );
    }
    if (Math.abs(mask.frames - 30) > 1) throw new Error(`mask has ${mask.frames} frames, not 30`);
    return `vseg built, 1 s masked in ${seconds.toFixed(1)} s`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The filters the fixed steps use: HDR tone-mapping, retime tempo, the envelope.
const PIPELINE_FILTERS = ["zscale", "tonemap", "atempo", "astats", "ametadata"];

// The codecs the fixed steps use: H.264 encodes, VP9 with alpha encoded and
// decoded (the head tracker's person mask).
const PIPELINE_ENCODERS = ["libx264", "libvpx-vp9"];
const PIPELINE_DECODERS = ["libvpx-vp9"];

// Codec names from `ffmpeg -encoders` / `-decoders` (lines like
// ` V....D libx264  libx264 H.264 ...`), split into the two sections by their
// headers.
function codecNames(listing: string): { encoders: Set<string>; decoders: Set<string> } {
  const encoders = new Set<string>();
  const decoders = new Set<string>();
  let section = encoders;
  for (const line of listing.split("\n")) {
    if (/^\s*Encoders:/.test(line)) section = encoders;
    else if (/^\s*Decoders:/.test(line)) section = decoders;
    const name = line.trim().split(/\s+/)[1];
    if (name) section.add(name);
  }
  return { encoders, decoders };
}

// ffprobe's `-show_stream_groups` (HEIC tile grids) is new in ffmpeg 7.0.
const FFMPEG_MIN_MAJOR = 7;

// The major version from a `-version` line: `version 6.1.1-3ubuntu5`,
// `version n7.0.2`, `version 7.0.2-static https://...`. A git build
// (`version N-117000-g...`) has none: null, taken as new enough.
export function ffmpegMajor(versionLine: string): number | null {
  const match = /version\s+n?(\d+)\.\d+/.exec(versionLine);
  return match ? Number(match[1]) : null;
}

// Throws the one-line reason when the tool is older than 7.
function requireMinVersion(tool: string, versionLine: string): void {
  const major = ffmpegMajor(versionLine);
  if (major === null || major >= FFMPEG_MIN_MAJOR) return;
  const version = /version\s+n?(\d+\.\d+)/.exec(versionLine)?.[1] ?? String(major);
  throw new Error(
    `${tool} ${version} found, ${FFMPEG_MIN_MAJOR} or newer is needed for HEIC photos (-show_stream_groups)`,
  );
}

// Filter names from `ffmpeg -filters` (lines like ` ... zscale  V->V  Apply ...`).
function filterNames(listing: string): Set<string> {
  const names = new Set<string>();
  for (const line of listing.split("\n")) {
    const name = line.trim().split(/\s+/)[1];
    if (name) names.add(name);
  }
  return names;
}

// A tiny reel for the AI check: the real decide schema is built from it, so
// the doctor fails on a schema the Claude Code CLI rejects, as the decide step
// would.
const AI_SAMPLE_TRANSCRIPT: Transcript = {
  words: [
    { id: "w0001", text: "Hello", start: 0, end: 0.4 },
    { id: "w0002", text: "there", start: 0.4, end: 0.8 },
  ],
};
const AI_SAMPLE_DURATION = 1;

// The decide schema the AI check sends, for the sample reel.
function doctorAiSchema(): Record<string, unknown> {
  return decideJsonSchema(ISSEBYA_PRESET, AI_SAMPLE_TRANSCRIPT, AI_SAMPLE_DURATION);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Runs one probe stage, its error prefixed with the stage and the key.
async function stage<T>(name: string, key: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(`${name} ${key}: ${reasonOf(error)}`);
  }
}

const PROBE_BODY = "edit-issebya doctor probe";

// Proves the key may read and write: lists the prefix, then puts a probe
// object, reads it back and deletes it (the delete runs whenever the put
// succeeded, so a half-run probe is not left behind).
async function probeR2(deps: DoctorDeps["r2"]): Promise<void> {
  const { storage, prefix } = deps();
  await storage.list(prefix);
  const key = `${prefix}doctor/probe-${randomBytes(6).toString("hex")}.txt`;
  const body = new TextEncoder().encode(PROBE_BODY);
  await stage("put", key, () => storage.put(key, body, { contentType: "text/plain" }));
  let failure: unknown = null;
  try {
    const read = await stage("get", key, () => storage.get(key));
    if (read === null) throw new Error(`get ${key}: probe missing`);
    if (new TextDecoder().decode(read) !== PROBE_BODY) throw new Error(`get ${key}: probe differs`);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await stage("delete", key, () => storage.delete(key));
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== null) throw failure;
}

async function check(name: string, run: () => Promise<string | void>): Promise<string> {
  try {
    const detail = await run();
    return `ok   ${detail ? `${name} ${detail}` : name}`;
  } catch (error) {
    return `FAIL ${name}: ${reasonOf(error).split("\n")[0]}`;
  }
}

// One line per check, never stopping at the first failure; exit code 1 when
// any line failed.
export async function runDoctor(deps: DoctorDeps): Promise<{ lines: string[]; exitCode: number }> {
  const lines = [
    await check("supabase reachable", deps.supabase),
    await check("r2 bucket readable and writable", () => probeR2(deps.r2)),
    await check("ffmpeg", async () => {
      const ffmpeg = await deps.ffmpeg();
      requireMinVersion("ffmpeg", ffmpeg);
      requireMinVersion("ffprobe", await deps.ffprobe());
      return ffmpeg;
    }),
    await check("ffmpeg filters", async () => {
      const names = filterNames(await deps.ffmpegFilters());
      const missing = PIPELINE_FILTERS.filter((name) => !names.has(name));
      if (missing.length > 0) throw new Error(`missing ${missing.join(", ")}`);
      return PIPELINE_FILTERS.join(", ");
    }),
    await check("ffmpeg codecs", async () => {
      const { encoders, decoders } = codecNames(await deps.ffmpegCodecs());
      const missing = [
        ...PIPELINE_ENCODERS.filter((name) => !encoders.has(name)).map((n) => `encoder ${n}`),
        ...PIPELINE_DECODERS.filter((name) => !decoders.has(name)).map((n) => `decoder ${n}`),
      ];
      if (missing.length > 0) throw new Error(`missing ${missing.join(", ")}`);
      return [...PIPELINE_ENCODERS, ...PIPELINE_DECODERS.map((n) => `${n} decoder`)].join(", ");
    }),
    await check("hyperframes", async () => {
      const version = (await deps.hyperframes()).trim().split("\n").at(-1)?.trim();
      if (!version) throw new Error("no version printed");
      return version;
    }),
    await check("ai structured call", async () => {
      const result = await deps.ai().call(plainTool, {
        prompt:
          'Reply with every track an empty list, change_title and change_summary "ok", unexpressed and free_field empty lists, and behind_rules photos and big_word "keep".',
        schema: doctorAiSchema(),
        cwd: tmpdir(),
      });
      if (result.kind !== "answer") throw new Error(result.reason);
      const parsed = parseDecideAnswer(
        result.answer,
        ISSEBYA_PRESET,
        AI_SAMPLE_TRANSCRIPT,
        AI_SAMPLE_DURATION,
      );
      if (!parsed.ok) throw new Error(`unexpected answer: ${parsed.reasons.join("; ")}`);
    }),
    await check("ai image call", () => aiImageCall(deps.ai())),
    await check("mask tool", () => maskToolCheck(deps.maskTool())),
    // Last, so the earlier lines keep their places.
    await check("scratch dir", async () => {
      const { dir, state } = await deps.scratchDir();
      return `${dir} ${state}`;
    }),
  ];
  return { lines, exitCode: lines.some((line) => line.startsWith("FAIL")) ? 1 : 0 };
}
