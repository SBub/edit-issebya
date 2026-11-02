import { FIRST_PREVIEW_MINUTES } from "../config.ts";
import { type SqlInsight, firstVersionsCte, uploadsCte } from "./common.ts";

export const firstPreview: SqlInsight = {
  kind: "sql",
  key: "first-preview",
  name: "Studio: upload to first preview, minutes per reel",
  description:
    `Per reel with a version, minutes from upload (its earliest process job) to version 1 ` +
    `(the player shows a reel only once a version exists). Target: under ` +
    `${FIRST_PREVIEW_MINUTES} minutes. Source: synced jobs and versions tables.`,
  display: "ActionsBar",
  xAxis: "previewed_at",
  yAxis: ["minutes"],
  goal: { label: `${FIRST_PREVIEW_MINUTES} minutes`, value: FIRST_PREVIEW_MINUTES },
  build: (d, t) => `with ${uploadsCte(t)},
${firstVersionsCte(t)}
select uploads.reel_id as reel_id, first_versions.previewed_at as previewed_at,
  ${d.minutesBetween("uploads.uploaded_at", "first_versions.previewed_at")} as minutes
from uploads
inner join first_versions on first_versions.reel_id = uploads.reel_id
order by first_versions.previewed_at`,
};
