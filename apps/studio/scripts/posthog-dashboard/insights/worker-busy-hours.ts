import { type SqlInsight } from "./common.ts";

export const workerBusyHours: SqlInsight = {
  kind: "sql",
  key: "worker-busy-hours",
  name: "Studio: worker busy hours per day",
  description:
    "By day of the job's start: the hours from started_at to finished_at summed over done and " +
    "failed jobs, and that time over the day's 24 hours. The worker runs one job at a time. A job " +
    "counts whole on the day it started, and a job claimed again after a lost lease counts its " +
    "last attempt only (claim_job overwrites started_at). Source: synced jobs table.",
  display: "ActionsBar",
  xAxis: "day",
  yAxis: ["busy_hours"],
  build: (d, t) => `select ${d.dayOf("jobs.started_at")} as day,
  sum(${d.secondsBetween("jobs.started_at", "jobs.finished_at")}) / 3600.0 as busy_hours,
  sum(${d.secondsBetween("jobs.started_at", "jobs.finished_at")}) / 86400.0 as busy_share,
  count(*) as finished_jobs
from ${t("jobs")} as jobs
where jobs.status in ('done', 'failed') and jobs.started_at is not null and jobs.finished_at is not null
group by ${d.dayOf("jobs.started_at")}
order by day`,
};
