import type { SupabaseClient } from "@supabase/supabase-js";
import { type Storage, isPartNumber, isUploadId } from "@edit-issebya/storage";
import { parseUploadRequest, sourceKey } from "./upload";

// The server side of the resumable upload. The browser (Uppy's AwsS3 plugin)
// asks to create, sign a part, list, complete or abort; the bytes go from the
// browser straight to storage, never through here. Every call after create
// finds the reel through the caller's own Supabase client (RLS: owner-only
// select) by its upload id, and takes the key from that row, never from the
// browser. Another owner's reel answers exactly like a missing one.

// How long the browser has to start one part's PUT. Each part is signed just
// before it is sent.
export const PART_URL_SECONDS = 900;

export type UploadAnswer<T> =
  { ok: true; value: T } | { ok: false; status: 400 | 401 | 404 | 409 | 500 | 503; error: string };

interface Deps {
  supabase: SupabaseClient | null;
  storage: Storage | null;
}

export interface UploadRow {
  id: string;
  status: string;
  sourceKey: string;
  uploadId: string;
}

const fail = (status: 400 | 401 | 404 | 409 | 500 | 503, error: string) =>
  ({ ok: false, status, error }) as const;

async function signedIn(supabase: SupabaseClient | null): Promise<UploadAnswer<SupabaseClient>> {
  if (!supabase) return fail(503, "unavailable");
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail(401, "signed-out");
  return { ok: true, value: supabase };
}

// The caller's reel for this upload id, whatever its status; null for a
// malformed id, a missing reel or another owner's (RLS hides it).
async function ownUploadReel(
  supabase: SupabaseClient,
  uploadId: unknown,
): Promise<UploadRow | null> {
  if (!isUploadId(uploadId)) return null;
  const { data, error } = await supabase
    .from("reels")
    .select("id, status, source_key, source_upload_id")
    .eq("source_upload_id", uploadId)
    .maybeSingle();
  if (error) {
    console.error("studio: upload reel not read:", error.code, error.message);
    return null;
  }
  if (!data || typeof data.source_key !== "string" || typeof data.source_upload_id !== "string") {
    return null;
  }
  return {
    id: data.id as string,
    status: data.status as string,
    sourceKey: data.source_key,
    uploadId: data.source_upload_id,
  };
}

// Signed in, and the caller's reel for this upload id is still uploading.
async function uploadingReel(
  deps: Deps,
  uploadId: unknown,
): Promise<UploadAnswer<{ supabase: SupabaseClient; storage: Storage; row: UploadRow }>> {
  if (!isUploadId(uploadId)) return fail(400, "bad-upload-id");
  const session = await signedIn(deps.supabase);
  if (!session.ok) return session;
  const row = await ownUploadReel(session.value, uploadId);
  if (!row || row.status !== "uploading") return fail(404, "not-found");
  if (!deps.storage) return fail(503, "unavailable");
  return { ok: true, value: { supabase: session.value, storage: deps.storage, row } };
}

// Creates the owner's `uploading` reel and its multipart upload. Only the
// file's name, size and type come here; the owner id is never sent (the insert
// policy takes it from the session). The answer is the key and upload id the
// browser sends its parts under.
export async function createUpload(
  deps: Deps & { prefix: string | null },
  input: { name?: unknown; bytes?: unknown; type?: unknown },
): Promise<UploadAnswer<{ reelId: string; key: string; uploadId: string }>> {
  const parsed = parseUploadRequest(input);
  if (!parsed.ok) return fail(400, parsed.reason);
  const session = await signedIn(deps.supabase);
  if (!session.ok) return session;
  const supabase = session.value;
  if (!deps.storage || deps.prefix === null) return fail(503, "unavailable");

  const reelId = crypto.randomUUID();
  const key = sourceKey(deps.prefix, reelId, parsed.value.ext);
  let uploadId: string;
  try {
    ({ uploadId } = await deps.storage.createMultipartUpload(key, {
      contentType: parsed.value.type || "application/octet-stream",
    }));
  } catch (error) {
    console.error("studio: multipart upload not created:", (error as Error).message);
    return fail(500, "failed");
  }

  const { error } = await supabase.from("reels").insert({
    id: reelId,
    source_name: parsed.value.name,
    source_key: key,
    source_upload_id: uploadId,
  });
  if (error) {
    // Logged without the file name.
    console.error("studio: reel not created:", error.code, error.message);
    await deps.storage.abortMultipartUpload(key, { uploadId }).catch(() => undefined);
    return fail(500, "failed");
  }
  return { ok: true, value: { reelId, key, uploadId } };
}

