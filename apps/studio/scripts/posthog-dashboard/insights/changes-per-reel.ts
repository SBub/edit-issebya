import { type SqlInsight, firstExportsCte } from "./common.ts";

export const changesPerReel: SqlInsight = {
  kind: "sql",
  key: "changes-per-reel",
  name: "Studio: change requests per exported reel, by week",
  description:
    "Per exported reel, the change jobs created before its first export; averaged by the week " +
    "of that first export. Source: synced jobs and exports tables.",
  display: "ActionsBar",
  xAxis: "week",
  yAxis: ["changes_per_reel"],
  build: (d, t) => `with ${firstExportsCte(t)},
reel_changes as (
  select first_exports.reel_id as reel_id, first_exports.exported_at as exported_at,
    sum(case when jobs.kind = 'change' and jobs.created_at < first_exports.exported_at then 1 else 0 end) as change_requests
  from first_exports
  inner join ${t("jobs")} as jobs on jobs.reel_id = first_exports.reel_id
  group by first_exports.reel_id, first_exports.exported_at
)
select ${d.weekOf("reel_changes.exported_at")} as week,
  sum(reel_changes.change_requests) * 1.0 / count(*) as changes_per_reel,
  count(*) as exported_reels
from reel_changes
group by ${d.weekOf("reel_changes.exported_at")}
order by week`,
};
