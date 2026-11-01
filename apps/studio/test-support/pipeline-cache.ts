import { readFile, stat } from "node:fs/promises";
import type { Storage } from "@edit-issebya/storage";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runWorkerOnce } from "./worker.ts";

const CLIP = new URL("../../../fixtures/footage/short-speech.mp4", import.meta.url);
// Every step's outputs for the clip, under their fingerprints
// (`yarn workspace @edit-issebya/worker fixtures:pipeline`).
const PIPELINE_FIXTURES = new URL("../../../fixtures/pipeline/", import.meta.url);

export interface PipelineManifest {
  steps: { name: string; fingerprint: string; files: string[] }[];
}

export async function pipelineManifest(): Promise<PipelineManifest> {
  return JSON.parse(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
    await readFile(new URL("manifest.json", PIPELINE_FIXTURES), "utf8"),
  ) as PipelineManifest;
}

// Stores every committed step output at `<prefix>cache/<step>/<fingerprint>/<file>`,
// so the worker finds each step's outputs and spawns no tool. Returns the keys
// written, for the spec's cleanup.
export async function seedPipelineCache(storage: Storage, prefix: string): Promise<string[]> {
  const manifest = await pipelineManifest();
  const keys: string[] = [];
  for (const step of manifest.steps) {
    for (const file of step.files) {
      const key = `${prefix}cache/${step.name}/${step.fingerprint}/${file}`;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
      const body = await readFile(new URL(`${step.name}/${file}`, PIPELINE_FIXTURES));
      await storage.put(key, new Uint8Array(body));
      keys.push(key);
    }
  }
  return keys;
}

export interface ProcessedReel {
  reelId: string;
  versionId: string;
  versionKey: string;
  sourceKey: string;
  // Every key written, the version's included.
  keys: string[];
}

// A reel as the pipeline leaves it: the fixture clip uploaded under the
// prefix, the reel and its queued job inserted as the service role, the cache
// seeded and the worker's `once` run (every step a hit, then version 1).
export async function seedProcessedReel({
  admin,
  storage,
  ownerId,
  prefix,
}: {
  admin: SupabaseClient;
  storage: Storage;
  ownerId: string;
  prefix: string;
}): Promise<ProcessedReel> {
  const reelId = crypto.randomUUID();
  const sourceKey = `${prefix}reels/${reelId}/source/original.mp4`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture clip
  const clip = await readFile(CLIP);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture clip
  const bytes = (await stat(CLIP)).size;
  await storage.put(sourceKey, new Uint8Array(clip));
  const keys = [sourceKey];

  const reel = await admin.from("reels").insert({
    id: reelId,
    owner_id: ownerId,
    status: "uploaded",
    source_key: sourceKey,
    source_bytes: bytes,
    source_name: "short-speech.mp4",
  });
  if (reel.error) throw new Error(`reel not inserted: ${reel.error.message}`);
  const job = await admin
    .from("jobs")
    .insert({ reel_id: reelId, owner_id: ownerId, kind: "process", status: "queued" });
  if (job.error) throw new Error(`job not inserted: ${job.error.message}`);

  keys.push(...(await seedPipelineCache(storage, prefix)));
  const worker = await runWorkerOnce({ R2_KEY_PREFIX: prefix });
  if (worker.code !== 0) throw new Error(`worker once failed (${worker.code}):\n${worker.output}`);

  const { data, error } = await admin
    .from("reels")
    .select("current_version_id, preview_copies")
    .eq("id", reelId)
    .single();
  if (error || !data) throw new Error(`reel not read: ${error?.message}`);
  const versionId = data.current_version_id as string | null;
  if (!versionId || !data.preview_copies) {
    throw new Error(`reel ${reelId} has no version or no preview copies after the worker`);
  }
  const versionKey = `${prefix}reels/${reelId}/versions/${versionId}.json`;
  keys.push(versionKey);
  return { reelId, versionId, versionKey, sourceKey, keys };
}
