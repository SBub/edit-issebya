import { DASHBOARD_KEY, DASHBOARD_NAME, marker } from "./config.ts";
import { INSIGHTS } from "./insights/index.ts";
import {
  type Json,
  TEXT_CARDS,
  cardTile,
  dashboardBody,
  insightBody,
  insightTile,
  projectPath,
} from "./payloads.ts";

// The idempotent create-or-update. Objects are matched by the marker line in
// their description (a text card: in its body), falling back to the exact
// name, never by tag alone (tagging can be a paid feature). A match is
// PATCHed, a missing object POSTed; a second run against the same state
// creates nothing.

/** The PostHog API, as the script needs it; `get` takes a path or a `next` URL. */
export interface HttpClient {
  get(pathOrUrl: string): Promise<unknown>;
  post(path: string, body: Json): Promise<unknown>;
  patch(path: string, body: Json): Promise<unknown>;
}

interface Owned {
  id: number | string;
  name?: string | null;
  description?: string | null;
  deleted?: boolean;
  dashboards?: (number | string)[];
}

interface Tile {
  id: number | string;
  deleted?: boolean | null;
  insight?: { id: number | string } | null;
  text?: { id: number | string; body?: string | null } | null;
}

interface Page {
  results?: unknown[];
  next?: string | null;
}

export interface ApplyResult {
  created: string[];
  updated: string[];
}

export interface ApplyEnv {
  apiKey: string;
  projectId: string;
}

/** The two variables `--apply` needs, from the owner's shell only. Throws naming any missing. */
export function readApplyEnv(env: Record<string, string | undefined>): ApplyEnv {
  const apiKey = env.POSTHOG_PERSONAL_API_KEY;
  const projectId = env.POSTHOG_PROJECT_ID;
  const missing = [
    ...(apiKey ? [] : ["POSTHOG_PERSONAL_API_KEY"]),
    ...(projectId ? [] : ["POSTHOG_PROJECT_ID"]),
  ];
  if (missing.length > 0 || !apiKey || !projectId) {
    throw new Error(`--apply needs ${missing.join(" and ")} exported in the shell`);
  }
  return { apiKey, projectId };
}

/** Every result of a paginated list, following `next`. */
async function listAll(client: HttpClient, path: string): Promise<unknown[]> {
  const results: unknown[] = [];
  let next: string | null | undefined = path;
  while (next) {
    const page = (await client.get(next)) as Page;
    results.push(...(page.results ?? []));
    next = page.next;
  }
  return results;
}

function findOwned(items: Owned[], key: string, name: string): Owned | undefined {
  const live = items.filter((item) => !item.deleted);
  return (
    live.find((item) => (item.description ?? "").includes(marker(key))) ??
    live.find((item) => item.name === name)
  );
}

function idOf(response: unknown, what: string): number | string {
  const id = (response as { id?: unknown } | null)?.id;
  if (typeof id !== "number" && typeof id !== "string") {
    throw new Error(`PostHog returned no id for ${what}`);
  }
  return id;
}

export async function applyDashboard(client: HttpClient, projectId: string): Promise<ApplyResult> {
  const created: string[] = [];
  const updated: string[] = [];
  const dashboardsPath = projectPath(projectId, "dashboards/");
  const insightsPath = projectPath(projectId, "insights/");

  const dashboards = (await listAll(client, `${dashboardsPath}?limit=100`)) as Owned[];
  const existingDashboard = findOwned(dashboards, DASHBOARD_KEY, DASHBOARD_NAME);
  let dashboardId: number | string;
  if (existingDashboard) {
    dashboardId = existingDashboard.id;
    await client.patch(`${dashboardsPath}${dashboardId}/`, dashboardBody());
    updated.push(DASHBOARD_KEY);
  } else {
    dashboardId = idOf(await client.post(dashboardsPath, dashboardBody()), "the dashboard");
    created.push(DASHBOARD_KEY);
  }

  const insights = (await listAll(client, `${insightsPath}?limit=100&saved=true`)) as Owned[];
  const insightIds = new Map<string, number | string>();
  for (const def of INSIGHTS) {
    const existing = findOwned(insights, def.key, def.name);
    if (existing) {
      const others = (existing.dashboards ?? []).filter((id) => id !== dashboardId);
      await client.patch(
        `${insightsPath}${existing.id}/`,
        insightBody(def, [...others, dashboardId]),
      );
      insightIds.set(def.key, existing.id);
      updated.push(def.key);
    } else {
      const response = await client.post(insightsPath, insightBody(def, [dashboardId]));
      insightIds.set(def.key, idOf(response, def.key));
      created.push(def.key);
    }
  }

  // Tiles: each insight's layout, and the text cards (reused by their marker).
  const dashboard = (await client.get(`${dashboardsPath}${dashboardId}/`)) as { tiles?: Tile[] };
  const tiles = (dashboard.tiles ?? []).filter((tile) => !tile.deleted);
  const insightTiles = INSIGHTS.map((def, index) => {
    const tile = tiles.find((t) => t.insight?.id === insightIds.get(def.key));
    if (!tile) throw new Error(`the dashboard has no tile for insight ${def.key}`);
    return insightTile(tile.id, index);
  });
  const cardTiles = TEXT_CARDS.map((card, index) => {
    const tile = tiles.find((t) => t.text && (t.text.body ?? "").includes(marker(card.key)));
    if (tile?.text) {
      updated.push(`text:${card.key}`);
      return cardTile(card, index, { tileId: tile.id, textId: tile.text.id });
    }
    created.push(`text:${card.key}`);
    return cardTile(card, index);
  });
  await client.patch(`${dashboardsPath}${dashboardId}/`, {
    tiles: [...insightTiles, ...cardTiles],
  });

  return { created, updated };
}
