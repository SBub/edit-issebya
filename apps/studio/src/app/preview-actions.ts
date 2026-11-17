"use server";

import { type EditInputs, photoPath } from "@edit-issebya/edit";
import {
  type FramesLayout,
  type PreviewKeys,
  parsePreviewCopies,
  previewKeys,
} from "@/lib/preview-sources";
import { reportFailure, serverErrorCapture } from "@/lib/error-tracking";
import { isReelId } from "@/lib/reels";
import { studioStorage } from "@/lib/storage";
import { createSupabaseServerClient } from "@/lib/supabase-server";

// The signed URLs of everything the preview reads; masks and photos by the
// path the page names them at.
export type PreviewUrls = Omit<PreviewKeys, "masks" | "photoIds"> & {
  masks: { path: string; url: string }[];
  photos: { path: string; url: string }[];
};

export type PreviewSourcesResult =
  | {
      status: "ready";
      versionId: string;
      urls: PreviewUrls;
      // How the frames sprite is laid out; null without one.
      framesLayout: FramesLayout | null;
    }
  | { status: "no-version" }
  | { status: "no-previews" }
  // A photo the version shows was deleted from the library (or is not ready).
  | { status: "photo-missing" }
  // A mask the version needs was cleared by the slimming; Export rebuilds it.
  | { status: "cutout-cleared" }
  | { status: "unconfigured" }
  | { status: "signed-out" }
  | { status: "failed" };

// Long enough to watch the preview many times over.
const DOWNLOAD_URL_SECONDS = 3600;

// Signed download URLs for the live preview of one version of the reel (the
// shown one, by default the current one): its edit, transcript and head
// track, the reel's footage preview copy and frames sprite, and the version's
// cut-out masks (each HEADed first: a mask the slimming cleared is a notice,
// never a preview that differs from the export) and its library photos'
// large copies (the key from the photo's own row). Every row is
// read under RLS as the signed-in owner, so a reel that is not theirs reads
// as nothing, and a version id is read only within this reel (another reel's
// reads as nothing too); the keys come only from columns owners cannot write
// (the version row, reels.preview_copies).
export async function loadPreviewSources(
  reelId: string,
  versionId?: string | null,
): Promise<PreviewSourcesResult> {
  if (typeof reelId !== "string" || !isReelId(reelId)) return { status: "failed" };
  if (versionId !== undefined && versionId !== null) {
    if (typeof versionId !== "string" || !isReelId(versionId)) return { status: "failed" };
  }

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
  const shownId = versionId ?? reel.data.current_version_id;
  if (!shownId) return { status: "no-version" };
  const previewCopies = parsePreviewCopies(reel.data.preview_copies);
  if (!previewCopies) return { status: "no-previews" };

  const version = await supabase
    .from("versions")
    .select("id, r2_key, inputs")
    .eq("id", shownId)
    .eq("reel_id", reelId)
    .maybeSingle<{ id: string; r2_key: string; inputs: EditInputs }>();
  if (version.error || !version.data) return { status: "failed" };

  const keys = previewKeys({
    r2Key: version.data.r2_key,
    reelId,
    versionId: shownId,
    inputs: version.data.inputs,
    previewCopies,
  });
  if (!keys) return { status: "failed" };

  // Only the owner's rows come back under RLS; the key is the row's, never
  // built from the id.
  const photos: { path: string; key: string }[] = [];
  if (keys.photoIds.length > 0) {
    const rows = await supabase
      .from("photos")
      .select("id, large_key, status")
      .in("id", keys.photoIds)
      .returns<{ id: string; large_key: string | null; status: string }[]>();
    if (rows.error) return { status: "failed" };
    for (const id of keys.photoIds) {
      const row = rows.data.find((photo) => photo.id === id);
      if (!row || row.status !== "ready" || !row.large_key) return { status: "photo-missing" };
      photos.push({ path: photoPath(id), key: row.large_key });
    }
  }

  const storage = studioStorage();
  if (!storage) return { status: "unconfigured" };
  try {
    const heads = await Promise.all(keys.masks.map((mask) => storage.head(mask.key)));
    if (heads.some((head) => head === null)) return { status: "cutout-cleared" };
    const sign = (key: string) =>
      storage.signDownload(key, { expiresInSeconds: DOWNLOAD_URL_SECONDS });
    const [edit, transcript, headTrack, footage, frames] = await Promise.all([
      sign(keys.edit),
      sign(keys.transcript),
      sign(keys.headTrack),
      sign(keys.footage),
      keys.frames ? sign(keys.frames) : null,
    ]);
    const signAll = (files: { path: string; key: string }[]) =>
      Promise.all(files.map(async ({ path, key }) => ({ path, url: await sign(key) })));
    const [masks, photoUrls] = await Promise.all([signAll(keys.masks), signAll(photos)]);
    const { frames: sprite } = previewCopies;
    return {
      status: "ready",
      versionId: shownId,
      urls: { edit, transcript, headTrack, footage, frames, masks, photos: photoUrls },
      framesLayout:
        frames && sprite
          ? {
              everySeconds: sprite.everySeconds,
              columns: sprite.columns,
              width: sprite.width,
              height: sprite.height,
            }
          : null,
    };
  } catch (error) {
    await reportFailure(serverErrorCapture(), {
      message: "studio: preview not signed",
      error,
      userId: user.id,
      properties: { reel_id: reelId },
      log: [(error as Error).message],
    });
    return { status: "failed" };
  }
}
