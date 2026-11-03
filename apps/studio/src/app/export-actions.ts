"use server";

import { reportFailure, serverErrorCapture } from "@/lib/error-tracking";
import {
  EXPORT_COLUMNS,
  type ExportRow,
  exportBlockedReason,
  exportFileName,
  exportLinkSeconds,
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
    await reportFailure(serverErrorCapture(), {
      message: "studio: reel not read for an export",
      error: reel.error ?? jobs.error,
      userId: user.id,
      properties: { reel_id: reelId },
      log: [reel.error?.code ?? jobs.error?.code],
    });
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
    await reportFailure(serverErrorCapture(), {
      message: "studio: render job not queued",
      error: error ?? undefined,
      userId: user.id,
      properties: { reel_id: reelId },
      log: [error?.code, error?.message],
    });
    return { status: "failed" };
  }
  return { status: "queued", jobId: data.id, versionId };
}

export type ExportFileResult =
  | { status: "ready"; url: string; fileName: string }
  | { status: "expired" }
  | { status: "none" }
  | { status: "unconfigured" }
  | { status: "signed-out" }
  | { status: "failed" };

// One export of the reel, read under RLS as the signed-in owner, with a
// download link signed for no longer than the time left until its expiry
// (`Content-Disposition: attachment`, a readable name). The modal fetches it
// once, the moment the export row arrives, and downloads it at once: nothing
// is kept or offered afterwards. An expired export is never signed. The key
// comes only from a row owners cannot write, and is checked to be this reel's
// export before signing.
export async function loadExport(reelId: string, exportId: string): Promise<ExportFileResult> {
  if (typeof reelId !== "string" || !isReelId(reelId)) return { status: "failed" };
  if (typeof exportId !== "string" || !isReelId(exportId)) return { status: "failed" };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { status: "unconfigured" };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "signed-out" };

  const found = await supabase
    .from("exports")
    .select(EXPORT_COLUMNS)
    .eq("id", exportId)
    .eq("reel_id", reelId)
    .maybeSingle<ExportRow>();
  if (found.error) {
    await reportFailure(serverErrorCapture(), {
      message: "studio: export not read",
      error: found.error,
      userId: user.id,
      properties: { reel_id: reelId },
      log: [found.error.code],
    });
    return { status: "failed" };
  }
  const row = found.data;
  if (!row) return { status: "none" };
  if (exportLinkSeconds(row.expires_at, Date.now()) === null) return { status: "expired" };
  if (!isExportKey(row.r2_key, reelId)) {
    await reportFailure(serverErrorCapture(), {
      message: "studio: export key refused",
      userId: user.id,
      properties: { reel_id: reelId },
      log: [reelId],
    });
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
  if (seconds === null) return { status: "expired" };
  try {
    const url = await storage.signDownload(row.r2_key, {
      expiresInSeconds: seconds,
      downloadName: fileName,
    });
    return { status: "ready", url, fileName };
  } catch (error) {
    // The error's name only: a signing error's message may hold the key.
    await reportFailure(serverErrorCapture(), {
      message: "studio: export link not signed",
      userId: user.id,
      properties: { reel_id: reelId, error_code: (error as Error).name },
      log: [(error as Error).name],
    });
    return { status: "failed" };
  }
}

export type CancelExportResult =
  | { status: "cancelled" }
  | { status: "not-cancelled" }
  | { status: "signed-out" }
  | { status: "failed" };

// Cancels the owner's own render job through `cancel_job` (the only path: the
// owner has no update right on `jobs`). The database refuses another owner's
// job, any other kind, a finished job and one whose export is recorded, all
// as `not-cancelled`.
export async function cancelExport(jobId: string): Promise<CancelExportResult> {
  if (typeof jobId !== "string" || !isReelId(jobId)) return { status: "failed" };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { status: "failed" };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "signed-out" };
  const { data, error } = await supabase.rpc("cancel_job", { p_job_id: jobId });
  if (error) {
    await reportFailure(serverErrorCapture(), {
      message: "studio: export not cancelled",
      error,
      userId: user.id,
      properties: { job_id: jobId },
      log: [error.code],
    });
    return { status: "failed" };
  }
  return data === true ? { status: "cancelled" } : { status: "not-cancelled" };
}
