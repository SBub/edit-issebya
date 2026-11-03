import { type SqlInsight } from "./common.ts";

export const failedSteps: SqlInsight = {
  kind: "sql",
  key: "failed-steps",
  name: "Studio: failed steps, by step and week",
  description:
    "Share of runs that failed, per step and week. Lower is better; a rising share points to the " +
    "step to fix.",
  display: "ActionsTable",
  build: (d, t) => `select ${d.weekOf("steps.started_at")} as week, steps.name as step_name,
  sum(case when steps.status = 'failed' then 1 else 0 end) as failed_steps,
  count(*) as finished_steps,
  sum(case when steps.status = 'failed' then 1 else 0 end) * 1.0 / count(*) as failed_share
from ${t("steps")} as steps
where steps.status in ('done', 'failed')
group by ${d.weekOf("steps.started_at")}, steps.name
order by week, step_name`,
};
