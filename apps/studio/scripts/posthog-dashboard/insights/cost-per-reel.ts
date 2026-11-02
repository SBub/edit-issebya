import { type SqlInsight } from "./common.ts";
import { costColumns } from "./cost-columns.ts";

export const costPerReel: SqlInsight = {
  kind: "sql",
  key: "cost-per-reel",
  name: "Studio: cost per reel",
  description:
    "Per reel, over every step of every job: wall and CPU seconds, peak memory, bytes in and " +
    "out, AI tokens and the AI cost Claude Code reports. No money is derived from machine time. " +
    "Photo steps (no reel) are left out. Source: synced steps table.",
  display: "ActionsTable",
  build: (_d, t) => `select steps.reel_id as reel_id,
${costColumns()}
from ${t("steps")} as steps
where steps.reel_id is not null
group by steps.reel_id
order by min(steps.started_at)`,
};
