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

// A ready library photo as a version may use it: what the decide step shows
// the AI (id, description, tags, quoted as data) and where the render finds
// its large copy.
export interface LibraryPhoto {
  id: string;
  description: string;
  tags: string[];
  large_key: string;
}

// The owner's ready photos (service role, so filtered by owner here).
export interface PhotoLibrary {
  readyPhotos(ownerId: string): Promise<LibraryPhoto[]>;
}

export function supabasePhotoLibrary(db: SupabaseClient): PhotoLibrary {
  return {
    async readyPhotos(ownerId) {
      const { data, error, status } = await db
        .from("photos")
        .select("id, description, tags, large_key")
        .eq("owner_id", ownerId)
        .eq("status", "ready")
        .order("created_at", { ascending: true });
      if (error) throw supabaseFailure("library photos not read", { error, status });
      return ((data ?? []) as LibraryPhoto[]).filter(
        (photo) => typeof photo.large_key === "string" && photo.large_key.length > 0,
      );
    },
  };
}
