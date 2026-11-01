import { randomUUID } from "node:crypto";
import { type VersionBlobs, type VersionRows, restoreVersion } from "@edit-issebya/edit";
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
}

// A restore job's one step: going back never rewrites history, so it saves a
// new version copying the old one's bytes, its parent the current version and
// restored-from the old one, and makes it current. A version of another reel
// is refused by restoreVersion before anything is written.
export function runRestore({
  ctx,
  rows,
  blobs,
  keyPrefix,
  versionId,
  newId = randomUUID,
}: RestoreRun): Promise<void> {
  return runInProcessStep(ctx, {
    name: STEP,
    async work() {
      const reelId = ctx.job.reel_id;
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
