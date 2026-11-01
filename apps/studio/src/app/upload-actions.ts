"use server";

import type { Storage } from "@edit-issebya/storage";
import type { SupabaseClient } from "@supabase/supabase-js";
import { keyPrefix, studioStorage } from "@/lib/storage";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import {
  type AbortUploadResult,
  type CreateUploadResult,
  type FinishUploadResult,
  type SignUploadResult,
  abortUploadFor,
  createUploadFor,
  finishUploadFor,
  signUploadRequestFor,
} from "@/lib/upload-service";

type Unavailable = { status: "signed-out" } | { status: "unavailable" };

// Every action is a public endpoint: each one checks the session itself and
// hands the user's client (RLS) to the upload service. File bytes never come
// here; the browser sends them straight to storage.
async function session(): Promise<
  Unavailable | { supabase: SupabaseClient; storage: Storage; prefix: string }
> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { status: "unavailable" };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "signed-out" };
  const storage = studioStorage();
  const prefix = keyPrefix();
  if (!storage || prefix === null) return { status: "unavailable" };
  return { supabase, storage, prefix };
}

// Creates the owner's `uploading` reel and returns its storage key.
export async function createUpload(input: {
  name: string;
  bytes: number;
  type: string;
}): Promise<CreateUploadResult | Unavailable> {
  const s = await session();
  if ("status" in s) return s;
  return createUploadFor(s.supabase, s.prefix, input ?? {});
}

// Signs one S3 multipart request (create, part, list or complete) for the
// caller's own uploading reel.
export async function signUploadRequest(request: {
  method: string;
  key: string;
  uploadId?: string;
  partNumber?: number;
}): Promise<SignUploadResult | Unavailable> {
  const s = await session();
  if ("status" in s) return s;
  return signUploadRequestFor(s.supabase, s.storage, request);
}

// Marks the reel uploaded once storage holds the whole object; safe to repeat.
export async function finishUpload(input: {
  reelId: string;
}): Promise<FinishUploadResult | Unavailable> {
  const s = await session();
  if ("status" in s) return s;
  return finishUploadFor(s.supabase, s.storage, input?.reelId);
}

// Aborts the multipart upload in storage and marks the reel failed.
export async function abortUpload(input: {
  reelId: string;
  uploadId?: string;
}): Promise<AbortUploadResult | Unavailable> {
  const s = await session();
  if ("status" in s) return s;
  return abortUploadFor(s.supabase, s.storage, input ?? {});
}
