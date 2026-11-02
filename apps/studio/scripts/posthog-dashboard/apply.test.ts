import { describe, expect, it } from "vitest";
import { type HttpClient, applyDashboard, readApplyEnv } from "./apply.ts";
import { INSIGHTS } from "./insights/index.ts";
import type { Json } from "./payloads.ts";

// An in-memory PostHog: dashboards, insights and tiles with numeric ids, lists
// paginated two per page through `next`, and tiles created when an insight
// names the dashboard, as PostHog does.

type Obj = { [key: string]: Json };
interface TileRow {
  id: number;
  insight?: number;
  text?: { id: number; body: string };
  layouts?: Json;
}

const PAGE_SIZE = 2;

class FakePostHog implements HttpClient {
  nextId = 1;
  dashboards = new Map<number, Obj & { tiles: TileRow[] }>();
  insights = new Map<number, Obj>();
  requests: { method: string; path: string }[] = [];

  private id(): number {
    return this.nextId++;
  }

  private page(path: string, items: Json[]) {
    const url = new URL(path, "https://fake.posthog");
    const offset = Number(url.searchParams.get("offset") ?? "0");
    url.searchParams.set("offset", String(offset + PAGE_SIZE));
    return {
      results: items.slice(offset, offset + PAGE_SIZE),
      next: offset + PAGE_SIZE < items.length ? url.toString() : null,
    };
  }

  private attach(insightId: number, dashboardIds: Json) {
    for (const raw of (dashboardIds as number[]) ?? []) {
      const dashboard = this.dashboards.get(raw);
      if (dashboard && !dashboard.tiles.some((tile) => tile.insight === insightId)) {
        dashboard.tiles.push({ id: this.id(), insight: insightId });
      }
    }
  }

  private route(path: string): { kind: string; id?: number } {
    const { pathname } = new URL(path, "https://fake.posthog");
    const base = "/api/projects/42/";
    const [kind = "", id = "", ...rest] = pathname.startsWith(base)
      ? pathname.slice(base.length).split("/")
      : [];
    const valid =
      (kind === "dashboards" || kind === "insights") &&
      ((id === "" && rest.length === 0) || (/^\d+$/.test(id) && rest.join("/") === ""));
    if (!valid) throw new Error(`unexpected path ${path}`);
    return { kind, ...(id ? { id: Number(id) } : {}) };
  }

  async get(path: string): Promise<unknown> {
    this.requests.push({ method: "GET", path });
    const { kind, id } = this.route(path);
    if (kind === "dashboards" && id !== undefined) {
      const dashboard = this.dashboards.get(id)!;
      return {
        ...dashboard,
        tiles: dashboard.tiles.map((tile) => ({
          id: tile.id,
          insight: tile.insight === undefined ? null : { id: tile.insight },
          text: tile.text ?? null,
          layouts: tile.layouts ?? {},
        })),
      };
    }
    const store = kind === "dashboards" ? this.dashboards : this.insights;
    return this.page(
      path,
      [...store.values()].map(({ tiles: _tiles, ...rest }) => rest as Obj),
    );
  }

  async post(path: string, body: Json): Promise<unknown> {
    this.requests.push({ method: "POST", path });
    const { kind } = this.route(path);
    const id = this.id();
    if (kind === "dashboards") {
      this.dashboards.set(id, { ...(body as Obj), id, tiles: [] });
    } else {
      this.insights.set(id, { ...(body as Obj), id });
      this.attach(id, (body as Obj).dashboards ?? []);
    }
    return { id };
  }

  async patch(path: string, body: Json): Promise<unknown> {
    this.requests.push({ method: "PATCH", path });
    const { kind, id } = this.route(path);
    const patch = body as Obj;
    if (kind === "insights") {
      this.insights.set(id!, { ...this.insights.get(id!)!, ...patch });
      this.attach(id!, patch.dashboards ?? []);
      return { id };
    }
    const dashboard = this.dashboards.get(id!)!;
    const { tiles, ...rest } = patch;
    Object.assign(dashboard, rest);
    for (const raw of (tiles as Obj[] | undefined) ?? []) {
      const text = raw.text as Obj | undefined;
      const existing = dashboard.tiles.find((tile) => tile.id === raw.id);
      if (text && !existing) {
        dashboard.tiles.push({
          id: this.id(),
          text: { id: this.id(), body: String(text.body) },
          layouts: raw.layouts,
        });
      } else if (existing) {
        if (text) {
          if (!existing.text || existing.text.id !== text.id) {
            throw new Error("Text tile not found.");
          }
          existing.text = { id: existing.text.id, body: String(text.body) };
        }
        existing.layouts = raw.layouts;
      } else {
        throw new Error(`Tile ID ${String(raw.id)} is not on this dashboard.`);
      }
    }
    return { id };
  }

