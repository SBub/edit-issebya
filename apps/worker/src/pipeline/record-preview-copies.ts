import type { StepContext } from "../step-runner.ts";

// After the fixed steps (preview_copies run or reused): records the
// preview_copies fingerprint on the reel, so the studio's preview finds the
// copies under `cache/preview_copies/<fingerprint>/`. After a lost lease
// nothing is written.
export async function recordPreviewCopies(
  { steps, job, signal }: StepContext,
  fingerprints: Record<string, string>,
): Promise<void> {
  const fingerprint = fingerprints.preview_copies;
  if (!fingerprint) throw new Error("no fingerprint for preview_copies");
  signal.throwIfAborted();
  await steps.previewCopies(job.reel_id, fingerprint);
}
