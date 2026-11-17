import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseFailure } from "../failure.ts";

export interface PhotoRow {
  r2_key: string;
  content_type: string;
  status: string;
}

export interface ReadyPhoto {
  description: string;
  tags: string[];
  model: string | null;
  promptVersion: string;
  width: number;
  height: number;
  thumbnailKey: string;
  largeKey: string;
}

// The `photos` row a `describe_photo` job reads and writes (service role).
export interface PhotoStore {
  // Null when the photo is gone (its owner deleted it).
  read(photoId: string): Promise<PhotoRow | null>;
  // Only a `describing` row becomes `ready`; no row matched throws (the photo
  // was deleted meanwhile, or is no longer describing).
  ready(photoId: string, photo: ReadyPhoto): Promise<void>;
}

export function supabasePhotoStore(db: SupabaseClient): PhotoStore {
  return {
    async read(photoId) {
      const { data, error, status } = await db
        .from("photos")
        .select("r2_key, content_type, status")
        .eq("id", photoId)
        .maybeSingle();
      if (error) throw supabaseFailure("photo not read", { error, status });
      return (data as PhotoRow | null) ?? null;
    },
    async ready(photoId, photo) {
      const { data, error, status } = await db
        .from("photos")
        .update({
          status: "ready",
          description: photo.description,
          tags: photo.tags,
          model: photo.model,
          prompt_version: photo.promptVersion,
          width: photo.width,
          height: photo.height,
          thumbnail_key: photo.thumbnailKey,
          large_key: photo.largeKey,
        })
        .eq("id", photoId)
        .eq("status", "describing")
        .select("id");
      if (error) throw supabaseFailure("photo not written ready", { error, status });
      if ((data ?? []).length !== 1) throw new Error(`photo ${photoId} is gone or not describing`);
    },
  };
}

// A library photo as a version may use it: what the owner's edit records of it
// (its description and tags, quoted as data), where the render finds its
// large copy, and its size, the card's aspect ratio.
export interface LibraryPhoto {
  id: string;
  description: string | null;
  tags: string[];
  large_key: string;
  width: number;
  height: number;
}

// The owner's library photos by id (service role, so filtered by owner here):
// only the ready ones with a large copy and a size come back, so a photo that
// is gone, another owner's, not ready or not sized is simply missing.
export interface PhotoLibrary {
  readyPhotos(ownerId: string, ids: readonly string[]): Promise<Map<string, LibraryPhoto>>;
}

export function supabasePhotoLibrary(db: SupabaseClient): PhotoLibrary {
  return {
    async readyPhotos(ownerId, ids) {
      if (ids.length === 0) return new Map();
      const { data, error, status } = await db
        .from("photos")
        .select("id, description, tags, large_key, width, height")
        .eq("owner_id", ownerId)
        .eq("status", "ready")
        .in("id", [...ids]);
      if (error) throw supabaseFailure("library photos not read", { error, status });
      const rows = (data ?? []) as {
        id: string;
        description: string | null;
        tags: string[] | null;
        large_key: string | null;
        width: number | null;
        height: number | null;
      }[];
      const photos = new Map<string, LibraryPhoto>();
      for (const row of rows) {
        if (!row.large_key || !row.width || !row.height) continue;
        photos.set(row.id, {
          id: row.id,
          description: row.description,
          tags: row.tags ?? [],
          large_key: row.large_key,
          width: row.width,
          height: row.height,
        });
      }
      return photos;
    },
  };
}
