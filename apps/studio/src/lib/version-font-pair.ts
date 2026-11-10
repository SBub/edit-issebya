import { type FontPairId, isFontPairId } from "@edit-issebya/edit";
import { isStorageKey, type Storage } from "@edit-issebya/storage";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reportFailure, serverErrorCapture } from "@/lib/error-tracking";

// The font pair a version's edit was set in (app_docs/font-pairs.md): the
// `font_pair` of the edit JSON, which is the version's own key (`r2_key`). Null
// for bytes that are not an edit or name no pair (a version saved before font
// pairs), so the picker shows no pair chosen rather than a guess.
export function fontPairOfEdit(bytes: Uint8Array | null): FontPairId | null {
  if (bytes === null) return null;
  try {
    const edit: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof edit !== "object" || edit === null) return null;
    const { font_pair } = edit as { font_pair?: unknown };
    return isFontPairId(font_pair) ? font_pair : null;
  } catch {
    return null;
  }
}

// The pair one version of a reel was made with, read from its edit in storage.
// The version is read under RLS as the signed-in owner, so another owner's
// version (or one of another reel) reads as null. A storage failure is
// reported and reads as null too: the picker then shows no chosen pair, and
// the page still renders.
export async function readVersionFontPair({
  supabase,
  storage,
  reelId,
  versionId,
  userId,
}: {
  supabase: SupabaseClient;
  storage: Storage | null;
  reelId: string;
  versionId: string;
  userId: string;
}): Promise<FontPairId | null> {
  if (!storage) return null;
  const version = await supabase
    .from("versions")
    .select("r2_key")
    .eq("id", versionId)
    .eq("reel_id", reelId)
    .maybeSingle<{ r2_key: string }>();
  if (version.error || !version.data || !isStorageKey(version.data.r2_key)) return null;
  try {
    return fontPairOfEdit(await storage.get(version.data.r2_key));
  } catch (error: unknown) {
    await reportFailure(serverErrorCapture(), {
      message: "studio: version font pair not read",
      error,
      userId,
      properties: { reel_id: reelId, version_id: versionId },
    });
    return null;
  }
}
