import { type SqlInsight } from "./common.ts";

export const storagePerStep: SqlInsight = {
  kind: "sql",
  key: "storage-per-step",
  name: "Studio: live storage per step",
  description:
    "Bytes stored right now, by the step that made the files: shows which step fills storage most. " +
    "A file shared by two reels counts for both.",
  display: "ActionsTable",
  build: (_d, t) => `select stored_files.step as step_name,
  sum(stored_files.bytes) as live_bytes,
  count(*) as live_files
from ${t("stored_files")} as stored_files
where stored_files.deleted_at is null
group by stored_files.step
order by live_bytes desc, step_name`,
};
