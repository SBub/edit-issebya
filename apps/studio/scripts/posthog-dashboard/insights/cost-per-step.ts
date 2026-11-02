import { type SqlInsight } from "./common.ts";
import { costColumns } from "./cost-columns.ts";

export const costPerStep: SqlInsight = {
  kind: "sql",
  key: "cost-per-step",
  name: "Studio: cost per step",
  description:
    "Per step name, over every run: the same sums as cost per reel (wall and CPU seconds, peak " +
    "memory, bytes, AI tokens and reported AI cost). No money is derived from machine time. " +
    "Source: synced steps table.",
  display: "ActionsTable",
  build: (_d, t) => `select steps.name as step_name,
${costColumns()}
from ${t("steps")} as steps
group by steps.name
order by steps.name`,
};
