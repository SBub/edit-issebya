import type { AiRunner } from "./ai.ts";

// Each dependency is built inside its own check, so a missing variable fails
// that line only.
export interface DoctorDeps {
  supabase: () => Promise<void>;
  r2: () => Promise<void>;
  ffmpeg: () => Promise<string>;
  // `ffmpeg -hide_banner -filters` output.
  ffmpegFilters: () => Promise<string>;
  // `ffmpeg -hide_banner -encoders` and `-decoders` output.
  ffmpegEncoders: () => Promise<string>;
  ffmpegDecoders: () => Promise<string>;
  // `hyperframes --version` output.
  hyperframes: () => Promise<string>;
  ai: () => AiRunner;
}

// The filters the fixed steps use: HDR tone-mapping, retime tempo, the envelope.
const PIPELINE_FILTERS = ["zscale", "tonemap", "atempo", "astats", "ametadata"];

// The cut-out and its preview copy are VP9 with alpha: libvpx-vp9 encodes
// them and decodes them (ffmpeg's native VP9 decoder drops the alpha).
const VP9 = "libvpx-vp9";

// Names from `ffmpeg -filters`, `-encoders` or `-decoders` (lines like
// ` ... zscale  V->V  Apply ...` or ` V....D libvpx-vp9  libvpx VP9 ...`).
function listedNames(listing: string): Set<string> {
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
      const names = listedNames(await deps.ffmpegFilters());
      const missing = PIPELINE_FILTERS.filter((name) => !names.has(name));
      if (missing.length > 0) throw new Error(`missing ${missing.join(", ")}`);
      return PIPELINE_FILTERS.join(", ");
    }),
    await check("ffmpeg vp9 with alpha", async () => {
      const missing = [
        ...(listedNames(await deps.ffmpegEncoders()).has(VP9) ? [] : ["encoder"]),
        ...(listedNames(await deps.ffmpegDecoders()).has(VP9) ? [] : ["decoder"]),
      ];
      if (missing.length > 0) throw new Error(`missing ${VP9} ${missing.join(" and ")}`);
      return `${VP9} encoder and decoder`;
    }),
    await check("hyperframes", async () => {
      const version = (await deps.hyperframes()).trim().split("\n").at(-1)?.trim();
      if (!version) throw new Error("no version printed");
      return version;
    }),
    await check("ai structured call", async () => {
      const answer = await deps.ai().runJson("Reply with ok set to true.", AI_SCHEMA);
      if ((answer as { ok?: unknown } | null)?.ok !== true) {
        throw new Error(`unexpected answer ${JSON.stringify(answer)}`);
      }
    }),
  ];
  return { lines, exitCode: lines.some((line) => line.startsWith("FAIL")) ? 1 : 0 };
}
