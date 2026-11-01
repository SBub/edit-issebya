import { type Storage, isUploadId } from "@edit-issebya/storage";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isReelId } from "./reels";
import { contentTypeOf, parseSignRequest, parseUploadRequest, sourceKey } from "./upload";

// The upload's server side, without Next: each function takes the signed-in
// user's Supabase client (RLS scopes every read to their own reels) and the
// storage, so the server actions stay thin and the DB tests drive these
// directly. Errors are logged with their code and message, never the file name.

export type CreateUploadResult =
  | { status: "ready"; reelId: string; key: string }
  | { status: "invalid"; reason: string }
  | { status: "failed" };

export type SignUploadResult =
  | { status: "signed"; url: string; headers?: Record<string, string> }
  | { status: "refused" }
  | { status: "failed" };

export type FinishUploadResult =
  | { status: "finished"; reelId: string; jobId: string }
  | { status: "incomplete" }
  | { status: "refused" }
  | { status: "failed" };

export type AbortUploadResult =
  { status: "aborted" } | { status: "refused" } | { status: "failed" };

// How long the browser has to send one signed request.
const UPLOAD_URL_SECONDS = 900;

// The caller's own uploading reel holding this key, through RLS.
async function uploadingReelByKey(
  supabase: SupabaseClient,
  key: string,
): Promise<{ id: string; source_key: string } | null> {
  const { data, error } = await supabase
    .from("reels")
    .select("id, source_key")
    .eq("source_key", key)
    .eq("status", "uploading")
    .maybeSingle<{ id: string; source_key: string }>();
  if (error) {
    console.error("studio: reel not read:", error.code, error.message);
    return null;
  }
  return data;
}

async function reelById(
  supabase: SupabaseClient,
  reelId: unknown,
): Promise<{ id: string; status: string; source_key: string | null } | null> {
  if (typeof reelId !== "string" || !isReelId(reelId)) return null;
  const { data, error } = await supabase
    .from("reels")
    .select("id, status, source_key")
    .eq("id", reelId)
    .maybeSingle<{ id: string; status: string; source_key: string | null }>();
  if (error) {
    console.error("studio: reel not read:", error.code, error.message);
    return null;
  }
  return data;
}

// Creates the owner's `uploading` reel and its key. Only the file's name, size
// and type come here; the owner id is never sent, the insert policy takes it
// from the session.
export async function createUploadFor(
  supabase: SupabaseClient,
  prefix: string,
  input: { name?: unknown; bytes?: unknown; type?: unknown },
): Promise<CreateUploadResult> {
  const parsed = parseUploadRequest(input);
  if (!parsed.ok) return { status: "invalid", reason: parsed.reason };

  const reelId = crypto.randomUUID();
  const key = sourceKey(prefix, reelId, parsed.value.ext);
  const { error } = await supabase
    .from("reels")
    .insert({ id: reelId, source_name: parsed.value.name, source_key: key });
  if (error) {
    console.error("studio: reel not created:", error.code, error.message);
    return { status: "failed" };
  }
  return { status: "ready", reelId, key };
}

// Signs one multipart request for the browser, only for a key that is the
// caller's own uploading reel's. R2 binds an upload id to its key, so another
// owner's upload id is useless with this key.
export async function signUploadRequestFor(
  supabase: SupabaseClient,
  storage: Storage,
  input: unknown,
): Promise<SignUploadResult> {
  const parsed = parseSignRequest(input);
  if (!parsed.ok) return { status: "refused" };
  const request = parsed.value;
  if (!(await uploadingReelByKey(supabase, request.key))) return { status: "refused" };

  const expiresInSeconds = UPLOAD_URL_SECONDS;
  try {
    switch (request.kind) {
      case "create": {
        const { url, headers } = await storage.signCreateMultipart(request.key, {
          contentType: contentTypeOf(request.key),
          expiresInSeconds,
        });
        return { status: "signed", url, headers };
      }
      case "part":
        return {
          status: "signed",
          url: await storage.signUploadPart(request.key, {
            uploadId: request.uploadId,
            partNumber: request.partNumber,
            expiresInSeconds,
          }),
        };
      case "list":
        return {
          status: "signed",
          url: await storage.signListParts(request.key, {
            uploadId: request.uploadId,
            expiresInSeconds,
          }),
        };
      case "complete":
        return {
          status: "signed",
          url: await storage.signCompleteMultipart(request.key, {
            uploadId: request.uploadId,
            expiresInSeconds,
          }),
        };
    }
  } catch (signError) {
    console.error("studio: upload request not signed:", (signError as Error).message);
    return { status: "failed" };
  }
}

// Finishes the upload once storage holds the whole object: its size comes from
// storage, never from the browser, and finish_upload (idempotent) moves the
// reel to uploaded and queues its one process job.
export async function finishUploadFor(
  supabase: SupabaseClient,
  storage: Storage,
  reelId: unknown,
): Promise<FinishUploadResult> {
  const reel = await reelById(supabase, reelId);
  if (!reel?.source_key) return { status: "refused" };

  let head: { bytes: number } | null;
  try {
    head = await storage.head(reel.source_key);
  } catch (headError) {
    console.error("studio: upload not checked:", (headError as Error).message);
    return { status: "failed" };
  }
  if (!head || head.bytes < 1) return { status: "incomplete" };

  const { data, error } = await supabase.rpc("finish_upload", {
    p_reel_id: reel.id,
    p_bytes: head.bytes,
  });
  if (error || typeof data !== "string") {
    console.error("studio: upload not finished:", error?.code, error?.message);
    return { status: "failed" };
  }
  return { status: "finished", reelId: reel.id, jobId: data };
}

// Cancels the owner's upload: the multipart upload is aborted in storage from
// the server, then abort_upload marks the reel failed.
export async function abortUploadFor(
  supabase: SupabaseClient,
  storage: Storage,
  input: { reelId?: unknown; uploadId?: unknown },
): Promise<AbortUploadResult> {
  const reel = await reelById(supabase, input.reelId);
  if (!reel?.source_key) return { status: "refused" };

  if (reel.status === "uploading" && isUploadId(input.uploadId)) {
    try {
      await storage.abortMultipart(reel.source_key, input.uploadId);
    } catch (abortError) {
      console.error("studio: multipart upload not aborted:", (abortError as Error).message);
    }
  }

  const { error } = await supabase.rpc("abort_upload", { p_reel_id: reel.id });
  if (error) {
    console.error("studio: upload not aborted:", error.code, error.message);
    return { status: "failed" };
  }
  return { status: "aborted" };
}
