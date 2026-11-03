"use server";

import { serverErrorCapture } from "@/lib/error-tracking";
import * as reels from "@/lib/reel-server";
import { createSupabaseServerClient } from "@/lib/supabase-server";

// The reels list's server action: a thin wrapper over lib/reel-server,
// building its own Supabase client per call (never at module load).
export async function deleteReel(reelId: string): Promise<reels.ReelAnswer<{ reelId: string }>> {
  return reels.deleteReel(
    { supabase: await createSupabaseServerClient(), errors: serverErrorCapture() },
    { reelId },
  );
}
