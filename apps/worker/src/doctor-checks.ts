import type { AiRunner } from "./ai.ts";

// Each dependency is built inside its own check, so a missing variable fails
// that line only.
export interface DoctorDeps {
  supabase: () => Promise<void>;
  r2: () => Promise<void>;
  ffmpeg: () => Promise<string>;
  // `ffmpeg -hide_banner -filters` output.
  ffmpegFilters: () => Promise<string>;
  // `ffmpeg -hide_banner -codecs` output.
  ffmpegCodecs: () => Promise<string>;
  // `hyperframes --version` output.
  hyperframes: () => Promise<string>;
  ai: () => AiRunner;
}

// The filters the fixed steps use: HDR tone-mapping, retime tempo, the envelope.
const PIPELINE_FILTERS = ["zscale", "tonemap", "atempo", "astats", "ametadata"];

// Filter names from `ffmpeg -filters` (lines like ` ... zscale  V->V  Apply ...`).
function filterNames(listing: string): Set<string> {
  const names = new Set<string>();
  for (const line of listing.split("\n")) {
    const name = line.trim().split(/\s+/)[1];
    if (name) names.add(name);
  }
  return names;
}

// The cut-out is VP9 with alpha: only libvpx-vp9 decodes and encodes alpha.
// Checks the `vp9` line's `(decoders: ...)` and `(encoders: ...)` parts.
function vp9Missing(listing: string): string[] {
  const line = listing.split("\n").find((text) => text.trim().split(/\s+/)[1] === "vp9") ?? "";
  const missing: string[] = [];
  if (!/\(decoders:[^)]*\blibvpx-vp9\b/.test(line)) missing.push("libvpx-vp9 decoder");
  if (!/\(encoders:[^)]*\blibvpx-vp9\b/.test(line)) missing.push("libvpx-vp9 encoder");
  return missing;
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
      const names = filterNames(await deps.ffmpegFilters());
      const missing = PIPELINE_FILTERS.filter((name) => !names.has(name));
      if (missing.length > 0) throw new Error(`missing ${missing.join(", ")}`);
      return PIPELINE_FILTERS.join(", ");
    }),
    await check("ffmpeg vp9", async () => {
      const missing = vp9Missing(await deps.ffmpegCodecs());
      if (missing.length > 0) throw new Error(`missing ${missing.join(", ")}`);
      return "libvpx-vp9 decoder and encoder";
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
