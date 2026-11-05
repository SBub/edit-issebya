import type { JobKind, JobRow } from "./jobs";
import type { ReelDetail } from "./reels";
import type { VersionListRow } from "./versions";

// The longest request the box, the server action and the jobs table accept.
export const MAX_REQUEST_LENGTH = 1000;

export type NormalizedRequest = { ok: true; request: string } | { ok: false; reason: string };

// The owner's words as stored: trimmed, 1 to 1000 characters (the table's
// check says the same).
export function normalizeRequest(text: unknown): NormalizedRequest {
  if (typeof text !== "string") return { ok: false, reason: "Write the change you want" };
  const request = text.trim();
  if (request.length === 0) return { ok: false, reason: "Write the change you want" };
  if (request.length > MAX_REQUEST_LENGTH) {
    return { ok: false, reason: `Keep it to ${MAX_REQUEST_LENGTH} characters` };
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
  if (reel.status === "refused") return "This clip was refused; upload another clip";
  if (reel.status === "uploading") return "Changes open once the upload finishes";
  if (reel.status === "failed" && reel.current_version_id === null) {
    return "Processing failed; press Try again on the preview first";
  }
  return null;
}

// What produced a version, in the owner's words: a going back (`Back to
// vN`), the owner's own request, the first version, or the worker styling on
// its own (the decide run after the first version).
export function versionOrigin(
  version: Pick<VersionListRow, "restored_from_id" | "request" | "parent_id">,
  versionsById: ReadonlyMap<string, Pick<VersionListRow, "number">>,
): string {
  if (version.restored_from_id) {
    const from = versionsById.get(version.restored_from_id);
    return from ? `Back to v${from.number}` : "Back to an earlier version";
  }
  if (version.request) return version.request;
  if (version.parent_id === null) return "First version";
  return "Styled automatically";
}

// A version's one-line title in the versions list. A going back and the first
// version are named by the list itself; otherwise Claude's `change_title`,
// and for versions saved before titles the owner's request (the row truncates
// it) or the automatic note.
export function versionTitle(
  version: Pick<VersionListRow, "restored_from_id" | "request" | "parent_id" | "change_title">,
  versionsById: ReadonlyMap<string, Pick<VersionListRow, "number">>,
): string {
  const origin = versionOrigin(version, versionsById);
  if (version.restored_from_id || (!version.request && version.parent_id === null)) return origin;
  return version.change_title?.trim() || origin;
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
  if (kind === "start_over") return "start over from v1";
  return null;
}
