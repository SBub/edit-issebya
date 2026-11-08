import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Storage } from "@edit-issebya/storage";
import {
  ISSEBYA_PRESET,
  type Transcript,
  decideJsonSchema,
  hookJsonSchema,
  parseDecideAnswer,
  parseHookAnswer,
} from "@edit-issebya/edit";
import type { AiRunner } from "./ai.ts";
import { hookInput, hookPrompt } from "./decide/hook.ts";
import { describePrompt } from "./photos/describe-prompt.ts";
import { PROMPT_NAMES, type PromptSource, promptIdentity } from "./prompts/source.ts";
import { describeJsonSchema, parseDescribeAnswer } from "./photos/describe-schema.ts";

// The committed sample photo the image check sends (scripts/make-test-photos.sh).
const SAMPLE_PHOTO = new URL("../../../fixtures/photos/sample.jpg", import.meta.url).pathname;

// The describe_photo call on the sample photo, sent as the step sends it (one
// JPEG image), answering the describe schema.
async function aiImageCall(ai: AiRunner, prompts: PromptSource): Promise<void> {
  const result = await ai.call({
    role: "describe",
    ...describePrompt(await prompts.get(PROMPT_NAMES.describe)),
    schema: describeJsonSchema,
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed sample photo
    image: { data: await readFile(SAMPLE_PHOTO), mediaType: "image/jpeg" },
  });
  if (result.kind !== "answer") throw new Error(result.reason);
  const parsed = parseDescribeAnswer(result.answer);
  if (!parsed.ok) throw new Error(`unexpected answer: ${parsed.reasons.join("; ")}`);
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
  // OPENROUTER_API_KEY as the worker reads it (checked set, never printed).
  openRouterKey: () => string | undefined;
  // POSTHOG_PERSONAL_API_KEY as the worker reads it (checked set, never printed).
  posthogKey: () => string | undefined;
  // POSTHOG_PROJECT_ID as the prompt source reads it (checked set; a project number, not secret).
  projectId: () => string | undefined;
  // The worker's prompt source: PostHog, or the placeholder double under
  // E2E_MOCK_PROMPTS. Each prompt is fetched once by the check that names it.
  prompts: () => PromptSource;
  // The AI runner the jobs use: each AI check (run only with `--ai`) makes one
  // tiny real call.
  ai: () => AiRunner;
  // The cut-out's mask tool (MODNet): the installed model checked against
  // its pinned hash, one run on a 1-second sample (written to `output`), and
  // ffprobe of a file.
  maskTool: () => MaskToolDeps;
  // The scratch folder and whether it exists or can be created (never created).
  scratchDir: () => Promise<{ dir: string; state: "exists" | "can be created" }>;
}

