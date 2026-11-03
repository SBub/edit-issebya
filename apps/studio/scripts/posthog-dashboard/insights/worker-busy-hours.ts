import { type SqlInsight } from "./common.ts";

export const workerBusyHours: SqlInsight = {
  kind: "sql",
  key: "worker-busy-hours",
  name: "Studio: worker busy hours per day",
  description:
    "Hours each day the worker spent running jobs, and that as a share of 24 hours. Close to 24 " +
    "means it is at capacity. Approximate: a restarted job counts only its last try.",
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
