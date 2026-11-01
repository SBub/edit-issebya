"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { changeBlockedReason, normalizeRequest } from "@/lib/change-requests";
import type { JobRow } from "@/lib/jobs";
import { type ReelDetail, isReelId } from "@/lib/reels";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export type ChangeActionResult =
  | { status: "queued"; jobId: string }
  | { status: "invalid"; reason: string }
  | { status: "blocked"; reason: string }
  | { status: "signed-out" }
  | { status: "failed" };

type Open =
  | { ok: true; supabase: SupabaseClient; currentVersionId: string | null }
  | { ok: false; result: ChangeActionResult };

// The user's own client, then the reel and its jobs under RLS: another
// owner's reel reads as missing. The interim ordering rule is checked here as
// well as in the page, so a stale tab cannot queue a second job.
async function openReel(reelId: string): Promise<Open> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { ok: false, result: { status: "failed" } };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, result: { status: "signed-out" } };

  const [reel, jobs] = await Promise.all([
    supabase
      .from("reels")
      .select("id, status, current_version_id")
      .eq("id", reelId)
      .maybeSingle<Pick<ReelDetail, "id" | "status" | "current_version_id">>(),
    supabase
      .from("jobs")
      .select("id, status")
      .eq("reel_id", reelId)
      .returns<Pick<JobRow, "id" | "status">[]>(),
  ]);
  if (reel.error || jobs.error) {
    console.error("studio: reel not read for a change:", reel.error?.code ?? jobs.error?.code);
    return { ok: false, result: { status: "failed" } };
  }
  if (!reel.data) return { ok: false, result: { status: "failed" } };
  const reason = changeBlockedReason(reel.data, jobs.data ?? []);
  if (reason) return { ok: false, result: { status: "blocked", reason } };
  return { ok: true, supabase, currentVersionId: reel.data.current_version_id };
}

async function insertJob(
  supabase: SupabaseClient,
  row: {
    reel_id: string;
    kind: "change" | "restore";
    request?: string;
    restore_version_id?: string;
  },
): Promise<ChangeActionResult> {
  // Under RLS: the insert policy takes the owner from the session and accepts
  // only the caller's reel (and, for a restore, a version of that reel).
  const { data, error } = await supabase.from("jobs").insert(row).select("id").single<{
    id: string;
  }>();
  if (error || !data) {
    // Logged without the request text.
    console.error(`studio: ${row.kind} job not queued:`, error?.code, error?.message);
    return { status: "failed" };
  }
  return { status: "queued", jobId: data.id };
}

// Queues a `change` job carrying the owner's words; the worker runs only the
// decide step with them.
export async function requestChange(input: {
  reelId: string;
  text: string;
}): Promise<ChangeActionResult> {
  if (typeof input.reelId !== "string" || !isReelId(input.reelId)) return { status: "failed" };
  const normalized = normalizeRequest(input.text);
  if (!normalized.ok) return { status: "invalid", reason: normalized.reason };

  const open = await openReel(input.reelId);
  if (!open.ok) return open.result;
  return insertJob(open.supabase, {
    reel_id: input.reelId,
    kind: "change",
    request: normalized.request,
  });
}

// Queues a `restore` job going back to an earlier version of the same reel;
// the worker saves a new version copying it, so history is never rewritten.
export async function requestRestore(input: {
  reelId: string;
  versionId: string;
}): Promise<ChangeActionResult> {
  if (typeof input.reelId !== "string" || !isReelId(input.reelId)) return { status: "failed" };
  if (typeof input.versionId !== "string" || !isReelId(input.versionId)) {
    return { status: "invalid", reason: "Pick a version to go back to." };
  }

  const open = await openReel(input.reelId);
  if (!open.ok) return open.result;
  if (open.currentVersionId === input.versionId) {
    return { status: "invalid", reason: "This is already the current version." };
  }
  return insertJob(open.supabase, {
    reel_id: input.reelId,
    kind: "restore",
    restore_version_id: input.versionId,
  });
}
