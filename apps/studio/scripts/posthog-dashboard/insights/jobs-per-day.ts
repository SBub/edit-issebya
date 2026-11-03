import { type SqlInsight } from "./common.ts";

export const jobsPerDay: SqlInsight = {
  kind: "sql",
  key: "jobs-per-day",
  name: "Studio: jobs per day, by kind",
  description:
    "By day of the job's creation and job kind: how many jobs were queued, whatever their status " +
    "now, so the work the worker was asked to do. Source: synced jobs table.",
  display: "ActionsTable",
  build: (d, t) => `select ${d.dayOf("jobs.created_at")} as day, jobs.kind as job_kind,
  count(*) as jobs
from ${t("jobs")} as jobs
group by ${d.dayOf("jobs.created_at")}, jobs.kind
order by day, job_kind`,
};
