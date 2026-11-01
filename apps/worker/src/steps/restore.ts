import { randomUUID } from "node:crypto";
import { type VersionStore, restoreVersion } from "@edit-issebya/edit";
import type { Storage } from "@edit-issebya/storage";
import { type StepContext, runInProcessStep } from "../step-runner.ts";
import { leaseGuarded } from "./version-io.ts";

const STEP = "restore";

export interface RestoreRun {
  ctx: StepContext;
  storage: Storage;
  keyPrefix: string;
  versions: VersionStore;
  // The job's restore_version_id.
  fromId: string | null;
  // Tests pass a fixed id.
  newId?: () => string;
}

// A restore job's one step: the old version's bytes copied into a new
// version, which becomes current. History is never rewritten: the old row and
// object stay as they were, so going back can itself be undone. A version of
// another reel or a missing object fails the step; after a lost lease nothing
// is written.
export function restore({
  ctx,
  storage,
  keyPrefix,
  versions,
  fromId,
  newId = randomUUID,
}: RestoreRun): Promise<void> {
  const { job, signal } = ctx;
  return runInProcessStep(ctx, {
    name: STEP,
    async work() {
      if (!fromId) throw new Error(`${STEP}: job has no version to restore`);
      const from = await versions.get(fromId);
      const { objects, store } = leaseGuarded(storage, versions, signal);
      signal.throwIfAborted();
      const row = await restoreVersion({
        objects,
        store,
        prefix: keyPrefix,
        reelId: job.reel_id,
        id: newId(),
        fromId,
      });
      // restoreVersion has refused a missing version, so `from` is set here.
      return {
        what: `restored version ${from?.number} as version ${row.number}`,
        sizeBytes: null,
      };
    },
  });
}
