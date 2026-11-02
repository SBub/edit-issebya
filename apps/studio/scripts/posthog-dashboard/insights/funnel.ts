import { STUDIO_EVENTS } from "../../../src/lib/studio-events.ts";
import { FUNNEL_WINDOW_DAYS } from "../config.ts";
import { type FunnelInsight } from "./common.ts";

export const funnel: FunnelInsight = {
  kind: "funnel",
  key: "funnel",
  name: "Studio: funnel by reel",
  description:
    `The five studio events in order (upload, preview opened, change requested, export ` +
    `requested, export downloaded), counted per reel (properties.reel_id), app = studio, within ` +
    `${FUNNEL_WINDOW_DAYS} days. Events are absent wherever PostHog is not initialised, so every ` +
    `other chart reads the database.`,
  events: STUDIO_EVENTS,
};
