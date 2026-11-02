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

// A change or a going back may be sent while the reel is processing or other
// jobs run: the database runs one job per reel at a time, in order
// (lib/failures changeQueueNote says what it waits for). Blocked only when no
// job could ever use it. Null when open, otherwise the one-line reason shown
// beside the disabled control.
export function changeBlockedReason(
  reel: Pick<ReelDetail, "status" | "current_version_id">,
): string | null {
  if (reel.status === "refused") return "This clip was refused; upload another clip.";
  if (reel.status === "uploading") return "Changes open once the upload finishes.";
  if (reel.status === "failed" && reel.current_version_id === null) {
    return "Processing failed; press Retry on the failed job first.";
  }
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
  job: Pick<JobRow, "kind" | "request" | "restore_version_id" | "version_id">,
  versionsById: ReadonlyMap<string, Pick<VersionListRow, "number">>,
): string | null {
  const kind = job.kind as JobKind;
  if (kind === "change" && job.request) return `"${job.request}"`;
  if (kind === "restore" && job.restore_version_id) {
    const to = versionsById.get(job.restore_version_id);
    return to ? `go back to v${to.number}` : "go back to an earlier version";
  }
  if (kind === "render") {
    const of = job.version_id ? versionsById.get(job.version_id) : undefined;
    return of ? `export of v${of.number}` : "export";
  }
  return null;
}
