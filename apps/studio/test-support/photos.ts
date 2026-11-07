import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Storage } from "@edit-issebya/storage";
import type { SupabaseClient } from "@supabase/supabase-js";

// The committed sample photo (1200x900).
export const SAMPLE_PHOTO = fileURLToPath(
  new URL("../../../fixtures/photos/sample.jpg", import.meta.url),
);

export interface SeededPhoto {
  id: string;
  largeKey: string;
  // Every object written, for the spec's cleanup.
  keys: string[];
}

// A ready library photo of `ownerId`, as describe_photo leaves it: its row
// (description, tags, sizes and keys) and fixtures/photos/sample.jpg stored
// as its original, thumbnail and large copy under the run's prefix. `bytes`
// replaces the sample with another 1200x900 JPEG.
export async function seedReadyPhoto({
  admin,
  storage,
  ownerId,
  prefix,
  bytes: given,
}: {
  admin: SupabaseClient;
  storage: Storage;
  ownerId: string;
  prefix: string;
  bytes?: Uint8Array;
}): Promise<SeededPhoto> {
  const id = crypto.randomUUID();
  const key = (name: string) => `${prefix}library/${id}/${name}`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed sample photo
  const bytes = given ?? new Uint8Array(await readFile(SAMPLE_PHOTO));
  const keys = [key("original.jpg"), key("thumbnail.jpg"), key("large.jpg")];
  for (const written of keys) await storage.put(written, bytes, { contentType: "image/jpeg" });
  const { error } = await admin.from("photos").insert({
    id,
    owner_id: ownerId,
    r2_key: key("original.jpg"),
    file_name: "sample.jpg",
    content_type: "image/jpeg",
    bytes: bytes.byteLength,
    width: 1200,
    height: 900,
    status: "ready",
    description: "A colourful test pattern of vertical bars.",
    tags: ["test pattern", "colour bars", "abstract"],
    model: "anthropic/claude-haiku-5.5",
    prompt_version: "photo-describe@v1",
    thumbnail_key: key("thumbnail.jpg"),
    large_key: key("large.jpg"),
  });
  if (error) throw new Error(`photo not seeded: ${error.message}`);
  return { id, largeKey: key("large.jpg"), keys };
}
