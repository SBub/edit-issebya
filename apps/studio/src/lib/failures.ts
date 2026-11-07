import type { JobRow } from "./jobs";
import type { ReelDetail } from "./reels";

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

// The line under a job waiting for the AI, with the next try in 24-hour local
// time (the same formatting as the offline line).
export function formatWaitingForAi(reason: string, notBefore: string): string {
  const at = new Date(notBefore);
  return `Waiting for the AI: ${reason}. Next try at ${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}`;
}

// The failed jobs that still show Retry: no other job retries them yet. None
// while the reel is refused (another clip is the only way on).
export function retryableJobIds(
  reel: Pick<ReelDetail, "status">,
  jobs: readonly Pick<JobRow, "id" | "status" | "retry_of_job_id">[],
): string[] {
  if (reel.status === "refused") return [];
  const retried = new Set(jobs.map((job) => job.retry_of_job_id).filter((id) => id !== null));
  return jobs.filter((job) => job.status === "failed" && !retried.has(job.id)).map((job) => job.id);
}

const LIVE_STATUSES: readonly JobRow["status"][] = ["queued", "running", "waiting_ai"];

// What Start over waits for: the reel's processing or other jobs before it,
// in one owner-facing line (the database runs one job per reel at a time, in
// order). Null when nothing is live.
export function startOverQueueNote(jobs: readonly Pick<JobRow, "status">[]): string | null {
  const live = jobs.filter((job) => LIVE_STATUSES.includes(job.status));
  return live.length > 0
    ? "Waiting: your reel is still being styled. Start over starts right after"
    : null;
}
