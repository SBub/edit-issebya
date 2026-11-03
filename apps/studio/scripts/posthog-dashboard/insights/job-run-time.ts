import { type SqlInsight } from "./common.ts";

export const jobRunTime: SqlInsight = {
  kind: "sql",
  key: "job-run-time",
  name: "Studio: job run time per kind, by week",
  description:
    "By week of the job's start and job kind, over done jobs: the median and 95th percentile " +
    "minutes from started_at to finished_at. claim_job overwrites started_at when a job is " +
    "claimed again after a lost lease, so such a job counts its last attempt only. " +
    "Source: synced jobs table.",
  display: "ActionsTable",
  build: (d, t) => `select ${d.weekOf("jobs.started_at")} as week, jobs.kind as job_kind,
  count(*) as done_jobs,
  ${d.median(d.minutesBetween("jobs.started_at", "jobs.finished_at"))} as median_minutes,
  ${d.quantile(0.95, d.minutesBetween("jobs.started_at", "jobs.finished_at"))} as p95_minutes
from ${t("jobs")} as jobs
where jobs.status = 'done' and jobs.started_at is not null and jobs.finished_at is not null
group by ${d.weekOf("jobs.started_at")}, jobs.kind
order by week, job_kind`,
};
