import type { Storage } from "@edit-issebya/storage";
import type { JobRow } from "./jobs";
import type { ReelStatus } from "./reels";

// Named columns, never "*", and no r2_key: the browser never sees where the
// file is stored, only a signed link to it.
export const EXPORT_COLUMNS = "id, reel_id, job_id, version_id, bytes, created_at, expires_at";

export interface ExportRow {
  id: string;
  reel_id: string;
  job_id: string;
  version_id: string;
  bytes: number;
  created_at: string;
  // Always created_at + 24 hours (the exports_set_expiry trigger).
  expires_at: string;
}

// The newest export by created_at (ISO timestamps sort as strings), id
// breaking ties; null when there is none.
export function latestExport<T extends Pick<ExportRow, "id" | "created_at">>(rows: T[]): T | null {
  let latest: T | null = null;
  for (const row of rows) {
    if (
      latest === null ||
      row.created_at > latest.created_at ||
      (row.created_at === latest.created_at && row.id > latest.id)
    ) {
      latest = row;
    }
  }
  return latest;
}

export type ExportView =
  { state: "none" } | { state: "ready"; msLeft: number } | { state: "expired" };

// What the panel shows for the newest export at `now`: expired from the exact
// instant of expires_at.
export function exportView(row: Pick<ExportRow, "expires_at"> | null, now: Date): ExportView {
  if (!row) return { state: "none" };
  const msLeft = Date.parse(row.expires_at) - now.getTime();
  return msLeft > 0 ? { state: "ready", msLeft } : { state: "expired" };
}

// Null when an export of this version may be queued, else the one-line reason
// the Export button is disabled. Mirrors the render insert policy: a processed
// reel, a current version, no queued or running render of that version.
export function exportBlockedReason(
  status: ReelStatus,
  jobs: Pick<JobRow, "status" | "kind" | "version_id">[],
  versionId: string | null,
): string | null {
  if (status !== "processed") return "Export opens once processing has finished.";
  if (!versionId) return "No version to export yet.";
  if (
    jobs.some(
      (job) =>
        job.kind === "render" &&
        job.version_id === versionId &&
        (job.status === "queued" || job.status === "running"),
    )
  ) {
    return "Exporting this version.";
  }
  return null;
}

// A download link never lives longer than an hour, like the preview's.
export const DOWNLOAD_URL_MAX_SECONDS = 3600;

// Whole seconds left until expires_at, capped at the maximum; null when less
// than one second is left, so a link is never signed past the export's life.
export function downloadSeconds(expiresAt: string, now: Date): number | null {
  const seconds = Math.floor((Date.parse(expiresAt) - now.getTime()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 1) return null;
  return Math.min(seconds, DOWNLOAD_URL_MAX_SECONDS);
}

const pad = (n: number) => String(n).padStart(2, "0");

// `reel-<first 8 of the reel id>-<yyyymmdd-hhmm of created_at, UTC>.mp4`.
export function exportFileName(reelId: string, createdAt: string): string {
  const at = new Date(createdAt);
  const stamp = `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}`;
  return `reel-${reelId.slice(0, 8).toLowerCase()}-${stamp}.mp4`;
}

// The signed attachment link for an export, or null without signing anything
// once it has expired. The link lives at most the time the export has left.
export async function signExportDownload(
  storage: Pick<Storage, "signDownload">,
  row: { r2_key: string; reel_id: string; created_at: string; expires_at: string },
  now: Date,
): Promise<string | null> {
  const expiresInSeconds = downloadSeconds(row.expires_at, now);
  if (expiresInSeconds === null) return null;
  return storage.signDownload(row.r2_key, {
    expiresInSeconds,
    fileName: exportFileName(row.reel_id, row.created_at),
  });
}
