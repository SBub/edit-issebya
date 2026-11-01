import { NextResponse } from "next/server";
import { keyPrefix } from "@edit-issebya/storage";
import { studioStorage } from "./storage";
import { createSupabaseServerClient } from "./supabase-server";
import type { UploadAnswer } from "./upload-server";

// The routes under app/api/uploads/s3/multipart (UPLOAD_ENDPOINT in
// lib/upload) answer Uppy's Companion S3 protocol themselves, with no
// Companion server: JSON only, never file bytes.

// Per request, never at module load.
export async function uploadDeps() {
  return { supabase: await createSupabaseServerClient(), storage: studioStorage() };
}

export function uploadPrefix(): string | null {
  return keyPrefix();
}

export function answer<T>(result: UploadAnswer<T>, shape: (value: T) => unknown): NextResponse {
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(shape(result.value), { headers: { "Cache-Control": "no-store" } });
}

// A JSON body, or null when the request is not JSON (a cross-site form post
// cannot set this content type without a preflight the studio never answers).
export async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return null;
  }
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function badRequest(): NextResponse {
  return NextResponse.json({ error: "bad-request" }, { status: 400 });
}
