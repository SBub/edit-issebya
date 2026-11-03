import type { JobRow, StepRow } from "./jobs";
import type { ReelDetail } from "./reels";

// Named columns, never "*".
export const EXPORT_COLUMNS =
  "id, reel_id, job_id, version_id, r2_key, bytes, created_at, expires_at";

export interface ExportRow {
  id: string;
  reel_id: string;
  job_id: string;
  version_id: string;
  r2_key: string;
  bytes: number;
  created_at: string;
  // Exactly 1 hour after created_at (set by the database; rows made before the
  // one-step export keep their 24 hours).
  expires_at: string;
}

// Null when Export is open, otherwise the one-line reason shown beside the
// disabled button. Only a render of the current version holds it: a change
// or a render of an older version does not.
export function exportBlockedReason(
  reel: Pick<ReelDetail, "status" | "current_version_id">,
  jobs: readonly Pick<JobRow, "kind" | "status" | "version_id">[],
): string | null {
  if (!reel.current_version_id) return "No version to export yet";
  if (reel.status !== "processed") return "Export opens once the reel is processed";
  const exporting = jobs.some(
    (job) =>
      job.kind === "render" &&
      job.version_id === reel.current_version_id &&
      (job.status === "queued" || job.status === "running"),
  );
  return exporting ? "Exporting this version..." : null;
}

// Whole seconds left until `expiresAt` (floored), the longest a download
// link may be signed for; null when none are left or the date does not parse,
// so a link is never signed past the export's expiry.
export function exportLinkSeconds(expiresAt: string, nowMs: number): number | null {
  const expires = Date.parse(expiresAt);
  if (Number.isNaN(expires)) return null;
  const seconds = Math.floor((expires - nowMs) / 1000);
  return seconds > 0 ? seconds : null;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const EXPORT_KEY = new RegExp(`^(?:[a-z0-9_-]+/)*exports/(${UUID})/${UUID}\\.mp4$`);

// A storage key the worker writes for this reel's export:
// `<prefix>exports/<reel_id>/<export_id>.mp4`.
export function isExportKey(key: string, reelId: string): boolean {
  const match = EXPORT_KEY.exec(key);
  return match !== null && match[1] === reelId.toLowerCase();
}

const pad = (n: number) => String(n).padStart(2, "0");

// `reel-v<N>-<YYYYMMDD-HHMM>.mp4` in UTC: safe as a download name.
export function exportFileName(versionNumber: number, createdAt: string): string {
  const date = new Date(createdAt);
  const stamp = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;
  return `reel-v${versionNumber}-${stamp}.mp4`;
}

// The newest export of the reel as the page follows it: enough to know which
// job it finished.
export interface ExportRef {
  id: string;
  job_id: string;
}

// What the export modal shows for the render job it follows (a pure function
// of the live rows, no reads, no timers):
// - `waiting`: before the render step runs (queued, the pipeline's hits, a
//   cut-out) or after it, until the export row arrives: an indeterminate bar
//   with a short plain label;
// - `rendering`: the render step is running, with its live percent;
// - `ready`: the job's export row arrived, so the file can be fetched;
// - `failed` and `cancelled`: the job ended without an export.
export type ExportModalState =
  | { kind: "waiting"; label: string }
  | { kind: "rendering"; percent: number }
  | { kind: "ready"; exportId: string }
  | { kind: "failed" }
  | { kind: "cancelled" };

export function exportModalState(
  jobId: string,
  jobs: readonly Pick<JobRow, "id" | "status">[],
  steps: readonly Pick<StepRow, "job_id" | "name" | "status" | "progress_percent">[],
  latestExport: ExportRef | null,
): ExportModalState {
  if (latestExport?.job_id === jobId) return { kind: "ready", exportId: latestExport.id };
  const job = jobs.find((candidate) => candidate.id === jobId);
  // Just queued: its row has not arrived over Realtime yet.
  if (!job || job.status === "queued") return { kind: "waiting", label: "Waiting to start" };
  if (job.status === "cancelled") return { kind: "cancelled" };
  if (job.status === "failed") return { kind: "failed" };
  if (job.status === "done") return { kind: "waiting", label: "Finishing" };
  if (job.status === "waiting_ai") return { kind: "waiting", label: "Waiting" };
  const render = steps.findLast(
    (step) => step.job_id === jobId && step.name === "render" && step.status === "running",
  );
  if (render) {
    const percent = Math.min(100, Math.max(0, Math.round(render.progress_percent ?? 0)));
    return { kind: "rendering", percent };
  }
  const rendered = steps.some(
    (step) => step.job_id === jobId && step.name === "render" && step.status === "done",
  );
  return { kind: "waiting", label: rendered ? "Finishing" : "Getting ready" };
}

// Whether the modal's job may still be cancelled (closing the modal cancels
// it): it is live and has no export yet.
export function exportCancellable(state: ExportModalState): boolean {
  return state.kind === "waiting" || state.kind === "rendering";
}

// The render job a page opened during an export follows again: the newest
// render of the current version still queued, running or waiting for the AI.
export function liveRenderJobId(
  reel: Pick<ReelDetail, "current_version_id">,
  jobs: readonly Pick<JobRow, "id" | "kind" | "status" | "version_id">[],
): string | null {
  const live = jobs.findLast(
    (job) =>
      job.kind === "render" &&
      job.version_id === reel.current_version_id &&
      (job.status === "queued" || job.status === "running" || job.status === "waiting_ai"),
  );
  return live?.id ?? null;
}
