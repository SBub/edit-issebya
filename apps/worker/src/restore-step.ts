import { randomUUID } from "node:crypto";
import { type VersionBlobs, type VersionRows, restoreVersion } from "@edit-issebya/edit";
import { type CutoutDeps, ensureVersionCutouts } from "./cutout/version-cutouts.ts";
import { reelOf } from "./queue.ts";
import { type StepContext, runInProcessStep } from "./step-runner.ts";

const STEP = "restore";

export interface RestoreRun {
  ctx: StepContext;
  rows: VersionRows;
  blobs: VersionBlobs;
  keyPrefix: string;
  // The version to go back to; must be a version of the job's reel.
  versionId: string;
  newId?: () => string;
  // Given, the old version's masks are made sure of first (a slimmed one is
  // rebuilt in a `cutout` step), so the restored version can be shown.
  cutouts?: CutoutDeps;
}

// A restore job's one step: going back never rewrites history, so it saves a
// new version copying the old one's bytes, its parent the current version and
// restored-from the old one, and makes it current. A version of another reel
// is refused by restoreVersion before anything is written. The restored
// bytes are the old ones: they already name the masks.
export async function runRestore({
  ctx,
  rows,
  blobs,
  keyPrefix,
  versionId,
  newId = randomUUID,
  cutouts,
}: RestoreRun): Promise<void> {
  if (cutouts) {
    const old = await rows.get(versionId);
    if (old && old.reel_id === reelOf(ctx.job)) await ensureVersionCutouts(ctx, cutouts, old);
  }
  return runInProcessStep(ctx, {
    name: STEP,
    async work() {
      const reelId = reelOf(ctx.job);
      const old = await rows.get(versionId);
      ctx.signal.throwIfAborted();
      const saved = await restoreVersion({ rows, blobs, keyPrefix, newId }, { reelId, versionId });
      return {
        what: `version ${saved.number}: restored from version ${old?.number ?? "?"}`,
        sizeBytes: saved.bytes,
      };
    },
  });
}
