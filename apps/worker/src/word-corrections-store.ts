import type { StoredCorrection } from "@edit-issebya/edit";
import type { SupabaseClient } from "@supabase/supabase-js";

// The reel's transcript corrections (`owner_word_corrections`, migration
// owner_word_corrections; app_docs/owner-edits.md): one row per spoken word
// the owner corrected in a caption. The worker reads and writes them with the
// service role; no pipeline step touches the table, so a reel processed again
// keeps them.
export interface WordCorrectionsStore {
  // Every correction of the reel.
  read(reelId: string): Promise<StoredCorrection[]>;
  // The corrections one save makes: each replaces the reel's earlier one for
  // the same word. Writing the same ones again changes nothing.
  write(reelId: string, ownerId: string, corrections: readonly StoredCorrection[]): Promise<void>;
}

export function supabaseWordCorrections(db: SupabaseClient): WordCorrectionsStore {
  return {
    async read(reelId) {
      const { data, error } = await db
        .from("owner_word_corrections")
        .select("word_id, text, original_text")
        .eq("reel_id", reelId);
      if (error) throw new Error(`owner_word_corrections: ${error.message}`);
      return ((data ?? []) as { word_id: string; text: string; original_text: string }[]).map(
        (row) => ({ word: row.word_id, text: row.text, original: row.original_text }),
      );
    },
    async write(reelId, ownerId, corrections) {
      if (corrections.length === 0) return;
      const now = new Date().toISOString();
      const { error } = await db.from("owner_word_corrections").upsert(
        corrections.map((entry) => ({
          updated_at: now,
          reel_id: reelId,
          owner_id: ownerId,
          word_id: entry.word,
          text: entry.text,
          original_text: entry.original,
        })),
        { onConflict: "reel_id,word_id" },
      );
      if (error) throw new Error(`owner_word_corrections: ${error.message}`);
    },
  };
}
