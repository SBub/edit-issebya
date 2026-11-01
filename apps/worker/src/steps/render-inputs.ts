import type { Edit } from "@edit-issebya/edit";
import { type Storage, cacheKey } from "@edit-issebya/storage";

export interface RenderInputKeys {
  // The retimed footage and the cut-out, full size.
  footage: string;
  cutout: string;
}

export interface EnsureRenderInputs {
  storage: Pick<Storage, "head">;
  keyPrefix: string;
  // The version's inputs: the fingerprints its edit was made from.
  inputs: Edit["inputs"];
  // Runs the fixed steps that make both files (never moving the reel's
  // status) and returns every step's fingerprint.
  rebuild: () => Promise<{ fingerprints: Record<string, string> }>;
  signal: AbortSignal;
}

// The render's two media inputs are `rebuildable` (slice 14 may delete them):
// both stored, nothing runs; either missing, the fixed steps rebuild them
// first, and they must come back under the very fingerprints the version was
// made from, else another footage would be rendered.
export async function ensureRenderInputs({
  storage,
  keyPrefix,
  inputs,
  rebuild,
  signal,
}: EnsureRenderInputs): Promise<RenderInputKeys> {
  const keys: RenderInputKeys = {
    footage: cacheKey(keyPrefix, "retime", inputs.footage, "source.mp4"),
    cutout: cacheKey(keyPrefix, "remove_background", inputs.cutout, "subject.webm"),
  };
  const missing = async () => {
    const heads = await Promise.all(
      [keys.footage, keys.cutout].map(async (key) => ({
        key,
        head: await storage.head(key, { signal }),
      })),
    );
    signal.throwIfAborted();
    return heads.filter(({ head }) => head === null).map(({ key }) => key);
  };

  if ((await missing()).length === 0) return keys;

  const { fingerprints } = await rebuild();
  signal.throwIfAborted();
  if (fingerprints.retime !== inputs.footage || fingerprints.remove_background !== inputs.cutout) {
    throw new Error(
      "render: the inputs of this version cannot be rebuilt (a step changed since it was made)",
    );
  }
  const still = await missing();
  if (still.length > 0) throw new Error(`render: input missing: ${still[0]}`);
  return keys;
}
