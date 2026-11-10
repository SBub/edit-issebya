import { type FontPairId, isFontPairId } from "@edit-issebya/edit";
import type { ClaimedJob } from "./queue.ts";

// What each job kind runs, injected so the dispatch is testable without a
// database, storage or AI.
export interface KindRunners {
  // The fixed pipeline, the preview copies, the first version and decide.
  process: () => Promise<void>;
  // Only the restore step, going back to this version.
  restore: (versionId: string) => Promise<void>;
  // The pipeline's hits and the render step, exporting this version.
  render: (versionId: string) => Promise<void>;
  // A library photo's images and its description.
  describe_photo: (photoId: string) => Promise<void>;
  // Start over (temporary, for testing): only the decide step, from version
  // 1 with no request, saved as a new version.
  start_over: () => Promise<void>;
  // The reel's current version placed again in this font pair, with no AI call.
  relayout: (fontPair: FontPairId) => Promise<void>;
}

// Runs the work of one claimed job by its kind. A change job (the change box
// is removed, app_docs/change-requests.md), a restore or a render without a
// version, a describe_photo without a photo, a relayout without a font pair
// and any other kind fail the job.
export function runJobKind(
  job: Pick<ClaimedJob, "kind" | "restore_version_id" | "version_id" | "photo_id" | "font_pair">,
  runners: KindRunners,
): Promise<void> {
  switch (job.kind) {
    case "process":
      return runners.process();
    case "change":
      throw new Error("change jobs are no longer run: the change box is removed");
    case "restore":
      if (!job.restore_version_id) throw new Error("restore job has no version to go back to");
      return runners.restore(job.restore_version_id);
    case "render":
      if (!job.version_id) throw new Error("render job has no version to export");
      return runners.render(job.version_id);
    case "describe_photo":
      if (!job.photo_id) throw new Error("describe_photo job has no photo");
      return runners.describe_photo(job.photo_id);
    case "start_over":
      return runners.start_over();
    case "relayout":
      if (!isFontPairId(job.font_pair)) throw new Error("relayout job has no font pair");
      return runners.relayout(job.font_pair);
    default:
      throw new Error(`unknown job kind: ${job.kind}`);
  }
}
