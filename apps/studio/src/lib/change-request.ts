import type { JobRow } from "./jobs";
import type { ReelStatus } from "./reels";

export const MAX_REQUEST_CHARS = 1000;

export type ParsedChangeRequest = { ok: true; value: string } | { ok: false; reason: string };

// The owner's words, trimmed, 1 to 1000 characters: the same bounds as the
// jobs_request_check constraint, so a refused request never reaches it.
export function parseChangeRequest(raw: unknown): ParsedChangeRequest {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.length === 0) return { ok: false, reason: "Write the change you want first." };
  if (value.length > MAX_REQUEST_CHARS) {
    return { ok: false, reason: `Keep the change under ${MAX_REQUEST_CHARS} characters.` };
  }
  return { ok: true, value };
}

// The interim ordering rule, as the insert policy enforces it: a change or a
// restore only for a processed reel with no queued or running job. A render is
// pinned to its version and never moves the current one, so it does not count
// (as in reel_has_active_job). Null when one may be sent, else the one-line
// reason the controls are disabled.
export function changeBlockedReason(
  status: ReelStatus,
  jobs: Pick<JobRow, "status" | "kind">[],
): string | null {
  if (status !== "processed") return "Changes open once processing has finished.";
  if (
    jobs.some(
      (job) => job.kind !== "render" && (job.status === "queued" || job.status === "running"),
    )
  ) {
    return "Wait for the running job to finish.";
  }
  return null;
}
