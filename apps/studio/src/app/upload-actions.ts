"use server";

import { isReelId } from "@/lib/reels";
import { keyPrefix } from "@edit-issebya/storage";
import { studioStorage } from "@/lib/storage";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { parseUploadRequest, sourceKey } from "@/lib/upload";

export type CreateUploadResult =
  | { status: "ready"; reelId: string; url: string; contentType: string }
  | { status: "invalid"; reason: string }
  | { status: "signed-out" }
  | { status: "unavailable" }
  | { status: "failed" };

export type FinishUploadResult =
  { status: "finished"; reelId: string } | { status: "signed-out" } | { status: "failed" };

// How long the browser has to start the PUT.
const UPLOAD_URL_SECONDS = 900;

// Creates the owner's `uploading` reel and a signed URL the browser PUTs the
// file to. Only the file's name, size and type come here: the body goes from
// the browser straight to storage. The owner id is never sent; the insert
// policy takes it from the session.
export async function createUpload(input: {
  name: string;
  bytes: number;
  type: string;
}): Promise<CreateUploadResult> {
  const parsed = parseUploadRequest(input);
  if (!parsed.ok) return { status: "invalid", reason: parsed.reason };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { status: "unavailable" };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "signed-out" };

  const storage = studioStorage();
  const prefix = keyPrefix();
  if (!storage || prefix === null) return { status: "unavailable" };

  const reelId = crypto.randomUUID();
  const key = sourceKey(prefix, reelId, parsed.value.ext);
  const { error } = await supabase
    .from("reels")
    .insert({ id: reelId, source_name: parsed.value.name, source_key: key });
  if (error) {
    // Logged without the file name.
    console.error("studio: reel not created:", error.code, error.message);
    return { status: "failed" };
  }

  const contentType = parsed.value.type || "application/octet-stream";
  try {
    const url = await storage.signUpload(key, {
      contentType,
      expiresInSeconds: UPLOAD_URL_SECONDS,
    });
    return { status: "ready", reelId, url, contentType };
  } catch (signError) {
    console.error("studio: upload not signed:", (signError as Error).message);
    return { status: "failed" };
  }
}

// Finishes the upload through finish_upload, the one narrow path: the reel
// becomes `uploaded` with its size and one `process` job is queued.
export async function finishUpload(input: {
  reelId: string;
  bytes: number;
}): Promise<FinishUploadResult> {
  if (typeof input.reelId !== "string" || !isReelId(input.reelId)) return { status: "failed" };
  if (!Number.isInteger(input.bytes) || input.bytes < 1) return { status: "failed" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { status: "failed" };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "signed-out" };

  const { error } = await supabase.rpc("finish_upload", {
    p_reel_id: input.reelId,
    p_bytes: input.bytes,
  });
  if (error) {
    console.error("studio: upload not finished:", error.code, error.message);
    return { status: "failed" };
  }
  return { status: "finished", reelId: input.reelId };
}
