"use server";

import type { EditInputs } from "@edit-issebya/edit";
import { type PreviewKeys, parsePreviewCopies, previewKeys } from "@/lib/preview-sources";
import { isReelId } from "@/lib/reels";
import { studioStorage } from "@/lib/storage";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export type PreviewSourcesResult =
  | { status: "ready"; versionId: string; urls: PreviewKeys }
  | { status: "no-version" }
  | { status: "no-previews" }
  | { status: "unconfigured" }
  | { status: "signed-out" }
  | { status: "failed" };

// Long enough to watch the preview many times over.
const DOWNLOAD_URL_SECONDS = 3600;

// Signed download URLs for the live preview of the reel's current version:
// its edit, transcript and head track, and the reel's two preview copies.
// Every row is read under RLS as the signed-in owner, so a reel that is not
// theirs reads as nothing; the keys come only from columns owners cannot
// write (the version row, reels.preview_copies).
export async function loadPreviewSources(reelId: string): Promise<PreviewSourcesResult> {
  if (typeof reelId !== "string" || !isReelId(reelId)) return { status: "failed" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { status: "unconfigured" };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "signed-out" };

  const reel = await supabase
    .from("reels")
    .select("id, current_version_id, preview_copies")
    .eq("id", reelId)
    .maybeSingle<{ id: string; current_version_id: string | null; preview_copies: unknown }>();
  if (reel.error || !reel.data) return { status: "failed" };
  const versionId = reel.data.current_version_id;
  if (!versionId) return { status: "no-version" };
  const previewCopies = parsePreviewCopies(reel.data.preview_copies);
  if (!previewCopies) return { status: "no-previews" };

  const version = await supabase
    .from("versions")
    .select("id, r2_key, inputs")
    .eq("id", versionId)
    .maybeSingle<{ id: string; r2_key: string; inputs: EditInputs }>();
  if (version.error || !version.data) return { status: "failed" };

  const keys = previewKeys({
    r2Key: version.data.r2_key,
    reelId,
    versionId,
    inputs: version.data.inputs,
    previewCopies,
  });
  if (!keys) return { status: "failed" };

  const storage = studioStorage();
  if (!storage) return { status: "unconfigured" };
  try {
    const sign = (key: string) =>
      storage.signDownload(key, { expiresInSeconds: DOWNLOAD_URL_SECONDS });
    const [edit, transcript, headTrack, footage, cutout] = await Promise.all([
      sign(keys.edit),
      sign(keys.transcript),
      sign(keys.headTrack),
      sign(keys.footage),
      sign(keys.cutout),
    ]);
    return { status: "ready", versionId, urls: { edit, transcript, headTrack, footage, cutout } };
  } catch (error) {
    console.error("studio: preview not signed:", (error as Error).message);
    return { status: "failed" };
  }
}
