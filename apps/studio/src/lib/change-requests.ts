import type { JobKind, JobRow } from "./jobs";
import type { ReelDetail } from "./reels";
import type { VersionListRow } from "./versions";

// The longest request the box, the server action and the jobs table accept.
export const MAX_REQUEST_LENGTH = 1000;

export type NormalizedRequest = { ok: true; request: string } | { ok: false; reason: string };

// The owner's words as stored: trimmed, 1 to 1000 characters (the table's
// check says the same).
export function normalizeRequest(text: unknown): NormalizedRequest {
  if (typeof text !== "string") return { ok: false, reason: "Write the change you want." };
  const request = text.trim();
  if (request.length === 0) return { ok: false, reason: "Write the change you want." };
  if (request.length > MAX_REQUEST_LENGTH) {
    return { ok: false, reason: `Keep it to ${MAX_REQUEST_LENGTH} characters.` };
  }
  return { ok: true, request };
}

// Interim rule, until jobs are ordered in the database: a change or a going
// back opens only on a processed reel with no job queued or running. Null
// when open, otherwise the one-line reason shown beside the disabled control.
export function changeBlockedReason(
  reel: Pick<ReelDetail, "status">,
  jobs: readonly Pick<JobRow, "status">[],
): string | null {
  if (jobs.some((job) => job.status === "queued" || job.status === "running")) {
    return "A job is running on this reel; wait for it to finish.";
  }
  if (reel.status !== "processed") return "Changes open once the reel is processed.";
  return null;
}

// What produced a version: a going back, the owner's words, or the worker on
// its own.
export function versionOrigin(
  version: Pick<VersionListRow, "restored_from_id" | "request">,
  versionsById: ReadonlyMap<string, Pick<VersionListRow, "number">>,
): string {
  if (version.restored_from_id) {
    const from = versionsById.get(version.restored_from_id);
    return from ? `restored from v${from.number}` : "restored from an earlier version";
  }
  if (version.request) return `"${version.request}"`;
  return "automatic";
}

// What a job was asked to do, for its line in the jobs list; null for a
// process job.
export function jobRequestLabel(
  job: Pick<JobRow, "kind" | "request" | "restore_version_id">,
  versionsById: ReadonlyMap<string, Pick<VersionListRow, "number">>,
): string | null {
  const kind = job.kind as JobKind;
  if (kind === "change" && job.request) return `"${job.request}"`;
  if (kind === "restore" && job.restore_version_id) {
    const to = versionsById.get(job.restore_version_id);
    return to ? `go back to v${to.number}` : "go back to an earlier version";
  }
  return null;
}
