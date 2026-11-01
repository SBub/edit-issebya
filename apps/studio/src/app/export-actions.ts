"use server";

import { signExportDownload } from "@/lib/exports";
import { isReelId } from "@/lib/reels";
import { studioStorage } from "@/lib/storage";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export type RequestExportResult =
  | { status: "queued"; versionId: string }
  | { status: "no-version" }
  | { status: "signed-out" }
  | { status: "refused" };

// Queues a render of the reel's current version under the owner's session:
// owner, status and lease come from defaults and the worker, and the insert
// policy decides (own processed reel, a version of it, no active render of
// that version). Nothing here uses the worker's keys.
export async function requestExport(input: { reelId: string }): Promise<RequestExportResult> {
  if (typeof input.reelId !== "string" || !isReelId(input.reelId)) return { status: "refused" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { status: "refused" };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "signed-out" };

  const { data: reel, error: reelError } = await supabase
    .from("reels")
    .select("current_version_id")
    .eq("id", input.reelId)
    .maybeSingle<{ current_version_id: string | null }>();
  if (reelError || !reel) return { status: "refused" };
  if (!reel.current_version_id) return { status: "no-version" };

  const { error } = await supabase.from("jobs").insert({
    reel_id: input.reelId,
    kind: "render",
    version_id: reel.current_version_id,
  });
  if (error) {
    console.error("studio: render job not queued:", error.code, error.message);
    return { status: "refused" };
  }
  return { status: "queued", versionId: reel.current_version_id };
}

export type ExportDownloadResult =
  | { state: "ready"; url: string }
  | { state: "expired" }
  | { state: "not-configured" }
  | { state: "signed-out" }
  | { state: "failed" };

// A signed attachment link for one of the owner's exports, read through RLS.
// It lives at most the time the export has left (capped at an hour), and is
// never signed once the export has expired.
export async function exportDownloadUrl(input: {
  exportId: string;
}): Promise<ExportDownloadResult> {
  if (typeof input.exportId !== "string" || !isReelId(input.exportId)) return { state: "failed" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { state: "not-configured" };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { state: "signed-out" };

  const { data: row, error } = await supabase
    .from("exports")
    .select("id, reel_id, r2_key, created_at, expires_at")
    .eq("id", input.exportId)
    .maybeSingle<{
      id: string;
      reel_id: string;
      r2_key: string;
      created_at: string;
      expires_at: string;
    }>();
  if (error || !row) return { state: "failed" };

  const storage = studioStorage();
  if (!storage) return { state: "not-configured" };

  try {
    const url = await signExportDownload(storage, row, new Date());
    return url === null ? { state: "expired" } : { state: "ready", url };
  } catch (signError) {
    console.error("studio: export download not signed:", (signError as Error).message);
    return { state: "failed" };
  }
}
