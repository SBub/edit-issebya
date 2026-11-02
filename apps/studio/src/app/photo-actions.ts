"use server";

import { keyPrefix } from "@edit-issebya/storage";
import { serverErrorCapture } from "@/lib/error-tracking";
import * as photos from "@/lib/photo-server";
import type { LibraryItem } from "@/lib/photos";
import { studioStorage } from "@/lib/storage";
import { createSupabaseServerClient } from "@/lib/supabase-server";

// The photo library's server actions: thin wrappers over lib/photo-server,
// each building its own Supabase client and storage per call (never at module
// load). Only JSON crosses here: the file's bytes go from the browser
// straight to storage. Answers carry no storage key.

async function deps(): Promise<photos.PhotoDeps> {
  return {
    supabase: await createSupabaseServerClient(),
    storage: studioStorage(),
    errors: serverErrorCapture(),
  };
}

export async function startPhotoUpload(input: {
  name: string;
  size: number;
  type: string;
}): Promise<photos.PhotoAnswer<{ photoId: string; url: string }>> {
  // Untrusted: anyone can post to an action, so the shape is checked again.
  const safe: { name?: unknown; size?: unknown; type?: unknown } =
    typeof input === "object" && input !== null ? input : {};
  return photos.startPhotoUpload(
    { ...(await deps()), prefix: keyPrefix() },
    { name: safe.name, size: safe.size, type: safe.type },
  );
}

export async function finishPhotoUpload(
  photoId: string,
  etag: string,
): Promise<photos.PhotoAnswer<{ photoId: string }>> {
  return photos.finishPhotoUpload(await deps(), { photoId, etag });
}

export async function deletePhoto(
  photoId: string,
): Promise<photos.PhotoAnswer<{ photoId: string }>> {
  return photos.deletePhoto(await deps(), { photoId });
}

export async function loadLibrary(): Promise<photos.PhotoAnswer<LibraryItem[]>> {
  return photos.loadLibrary(await deps());
}
