import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signedInClient,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin, localSupabaseClient } from "../test-support/local-supabase.ts";
import { claimableJobIds } from "../test-support/worker.ts";

interface JobRow {
  id: string;
  status: string;
  lease_holder: string | null;
  lease_expires_at: string | null;
  attempts: number;
  started_at: string | null;
}

const admin = localSupabaseAdmin();
let owner: { id: string; email: string };
let ownerClient: SupabaseClient;
let olderJob: string;
let newerJob: string;

async function insertJob(reelId: string, createdAt: string): Promise<string> {
  const { data, error } = await admin
    .from("jobs")
    .insert({ reel_id: reelId, owner_id: owner.id, created_at: createdAt })
    .select("id")
    .single();
  if (error || !data) throw new Error(`job not inserted: ${error?.message}`);
  return data.id as string;
}

async function claim(worker: string, seconds = 300) {
  return admin.rpc("claim_job", { p_worker: worker, p_lease_seconds: seconds });
}

async function readJob(id: string): Promise<JobRow> {
  const { data, error } = await admin
    .from("jobs")
    .select("id, status, lease_holder, lease_expires_at, attempts, started_at")
    .eq("id", id)
    .single();
  if (error || !data) throw new Error(`job not read: ${error?.message}`);
  return data as JobRow;
}

beforeAll(async () => {
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "jobs");
  ownerClient = (await signedInClient(admin, owner.email)).client;
  const reel = await insertReel(admin, { ownerId: owner.id, name: "jobs.mov", status: "uploaded" });
  olderJob = await insertJob(reel, new Date(Date.now() - 120_000).toISOString());
  newerJob = await insertJob(reel, new Date(Date.now() - 60_000).toISOString());
});

afterAll(async () => {
  if (owner) await deleteTestUser(admin, owner.id);
});

describe("claim_job", () => {
  it("claims the oldest job with a lease, then the next, then none", async () => {
    const first = await claim("a");
    expect(first.error).toBeNull();
    const [claimed] = first.data as JobRow[];
    expect(claimed?.id).toBe(olderJob);
    expect(claimed?.status).toBe("running");
    expect(claimed?.lease_holder).toBe("a");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.started_at).not.toBeNull();
    // Both stamps come from the database clock, which can drift from the
    // host's (the Docker VM after a sleep), so never compare with Date.now().
    const lease =
      new Date(claimed!.lease_expires_at!).getTime() - new Date(claimed!.started_at!).getTime();
    expect(lease).toBe(300_000);

    const second = await claim("b");
    expect((second.data as JobRow[]).map((job) => job.id)).toEqual([newerJob]);

    const third = await claim("b");
    expect(third.error).toBeNull();
    expect(third.data).toEqual([]);
  });

  it("re-claims a job whose lease expired, counting the attempt", async () => {
    // Expire the lease on the database clock: a minute before it was claimed.
    const { started_at } = await readJob(olderJob);
    const { error } = await admin
      .from("jobs")
      .update({
        lease_expires_at: new Date(new Date(started_at!).getTime() - 60_000).toISOString(),
      })
      .eq("id", olderJob);
    expect(error).toBeNull();

    const { data } = await claim("b");
    const [claimed] = data as JobRow[];
    expect(claimed?.id).toBe(olderJob);
    expect(claimed?.attempts).toBe(2);
    expect(claimed?.lease_holder).toBe("b");
  });

  it("refuses the owner and anon, and changes nothing", async () => {
    const before = await readJob(olderJob);
    for (const client of [ownerClient, localSupabaseClient()]) {
      const { error } = await client.rpc("claim_job", { p_worker: "x", p_lease_seconds: 300 });
      expect(error).not.toBeNull();
    }
    expect(await readJob(olderJob)).toEqual(before);
  });

  it("refuses an empty worker or a lease out of range", async () => {
    expect((await claim("")).error).not.toBeNull();
    expect((await claim("a", 0)).error).not.toBeNull();
    expect((await claim("a", 3601)).error).not.toBeNull();
  });
});