export interface MaskToolDeps {
  // Rejects with one line when the model is missing or has another hash.
  verifyModel: () => Promise<void>;
  // The pinned model's SHA-256, named on the line.
  modelSha256: string;
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

// The MODNet model present with its pinned hash, run on one second of the
// sample, its mask checked: H.264 at the sample's size, 30 frames give or
// take one. Any OS.
async function maskToolCheck(deps: MaskToolDeps): Promise<string> {
  await deps.verifyModel();
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
    return `modnet ${deps.modelSha256.slice(0, 8)}, 1 s masked in ${seconds.toFixed(1)} s`;
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
// the doctor fails on a schema the provider rejects, as the decide step would.
const AI_SAMPLE_TRANSCRIPT: Transcript = {
  words: [
    { id: "w0001", text: "Hello", start: 0, end: 0.4 },
    { id: "w0002", text: "there", start: 0.4, end: 0.8 },
  ],
};

// The decide schema the AI check sends, for the sample reel.
function doctorAiSchema(): Record<string, unknown> {
  return decideJsonSchema(ISSEBYA_PRESET, AI_SAMPLE_TRANSCRIPT);
}

// The hook call the AI check sends, for the sample reel: the fetched hook
// prompt, filled as the decide step fills it.
async function doctorHookCall(prompts: PromptSource) {
  return hookPrompt(
    await prompts.get(PROMPT_NAMES.hook),
    hookInput(AI_SAMPLE_TRANSCRIPT, ISSEBYA_PRESET),
  );
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

export interface DoctorOptions {
  // The two real, paid AI calls (`doctor --ai`); off by default, so a startup
  // check costs nothing.
  ai?: boolean;
}

// One line per check, never stopping at the first failure; exit code 1 when
// any line failed.
export async function runDoctor(
  deps: DoctorDeps,
  options: DoctorOptions = {},
): Promise<{ lines: string[]; exitCode: number }> {
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
    await check("openrouter key", async () => {
      if (!deps.openRouterKey()?.trim()) {
        throw new Error("OPENROUTER_API_KEY is not set (apps/worker/.env.development)");
      }
      return "set";
    }),
    ...(await promptChecks(deps)),
    ...(options.ai ? await aiChecks(deps) : []),
    await check("mask tool", () => maskToolCheck(deps.maskTool())),
    // Last, so the earlier lines keep their places.
    await check("scratch dir", async () => {
      const { dir, state } = await deps.scratchDir();
      return `${dir} ${state}`;
    }),
  ];
  return { lines, exitCode: lines.some((line) => line.startsWith("FAIL")) ? 1 : 0 };
}

// The PostHog prompts, each fetched by name at the configured label: the line
// names `name@vN` and the label, never the text. Without the project id or the
// personal key, its line says which one is missing and the five prompts are not
// fetched.
async function promptChecks(deps: DoctorDeps): Promise<string[]> {
  const key = await check("posthog personal key", async () => {
    if (!deps.posthogKey()?.trim()) {
      throw new Error(
        "POSTHOG_PERSONAL_API_KEY is not set (apps/worker/.env.development): the decide and describe_photo prompts come from PostHog, so those jobs cannot run",
      );
    }
    return "set";
  });
  const project = await check("posthog project id", async () => {
    if (!deps.projectId()?.trim()) {
      throw new Error(
        "POSTHOG_PROJECT_ID is not set (apps/worker/.env.development): the prompts are fetched from that project, so those jobs cannot run",
      );
    }
    return "set";
  });
  if (key.startsWith("FAIL") || project.startsWith("FAIL")) return [key, project];
  const lines = [key, project];
  for (const name of Object.values(PROMPT_NAMES)) {
    lines.push(
      await check("prompt", async () => {
        const prompt = await deps.prompts().get(name);
        return `${promptIdentity(prompt)} (label ${prompt.label})`;
      }),
    );
  }
  return lines;
}

// The three paid checks, after the key line: one tiny structured call with
// the decide schema, one hook call with the hook schema and one image call.
async function aiChecks(deps: DoctorDeps): Promise<string[]> {
  return [
    // One tiny real call with the real decide schema: the line names the
    // model that answered. Its prompt is a placeholder the doctor writes itself.
    await check("ai structured call", async () => {
      const result = await deps.ai().call({
        role: "decide",
        prompt: "doctor probe: answer with the empty lists",
        promptVersion: "doctor-probe@v0",
        schema: doctorAiSchema(),
      });
      if (result.kind !== "answer") throw new Error(result.reason);
      const parsed = parseDecideAnswer(result.answer, ISSEBYA_PRESET, AI_SAMPLE_TRANSCRIPT);
      if (!parsed.ok) throw new Error(`unexpected answer: ${parsed.reasons.join("; ")}`);
      return result.usage.model ?? undefined;
    }),
    // The hook call with the real hook schema and prompt, as the decide step
    // sends it before the components.
    await check("ai hook call", async () => {
      const result = await deps.ai().call({
        role: "hook",
        ...(await doctorHookCall(deps.prompts())),
        schema: hookJsonSchema(ISSEBYA_PRESET),
      });
      if (result.kind !== "answer") throw new Error(result.reason);
      const parsed = parseHookAnswer(result.answer, ISSEBYA_PRESET);
      if (!parsed.ok) throw new Error(`unexpected answer: ${parsed.reasons.join("; ")}`);
      return result.usage.model ?? undefined;
    }),
    await check("ai image call", () => aiImageCall(deps.ai(), deps.prompts())),
  ];
}
