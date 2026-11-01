import type { ClaimedJob } from "./queue.ts";

// What each job kind runs, injected so the dispatch is testable without a
// database, storage or AI.
export interface KindRunners {
  // The fixed pipeline, the preview copies, the first version and decide.
  process: () => Promise<void>;
  // Only the decide step, with the owner's request.
  change: (request: string) => Promise<void>;
  // Only the restore step, going back to this version.
  restore: (versionId: string) => Promise<void>;
}

// Runs the work of one claimed job by its kind. A change without a request,
// a restore without a version and any other kind fail the job.
export function runJobKind(
  job: Pick<ClaimedJob, "kind" | "request" | "restore_version_id">,
  runners: KindRunners,
): Promise<void> {
  switch (job.kind) {
    case "process":
      return runners.process();
    case "change":
      if (!job.request) throw new Error("change job has no request");
      return runners.change(job.request);
    case "restore":
      if (!job.restore_version_id) throw new Error("restore job has no version to go back to");
      return runners.restore(job.restore_version_id);
    default:
      throw new Error(`unknown job kind: ${job.kind}`);
  }
}
