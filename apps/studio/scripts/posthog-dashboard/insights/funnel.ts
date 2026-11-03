import { STUDIO_EVENTS } from "../../../src/lib/studio-events.ts";
import { FUNNEL_WINDOW_DAYS } from "../config.ts";
import { type FunnelInsight } from "./common.ts";

export const funnel: FunnelInsight = {
  kind: "funnel",
  key: "funnel",
  name: "Studio: funnel by reel",
  description:
    `How far reels get through upload, open preview, ask for a change, export and download, ` +
    `within ${FUNNEL_WINDOW_DAYS} days. A big drop shows where reels stall. Counts only reels where ` +
    `tracking was on, so it can read low.`,
  events: STUDIO_EVENTS,
};
