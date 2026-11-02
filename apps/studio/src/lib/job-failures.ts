import type { JobRow } from "./jobs";
import type { ReelDetail } from "./reels";

// `Waiting for the AI: <reason>. Next try at HH:MM.`, the time in 24 hours in
// the given zone (the browser's when none is given).
export function waitingForAiLine(
  job: Pick<JobRow, "waiting_reason" | "not_before">,
  timeZone?: string,
): string | null {
  if (!job.waiting_reason || !job.not_before) return null;
  const at = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(new Date(job.not_before));
  return `Waiting for the AI: ${job.waiting_reason}. Next try at ${at}.`;
}

// A failed job may be retried once, unless its reel's footage was refused
// (another upload is the way on).
export function canRetry(
  job: Pick<JobRow, "id" | "status">,
  jobs: readonly Pick<JobRow, "retry_of_job_id">[],
  reel: Pick<ReelDetail, "status">,
): boolean {
  if (job.status !== "failed" || reel.status === "refused") return false;
  return !jobs.some((other) => other.retry_of_job_id === job.id);
}

// True when a later job retries this one.
export function isRetried(
  job: Pick<JobRow, "id">,
  jobs: readonly Pick<JobRow, "retry_of_job_id">[],
): boolean {
  return jobs.some((other) => other.retry_of_job_id === job.id);
}