export async function signPart(
  deps: Deps,
  input: { uploadId: unknown; partNumber: unknown },
): Promise<UploadAnswer<{ url: string }>> {
  // From the path: digits only, 1 to 10000.
  const raw = input.partNumber;
  const partNumber = typeof raw === "string" && /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!isPartNumber(partNumber)) return fail(400, "bad-part-number");
  const found = await uploadingReel(deps, input.uploadId);
  if (!found.ok) return found;
  const { storage, row } = found.value;
  const url = await storage.signUploadPart(row.sourceKey, {
    uploadId: row.uploadId,
    partNumber,
    expiresInSeconds: PART_URL_SECONDS,
  });
  return { ok: true, value: { url } };
}

// The parts storage already holds, so a resumed upload sends only the rest.
export async function listParts(
  deps: Deps,
  input: { uploadId: unknown },
): Promise<UploadAnswer<{ PartNumber: number; ETag: string; Size: number }[]>> {
  const found = await uploadingReel(deps, input.uploadId);
  if (!found.ok) return found;
  const { storage, row } = found.value;
  const parts = await storage.listUploadParts(row.sourceKey, { uploadId: row.uploadId });
  return {
    ok: true,
    value: (parts ?? []).map((part) => ({
      PartNumber: part.partNumber,
      ETag: part.etag,
      Size: part.bytes,
    })),
  };
}

const ETAG = /^"?[A-Za-z0-9-]{1,128}"?$/;

// The completed parts, sorted, or null when any is malformed or repeated.
export function parseParts(value: unknown): { partNumber: number; etag: string }[] | null {
  if (!Array.isArray(value) || value.length < 1) return null;
  const parts: { partNumber: number; etag: string }[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "object" || item === null) return null;
    const { PartNumber, ETag } = item as { PartNumber?: unknown; ETag?: unknown };
    if (!isPartNumber(PartNumber) || typeof ETag !== "string" || !ETAG.test(ETag)) return null;
    parts.push({ partNumber: PartNumber, etag: ETag.replace(/^"(.*)"$/, "$1") });
  }
  parts.sort((a, b) => a.partNumber - b.partNumber);
  for (let i = 1; i < parts.length; i += 1) {
    if (parts[i]!.partNumber === parts[i - 1]!.partNumber) return null;
  }
  return parts;
}

// Assembles the object, then finish_upload: the reel becomes `uploaded` with
// the size storage reports (never the browser's), and one process job is
// queued. Idempotent: a repeated call for an already finished reel answers the
// same, and queues nothing.
export async function completeUpload(
  deps: Deps,
  input: { uploadId: unknown; parts: unknown },
): Promise<UploadAnswer<{ reelId: string; key: string }>> {
  if (!isUploadId(input.uploadId)) return fail(400, "bad-upload-id");
  const parts = parseParts(input.parts);
  if (!parts) return fail(400, "bad-parts");
  const session = await signedIn(deps.supabase);
  if (!session.ok) return session;
  const supabase = session.value;
  const row = await ownUploadReel(supabase, input.uploadId);
  if (!row || row.status === "failed") return fail(404, "not-found");
  if (!deps.storage) return fail(503, "unavailable");

  if (row.status === "uploading") {
    const done = await deps.storage.completeMultipartUpload(row.sourceKey, {
      uploadId: row.uploadId,
      parts,
    });
    // "missing": completed by an earlier call whose answer was lost, when the
    // object is there; otherwise the upload is gone.
    if (done === "missing" && !(await deps.storage.head(row.sourceKey))) {
      return fail(409, "upload-gone");
    }
  }
  const info = await deps.storage.head(row.sourceKey);
  if (!info || info.bytes < 1) return fail(409, "upload-gone");
  const { error } = await supabase.rpc("finish_upload", {
    p_reel_id: row.id,
    p_bytes: info.bytes,
  });
  if (error) {
    console.error("studio: upload not finished:", error.code, error.message);
    return fail(500, "failed");
  }
  return { ok: true, value: { reelId: row.id, key: row.sourceKey } };
}

// A cancelled upload: storage drops the parts and the reel becomes `failed`.
export async function abortUpload(
  deps: Deps,
  input: { uploadId: unknown },
): Promise<UploadAnswer<{ reelId: string }>> {
  const found = await uploadingReel(deps, input.uploadId);
  if (!found.ok) return found;
  const { supabase, storage, row } = found.value;
  await storage.abortMultipartUpload(row.sourceKey, { uploadId: row.uploadId });
  const { error } = await supabase.rpc("fail_upload", { p_reel_id: row.id });
  if (error) {
    console.error("studio: upload not failed:", error.code, error.message);
    return fail(500, "failed");
  }
  return { ok: true, value: { reelId: row.id } };
}
