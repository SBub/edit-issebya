"use server";

import { type VersionInputs, previewKeys } from "@/lib/preview-sources";
import { isReelId } from "@/lib/reels";
import { studioStorage } from "@/lib/storage";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export interface PreviewUrls {
  version: string;
  transcript: string;
  headTrack: string;
  footage: string;
  cutout: string;
}

export type PreviewSourcesResult =
  | { state: "ready"; versionId: string; urls: PreviewUrls }
  | { state: "no-version" }
  | { state: "no-previews" }
  | { state: "not-configured" }
  | { state: "signed-out" }
  | { state: "failed" };

// How long the browser may fetch the preview's objects. A page left open
// longer shows a load error; a reload signs new links (no timed refresh).
const DOWNLOAD_URL_SECONDS = 3600;

// Signed download links for the five objects of the open reel's current
// version: its edit, transcript and head track, and the reel's two preview
// copies. Everything is read through the signed-in user's client, so RLS
// decides; nothing of any other reel is read, and never with the worker's keys.
export async function previewSources(reelId: string): Promise<PreviewSourcesResult> {
  if (typeof reelId !== "string" || !isReelId(reelId)) return { state: "failed" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { state: "not-configured" };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { state: "signed-out" };

  const { data: reel, error: reelError } = await supabase
    .from("reels")
    .select("current_version_id, preview_copies_fingerprint")
    .eq("id", reelId)
    .maybeSingle<{
      current_version_id: string | null;
      preview_copies_fingerprint: string | null;
    }>();
  if (reelError || !reel) return { state: "failed" };
  if (!reel.current_version_id) return { state: "no-version" };
  if (!reel.preview_copies_fingerprint) return { state: "no-previews" };

  const { data: version, error: versionError } = await supabase
    .from("versions")
    .select("id, r2_key, inputs")
    .eq("id", reel.current_version_id)
    .maybeSingle<{ id: string; r2_key: string; inputs: VersionInputs }>();
  if (versionError || !version) return { state: "failed" };

  const storage = studioStorage();
  if (!storage) return { state: "not-configured" };

  try {
    const keys = previewKeys({
      reelId,
      version,
      previewFingerprint: reel.preview_copies_fingerprint,
    });
    const sign = (key: string) =>
      storage.signDownload(key, { expiresInSeconds: DOWNLOAD_URL_SECONDS });
    const [versionUrl, transcript, headTrack, footage, cutout] = await Promise.all([
      sign(keys.version),
      sign(keys.transcript),
      sign(keys.headTrack),
      sign(keys.footage),
      sign(keys.cutout),
    ]);
    return {
      state: "ready",
      versionId: version.id,
      urls: { version: versionUrl, transcript, headTrack, footage, cutout },
    };
  } catch (signError) {
    console.error("studio: preview not signed:", (signError as Error).message);
    return { state: "failed" };
  }
}
