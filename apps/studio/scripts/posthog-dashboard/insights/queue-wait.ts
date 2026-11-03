import { type SqlInsight } from "./common.ts";

export const queueWait: SqlInsight = {
  kind: "sql",
  key: "queue-wait",
  name: "Studio: queue wait per kind, by week (approximate)",
  description:
    "Minutes jobs wait before the worker starts them, per kind and week: typical (median) and slow " +
    "(95th percentile). Lower is better. Approximate: a restarted job's wait includes its lost " +
    "try, and a job also waits for earlier jobs of its reel.",
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
