import type { SupabaseClient } from "@supabase/supabase-js";
import type { Storage } from "@edit-issebya/storage";
import { type ErrorCapture, reportFailure } from "./error-tracking";
import {
  type LibraryItem,
  MAX_PHOTO_BYTES,
  PHOTO_COLUMNS,
  type PhotoRow,
  isPhotoId,
  parsePhotoUpload,
  photoKey,
} from "./photos";
import { formatAge } from "./reels";
import { PART_URL_SECONDS, parseParts } from "./upload-server";

// The server side of the photo library. The bytes go from the browser
// straight to storage as a one-part multipart upload (the same storage
// methods as footage), never through here. Every call after the start finds
// the photo through the caller's own Supabase client (RLS: owner-only select)
// and takes its keys and upload id from that row, never from the browser.
// Another owner's photo answers exactly like a missing one.

// Long enough for the reel page to stay open a while; the browser caches it.
const IMAGE_URL_SECONDS = 3600;

export type PhotoError =
  | "signed-out"
  | "unavailable"
  | "name"
  | "empty"
  | "too-large"
  | "type"
  | "not-found"
  | "upload-gone"
  | "failed";

export type PhotoAnswer<T> = { ok: true; value: T } | { ok: false; error: PhotoError };

export interface PhotoDeps {
  supabase: SupabaseClient | null;
  storage: Storage | null;
  // Every handled failure is captured here (a fake in tests).
  errors: ErrorCapture;
}

interface Session {
  supabase: SupabaseClient;
  userId: string;
}

const fail = (error: PhotoError) => ({ ok: false, error }) as const;

async function signedIn(supabase: SupabaseClient | null): Promise<PhotoAnswer<Session>> {
  if (!supabase) return fail("unavailable");
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("signed-out");
  return { ok: true, value: { supabase, userId: user.id } };
}

// The caller's photo; null for a missing one or another owner's (RLS hides it).
async function ownPhoto(
  { supabase, userId }: Session,
  errors: ErrorCapture,
  photoId: string,
): Promise<PhotoAnswer<PhotoRow | null>> {
  const { data, error } = await supabase
    .from("photos")
    .select(PHOTO_COLUMNS)
    .eq("id", photoId)
    .maybeSingle<PhotoRow>();
  if (error) {
    await reportFailure(errors, {
      message: "studio: photo not read",
      error,
      userId,
      properties: { photo_id: photoId },
    });
    return fail("failed");
  }
  return { ok: true, value: data ?? null };
}

// Creates the owner's `uploading` photo and its one-part upload, and signs
// that part. Only the file's name, size and type come here; the owner comes
// from the session (the insert policy).
export async function startPhotoUpload(
  deps: PhotoDeps & { prefix: string | null },
  input: { name?: unknown; size?: unknown; type?: unknown },
): Promise<PhotoAnswer<{ photoId: string; url: string }>> {
  const parsed = parsePhotoUpload(input);
  if (!parsed.ok) return fail(parsed.reason);
  const session = await signedIn(deps.supabase);
  if (!session.ok) return session;
  const { supabase, userId } = session.value;
  if (!deps.storage || deps.prefix === null) return fail("unavailable");

  const photoId = crypto.randomUUID();
  const key = photoKey(deps.prefix, photoId, parsed.value.ext);
  let uploadId: string;
  try {
    ({ uploadId } = await deps.storage.createMultipartUpload(key, {
      contentType: parsed.value.contentType,
    }));
  } catch (error) {
    // The provider's message only, never the key or the file name.
    await reportFailure(deps.errors, {
      message: "studio: photo upload not created",
      error,
      userId,
      log: [(error as Error).message],
    });
    return fail("failed");
  }

  const { error } = await supabase.from("photos").insert({
    id: photoId,
    file_name: parsed.value.name,
    r2_key: key,
    content_type: parsed.value.contentType,
    upload_id: uploadId,
  });
  if (error) {
    // Logged without the file name.
    await reportFailure(deps.errors, {
      message: "studio: photo not created",
      error,
      userId,
      properties: { photo_id: photoId },
    });
    await deps.storage.abortMultipartUpload(key, { uploadId }).catch(() => undefined);
    return fail("failed");
  }

  const url = await deps.storage.signUploadPart(key, {
    uploadId,
    partNumber: 1,
    expiresInSeconds: PART_URL_SECONDS,
  });
  return { ok: true, value: { photoId, url } };
}

