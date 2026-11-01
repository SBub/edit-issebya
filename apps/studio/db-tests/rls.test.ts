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
      // Not vacuous: the list holds at least the studio's tables.
      expect(rows.map((r) => r.table)).toEqual(
        expect.arrayContaining(["reels", "jobs", "steps", "versions", "exports"]),
      );
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

  async function countOwn(ownerId: string) {
    const { count } = await admin
      .from("reels")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", ownerId);
    return count;
  }

  function keyFor(id: string) {
    return `dev/reels/${id}/source/original.mp4`;
  }

  it("refuses an owner insert naming owner_id, status or source_bytes", async () => {
    const before = await countOwn(userA.id);
    for (const extra of [
      { owner_id: userA.id },
      { status: "uploading" },
      { status: "received" },
      { source_bytes: 10 },
    ]) {
      const id = crypto.randomUUID();
      const { error } = await clientA
        .from("reels")
        .insert({ id, source_name: "x.mov", source_key: keyFor(id), ...extra });
      expect(error, JSON.stringify(extra)).not.toBeNull();
    }
    expect(await countOwn(userA.id)).toBe(before);
  });

  it("refuses an owner insert whose key names another reel", async () => {
    const before = await countOwn(userA.id);
    const { error } = await clientA.from("reels").insert({
      id: crypto.randomUUID(),
      source_name: "x.mov",
      source_key: keyFor(reelA),
    });
    expect(error).not.toBeNull();
    expect(await countOwn(userA.id)).toBe(before);
  });

  it("lets the owner insert their own uploading reel", async () => {
    const id = crypto.randomUUID();
    const { error } = await clientA
      .from("reels")
      .insert({ id, source_name: "new.mov", source_key: keyFor(id) });
    expect(error).toBeNull();
    const { data } = await admin
      .from("reels")
      .select("owner_id, status, source_bytes")
      .eq("id", id)
      .single();
    expect(data).toEqual({ owner_id: userA.id, status: "uploading", source_bytes: null });
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

describe("jobs and steps RLS", () => {
  const admin = localSupabaseAdmin();
  let userA: { id: string; email: string };
  let userB: { id: string; email: string };
  let clientA: SupabaseClient;
  let clientB: SupabaseClient;
  let reelA: string;
  let jobA: string;
  let stepA: string;

  beforeAll(async () => {
    userA = await createTestUser(admin, "jobs-rls-a");
    userB = await createTestUser(admin, "jobs-rls-b");
    reelA = await insertReel(admin, { ownerId: userA.id, name: "a.mov", status: "received" });
    clientA = (await signedInClient(admin, userA.email)).client;
    clientB = (await signedInClient(admin, userB.email)).client;
    const job = await admin
      .from("jobs")
      .insert({ reel_id: reelA, owner_id: userA.id, status: "done" })
      .select("id")
      .single();
    jobA = job.data!.id as string;
    const step = await admin
      .from("steps")
      .insert({
        job_id: jobA,
        reel_id: reelA,
        owner_id: userA.id,
        name: "receive",
        status: "done",
        summary: "footage received, 1.0 MB",
      })
      .select("id")
      .single();
    stepA = step.data!.id as string;
  });

  afterAll(async () => {
    if (userA) await deleteTestUser(admin, userA.id);
    if (userB) await deleteTestUser(admin, userB.id);
  });

  async function jobCount() {
    const { count } = await admin
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("reel_id", reelA);
    return count;
  }

  it("lets the owner read their jobs and steps", async () => {
    expect((await clientA.from("jobs").select("id").eq("id", jobA)).data).toEqual([{ id: jobA }]);
    expect((await clientA.from("steps").select("id").eq("id", stepA)).data).toEqual([
      { id: stepA },
    ]);
  });

  it("hides them from another user and from anon", async () => {
    expect((await clientB.from("jobs").select("id").eq("id", jobA)).data).toEqual([]);
    expect((await clientB.from("steps").select("id").eq("id", stepA)).data).toEqual([]);
    const anon = localSupabaseClient();
    for (const table of ["jobs", "steps"]) {
      const { data, error } = await anon.from(table).select("id");
      if (!error) expect(data).toEqual([]);
      else expect(data).toBeNull();
    }
  });

  it("refuses another user's job for the owner's reel", async () => {
    const before = await jobCount();
    const { error } = await clientB.from("jobs").insert({ reel_id: reelA, kind: "process" });
    expect(error).not.toBeNull();
    expect(await jobCount()).toBe(before);
  });

  it("lets the owner queue a process job for their own reel", async () => {
    const before = await jobCount();
    const { error } = await clientA.from("jobs").insert({ reel_id: reelA, kind: "process" });
    expect(error).toBeNull();
    expect(await jobCount()).toBe((before ?? 0) + 1);
    // Leave nothing claimable on the shared stack.
    await admin.from("jobs").delete().eq("reel_id", reelA).eq("status", "queued");
  });

  it("changes nothing on the owner's update of a job or a step", async () => {
    await clientA.from("jobs").update({ status: "failed" }).eq("id", jobA);
    await clientA.from("steps").update({ summary: "forged" }).eq("id", stepA);
    expect((await admin.from("jobs").select("status").eq("id", jobA).single()).data).toEqual({
      status: "done",
    });
    expect((await admin.from("steps").select("summary").eq("id", stepA).single()).data).toEqual({
      summary: "footage received, 1.0 MB",
    });
  });
});

describe("finish_upload", () => {
  const admin = localSupabaseAdmin();
  let userA: { id: string; email: string };
  let userB: { id: string; email: string };
  let clientA: SupabaseClient;
  let clientB: SupabaseClient;

  beforeAll(async () => {
    userA = await createTestUser(admin, "finish-a");
    userB = await createTestUser(admin, "finish-b");
    clientA = (await signedInClient(admin, userA.email)).client;
    clientB = (await signedInClient(admin, userB.email)).client;
  });

  afterAll(async () => {
    // Remove the queued jobs first, then the users (cascade).
    if (userA) await admin.from("jobs").delete().eq("owner_id", userA.id);
    if (userA) await deleteTestUser(admin, userA.id);
    if (userB) await deleteTestUser(admin, userB.id);
  });

  async function uploadingReel(): Promise<string> {
    const id = crypto.randomUUID();
    const { error } = await clientA
      .from("reels")
      .insert({ id, source_name: "up.mp4", source_key: `dev/reels/${id}/source/original.mp4` });
    if (error) throw new Error(`reel not inserted: ${error.message}`);
    return id;
  }

  async function state(id: string) {
    const reel = await admin.from("reels").select("status, source_bytes").eq("id", id).single();
    const jobs = await admin.from("jobs").select("owner_id, kind, status").eq("reel_id", id);
    return { reel: reel.data, jobs: jobs.data };
  }

  it("refuses another user, anon and a zero size", async () => {
    const id = await uploadingReel();
    expect(
      (await clientB.rpc("finish_upload", { p_reel_id: id, p_bytes: 10 })).error,
    ).not.toBeNull();
    expect(
      (await localSupabaseClient().rpc("finish_upload", { p_reel_id: id, p_bytes: 10 })).error,
    ).not.toBeNull();
    expect(
      (await clientA.rpc("finish_upload", { p_reel_id: id, p_bytes: 0 })).error,
    ).not.toBeNull();
    expect(await state(id)).toEqual({
      reel: { status: "uploading", source_bytes: null },
      jobs: [],
    });
  });

  it("finishes the owner's upload once, queueing one job", async () => {
    const id = await uploadingReel();
    const first = await clientA.rpc("finish_upload", { p_reel_id: id, p_bytes: 1234 });
    expect(first.error).toBeNull();
    expect(typeof first.data).toBe("string");
    const second = await clientA.rpc("finish_upload", { p_reel_id: id, p_bytes: 1234 });
    expect(second.error).not.toBeNull();
    expect(await state(id)).toEqual({
      reel: { status: "uploaded", source_bytes: 1234 },
      jobs: [{ owner_id: userA.id, kind: "process", status: "queued" }],
    });
    await admin.from("jobs").delete().eq("reel_id", id);
  });

  it("refuses a reel in any other state", async () => {
    const id = await insertReel(admin, { ownerId: userA.id, name: "r.mov", status: "received" });
    expect(
      (await clientA.rpc("finish_upload", { p_reel_id: id, p_bytes: 10 })).error,
    ).not.toBeNull();
    expect((await state(id)).jobs).toEqual([]);
  });

  it("changes nothing on the owner's direct status update", async () => {
    const id = await uploadingReel();
    for (const status of ["received", "failed", "uploaded"]) {
      await clientA.from("reels").update({ status }).eq("id", id);
    }
    expect((await state(id)).reel).toEqual({ status: "uploading", source_bytes: null });
  });
});
