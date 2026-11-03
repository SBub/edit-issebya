import { type SqlInsight } from "./common.ts";

export const storagePerReel: SqlInsight = {
  kind: "sql",
  key: "storage-per-reel",
  name: "Studio: live storage per reel",
  description:
    "Bytes stored right now for each reel. A file shared by two reels counts for both, so the rows " +
    "can add up to more than the total.",
  display: "ActionsTable",
  build: (_d, t) => `select stored_files.reel_id as reel_id,
  sum(stored_files.bytes) as live_bytes,
  count(*) as live_files
from ${t("stored_files")} as stored_files
where stored_files.deleted_at is null and stored_files.reel_id is not null
group by stored_files.reel_id
order by live_bytes desc, reel_id`,
};
