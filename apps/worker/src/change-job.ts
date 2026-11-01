import type { VersionStore } from "@edit-issebya/edit";
import type { Storage } from "@edit-issebya/storage";
import { type DecideRun, decide } from "./decide/decide.ts";
import type { SpawnTool, StepContext } from "./step-runner.ts";
import { fingerprintsFromInputs } from "./steps/version-io.ts";

export interface ChangeJobRun {
  ctx: StepContext;
  storage: Storage;
  keyPrefix: string;
  scratchDir: string;
  versions: VersionStore;
  // The owner's words, from the job row.
  request: string | null;
  ai?: DecideRun["ai"];
  // Tests pass a fixed id and a fake spawner.
  newId?: () => string;
  spawnTool?: SpawnTool;
}

// A change job runs only the decide step, with the owner's request, from the
// current version: the fingerprints come from that version's inputs (exactly
// the outputs its word anchors refer to), so no fixed step runs and none
// writes a step row or moves the reel's status.
export async function changeJob({
  ctx,
  storage,
  keyPrefix,
  scratchDir,
  versions,
  request,
  ai,
  newId,
  spawnTool,
}: ChangeJobRun): Promise<void> {
  if (!request?.trim()) throw new Error("change: job has no request");
  const current = await versions.current(ctx.job.reel_id);
  if (!current) throw new Error("change: no current version");
  const parent = await versions.get(current.id);
  if (!parent) throw new Error("change: no current version");
  await decide({
    ctx,
    storage,
    keyPrefix,
    scratchDir,
    fingerprints: fingerprintsFromInputs(parent.inputs),
    versions,
    request,
    ...(ai ? { ai } : {}),
    ...(newId ? { newId } : {}),
    ...(spawnTool ? { spawnTool } : {}),
  });
}
