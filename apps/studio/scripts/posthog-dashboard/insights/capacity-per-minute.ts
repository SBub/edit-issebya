import { type SqlInsight } from "./common.ts";

// Per minute of the reel's source (reels.source_seconds), not of its retimed
// footage: the source is what the owner uploads, so it is the unit a server
// must absorb, and it is recorded after check_footage, before every step that
// does heavy work (app_docs/dashboard.md).
export const capacityPerMinute: SqlInsight = {
  kind: "sql",
  key: "capacity-per-minute",
  name: "Studio: CPU per source minute and peak memory, per step",
  description:
    "Per step: typical CPU seconds for each minute of uploaded video, and the most memory it used. " +
    "Use it to size a server. Raw machine measurements, no money.",
  display: "ActionsTable",
  build: (d, t) => `select steps.name as step_name,
  count(steps.id) as done_steps,
  ${d.median("steps.cpu_ms / 1000.0 / (reels.source_seconds / 60.0)")} as median_cpu_seconds_per_source_minute,
  max(steps.peak_rss_bytes) as max_peak_memory_bytes
from ${t("steps")} as steps
inner join ${t("reels")} as reels on reels.id = steps.reel_id
where steps.status = 'done' and not steps.cache_hit and reels.source_seconds is not null
group by steps.name
order by step_name`,
};
