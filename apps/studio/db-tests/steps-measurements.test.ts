import type { SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signedInClient,
} from "../test-support/fixtures.ts";
import { LOCAL_DB_URL, localSupabaseAdmin } from "../test-support/local-supabase.ts";

// The exact column set: a column added later (a price derived from machine
// measurements, say) fails here until this list and app_docs/measurement.md
// change with it.
const STEP_COLUMNS = [
  ["id", "uuid"],
  ["job_id", "uuid"],
  ["reel_id", "uuid"],
  ["owner_id", "uuid"],
  ["name", "text"],
  ["status", "text"],
  ["summary", "text"],
  ["error_tail", "text"],
  ["started_at", "timestamp with time zone"],
  ["finished_at", "timestamp with time zone"],
  ["wall_ms", "bigint"],
  ["cpu_ms", "bigint"],
  ["peak_rss_bytes", "bigint"],
  ["bytes_in", "bigint"],
  ["bytes_out", "bigint"],
  ["ai_input_tokens", "bigint"],
  ["ai_output_tokens", "bigint"],
  ["ai_cost_usd", "numeric"],
  ["ai_model", "text"],
];

describe("steps columns", () => {
  it("are exactly the step log's plus the measurements", async () => {
    const db = new pg.Client({ connectionString: LOCAL_DB_URL });
    await db.connect();
    try {
      const { rows } = await db.query<{ column_name: string; data_type: string }>(`
        select column_name, data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'steps'
        order by column_name`);
      expect(rows.map((r) => [r.column_name, r.data_type])).toEqual(
        [...STEP_COLUMNS].sort(([a], [b]) => (a! < b! ? -1 : 1)),
      );
    } finally {
      await db.end();
    }
  });
});

describe("step measurements", () => {
  const admin = localSupabaseAdmin();
  let owner: { id: string; email: string };
  let client: SupabaseClient;
  let stepId: string;

  beforeAll(async () => {
    owner = await createTestUser(admin, "measurements");
    const reelId = await insertReel(admin, { ownerId: owner.id, status: "received" });
    client = (await signedInClient(admin, owner.email)).client;
    const job = await admin
      .from("jobs")
      .insert({ reel_id: reelId, owner_id: owner.id, status: "done" })
      .select("id")
      .single();
    const step = await admin
      .from("steps")
      .insert({ job_id: job.data!.id, reel_id: reelId, owner_id: owner.id, name: "probe" })
      .select("id")
      .single();
    stepId = step.data!.id as string;
  });

  afterAll(async () => {
    if (owner) await deleteTestUser(admin, owner.id);
  });

  it("are written by the worker's key and read back by the owner", async () => {
    const measurements = {
      wall_ms: 407_000,
      cpu_ms: 1_150,
      peak_rss_bytes: 211_845_120,
      bytes_in: 123_456,
      bytes_out: 654_321,
    };
    const { error } = await admin
      .from("steps")
      .update({ status: "done", ...measurements })
      .eq("id", stepId);
    expect(error).toBeNull();
    const { data } = await client
      .from("steps")
      .select("wall_ms, cpu_ms, peak_rss_bytes, bytes_in, bytes_out")
      .eq("id", stepId)
      .single();
    expect(data).toEqual(measurements);
  });

  it("rejects a negative measurement", async () => {
    const { error } = await admin.from("steps").update({ cpu_ms: -1 }).eq("id", stepId);
    expect(error?.code).toBe("23514");
  });
});
