import { type SqlInsight, uploadsCte } from "./common.ts";

export const completion: SqlInsight = {
  kind: "sql",
  key: "completion",
  name: "Studio: uploaded and exported reels, by week",
  description:
    "Each week: reels uploaded, and how many of those were exported. The closer the two bars, " +
    "the more uploads end as a finished reel.",
  display: "ActionsBar",
  xAxis: "week",
  yAxis: ["uploaded_reels", "exported_reels"],
  build: (d, t) => `with ${uploadsCte(t)}
select ${d.weekOf("uploads.uploaded_at")} as week,
  count(*) as uploaded_reels,
  sum(case when uploads.reel_id in (select exports.reel_id from ${t("exports")} as exports) then 1 else 0 end) as exported_reels,
  sum(case when uploads.reel_id in (select exports.reel_id from ${t("exports")} as exports) then 1 else 0 end) * 1.0 / count(*) as completion
from uploads
group by ${d.weekOf("uploads.uploaded_at")}
order by week`,
};
