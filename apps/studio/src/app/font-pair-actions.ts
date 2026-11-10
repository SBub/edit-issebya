"use server";

import type { FontPairId } from "@edit-issebya/edit";
import { isReelId } from "@/lib/reels";
import { studioStorage } from "@/lib/storage";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { readVersionFontPair } from "@/lib/version-font-pair";

// The font pair one version of the reel was set in (app_docs/font-pairs.md), for
// the picker's chosen option once a new current version arrives. Null when it
// cannot be read: the owner's session is gone, the version is not theirs, or
// the edit names no pair.
export async function loadVersionFontPair(
  reelId: string,
  versionId: string,
): Promise<FontPairId | null> {
  if (typeof reelId !== "string" || !isReelId(reelId)) return null;
  if (typeof versionId !== "string" || !isReelId(versionId)) return null;
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return readVersionFontPair({
    supabase,
    storage: studioStorage(),
    reelId,
    versionId,
    userId: user.id,
  });
}
