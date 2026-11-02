import { type SqlInsight } from "./common.ts";

export const storageTotal: SqlInsight = {
  kind: "sql",
  key: "storage-total",
  name: "Studio: live storage in total",
  description:
    "Bytes of distinct live objects (r2_key with a row whose deleted_at is null): an object two " +
    "reels share counts once. Also the per-reel-row sum and the object count. Source: synced " +
    "stored_files table.",
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
