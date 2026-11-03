import { type SqlInsight } from "./common.ts";

export const jobsPerDay: SqlInsight = {
  kind: "sql",
  key: "jobs-per-day",
  name: "Studio: jobs per day, by kind",
  description:
    "How many jobs the worker was given each day, by kind, whatever happened to them. Shows how " +
    "much work comes in.",
  display: "ActionsTable",
  build: (d, t) => `select ${d.dayOf("jobs.created_at")} as day, jobs.kind as job_kind,
  count(*) as jobs
from ${t("jobs")} as jobs
group by ${d.dayOf("jobs.created_at")}, jobs.kind
order by day, job_kind`,
};
