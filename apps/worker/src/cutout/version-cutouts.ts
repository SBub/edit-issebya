import {
  type Edit,
  ISSEBYA_PRESET,
  type StoredVersion,
  type Transcript,
  parseEdit,
  transcriptSchema,
} from "@edit-issebya/edit";
import type { Storage } from "@edit-issebya/storage";
import { cacheKey } from "../pipeline/fingerprint.ts";
import type { ToolPaths } from "../pipeline/tools.ts";
import type { SpawnTool, StepContext } from "../step-runner.ts";
import { ensureCutouts } from "./ensure-cutouts.ts";

// What making a stored version's masks needs beyond the step context.
export interface CutoutDeps {
  storage: Storage;
  keyPrefix: string;
  scratchDir: string;
  tools: ToolPaths;
  spawnTool?: SpawnTool;
  env?: NodeJS.ProcessEnv;
  recordStored?: (key: string, bytes: number) => Promise<void>;
}

async function readJson(storage: Storage, key: string, what: string): Promise<unknown> {
  const bytes = await storage.get(key);
  if (!bytes) throw new Error(`cutout: ${what} missing: ${key}`);
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

// A stored version's edit and transcript, read from storage.
async function readVersionEdit(
  storage: Storage,
  keyPrefix: string,
  version: Pick<StoredVersion, "r2_key" | "inputs">,
): Promise<{ edit: Edit; transcript: Transcript }> {
  const ref = version.inputs.transcript;
  const transcript = transcriptSchema.parse(
    await readJson(storage, cacheKey(keyPrefix, ref.step, ref.fingerprint, ref.file), "input"),
  );
  const parsed = parseEdit(
    await readJson(storage, version.r2_key, "edit"),
    ISSEBYA_PRESET,
    transcript,
  );
  if (!parsed.ok) throw new Error(`cutout: stored edit refused: ${parsed.reasons.join("; ")}`);
  return { edit: parsed.edit, transcript };
}

// Makes sure a stored version's masks exist (a slimmed one is rebuilt; all
// stored is a hit; no behind items, nothing at all), before it is restored or
// rendered. Its photos are not checked here.
export async function ensureVersionCutouts(
  ctx: StepContext,
  deps: CutoutDeps,
  version: Pick<StoredVersion, "r2_key" | "inputs">,
): Promise<void> {
  const { edit, transcript } = await readVersionEdit(deps.storage, deps.keyPrefix, version);
  if ((edit.tracks.behind ?? []).length === 0) return;
  await ensureCutouts({ ctx, ...deps, edit, transcript });
}
