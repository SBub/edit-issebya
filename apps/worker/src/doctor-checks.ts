import { tmpdir } from "node:os";
import {
  ISSEBYA_PRESET,
  type Transcript,
  decideJsonSchema,
  parseDecideAnswer,
} from "@edit-issebya/edit";
import { type AiRunner, plainTool } from "./ai.ts";

// Each dependency is built inside its own check, so a missing variable fails
// that line only.
export interface DoctorDeps {
  supabase: () => Promise<void>;
  r2: () => Promise<void>;
  ffmpeg: () => Promise<string>;
  // `ffmpeg -hide_banner -filters` output.
  ffmpegFilters: () => Promise<string>;
  // `ffmpeg -hide_banner -encoders` and `-decoders` output, joined.
  ffmpegCodecs: () => Promise<string>;
  // `hyperframes --version` output.
  hyperframes: () => Promise<string>;
  ai: () => AiRunner;
}

// The filters the fixed steps use: HDR tone-mapping, retime tempo, the envelope.
const PIPELINE_FILTERS = ["zscale", "tonemap", "atempo", "astats", "ametadata"];

// The codecs the fixed steps use: H.264 encodes, VP9 with alpha encoded and
// decoded (the cut-out, the head tracker, the subject preview).
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

async function check(name: string, run: () => Promise<string | void>): Promise<string> {
  try {
    const detail = await run();
    return `ok   ${detail ? `${name} ${detail}` : name}`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `FAIL ${name}: ${reason.split("\n")[0]}`;
  }
}

// One line per check, never stopping at the first failure; exit code 1 when
// any line failed.
export async function runDoctor(deps: DoctorDeps): Promise<{ lines: string[]; exitCode: number }> {
  const lines = [
    await check("supabase reachable", deps.supabase),
    await check("r2 bucket reachable", deps.r2),
    await check("ffmpeg", deps.ffmpeg),
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
          'Reply with every track an empty list, change_summary "ok", and unexpressed and free_field empty lists.',
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
  ];
  return { lines, exitCode: lines.some((line) => line.startsWith("FAIL")) ? 1 : 0 };
}
