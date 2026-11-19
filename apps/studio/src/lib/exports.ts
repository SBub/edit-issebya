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
  // 48 hours after created_at (set by the database from its one setting,
  // `export_keep_interval()`; rows made before it keep the expiry they got).
  expires_at: string;
}

const LIVE: readonly JobRow["status"][] = ["queued", "running", "waiting_ai"];

type RenderJob = Pick<JobRow, "id" | "kind" | "status">;

// The reel's export in progress: its newest render job still queued, running
// or waiting. One at most in practice (Export is held while one is live).
export function liveRenderJobId(jobs: readonly RenderJob[]): string | null {
  const live = jobs.findLast((job) => job.kind === "render" && LIVE.includes(job.status));
  return live?.id ?? null;
}

// Why editing this reel is off, shown beside every editing control while the
// reel exports (going back, Start over, the font pair, Move text). The export
// renders the current version, and the reel's jobs run one at a time, so an
// edit could only wait behind it. Null when no export is live. Other reels,
// the photo library and uploads are never held.
export const EDITING_OFF_WHILE_EXPORTING =
  "Editing is off while this reel exports. Cancel the export to edit now";

// Said with that reason in the Versions column while the reel exports: only
// Cancel ends an export.
export const LEAVE_WHILE_EXPORTING = "You can leave this page, the export keeps going";

export function exportingReason(jobs: readonly RenderJob[]): string | null {
  return liveRenderJobId(jobs) === null ? null : EDITING_OFF_WHILE_EXPORTING;
}

// Null when Export is open, otherwise the one-line reason shown beside the
// disabled button. One export of a reel at a time.
export function exportBlockedReason(
  reel: Pick<ReelDetail, "status" | "current_version_id">,
  jobs: readonly RenderJob[],
): string | null {
  if (!reel.current_version_id) return "No version to export yet";
  if (reel.status !== "processed") return "Export opens once the reel is processed";
  return liveRenderJobId(jobs) === null ? null : "This reel is already exporting";
}

// The longest a download link lives. A link is signed at the click that uses
// it, so it only has to outlive the start of the download.
const EXPORT_LINK_MAX_SECONDS = 3600;

// How long a download link may be signed for: the whole seconds left until
// `expiresAt` (floored), an hour at most; null when none are left or the date
// does not parse, so a link is never signed past the export's expiry.
export function exportLinkSeconds(expiresAt: string, nowMs: number): number | null {
  const expires = Date.parse(expiresAt);
  if (Number.isNaN(expires)) return null;
  const seconds = Math.floor((expires - nowMs) / 1000);
  return seconds > 0 ? Math.min(seconds, EXPORT_LINK_MAX_SECONDS) : null;
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

// The columns the pages read of an export (never its key).
export const EXPORT_REF_COLUMNS = "id, reel_id, job_id, version_id, created_at, expires_at";

// An export as the pages follow it: enough to know which job it finished,
// which version it holds and until when it is kept.
export interface ExportRef {
  id: string;
  reel_id: string;
  job_id: string;
  version_id: string;
  created_at: string;
  expires_at: string;
}

// The kept export of each reel: its newest export, while its 48 hours have not
// passed (an older one was replaced by it; the worker removes that file). The
// Download icon in the reels list and the Download button on the reel's page
// show exactly while a reel has one.
export function keptExports(rows: readonly ExportRef[], nowMs: number): Map<string, ExportRef> {
  const newest = new Map<string, ExportRef>();
  for (const row of rows) {
    const held = newest.get(row.reel_id);
    if (!held || held.created_at < row.created_at) newest.set(row.reel_id, row);
  }
  for (const [reelId, row] of newest) {
    if (exportLinkSeconds(row.expires_at, nowMs) === null) newest.delete(reelId);
  }
  return newest;
}

// How far the export the page follows is (a pure function of the live rows,
// no reads, no timers):
// - `waiting`: before the render step runs (queued, the pipeline's hits, a
//   cut-out) or after it, until the export row arrives;
// - `rendering`: the render step is running, with its live percent;
// - `ready`: the job's export row arrived, so the file can be fetched;
// - `failed` and `cancelled`: the job ended without an export.
export type ExportProgress =
  | { kind: "waiting"; label: string }
  | { kind: "rendering"; percent: number }
  | { kind: "ready"; exportId: string }
  | { kind: "failed" }
  | { kind: "cancelled" };

export function exportProgress(
  jobId: string,
  jobs: readonly Pick<JobRow, "id" | "status">[],
  steps: readonly Pick<StepRow, "job_id" | "name" | "status" | "progress_percent">[],
  latestExport: Pick<ExportRef, "id" | "job_id"> | null,
): ExportProgress {
  if (latestExport?.job_id === jobId) return { kind: "ready", exportId: latestExport.id };
  const job = jobs.find((candidate) => candidate.id === jobId);
  // Just queued: its row has not arrived over Realtime yet.
  if (!job || job.status === "queued") return { kind: "waiting", label: "waiting to start" };
  if (job.status === "cancelled") return { kind: "cancelled" };
  if (job.status === "failed") return { kind: "failed" };
  if (job.status === "done") return { kind: "waiting", label: "finishing" };
  if (job.status === "waiting_ai") return { kind: "waiting", label: "waiting" };
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
  return { kind: "waiting", label: rendered ? "finishing" : "getting ready" };
}

// Whether the export is still running: it shows its progress and Cancel, and
// only Cancel ends it (leaving the page never does).
export function exportRunning(progress: ExportProgress | null): boolean {
  return progress?.kind === "waiting" || progress?.kind === "rendering";
}

// The line the reel's header shows for a running export is `Exporting… 40%`
// while the render step runs, else `Exporting… <what it waits for>`: this
// lead, then the detail. On a phone only the detail is seen (the lead is read
// out), so the line fits the header's one row.
export const EXPORTING_LEAD = "Exporting…";

export function exportProgressDetail(progress: ExportProgress): string {
  if (progress.kind === "rendering") return `${progress.percent}%`;
  if (progress.kind === "waiting") return progress.label;
  return "";
}
