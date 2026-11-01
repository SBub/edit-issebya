import { readFile } from "node:fs/promises";
import { type Edit, type VersionRow, saveVersion, supabaseVersionStore } from "@edit-issebya/edit";
import { type Storage, cacheKey } from "@edit-issebya/storage";
import type { SupabaseClient } from "@supabase/supabase-js";

// Every step's outputs for the fixture clip, under their fingerprints
// (`yarn workspace @edit-issebya/worker fixtures:pipeline`).
export const PIPELINE_FIXTURES = new URL("../../../fixtures/pipeline/", import.meta.url);

interface PipelineManifest {
  steps: { name: string; fingerprint: string; files: string[] }[];
}

export async function readManifest(): Promise<PipelineManifest> {
  return JSON.parse(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
    await readFile(new URL("manifest.json", PIPELINE_FIXTURES), "utf8"),
  ) as PipelineManifest;
}

// Stores every committed step output at `<prefix>cache/<step>/<fingerprint>/<file>`,
// so the worker finds each step's outputs and spawns no tool. Returns the
// keys it wrote, for the spec to delete.
export async function seedPipelineCache(storage: Storage, prefix: string): Promise<string[]> {
  const manifest = await readManifest();
  const keys: string[] = [];
  for (const step of manifest.steps) {
    for (const file of step.files) {
      const key = cacheKey(prefix, step.name, step.fingerprint, file);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
      const body = await readFile(new URL(`${step.name}/${file}`, PIPELINE_FIXTURES));
      await storage.put(key, new Uint8Array(body));
      keys.push(key);
    }
  }
  return keys;
}

// Saves a further version of the reel, parented on its current one, the way
// the worker does (secret key, test helpers only); the reel's current version
// moves to it.
export function saveNextVersion(
  admin: SupabaseClient,
  storage: Storage,
  { prefix, reelId, edit }: { prefix: string; reelId: string; edit: Edit },
): Promise<VersionRow> {
  return saveVersion({
    objects: storage,
    store: supabaseVersionStore(admin),
    prefix,
    reelId,
    id: crypto.randomUUID(),
    edit,
    meta: {
      request: null,
      model: null,
      promptVersion: null,
      changeSummary: "e2e: next version",
      checks: { ok: true, reasons: [] },
    },
  });
}
