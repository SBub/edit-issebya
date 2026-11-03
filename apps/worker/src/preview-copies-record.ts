import type { EditRef } from "@edit-issebya/edit";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  FOOTAGE_FRAMES,
  FOOTAGE_PREVIEW_FILE,
  FRAMES_FILE,
  THUMBNAIL_FILE,
} from "./pipeline/preview-copies.ts";

export const STEP = "preview_copies";

export interface PreviewCopiesRefs {
  footage: EditRef;
  thumbnail: EditRef;
  frames: EditRef;
  // How the frames sprite is laid out (one row, one frame every few seconds).
  frames_layout: typeof FOOTAGE_FRAMES;
}

// Where the studio finds the reel's preview copy (footage only: no cut-out),
// its thumbnail and its frames sprite, by the preview_copies step's
// fingerprint (from runPipeline).
export function previewCopiesRefs(fingerprints: Record<string, string>): PreviewCopiesRefs {
  const fingerprint = fingerprints[STEP];
  if (!fingerprint) throw new Error(`${STEP}: no fingerprint for ${STEP}`);
  return {
    footage: { step: STEP, fingerprint, file: FOOTAGE_PREVIEW_FILE },
    thumbnail: { step: STEP, fingerprint, file: THUMBNAIL_FILE },
    frames: { step: STEP, fingerprint, file: FRAMES_FILE },
    frames_layout: { ...FOOTAGE_FRAMES },
  };
}

// The minimal client surface the update needs, so tests stub it.
type ReelsUpdater = Pick<SupabaseClient, "from">;

// Records the refs on the reel (service role; owners cannot write this
// column). A retried job writes the same value again.
export async function recordPreviewCopies(
  db: ReelsUpdater,
  reelId: string,
  refs: PreviewCopiesRefs,
): Promise<void> {
  const { error } = await db.from("reels").update({ preview_copies: refs }).eq("id", reelId);
  if (error) throw new Error(`preview copies not recorded: ${error.message}`);
}
