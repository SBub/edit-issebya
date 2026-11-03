import { type SqlInsight } from "./common.ts";

export const storageTotal: SqlInsight = {
  kind: "sql",
  key: "storage-total",
  name: "Studio: live storage in total",
  description:
    "Total bytes stored right now, with a file shared by several reels counted once, and the " +
    "number of files. Deleted files are not counted.",
  display: "BoldNumber",
  build: (_d, t) => `with live_objects as (
  select stored_files.r2_key as r2_key,
    max(stored_files.bytes) as object_bytes,
    sum(stored_files.bytes) as row_bytes
  from ${t("stored_files")} as stored_files
  where stored_files.deleted_at is null
  group by stored_files.r2_key
)
select coalesce(sum(live_objects.object_bytes), 0) as total_bytes,
  coalesce(sum(live_objects.row_bytes), 0) as per_reel_row_bytes,
  count(*) as live_objects
from live_objects`,
};
