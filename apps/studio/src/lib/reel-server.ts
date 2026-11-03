import type { SupabaseClient } from "@supabase/supabase-js";
import { type ErrorCapture, reportFailure } from "./error-tracking";
import { isReelId } from "./reels";

// The server side of deleting a reel from the reels list. delete_reel (a
// security definer function) deletes only the caller's own reel, its versions,
// jobs, steps and exports going with it, and queues every storage key it had
// for the worker, which removes the objects between jobs. No storage access
// here, and no secret key. Another owner's reel answers exactly like a missing
// one.

export type ReelError = "signed-out" | "unavailable" | "not-found" | "failed";

export type ReelAnswer<T> = { ok: true; value: T } | { ok: false; error: ReelError };

export interface ReelDeps {
  supabase: SupabaseClient | null;
  // Every handled failure is captured here (a fake in tests).
  errors: ErrorCapture;
}

const fail = (error: ReelError) => ({ ok: false, error }) as const;

export async function deleteReel(
  deps: ReelDeps,
  input: { reelId: unknown },
): Promise<ReelAnswer<{ reelId: string }>> {
  const { reelId } = input;
  if (typeof reelId !== "string" || !isReelId(reelId)) return fail("not-found");
  if (!deps.supabase) return fail("unavailable");
  const {
    data: { user },
  } = await deps.supabase.auth.getUser();
  if (!user) return fail("signed-out");

  const { error } = await deps.supabase.rpc("delete_reel", { p_reel_id: reelId });
  if (error) {
    // Not the caller's, or already gone (a second tab, a double click).
    if (error.code === "P0002") return fail("not-found");
    await reportFailure(deps.errors, {
      message: "studio: reel not deleted",
      error,
      userId: user.id,
      properties: { reel_id: reelId },
    });
    return fail("failed");
  }
  return { ok: true, value: { reelId } };
}
