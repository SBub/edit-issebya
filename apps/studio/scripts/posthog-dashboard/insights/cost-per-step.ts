import { type SqlInsight } from "./common.ts";
import { costColumns } from "./cost-columns.ts";

export const costPerStep: SqlInsight = {
  kind: "sql",
  key: "cost-per-step",
  name: "Studio: cost per step",
  description:
    "The same totals as cost per reel, but per step, so you see which step uses the most time, " +
    "memory or AI. Machine time is not turned into money.",
  display: "ActionsTable",
  build: (_d, t) => `select steps.name as step_name,
${costColumns()}
from ${t("steps")} as steps
group by steps.name
order by steps.name`,
};
