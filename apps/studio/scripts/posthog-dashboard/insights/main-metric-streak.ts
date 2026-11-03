import { MAIN_METRIC_MINUTES, STREAK_TARGET } from "../config.ts";
import { type SqlInsight, exportedReelsCte, firstExportsCte, uploadsCte } from "./common.ts";

export const mainMetricStreak: SqlInsight = {
  kind: "sql",
  key: "main-metric-streak",
  name: `Studio: reels in a row under ${MAIN_METRIC_MINUTES} minutes`,
  description:
    `How many of the latest exported reels in a row took under ${MAIN_METRIC_MINUTES} minutes from ` +
    `upload to export. Higher is better; the goal is ${STREAK_TARGET} in a row. A slower reel resets it to 0.`,
  display: "BoldNumber",
  build: (d, t) => `with ${uploadsCte(t)},
${firstExportsCte(t)},
${exportedReelsCte(d)},
ranked as (
  select exported_reels.minutes as minutes,
    row_number() over (order by exported_reels.exported_at desc) as recency
  from exported_reels
)
select coalesce(
  min(case when ranked.minutes >= ${MAIN_METRIC_MINUTES} then ranked.recency else null end) - 1,
  count(*)
) as streak
from ranked`,
};
