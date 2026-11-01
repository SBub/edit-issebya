"use server";

import {
  EXPORT_COLUMNS,
  type ExportRow,
  exportBlockedReason,
  exportFileName,
  exportLinkSeconds,
  exportView,
  isExportKey,
} from "@/lib/exports";
import type { JobRow } from "@/lib/jobs";
import { type ReelDetail, isReelId } from "@/lib/reels";
import { studioStorage } from "@/lib/storage";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export type ExportRequestResult =
  | { status: "queued"; jobId: string; versionId: string }
  | { status: "blocked"; reason: string }
  | { status: "signed-out" }
  | { status: "failed" };

// Queues a `render` job for the reel's current version. The version is read
// here under RLS, never chosen by the browser; the rule the button follows is
// checked again, so a stale tab or a double press cannot queue a second
// render of the same version.
export async function requestExport(reelId: string): Promise<ExportRequestResult> {
  if (typeof reelId !== "string" || !isReelId(reelId)) return { status: "failed" };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { status: "failed" };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "signed-out" };

  const [reel, jobs] = await Promise.all([
    supabase
      .from("reels")
      .select("id, status, current_version_id")
      .eq("id", reelId)
      .maybeSingle<Pick<ReelDetail, "id" | "status" | "current_version_id">>(),
    supabase
      .from("jobs")
      .select("id, kind, status, version_id")
      .eq("reel_id", reelId)
      .returns<Pick<JobRow, "id" | "kind" | "status" | "version_id">[]>(),
  ]);
  if (reel.error || jobs.error) {
    console.error("studio: reel not read for an export:", reel.error?.code ?? jobs.error?.code);
    return { status: "failed" };
  }
  if (!reel.data) return { status: "failed" };
  const reason = exportBlockedReason(reel.data, jobs.data ?? []);
  if (reason) return { status: "blocked", reason };
  const versionId = reel.data.current_version_id!;

  // Under RLS: the render policy takes the owner from the session and accepts
  // only the caller's reel and a version of that reel.
  const { data, error } = await supabase
    .from("jobs")
    .insert({ reel_id: reelId, kind: "render", version_id: versionId })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) {
    console.error("studio: render job not queued:", error?.code, error?.message);
    return { status: "failed" };
  }
  return { status: "queued", jobId: data.id, versionId };
}

export type LatestExportResult =
  | {
      status: "ready";
      exportId: string;
      url: string;
      fileName: string;
      bytes: number;
      versionNumber: number;
      expiresAt: string;
    }
  | { status: "expired"; exportId: string }
  | { status: "none" }
  | { status: "unconfigured" }
  | { status: "signed-out" }
  | { status: "failed" };

// The reel's newest export, read under RLS as the signed-in owner. A live one
// comes with a download link signed for no longer than the time left until
// its expiry, downloading under a readable name; an expired one is never
// signed at all. The key comes only from a row owners cannot write, and is
// checked to be this reel's export before signing.
export async function loadLatestExport(reelId: string): Promise<LatestExportResult> {
  if (typeof reelId !== "string" || !isReelId(reelId)) return { status: "failed" };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { status: "unconfigured" };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "signed-out" };

  const latest = await supabase
    .from("exports")
    .select(EXPORT_COLUMNS)
    .eq("reel_id", reelId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<ExportRow>();
  if (latest.error) {
    console.error("studio: export not read:", latest.error.code);
    return { status: "failed" };
  }
  const row = latest.data;
  const view = exportView(row, Date.now());
  if (!row || view.kind === "none") return { status: "none" };
  if (view.kind === "expired") return { status: "expired", exportId: row.id };
  if (!isExportKey(row.r2_key, reelId)) {
    console.error("studio: export key refused for reel", reelId);
    return { status: "failed" };
  }

  const version = await supabase
    .from("versions")
    .select("number")
    .eq("id", row.version_id)
    .maybeSingle<{ number: number }>();
  if (version.error || !version.data) return { status: "failed" };

  const storage = studioStorage();
  if (!storage) return { status: "unconfigured" };
  const fileName = exportFileName(version.data.number, row.created_at);
  // Measured again just before signing: the reads above took time.
  const seconds = exportLinkSeconds(row.expires_at, Date.now());
  if (seconds === null) return { status: "expired", exportId: row.id };
  try {
    const url = await storage.signDownload(row.r2_key, {
      expiresInSeconds: seconds,
      downloadName: fileName,
    });
    return {
      status: "ready",
      exportId: row.id,
      url,
      fileName,
      bytes: row.bytes,
      versionNumber: version.data.number,
      expiresAt: row.expires_at,
    };
  } catch (error) {
    console.error("studio: export link not signed:", (error as Error).name);
    return { status: "failed" };
  }
}
