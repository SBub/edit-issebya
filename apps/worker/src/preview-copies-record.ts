import type { EditRef } from "@edit-issebya/edit";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FOOTAGE_PREVIEW_FILE, SUBJECT_PREVIEW_FILE } from "./pipeline/preview-copies.ts";
import { dbFailure } from "./failures.ts";

const STEP = "preview_copies";

export interface PreviewCopiesRefs {
  footage: EditRef;
  cutout: EditRef;
}

// Where the studio finds the reel's preview copies, by the preview_copies
// step's fingerprint (from runPipeline).
export function previewCopiesRefs(fingerprints: Record<string, string>): PreviewCopiesRefs {
  const fingerprint = fingerprints[STEP];
  if (!fingerprint) throw new Error(`${STEP}: no fingerprint for ${STEP}`);
  return {
    footage: { step: STEP, fingerprint, file: FOOTAGE_PREVIEW_FILE },
    cutout: { step: STEP, fingerprint, file: SUBJECT_PREVIEW_FILE },
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
  const { error, status } = await db
    .from("reels")
    .update({ preview_copies: refs })
    .eq("id", reelId);
  if (error) throw dbFailure("preview copies not recorded", { error, status });
}
