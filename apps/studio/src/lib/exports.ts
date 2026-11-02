import type { JobRow } from "./jobs";
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
  // Exactly 24 hours after created_at (set by the database).
  expires_at: string;
}

// Null when Export is open, otherwise the one-line reason shown beside the
// disabled button. Only a render of the current version holds it: a change
// or a render of an older version does not.
export function exportBlockedReason(
  reel: Pick<ReelDetail, "status" | "current_version_id">,
  jobs: readonly Pick<JobRow, "kind" | "status" | "version_id">[],
): string | null {
  if (!reel.current_version_id) return "No version to export yet.";
  if (reel.status !== "processed") return "Export opens once the reel is processed.";
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

export type ExportView =
  { kind: "none" } | { kind: "expired" } | { kind: "ready"; seconds: number };

export function exportView(row: Pick<ExportRow, "expires_at"> | null, nowMs: number): ExportView {
  if (!row) return { kind: "none" };
  const seconds = exportLinkSeconds(row.expires_at, nowMs);
  return seconds === null ? { kind: "expired" } : { kind: "ready", seconds };
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
