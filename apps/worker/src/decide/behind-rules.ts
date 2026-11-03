import type { BehindForbid } from "@edit-issebya/edit";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseFailure } from "../failure.ts";

// The reel's behind rules as stored: what a change request switched off
// ("no photos in this one"). Only save_version writes them, with a version.
export interface ReelRules {
  read(reelId: string): Promise<BehindForbid>;
}

// The reel's flags through the worker's (service role) client.
export function supabaseReelRules(db: SupabaseClient): ReelRules {
  return {
    async read(reelId) {
      const { data, error, status } = await db
        .from("reels")
        .select("no_photos, no_big_word")
        .eq("id", reelId)
        .maybeSingle();
      if (error) throw supabaseFailure("reel behind rules not read", { error, status });
      if (!data) throw new Error(`reel ${reelId} does not exist`);
      const row = data as { no_photos: boolean; no_big_word: boolean };
      return { photos: row.no_photos, bigWord: row.no_big_word };
    },
  };
}
