import type { JobKind, JobRow } from "./jobs";
import type { ReelDetail } from "./reels";
import type { VersionListRow } from "./versions";

// A going back or a Start over may be sent while the reel is processing or
// other jobs run: the database runs one job per reel at a time, in order
// (lib/failures startOverQueueNote says what Start over waits for). Blocked
// only when no job could ever use it. Null when open, otherwise the one-line
// reason shown beside the disabled control.
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

// The title of a version the owner made by moving or resizing text
// (app_docs/owner-edits.md).
const EDITED_BY_YOU = "Edited by you";

// A version row's origin columns; `edited_from_id` is absent on rows read
// before it existed.
type OriginColumns = Pick<VersionListRow, "restored_from_id" | "request" | "parent_id"> &
  Partial<Pick<VersionListRow, "edited_from_id">>;

// What produced a version, in the owner's words: a going back (`Back to
// vN`), the owner's own moves (`Edited by you`), the owner's own request, the
// first version, or the worker styling on its own (the decide run after the
// first version).
export function versionOrigin(
  version: OriginColumns,
  versionsById: ReadonlyMap<string, Pick<VersionListRow, "number">>,
): string {
  if (version.restored_from_id) {
    const from = versionsById.get(version.restored_from_id);
    return from ? `Back to v${from.number}` : "Back to an earlier version";
  }
  if (version.edited_from_id) return EDITED_BY_YOU;
  if (version.request) return version.request;
  if (version.parent_id === null) return "First version";
  return "Styled automatically";
}

// The second line of an edited version's details: the version the owner's
// moves started from. Null for every other version.
export function editedFromLabel(
  version: Partial<Pick<VersionListRow, "edited_from_id" | "restored_from_id">>,
  versionsById: ReadonlyMap<string, Pick<VersionListRow, "number">>,
): string | null {
  if (!version.edited_from_id || version.restored_from_id) return null;
  const from = versionsById.get(version.edited_from_id);
  return from ? `You moved or resized text in v${from.number}` : "You moved or resized text";
}

// A version's one-line title in the versions list. A going back, the owner's
// own edit and the first version are named by the list itself; otherwise Claude's `change_title`,
// and for versions saved before titles the owner's request (the row truncates
// it) or the automatic note.
export function versionTitle(
  version: OriginColumns & Pick<VersionListRow, "change_title">,
  versionsById: ReadonlyMap<string, Pick<VersionListRow, "number">>,
): string {
  const origin = versionOrigin(version, versionsById);
  if (
    version.restored_from_id ||
    version.edited_from_id ||
    (!version.request && version.parent_id === null)
  ) {
    return origin;
  }
  return version.change_title?.trim() || origin;
}

// What a job was asked to do, for its line in the jobs list; null for a
// process job.
export function jobRequestLabel(
  job: Pick<JobRow, "kind" | "request" | "restore_version_id" | "version_id">,
  versionsById: ReadonlyMap<string, Pick<VersionListRow, "number">>,
): string | null {
  const kind = job.kind as JobKind;
  if (kind === "restore" && job.restore_version_id) {
    const to = versionsById.get(job.restore_version_id);
    return to ? `go back to v${to.number}` : "go back to an earlier version";
  }
  if (kind === "render") {
    const of = job.version_id ? versionsById.get(job.version_id) : undefined;
    return of ? `export of v${of.number}` : "export";
  }
  if (kind === "start_over") return "start over from v1";
  if (kind === "owner_edit") return "your moves";
  return null;
}
