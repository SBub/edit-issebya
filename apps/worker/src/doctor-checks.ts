import type { AiRunner } from "./ai.ts";

// Each dependency is built inside its own check, so a missing variable fails
// that line only.
export interface DoctorDeps {
  supabase: () => Promise<void>;
  r2: () => Promise<void>;
  ffmpeg: () => Promise<string>;
  ai: () => AiRunner;
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
    await check("ai structured call", async () => {
      const answer = await deps.ai().runJson("Reply with ok set to true.", AI_SCHEMA);
      if ((answer as { ok?: unknown } | null)?.ok !== true) {
        throw new Error(`unexpected answer ${JSON.stringify(answer)}`);
      }
    }),
  ];
  return { lines, exitCode: lines.some((line) => line.startsWith("FAIL")) ? 1 : 0 };
}
