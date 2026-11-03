import { type SqlInsight } from "./common.ts";
import { costColumns } from "./cost-columns.ts";

export const costPerReel: SqlInsight = {
  kind: "sql",
  key: "cost-per-reel",
  name: "Studio: cost per reel",
  description:
    "One row per reel: machine time, memory, data moved, AI tokens and the AI cost Claude reports. " +
    "Higher means the reel cost more to make. Machine time is not turned into money.",
  display: "ActionsTable",
  build: (_d, t) => `select steps.reel_id as reel_id,
${costColumns()}
from ${t("steps")} as steps
where steps.reel_id is not null
group by steps.reel_id
order by min(steps.started_at)`,
};
