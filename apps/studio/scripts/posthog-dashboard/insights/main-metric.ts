import { MAIN_METRIC_MINUTES } from "../config.ts";
import { type SqlInsight, exportedReelsCte, firstExportsCte, uploadsCte } from "./common.ts";

export const mainMetric: SqlInsight = {
  kind: "sql",
  key: "main-metric",
  name: "Studio: upload to export, minutes per reel",
  description:
    `The main metric: per exported reel, minutes from upload (its earliest process job) to its ` +
    `first export (earliest exports row, so the render is included). Target: under ` +
    `${MAIN_METRIC_MINUTES} minutes. Source: synced jobs and exports tables.`,
  display: "ActionsBar",
  xAxis: "exported_at",
  yAxis: ["minutes"],
  goal: { label: `${MAIN_METRIC_MINUTES} minutes`, value: MAIN_METRIC_MINUTES },
  build: (d, t) => `with ${uploadsCte(t)},
${firstExportsCte(t)},
${exportedReelsCte(d)}
select exported_reels.reel_id as reel_id, exported_reels.exported_at as exported_at,
  exported_reels.minutes as minutes
from exported_reels
order by exported_reels.exported_at`,
};
