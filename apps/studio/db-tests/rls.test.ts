import type { SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signedInClient,
} from "../test-support/fixtures.ts";
import {
  LOCAL_DB_URL,
  localSupabaseAdmin,
  localSupabaseClient,
} from "../test-support/local-supabase.ts";

describe("every public table", () => {
  it("has RLS on and at least one policy", async () => {
    const db = new pg.Client({ connectionString: LOCAL_DB_URL });
    await db.connect();
    try {
      const { rows } = await db.query<{ table: string; rls: boolean; policies: number }>(`
        select c.relname as table, c.relrowsecurity as rls,
               (select count(*)::int from pg_policies p
                 where p.schemaname = 'public' and p.tablename = c.relname) as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
        order by c.relname`);
      // Not vacuous: the list holds at least the reels table.
      expect(rows.map((r) => r.table)).toContain("reels");
      for (const row of rows) {
        expect({ table: row.table, rls: row.rls }).toEqual({ table: row.table, rls: true });
        expect(row.policies, `${row.table} has no policy`).toBeGreaterThan(0);
      }
    } finally {
      await db.end();
    }
  });
});

describe("reels RLS", () => {
  const admin = localSupabaseAdmin();
  let userA: { id: string; email: string };
  let userB: { id: string; email: string };
  let clientA: SupabaseClient;
  let clientB: SupabaseClient;
  let reelA: string;

  beforeAll(async () => {
    userA = await createTestUser(admin, "rls-a");
    userB = await createTestUser(admin, "rls-b");
    reelA = await insertReel(admin, { ownerId: userA.id, name: "a.mov", status: "uploaded" });
    clientA = (await signedInClient(admin, userA.email)).client;
    clientB = (await signedInClient(admin, userB.email)).client;
  });

  afterAll(async () => {
    if (userA) await deleteTestUser(admin, userA.id);
    if (userB) await deleteTestUser(admin, userB.id);
  });

  async function adminRead() {
    const { data, error } = await admin
      .from("reels")
      .select("id, status, source_name")
      .eq("id", reelA)
      .single();
    expect(error).toBeNull();
    return data;
  }

  it("lets the owner read their reel", async () => {
    const { data, error } = await clientA.from("reels").select("id").eq("id", reelA);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: reelA }]);
  });

  it("hides the reel from another user", async () => {
    const { data, error } = await clientB.from("reels").select("id").eq("id", reelA);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("refuses the owner's insert", async () => {
    const { error } = await clientA
      .from("reels")
      .insert({ owner_id: userA.id, source_name: "x.mov" });
    expect(error).not.toBeNull();
    const { count } = await admin
      .from("reels")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", userA.id);
    expect(count).toBe(1);
  });

  it("changes nothing on the owner's update or delete", async () => {
    await clientA.from("reels").update({ status: "failed" }).eq("id", reelA);
    await clientA.from("reels").delete().eq("id", reelA);
    expect(await adminRead()).toEqual({ id: reelA, status: "uploaded", source_name: "a.mov" });
  });

  it("gives anon nothing", async () => {
    const anon = localSupabaseClient();
    const { data, error } = await anon.from("reels").select("id").eq("id", reelA);
    // Either a permission error (no grant) or no rows; never the reel.
    if (!error) expect(data).toEqual([]);
    else expect(data).toBeNull();
  });
});