// Assembles the one part, then finish_photo_upload: the photo becomes
// `describing` with the size storage reports (never the browser's) and one
// describe_photo job is queued. Idempotent: a repeat for a photo already past
// `uploading` answers the same and queues nothing. An object over the limit
// is deleted with its row.
export async function finishPhotoUpload(
  deps: PhotoDeps,
  input: { photoId: unknown; etag: unknown },
): Promise<PhotoAnswer<{ photoId: string }>> {
  if (!isPhotoId(input.photoId)) return fail("not-found");
  const parts = parseParts([{ PartNumber: 1, ETag: input.etag }]);
  if (!parts) return fail("upload-gone");
  const session = await signedIn(deps.supabase);
  if (!session.ok) return session;
  const { supabase, userId } = session.value;
  const found = await ownPhoto(session.value, deps.errors, input.photoId);
  if (!found.ok) return found;
  const row = found.value;
  if (!row) return fail("not-found");
  if (row.status !== "uploading") return { ok: true, value: { photoId: row.id } };
  if (!deps.storage || !row.upload_id) return fail("unavailable");

  const done = await deps.storage.completeMultipartUpload(row.r2_key, {
    uploadId: row.upload_id,
    parts,
  });
  // "missing": completed by an earlier call whose answer was lost, when the
  // object is there; otherwise the upload is gone.
  const info = await deps.storage.head(row.r2_key);
  if (!info || info.bytes < 1) {
    return fail(done === "missing" ? "upload-gone" : "failed");
  }
  if (info.bytes > MAX_PHOTO_BYTES) {
    await deps.storage.delete(row.r2_key);
    await supabase.rpc("delete_photo", { p_photo_id: row.id });
    return fail("too-large");
  }
  const { error } = await supabase.rpc("finish_photo_upload", {
    p_photo_id: row.id,
    p_bytes: info.bytes,
  });
  if (error) {
    await reportFailure(deps.errors, {
      message: "studio: photo upload not finished",
      error,
      userId,
      properties: { photo_id: row.id },
    });
    return fail("failed");
  }
  return { ok: true, value: { photoId: row.id } };
}

// Deletes the photo's objects (the keys from its row), then the row through
// delete_photo (its jobs, steps and stored-file rows go with it). A storage
// failure leaves the row, so the owner can try again.
export async function deletePhoto(
  deps: PhotoDeps,
  input: { photoId: unknown },
): Promise<PhotoAnswer<{ photoId: string }>> {
  if (!isPhotoId(input.photoId)) return fail("not-found");
  const session = await signedIn(deps.supabase);
  if (!session.ok) return session;
  const { supabase, userId } = session.value;
  const found = await ownPhoto(session.value, deps.errors, input.photoId);
  if (!found.ok) return found;
  const row = found.value;
  if (!row) return fail("not-found");
  if (!deps.storage) return fail("unavailable");

  try {
    if (row.status === "uploading" && row.upload_id) {
      await deps.storage.abortMultipartUpload(row.r2_key, { uploadId: row.upload_id });
    }
    for (const key of [row.r2_key, row.thumbnail_key, row.large_key]) {
      if (key) await deps.storage.delete(key);
    }
  } catch (error) {
    // The error's name only: a storage error's message may hold the key.
    await reportFailure(deps.errors, {
      message: "studio: photo files not deleted",
      userId,
      properties: { photo_id: row.id, error_code: (error as Error).name },
      log: [(error as Error).name],
    });
    return fail("failed");
  }

  const { error } = await supabase.rpc("delete_photo", { p_photo_id: row.id });
  if (error) {
    await reportFailure(deps.errors, {
      message: "studio: photo not deleted",
      error,
      userId,
      properties: { photo_id: row.id },
    });
    return fail("failed");
  }
  return { ok: true, value: { photoId: row.id } };
}

async function signed(
  storage: Storage | null,
  key: string | null,
  userId: string,
  errors: ErrorCapture,
): Promise<string | null> {
  if (!storage || !key) return null;
  try {
    return await storage.signDownload(key, { expiresInSeconds: IMAGE_URL_SECONDS });
  } catch (error) {
    await reportFailure(errors, {
      message: "studio: photo image not signed",
      userId,
      properties: { error_code: (error as Error).name },
      log: [(error as Error).name],
    });
    return null;
  }
}

// The owner's photos, newest first, with the thumbnail and the large copy
// signed here. RLS returns only the owner's rows; no owner filter, so a
// missing policy can never be masked by the query. A failed signing is a
// neutral tile.
export async function loadLibrary(
  deps: PhotoDeps,
  now: number = Date.now(),
): Promise<PhotoAnswer<LibraryItem[]>> {
  const session = await signedIn(deps.supabase);
  if (!session.ok) return session;
  const { supabase, userId } = session.value;
  const { data, error } = await supabase
    .from("photos")
    .select(PHOTO_COLUMNS)
    .order("created_at", { ascending: false })
    .returns<PhotoRow[]>();
  if (error) {
    await reportFailure(deps.errors, { message: "studio: photos not read", error, userId });
    return fail("failed");
  }
  const items = await Promise.all(
    (data ?? []).map(async (row): Promise<LibraryItem> => ({
      id: row.id,
      fileName: row.file_name,
      status: row.status,
      createdAt: row.created_at,
      age: formatAge(row.created_at, now),
      bytes: row.bytes,
      width: row.width,
      height: row.height,
      description: row.description,
      tags: row.tags ?? [],
      thumbnailUrl: await signed(deps.storage, row.thumbnail_key, userId, deps.errors),
      largeUrl: await signed(deps.storage, row.large_key, userId, deps.errors),
    })),
  );
  return { ok: true, value: items };
}
