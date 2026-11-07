"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { reportFailure, serverErrorCapture } from "@/lib/error-tracking";
import { changeBlockedReason } from "@/lib/change-requests";
import { type ReelDetail, isReelId } from "@/lib/reels";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export type ChangeActionResult =
  | { status: "queued"; jobId: string }
  | { status: "invalid"; reason: string }
  | { status: "blocked"; reason: string }
  | { status: "signed-out" }
  | { status: "failed" };

type Open =
  | { ok: true; supabase: SupabaseClient; userId: string; currentVersionId: string | null }
  | { ok: false; result: ChangeActionResult };

// The user's own client, then the reel under RLS: another owner's reel reads
// as missing. The blocked rule is checked here as well as in the page, so a
// stale tab cannot queue a job on a refused or unusable reel. The order of
// jobs is the database's (claim_job runs one job per reel at a time).
async function openReel(reelId: string): Promise<Open> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, result: { status: "failed" } };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, result: { status: "signed-out" } };

  const reel = await supabase
    .from("reels")
    .select("id, status, current_version_id")
    .eq("id", reelId)
    .maybeSingle<Pick<ReelDetail, "id" | "status" | "current_version_id">>();
  if (reel.error) {
    await reportFailure(serverErrorCapture(), {
      message: "studio: reel not read for a change",
      error: reel.error,
      userId: user.id,
      properties: { reel_id: reelId },
      log: [reel.error.code],
    });
    return { ok: false, result: { status: "failed" } };
  }
  if (!reel.data) return { ok: false, result: { status: "failed" } };
  const reason = changeBlockedReason(reel.data);
  if (reason) return { ok: false, result: { status: "blocked", reason } };
  return { ok: true, supabase, userId: user.id, currentVersionId: reel.data.current_version_id };
}

async function insertJob(
  { supabase, userId }: { supabase: SupabaseClient; userId: string },
  row: {
    reel_id: string;
    kind: "restore" | "start_over";
    restore_version_id?: string;
  },
): Promise<ChangeActionResult> {
  // Under RLS: the insert policy takes the owner from the session and accepts
  // only the caller's reel (and, for a restore, a version of that reel).
  const { data, error } = await supabase.from("jobs").insert(row).select("id").single<{
    id: string;
  }>();
  if (error || !data) {
    // Logged and captured with the reel id only.
    await reportFailure(serverErrorCapture(), {
      message: `studio: ${row.kind} job not queued`,
      error: error ?? undefined,
      userId,
      properties: { reel_id: row.reel_id },
      log: [error?.code, error?.message],
    });
    return { status: "failed" };
  }
  return { status: "queued", jobId: data.id };
}

// Queues a `restore` job going back to an earlier version of the same reel;
// the worker saves a new version copying it, so history is never rewritten.
export async function requestRestore(input: {
  reelId: string;
  versionId: string;
}): Promise<ChangeActionResult> {
  if (typeof input.reelId !== "string" || !isReelId(input.reelId)) return { status: "failed" };
  if (typeof input.versionId !== "string" || !isReelId(input.versionId)) {
    return { status: "invalid", reason: "Pick a version to go back to" };
  }

  const open = await openReel(input.reelId);
  if (!open.ok) return open.result;
  if (open.currentVersionId === input.versionId) {
    return { status: "invalid", reason: "This is already the current version" };
  }
  return insertJob(open, {
    reel_id: input.reelId,
    kind: "restore",
    restore_version_id: input.versionId,
  });
}

// Start over (a temporary testing control, to be removed): queues a
// `start_over` job; the worker decides again from version 1 with no request
// and saves the result as a new version, so earlier versions stay.
export async function requestStartOver(input: { reelId: string }): Promise<ChangeActionResult> {
  if (typeof input.reelId !== "string" || !isReelId(input.reelId)) return { status: "failed" };
  const open = await openReel(input.reelId);
  if (!open.ok) return open.result;
  if (open.currentVersionId === null) {
    return { status: "invalid", reason: "Start over opens once the first version is ready" };
  }
  return insertJob(open, { reel_id: input.reelId, kind: "start_over" });
}
