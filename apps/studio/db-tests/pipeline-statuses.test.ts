import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signedInClient,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";

// The pipeline's reel statuses and the cache-hit step (app_docs/pipeline.md).
describe("pipeline statuses", () => {
  const admin = localSupabaseAdmin();
  let owner: { id: string; email: string };
  let client: SupabaseClient;
  let reelId: string;
  let jobId: string;

  beforeAll(async () => {
    owner = await createTestUser(admin, "pipeline-statuses");
    reelId = await insertReel(admin, { ownerId: owner.id, status: "uploaded" });
    client = (await signedInClient(admin, owner.email)).client;
    const job = await admin
      .from("jobs")
      .insert({ reel_id: reelId, owner_id: owner.id, status: "running" })
      .select("id")
      .single();
    jobId = job.data!.id as string;
  });

  afterAll(async () => {
    if (owner) await deleteTestUser(admin, owner.id);
  });

  it("accepts each step's reel status", async () => {
    for (const status of ["converting", "transcribing", "retiming", "processed"]) {
      const { error } = await admin.from("reels").update({ status }).eq("id", reelId);
      expect(error, status).toBeNull();
    }
  });

  it("rejects an unknown reel status", async () => {
    const { error } = await admin.from("reels").update({ status: "bogus" }).eq("id", reelId);
    expect(error?.code).toBe("23514");
  });

  it("defaults cache_hit to false", async () => {
    const { data, error } = await admin
      .from("steps")
      .insert({ job_id: jobId, reel_id: reelId, owner_id: owner.id, name: "convert" })
      .select("cache_hit")
      .single();
    expect(error).toBeNull();
    expect(data).toEqual({ cache_hit: false });
  });

  it("accepts a skipped cache hit, read back by the owner", async () => {
    const { data: step, error } = await admin
      .from("steps")
      .insert({
        job_id: jobId,
        reel_id: reelId,
        owner_id: owner.id,
        name: "transcribe",
        status: "skipped",
        cache_hit: true,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    const { data } = await client
      .from("steps")
      .select("status, cache_hit")
      .eq("id", step!.id)
      .single();
    expect(data).toEqual({ status: "skipped", cache_hit: true });
  });
});
