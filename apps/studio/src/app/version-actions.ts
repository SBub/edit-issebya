"use server";

import { parseChangeRequest } from "@/lib/change-request";
import { isReelId } from "@/lib/reels";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export type QueueJobResult =
  | { status: "queued" }
  | { status: "invalid"; reason: string }
  | { status: "signed-out" }
  | { status: "refused" };

// Inserts a change or restore job under the owner's session: owner, status
// and lease come from defaults and the worker, and the insert policy decides
// (own processed reel, no active job, a restore target of the same reel). A
// refusal is logged without the request text.
async function queueJob(
  reelId: string,
  fields: { kind: "change"; request: string } | { kind: "restore"; restore_version_id: string },
): Promise<QueueJobResult> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { status: "refused" };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "signed-out" };

  const { error } = await supabase.from("jobs").insert({ reel_id: reelId, ...fields });
  if (error) {
    console.error(`studio: ${fields.kind} job not queued:`, error.code, error.message);
    return { status: "refused" };
  }
  return { status: "queued" };
}

// The owner's change, in their own words, for the decide step.
export async function requestChange(input: {
  reelId: string;
  text: string;
}): Promise<QueueJobResult> {
  if (typeof input.reelId !== "string" || !isReelId(input.reelId)) return { status: "refused" };
  const parsed = parseChangeRequest(input.text);
  if (!parsed.ok) return { status: "invalid", reason: parsed.reason };
  return queueJob(input.reelId, { kind: "change", request: parsed.value });
}

// Going back to an earlier version: the worker copies it into a new one.
export async function goBackTo(input: {
  reelId: string;
  versionId: string;
}): Promise<QueueJobResult> {
  if (typeof input.reelId !== "string" || !isReelId(input.reelId)) return { status: "refused" };
  if (typeof input.versionId !== "string" || !isReelId(input.versionId)) {
    return { status: "refused" };
  }
  return queueJob(input.reelId, { kind: "restore", restore_version_id: input.versionId });
}
