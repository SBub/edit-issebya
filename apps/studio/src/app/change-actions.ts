"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { reportFailure, serverErrorCapture } from "@/lib/error-tracking";
import {
  type FontPairId,
  type OwnerAdd,
  type OwnerMove,
  isFontPairId,
  parseOwnerAdds,
  parseOwnerMoves,
} from "@edit-issebya/edit";
import { changeBlockedReason } from "@/lib/change-requests";
import type { JobRow } from "@/lib/jobs";
import { type ReelDetail, isReelId } from "@/lib/reels";
import { OWNER_EDIT_FLAG, isFlagOn } from "@/lib/feature-flags";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export type ChangeActionResult =
  | { status: "queued"; jobId: string }
  | { status: "invalid"; reason: string }
  | { status: "blocked"; reason: string }
  | { status: "signed-out" }
  | { status: "failed" };

type Open =
  | {
      ok: true;
      supabase: SupabaseClient;
      userId: string;
      email: string | null;
      currentVersionId: string | null;
    }
  | { ok: false; result: ChangeActionResult };

// The user's own client, then the reel under RLS: another owner's reel reads
// as missing. The blocked rule is checked here as well as in the page, so a
// stale tab cannot queue a job on a refused or unusable reel, nor an edit of a
// reel that is exporting (its live render jobs are read for that). The order of
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
  const renders = await supabase
    .from("jobs")
    .select("id, kind, status")
    .eq("reel_id", reelId)
    .eq("kind", "render")
    .in("status", ["queued", "running", "waiting_ai"])
    .returns<Pick<JobRow, "id" | "kind" | "status">[]>();
  if (renders.error) {
    await reportFailure(serverErrorCapture(), {
      message: "studio: reel's exports not read for a change",
      error: renders.error,
      userId: user.id,
      properties: { reel_id: reelId },
      log: [renders.error.code],
    });
    return { ok: false, result: { status: "failed" } };
  }
  const reason = changeBlockedReason(reel.data, renders.data ?? []);
  if (reason) return { ok: false, result: { status: "blocked", reason } };
  return {
    ok: true,
    supabase,
    userId: user.id,
    email: user.email ?? null,
    currentVersionId: reel.data.current_version_id,
  };
}

async function insertJob(
  { supabase, userId }: { supabase: SupabaseClient; userId: string },
  row: {
    reel_id: string;
    kind: "restore" | "start_over" | "relayout" | "owner_edit";
    restore_version_id?: string;
    font_pair?: FontPairId;
    owner_edit?: { version_id: string; moves: OwnerMove[]; adds?: OwnerAdd[] };
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

// Font pairs (app_docs/font-pairs.md): saves the owner's pair to their profile,
// then queues a `relayout` job that places the reel's current version again in
// that pair (no AI call). The profile is what the next decide and first version
// use; the job is what this reel gets now.
export async function requestFontPair(input: {
  reelId: string;
  fontPair: string;
}): Promise<ChangeActionResult> {
  if (typeof input.reelId !== "string" || !isReelId(input.reelId)) return { status: "failed" };
  if (!isFontPairId(input.fontPair)) {
    return { status: "invalid", reason: "Pick one of the six font pairs" };
  }
  const open = await openReel(input.reelId);
  if (!open.ok) return open.result;
  if (open.currentVersionId === null) {
    return { status: "invalid", reason: "Font pairs open once the first version is ready" };
  }
  // The database saves the owner's row (`set_font_pair`, a security invoker
  // upsert that never sets user_id: the user may change only the pair).
  const { error } = await open.supabase.rpc("set_font_pair", { p_font_pair: input.fontPair });
  if (error) {
    await reportFailure(serverErrorCapture(), {
      message: "studio: font pair not saved",
      error,
      userId: open.userId,
      log: [error.code, error.message],
    });
    return { status: "failed" };
  }
  return insertJob(open, {
    reel_id: input.reelId,
    kind: "relayout",
    font_pair: input.fontPair,
  });
}

// The owner's moves (app_docs/owner-edits.md): queues an `owner_edit` job with
// the version the owner edited, the moves (a swap is a card's box move with a
// `photo_id`) and the cards the owner added. The worker applies them and
// saves a new version marked as the owner's; the edited version stays as it
// was. The moves and cards are checked for shape here, and for their rules
// (the safe zone for a text, the frame for a card, each photo a ready one of
// the owner's, its size read from the library) by the worker.
export async function requestOwnerEdit(input: {
  reelId: string;
  versionId: string;
  moves: unknown;
  adds?: unknown;
}): Promise<ChangeActionResult> {
  if (typeof input.reelId !== "string" || !isReelId(input.reelId)) return { status: "failed" };
  if (typeof input.versionId !== "string" || !isReelId(input.versionId)) {
    return { status: "invalid", reason: "Pick a version to edit" };
  }
  const adds = parseOwnerAdds(input.adds);
  const moves =
    Array.isArray(input.moves) && input.moves.length === 0 ? [] : parseOwnerMoves(input.moves);
  if (!moves || !adds || moves.length + adds.length === 0) {
    return { status: "invalid", reason: "Move or resize a text first" };
  }
  const open = await openReel(input.reelId);
  if (!open.ok) return open.result;
  // The Move editor's flag, evaluated for this user like the page does: off,
  // nothing is queued whatever the browser sends.
  if (!(await isFlagOn(OWNER_EDIT_FLAG, { id: open.userId, email: open.email }))) {
    return { status: "invalid", reason: "Moving is not available yet" };
  }
  if (open.currentVersionId === null) {
    return { status: "invalid", reason: "Editing opens once the first version is ready" };
  }
  return insertJob(open, {
    reel_id: input.reelId,
    kind: "owner_edit",
    owner_edit: { version_id: input.versionId, moves, ...(adds.length > 0 ? { adds } : {}) },
  });
}
