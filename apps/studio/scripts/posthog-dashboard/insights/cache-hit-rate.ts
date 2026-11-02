import { type SqlInsight } from "./common.ts";

export const cacheHitRate: SqlInsight = {
  kind: "sql",
  key: "cache-hit-rate",
  name: "Studio: cache hit rate, by week",
  description:
    "By week of the step's start: cache hits (steps recorded skipped with cache_hit true) over " +
    "finished steps (done, failed or skipped; running and waiting excluded), and the rate to " +
    "date (the last row is the total). Source: synced steps table.",
  display: "ActionsLineGraph",
  xAxis: "week",
  yAxis: ["hit_rate", "hit_rate_to_date"],
  build: (d, t) => `with weekly as (
  select ${d.weekOf("steps.started_at")} as week,
    sum(case when steps.cache_hit then 1 else 0 end) as cache_hits,
    count(*) as finished_steps
  from ${t("steps")} as steps
  where steps.status in ('done', 'failed', 'skipped')
  group by ${d.weekOf("steps.started_at")}
)
select weekly.week as week, weekly.cache_hits as cache_hits, weekly.finished_steps as finished_steps,
  weekly.cache_hits * 1.0 / weekly.finished_steps as hit_rate,
  sum(weekly.cache_hits) over (order by weekly.week) * 1.0
    / sum(weekly.finished_steps) over (order by weekly.week) as hit_rate_to_date
from weekly
order by weekly.week`,
};
