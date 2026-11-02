import type { JobRow } from "./jobs";
import type { ReelDetail } from "./reels";

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

// The line under a job waiting for the AI, with the next try in 24-hour local
// time (the same formatting as the offline line).
export function formatWaitingForAi(reason: string, notBefore: string): string {
  const at = new Date(notBefore);
  return `Waiting for the AI: ${reason}. Next try at ${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}.`;
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

// What a change sent now waits for: the reel's processing, or other jobs
// before it (the database runs one job per reel at a time, in order). Null
// when nothing is ahead of it.
export function changeQueueNote(jobs: readonly Pick<JobRow, "kind" | "status">[]): string | null {
  const live = jobs.filter((job) => LIVE_STATUSES.includes(job.status));
  if (live.some((job) => job.kind === "process")) {
    return "Your change will run after processing finishes.";
  }
  if (live.length > 0) return "Your change will run after the jobs before it finish.";
  return null;
}
