import { type SqlInsight } from "./common.ts";

// The reel's length in 15-second buckets of its source.
const BUCKET = "floor(reels.source_seconds / 15) * 15";

export const stepTimeVsLength: SqlInsight = {
  kind: "sql",
  key: "step-time-vs-length",
  name: "Studio: time per step against reel length",
  description:
    "How long each step takes for reels of different lengths (in 15-second bands). If time grows " +
    "faster than length, that step will slow down longer reels. Successful runs only.",
  display: "ActionsTable",
  build: (d, t) => `select steps.name as step_name, ${BUCKET} as source_seconds_from,
  count(steps.id) as done_steps,
  ${d.median("steps.wall_ms / 1000.0")} as median_seconds,
  max(steps.wall_ms / 1000.0) as max_seconds,
  ${d.median("steps.wall_ms / 1000.0 / nullif(reels.footage_seconds, 0)")} as median_seconds_per_footage_second
from ${t("steps")} as steps
inner join ${t("reels")} as reels on reels.id = steps.reel_id
where steps.status = 'done' and reels.source_seconds is not null
group by steps.name, ${BUCKET}
order by step_name, source_seconds_from`,
};
