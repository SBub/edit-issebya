import { type SqlInsight } from "./common.ts";

export const storagePerReel: SqlInsight = {
  kind: "sql",
  key: "storage-per-reel",
  name: "Studio: live storage per reel",
  description:
    "Per reel, bytes of its live stored files (deleted_at null). An object two reels share " +
    "counts for each. Source: synced stored_files table.",
  display: "ActionsTable",
  build: (_d, t) => `select stored_files.reel_id as reel_id,
  sum(stored_files.bytes) as live_bytes,
  count(*) as live_files
from ${t("stored_files")} as stored_files
where stored_files.deleted_at is null
group by stored_files.reel_id
order by live_bytes desc, reel_id`,
};
