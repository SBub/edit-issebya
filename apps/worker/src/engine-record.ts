import type { EngineNote } from "@edit-issebya/edit";

// The engine record as one log line per version: every note as
// `item action (rule): reason`, or `nothing moved`.
export function engineRecordLine(
  reelId: string,
  number: number,
  record: readonly EngineNote[],
): string {
  const notes =
    record.length === 0
      ? "nothing moved"
      : record
          .map((note) => `${note.item} ${note.action} (${note.rule}): ${note.reason}`)
          .join("; ");
  return `engine record, reel ${reelId}, version ${number}: ${notes}`;
}
