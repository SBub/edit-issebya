import { type SqlInsight } from "./common.ts";

export const aiWaitShare: SqlInsight = {
  kind: "sql",
  key: "ai-wait-share",
  name: "Studio: share of worker time waiting on Claude, by week",
  description:
    "Share of worker time spent on steps that call Claude, by week. Higher means Claude, not the " +
    "Mac, is the bottleneck. An upper bound: the whole step counts, not only the wait.",
  display: "ActionsLineGraph",
  xAxis: "week",
  yAxis: ["ai_share"],
  build: (d, t) => `select ${d.weekOf("steps.started_at")} as week,
  sum(case when steps.ai_model is not null then steps.wall_ms else 0 end) / 1000.0 as ai_wall_seconds,
  sum(steps.wall_ms) / 1000.0 as wall_seconds,
  sum(case when steps.ai_model is not null then steps.wall_ms else 0 end) * 1.0
    / nullif(sum(steps.wall_ms), 0) as ai_share
from ${t("steps")} as steps
where steps.wall_ms is not null
group by ${d.weekOf("steps.started_at")}
order by week`,
};
