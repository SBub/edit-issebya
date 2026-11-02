import { type SqlInsight } from "./common.ts";

export const storagePerStep: SqlInsight = {
  kind: "sql",
  key: "storage-per-step",
  name: "Studio: live storage per step",
  description:
    "Per step that made the file, bytes of live stored files (deleted_at null), per reel row. " +
    "Source: synced stored_files table.",
  display: "ActionsTable",
  build: (_d, t) => `select stored_files.step as step_name,
  sum(stored_files.bytes) as live_bytes,
  count(*) as live_files
from ${t("stored_files")} as stored_files
where stored_files.deleted_at is null
group by stored_files.step
order by live_bytes desc, step_name`,
};