  textTiles(): TileRow[] {
    return [...this.dashboards.values()].flatMap((d) => d.tiles.filter((tile) => tile.text));
  }
}

const KEYS = INSIGHTS.map((def) => def.key);

describe("applyDashboard", () => {
  it("creates the dashboard, 13 insights and 2 text cards on a first run", async () => {
    const fake = new FakePostHog();
    const result = await applyDashboard(fake, "42");
    expect(result.created).toEqual(["dashboard", ...KEYS, "text:supabase-usage", "text:guardrail"]);
    expect(result.updated).toEqual([]);
    expect(fake.dashboards.size).toBe(1);
    expect(fake.insights.size).toBe(13);
    expect(fake.textTiles()).toHaveLength(2);
    const [dashboard] = [...fake.dashboards.values()];
    expect(dashboard!.tiles).toHaveLength(15);
    expect(dashboard!.tiles.every((tile) => tile.layouts)).toBe(true);
  });

  it("creates nothing on a second run, follows pagination and updates everything", async () => {
    const fake = new FakePostHog();
    await applyDashboard(fake, "42");
    fake.requests = [];
    const result = await applyDashboard(fake, "42");
    expect(result.created).toEqual([]);
    expect(result.updated).toEqual(["dashboard", ...KEYS, "text:supabase-usage", "text:guardrail"]);
    expect(fake.requests.filter((r) => r.method === "POST")).toEqual([]);
    // 13 insights two per page: seven pages read.
    expect(
      fake.requests.filter((r) => r.method === "GET" && r.path.includes("insights")),
    ).toHaveLength(7);
    expect(fake.requests.filter((r) => r.method === "PATCH")).toHaveLength(1 + 13 + 1);
    expect(fake.dashboards.size).toBe(1);
    expect(fake.insights.size).toBe(13);
    expect(fake.textTiles()).toHaveLength(2);
    expect([...fake.dashboards.values()][0]!.tiles).toHaveLength(15);
  });

  it("finds a renamed insight by its marker and leaves unrelated insights alone", async () => {
    const fake = new FakePostHog();
    const unrelated = await fake.post("/api/projects/42/insights/", {
      name: "Landing: visits",
      description: "not ours",
      dashboards: [],
    });
    await applyDashboard(fake, "42");
    const [first] = [...fake.insights.values()].filter((i) => i.id !== (unrelated as Obj).id);
    first!.name = "Renamed by hand";
    const result = await applyDashboard(fake, "42");
    expect(result.created).toEqual([]);
    expect(fake.insights.size).toBe(14);
    expect(fake.insights.get((unrelated as Obj).id as number)).toEqual({
      id: (unrelated as Obj).id,
      name: "Landing: visits",
      description: "not ours",
      dashboards: [],
    });
    expect(fake.insights.get(first!.id as number)!.name).toBe(INSIGHTS[0]!.name);
  });
});

describe("readApplyEnv", () => {
  it("returns both variables", () => {
    expect(readApplyEnv({ POSTHOG_PERSONAL_API_KEY: "k", POSTHOG_PROJECT_ID: "1" })).toEqual({
      apiKey: "k",
      projectId: "1",
    });
  });

  it("throws naming the missing variable", () => {
    expect(() => readApplyEnv({ POSTHOG_PROJECT_ID: "1" })).toThrow(/POSTHOG_PERSONAL_API_KEY/);
    expect(() => readApplyEnv({ POSTHOG_PERSONAL_API_KEY: "k" })).toThrow(/POSTHOG_PROJECT_ID/);
    expect(() => readApplyEnv({})).toThrow(/POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID/);
  });
});
