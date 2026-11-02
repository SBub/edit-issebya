import { STUDIO_SUPER_PROPERTIES } from "../../src/lib/analytics.ts";
import {
  DASHBOARD_DESCRIPTION,
  DASHBOARD_KEY,
  DASHBOARD_NAME,
  DEFAULT_PROJECT_ID,
  FUNNEL_WINDOW_DAYS,
  GUARDRAIL_CARD_KEY,
  GUARDRAIL_TEXT,
  SUPABASE_CARD_KEY,
  SUPABASE_CARD_TEXT,
  TABLE_PREFIX,
  TAG,
  marker,
} from "./config.ts";
import { hogql } from "./dialect.ts";
import type { Insight } from "./insights/common.ts";
import { INSIGHTS } from "./insights/index.ts";

// The exact PostHog API bodies (field names checked against PostHog's
// DashboardSerializer and frontend/src/queries/schema/schema-general.ts, see
// app_docs/dashboard.md). Stable output: no dates, no random values.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface Layout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextCard {
  key: string;
  body: string;
}

const GRID_COLUMNS = 12;
const TILE_WIDTH = 6;
const TILE_HEIGHT = 5;
const CARD_HEIGHT = 2;

export function projectPath(projectId: string, rest: string): string {
  return `/api/projects/${projectId}/${rest}`;
}

/** Appends the marker line that identifies an object the script owns. */
function withMarker(text: string, key: string): string {
  return `${text}\n\n${marker(key)}`;
}

function insightQuery(def: Insight): Json {
  if (def.kind === "funnel") {
    return {
      kind: "InsightVizNode",
      source: {
        kind: "FunnelsQuery",
        series: def.events.map((event) => ({ kind: "EventsNode", event, name: event })),
        dateRange: { date_from: "-90d" },
        properties: [
          { type: "event", key: "app", operator: "exact", value: [STUDIO_SUPER_PROPERTIES.app] },
        ],
        funnelsFilter: {
          funnelOrderType: "ordered",
          funnelVizType: "steps",
          funnelWindowInterval: FUNNEL_WINDOW_DAYS,
          funnelWindowIntervalUnit: "day",
          funnelAggregateByHogQL: "properties.reel_id",
        },
      },
    };
  }
  const chartSettings: { [key: string]: Json } = {};
  if (def.xAxis) chartSettings.xAxis = { column: def.xAxis };
  if (def.yAxis) chartSettings.yAxis = def.yAxis.map((column) => ({ column }));
  if (def.goal) chartSettings.goalLines = [{ ...def.goal, displayLabel: true }];
  return {
    kind: "DataVisualizationNode",
    source: { kind: "HogQLQuery", query: def.build(hogql, (name) => TABLE_PREFIX + name) },
    display: def.display,
    chartSettings,
  };
}

/** The full body of an insight, attached to the given dashboards. */
export function insightBody(def: Insight, dashboardIds: Json[]): { [key: string]: Json } {
  return {
    name: def.name,
    description: withMarker(def.description, def.key),
    tags: [TAG],
    query: insightQuery(def),
    dashboards: dashboardIds,
  };
}

export function dashboardBody(): { [key: string]: Json } {
  return {
    name: DASHBOARD_NAME,
    description: withMarker(DASHBOARD_DESCRIPTION, DASHBOARD_KEY),
    tags: [TAG],
  };
}

export const TEXT_CARDS: readonly TextCard[] = [
  { key: SUPABASE_CARD_KEY, body: withMarker(SUPABASE_CARD_TEXT, SUPABASE_CARD_KEY) },
  { key: GUARDRAIL_CARD_KEY, body: withMarker(GUARDRAIL_TEXT, GUARDRAIL_CARD_KEY) },
];

/** Two insights per row in dashboard order, then the text cards side by side. */
function insightLayout(index: number): Layout {
  return {
    x: (index % 2) * TILE_WIDTH,
    y: Math.floor(index / 2) * TILE_HEIGHT,
    w: TILE_WIDTH,
    h: TILE_HEIGHT,
  };
}

function cardLayout(index: number): Layout {
  const top = Math.ceil(INSIGHTS.length / 2) * TILE_HEIGHT;
  const perRow = GRID_COLUMNS / TILE_WIDTH;
  return {
    x: (index % perRow) * TILE_WIDTH,
    y: top + Math.floor(index / perRow) * CARD_HEIGHT,
    w: TILE_WIDTH,
    h: CARD_HEIGHT,
  };
}

/** One tile entry of the dashboard PATCH: an insight tile's layout, or a text card. */
export function insightTile(tileId: Json, index: number): { [key: string]: Json } {
  return { id: tileId, layouts: { sm: { ...insightLayout(index) } } };
}

export function cardTile(
  card: TextCard,
  index: number,
  existing?: { tileId: Json; textId: Json },
): { [key: string]: Json } {
  const layouts = { sm: { ...cardLayout(index) } };
  if (existing) {
    return { id: existing.tileId, text: { id: existing.textId, body: card.body }, layouts };
  }
  return { text: { body: card.body }, layouts };
}

export interface Request {
  method: "POST" | "PATCH";
  path: string;
  body: Json;
}

/**
 * Every write a first `--apply` sends, in order, with ids as `<id:key>` and
 * dashboard tile ids as `<tile:key>` placeholders.
 */
export function dryRunPayloads(projectId: string = DEFAULT_PROJECT_ID): Request[] {
  const dashboardId = `<id:${DASHBOARD_KEY}>`;
  return [
    { method: "POST", path: projectPath(projectId, "dashboards/"), body: dashboardBody() },
    ...INSIGHTS.map((def): Request => ({
      method: "POST",
      path: projectPath(projectId, "insights/"),
      body: insightBody(def, [dashboardId]),
    })),
    {
      method: "PATCH",
      path: projectPath(projectId, `dashboards/${dashboardId}/`),
      body: {
        tiles: [
          ...INSIGHTS.map((def, index) => insightTile(`<tile:${def.key}>`, index)),
          ...TEXT_CARDS.map((card, index) => cardTile(card, index)),
        ],
      },
    },
  ];
}
