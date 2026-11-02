import { fileURLToPath } from "node:url";
import { HYPERFRAMES_VERSION } from "./tools.ts";

// The person mask the head tracker reads: HyperFrames' background removal, run
// by head_track on its own sampled frames only, never stored. The model is not
// a flag: HyperFrames' default (`u2net_human_seg` in 0.8.222) is pinned by the
// HyperFrames version, which is why that version is a setting. Faster methods
// and a stored cut-out on demand are issue #20, not here.
export const PERSON_MASK_SETTINGS = {
  device: "auto",
  quality: "balanced",
  hyperframes: HYPERFRAMES_VERSION,
};

export type PersonMaskSettings = typeof PERSON_MASK_SETTINGS;

// The worker's own entry around HyperFrames' `removeBackground` (it prints
// the frame progress the pinned CLI keeps to itself unattended), run by the
// same Node as HyperFrames' CLI.
export const PERSON_MASK_ENTRY = fileURLToPath(
  new URL("./remove-background-entry.ts", import.meta.url),
);

// The entry's arguments: the CLI's `remove-background` options, the same
// values, without the command name and `--json` (the entry always ends with
// the JSON result).
export function personMaskArgs(
  input: string,
  output: string,
  settings: PersonMaskSettings,
): string[] {
  return [input, "-o", output, "--device", settings.device, "--quality", settings.quality];
}

// The last non-empty stdout line is the JSON result (the CLI's `--json`
// document, printed by the entry).
export function parsePersonMaskResult(stdout: string): {
  framesProcessed: number;
  provider: string;
} {
  const line = stdout
    .split("\n")
    .map((text) => text.trim())
    .filter(Boolean)
    .at(-1);
  let result: unknown;
  try {
    result = JSON.parse(line ?? "");
  } catch {
    throw new Error(
      `head_track: person mask: no JSON result in HyperFrames' output: ${line ?? ""}`,
    );
  }
  const { ok, framesProcessed, provider } = (result ?? {}) as {
    ok?: unknown;
    framesProcessed?: unknown;
    provider?: unknown;
  };
  if (ok !== true || typeof framesProcessed !== "number" || !(framesProcessed > 0)) {
    throw new Error(`head_track: person mask: HyperFrames did not succeed: ${line}`);
  }
  return { framesProcessed, provider: typeof provider === "string" ? provider : "unknown" };
}
