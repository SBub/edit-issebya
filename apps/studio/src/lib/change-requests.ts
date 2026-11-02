import { type JobKind, type JobRow, isUnfinished } from "./jobs";
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

export interface ChangeRule {
  // Why a change or a going back cannot be sent now; null when it can.
  blocked: string | null;
  // When it can: what happens to it (it waits its turn in claim_job).
  notice: string | null;
}

// A change or a going back is refused on a refused reel and before the reel
// can have a version; otherwise it is open and waits its turn, since the
// database runs one job per reel at a time, in order (app_docs/failures.md).
export function changeRule(
  reel: Pick<ReelDetail, "status" | "current_version_id">,
  jobs: readonly Pick<JobRow, "kind" | "status">[],
): ChangeRule {
  if (reel.status === "refused") {
    return { blocked: "This clip was refused; upload another.", notice: null };
  }
  const processing = jobs.some((job) => job.kind === "process" && isUnfinished(job));
  if (reel.status === "uploading" || (!reel.current_version_id && !processing)) {
    return { blocked: "Changes open once the reel has a version.", notice: null };
  }
  if (processing) {
    return { blocked: null, notice: "Your change will run after processing finishes." };
  }
  if (jobs.some(isUnfinished)) {
    return { blocked: null, notice: "Your change will run after the current job finishes." };
  }
  return { blocked: null, notice: null };
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
