import { tmpdir } from "node:os";
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

const AI_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

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
        prompt: "Reply with ok set to true.",
        schema: AI_SCHEMA,
        cwd: tmpdir(),
      });
      if (result.kind !== "answer") throw new Error(result.reason);
      if ((result.answer as { ok?: unknown } | null)?.ok !== true) {
        throw new Error(`unexpected answer ${JSON.stringify(result.answer)}`);
      }
    }),
  ];
  return { lines, exitCode: lines.some((line) => line.startsWith("FAIL")) ? 1 : 0 };
}
