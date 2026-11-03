import { describe, expect, it } from "vitest";
import { STUDIO_EVENTS } from "../../src/lib/studio-events.ts";
import { TAG, marker } from "./config.ts";
import { INSIGHTS } from "./insights/index.ts";
import { type Json, dryRunPayloads } from "./payloads.ts";

const payloads = dryRunPayloads();
const text = JSON.stringify(payloads);

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

type Body = { [key: string]: Json };

describe("dry run payloads", () => {
  it("match the committed snapshot", () => {
    expect(payloads).toMatchSnapshot();
  });

  it("are stable between calls", () => {
    expect(JSON.stringify(dryRunPayloads())).toBe(text);
  });

  it("hold the dashboard, the 20 insights and both text cards, each once", () => {
    expect(INSIGHTS).toHaveLength(20);
    expect(count(text, marker("dashboard"))).toBe(1);
    for (const def of INSIGHTS) expect(count(text, marker(def.key))).toBe(1);
    expect(count(text, marker("supabase-usage"))).toBe(1);
    expect(count(text, marker("guardrail"))).toBe(1);
    expect(new Set(INSIGHTS.map((def) => def.key)).size).toBe(20);
  });

  it("keep every description under 400 characters, ending in its marker line", () => {
    // PostHog's MCP tool caps an insight description at 400 characters, and a
    // description is rewritten shorter, never cut (app_docs/dashboard.md).
    const posts = payloads.filter((request) => request.method === "POST");
    const patch = payloads.find((request) => request.method === "PATCH");
    const cards = ((patch?.body as Body).tiles as Body[])
      .map((tile) => (tile.text as Body | undefined)?.body)
      .filter((body) => body !== undefined);
    const keys = ["dashboard", ...INSIGHTS.map((def) => def.key), "supabase-usage", "guardrail"];
    const descriptions = [...posts.map((request) => (request.body as Body).description), ...cards];
    expect(descriptions).toHaveLength(keys.length);
    descriptions.forEach((description, index) => {
      const key = keys[index] ?? "";
      expect(typeof description, key).toBe("string");
      expect(String(description).length, key).toBeLessThan(400);
      expect(String(description).endsWith(`\n\n${marker(key)}`), key).toBe(true);
    });
  });

  it("tag the dashboard and every insight", () => {
    const posts = payloads.filter((request) => request.method === "POST");
    expect(posts).toHaveLength(21);
    for (const request of posts) expect((request.body as Body).tags).toEqual([TAG]);
  });

  it("send the funnel's steps as the studio events, in order", () => {
    const funnel = payloads.find((request) =>
      String((request.body as Body).description ?? "").includes(marker("funnel")),
    );
    const query = (funnel?.body as Body).query as Body;
    const source = query.source as Body;
    expect(query.kind).toBe("InsightVizNode");
    expect(source.kind).toBe("FunnelsQuery");
    expect((source.series as Body[]).map((step) => step.event)).toEqual([...STUDIO_EVENTS]);
    expect((source.funnelsFilter as Body).funnelAggregateByHogQL).toBe("properties.reel_id");
  });

  it("read the synced tables through the table prefix only", () => {
    const queries = payloads
      .map((request) => ((request.body as Body).query as Body | undefined)?.source as Body)
      .filter((source) => source?.kind === "HogQLQuery")
      .map((source) => String(source.query));
    expect(queries).toHaveLength(19);
    for (const query of queries) {
      expect(query).toMatch(/from supabase_[a-z_]+ as [a-z_]+/);
      expect(query).not.toMatch(/from (reels|jobs|steps|versions|exports|stored_files)\b/);
    }
  });
});
