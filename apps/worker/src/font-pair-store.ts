import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_FONT_PAIR_ID, type FontPairId, isFontPairId } from "@edit-issebya/edit";

// The font pair a reel's owner chose: their row in `profiles` (migration
// font_pair_profiles), read by the worker with the service role. The decide
// step and the first version set the reel's new version in this pair.
export async function ownerFontPair(db: SupabaseClient, ownerId: string): Promise<FontPairId> {
  const { data, error } = await db
    .from("profiles")
    .select("font_pair")
    .eq("user_id", ownerId)
    .maybeSingle();
  if (error) throw new Error(`profiles: ${error.message}`);
  return fontPairOfRow(data);
}

// The pair a profile row names. No row is the classic pair; a name that is not
// one of the six is refused, never guessed at.
export function fontPairOfRow(row: { font_pair?: unknown } | null): FontPairId {
  if (row === null) return DEFAULT_FONT_PAIR_ID;
  if (!isFontPairId(row.font_pair)) {
    throw new Error(`profiles: font pair ${String(row.font_pair)} is not one of the six`);
  }
  return row.font_pair;
}
