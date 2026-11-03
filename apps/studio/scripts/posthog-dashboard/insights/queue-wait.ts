import { type SqlInsight } from "./common.ts";

export const queueWait: SqlInsight = {
  kind: "sql",
  key: "queue-wait",
  name: "Studio: queue wait per kind, by week (approximate)",
  description:
    "Approximate. By week of the job's creation and job kind, over jobs the worker has claimed: " +
    "the median and 95th percentile minutes from created_at to started_at. claim_job overwrites " +
    "started_at when a job is claimed again after a lost lease, so such a job's wait includes " +
    "its lost attempt. A job also waits while an older job of its reel or photo runs, not only " +
    "while the worker is busy. Source: synced jobs table.",
  display: "ActionsTable",
  build: (d, t) => `select ${d.weekOf("jobs.created_at")} as week, jobs.kind as job_kind,
  count(*) as claimed_jobs,
  ${d.median(d.minutesBetween("jobs.created_at", "jobs.started_at"))} as median_wait_minutes,
  ${d.quantile(0.95, d.minutesBetween("jobs.created_at", "jobs.started_at"))} as p95_wait_minutes
from ${t("jobs")} as jobs
where jobs.started_at is not null
group by ${d.weekOf("jobs.created_at")}, jobs.kind
order by week, job_kind`,
};
