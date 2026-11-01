import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signedInClient,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin, localSupabaseClient } from "../test-support/local-supabase.ts";
import { claimableJobIds } from "../test-support/worker.ts";

const INPUTS = {
  footage: "1".repeat(64),
  transcript: "2".repeat(64),
  cutout: "3".repeat(64),
  headTrack: "4".repeat(64),
};
const DAY_MS = 24 * 60 * 60 * 1000;

// The admin client plays the worker (secret key).
const admin = localSupabaseAdmin();
let owner: { id: string; email: string };
let other: { id: string; email: string };
let ownerClient: SupabaseClient;
let otherClient: SupabaseClient;
let reel: string;
let otherReel: string;
let version: string;
let secondVersion: string;
let otherVersion: string;
// A finished render job of the owner's reel, which the export rows name.
let doneJob: string;

async function addVersion(reelId: string, parentId: string | null): Promise<string> {
  const id = crypto.randomUUID();
  const { error } = await admin.rpc("save_version", {
    p_id: id,
    p_reel_id: reelId,
    p_parent_id: parentId,
    p_restored_from_id: null,
    p_request: null,
    p_model: null,
    p_prompt_version: null,
    p_change_summary: "test version",
    p_checks: { ok: true, reasons: [] },
    p_inputs: INPUTS,
    p_r2_key: `test/reels/${reelId}/versions/${id}.json`,
    p_used_free_field: false,
    p_free_field: [],
    p_unexpressed: [],
  });
  if (error) throw new Error(`version not saved: ${error.message}`);
  return id;
}

async function setReelStatus(reelId: string, status: string) {
  const { error } = await admin.from("reels").update({ status }).eq("id", reelId);
  if (error) throw new Error(`reel not updated: ${error.message}`);
}

async function jobsOf(reelId: string) {
  const { data, error } = await admin
    .from("jobs")
    .select("kind, status, version_id")
    .eq("reel_id", reelId)
    .neq("id", doneJob)
    .order("created_at");
  if (error) throw new Error(`jobs not read: ${error.message}`);
  return data;
}

async function insertExport(fields: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  const { data, error } = await admin
    .from("exports")
    .insert({
      id,
      reel_id: reel,
      owner_id: owner.id,
      job_id: doneJob,
      version_id: version,
      r2_key: `test/exports/${reel}/${id}.mp4`,
      bytes: 1000,
      ...fields,
    })
    .select("id, created_at, expires_at")
    .single();
  if (error || !data) throw new Error(`export not inserted: ${error?.message}`);
  return data as { id: string; created_at: string; expires_at: string };
}

const lifeMs = (row: { created_at: string; expires_at: string }) =>
  Date.parse(row.expires_at) - Date.parse(row.created_at);

beforeAll(async () => {
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "export-owner");
  other = await createTestUser(admin, "export-other");
  ownerClient = (await signedInClient(admin, owner.email)).client;
  otherClient = (await signedInClient(admin, other.email)).client;
  reel = await insertReel(admin, { ownerId: owner.id, name: "a.mov", status: "processed" });
  otherReel = await insertReel(admin, { ownerId: other.id, name: "b.mov", status: "processed" });
  version = await addVersion(reel, null);
  secondVersion = await addVersion(reel, version);
  otherVersion = await addVersion(otherReel, null);
  const job = await admin
    .from("jobs")
    .insert({
      reel_id: reel,
      owner_id: owner.id,
      kind: "render",
      version_id: version,
      status: "done",
    })
    .select("id")
    .single();
  if (job.error) throw new Error(`job not inserted: ${job.error.message}`);
  doneJob = job.data.id as string;
});

// Each test starts from a processed reel with no active job.
afterEach(async () => {
  await admin.from("jobs").delete().in("reel_id", [reel, otherReel]).neq("id", doneJob);
  await admin.from("exports").delete().eq("reel_id", reel);
  await setReelStatus(reel, "processed");
});

afterAll(async () => {
  if (owner) await deleteTestUser(admin, owner.id);
  if (other) await deleteTestUser(admin, other.id);
});

describe("exports", () => {
  it("lets the owner read their exports and nobody else", async () => {
    const row = await insertExport();
    expect((await ownerClient.from("exports").select("id").eq("id", row.id)).data).toEqual([
      { id: row.id },
    ]);
    expect((await otherClient.from("exports").select("id").eq("id", row.id)).data).toEqual([]);
    const anon = await localSupabaseClient().from("exports").select("id").eq("id", row.id);
    expect(anon.data ?? []).toEqual([]);
  });

  it("refuses every owner write", async () => {
    const row = await insertExport();
    for (const client of [ownerClient, otherClient]) {
      const insert = await client.from("exports").insert({
        reel_id: reel,
        owner_id: owner.id,
        job_id: doneJob,
        version_id: version,
        r2_key: `test/exports/${reel}/forged.mp4`,
        bytes: 1,
      });
      expect(insert.error).not.toBeNull();
      await client.from("exports").update({ expires_at: "2099-01-01T00:00:00Z" }).eq("id", row.id);
      await client.from("exports").delete().eq("id", row.id);
    }
    const { data } = await admin
      .from("exports")
      .select("id, created_at, expires_at")
      .eq("id", row.id);
    expect(data).toHaveLength(1);
    expect(lifeMs(data![0]!)).toBe(DAY_MS);
  });

  it("lives exactly 24 hours whatever the writer sends", async () => {
    const row = await insertExport({ expires_at: "2099-01-01T00:00:00Z" });
    expect(lifeMs(row)).toBe(DAY_MS);

    const earlier = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const { data, error } = await admin
      .from("exports")
      .update({ created_at: earlier })
      .eq("id", row.id)
      .select("created_at, expires_at")
      .single();
    expect(error).toBeNull();
    expect(lifeMs(data!)).toBe(DAY_MS);
    expect(Date.parse(data!.expires_at)).toBeLessThan(Date.now());
  });
});

describe("render jobs", () => {
  it("lets the owner queue a render of a version of their processed reel", async () => {
    const { error } = await ownerClient
      .from("jobs")
      .insert({ reel_id: reel, kind: "render", version_id: version });
    expect(error).toBeNull();
    expect(await jobsOf(reel)).toEqual([{ kind: "render", status: "queued", version_id: version }]);
  });

  it("refuses a version of another reel, a reel not processed, and another user's reel", async () => {
    const otherReelsVersion = await ownerClient
      .from("jobs")
      .insert({ reel_id: reel, kind: "render", version_id: otherVersion });
    expect(otherReelsVersion.error?.code).toBe("42501");

    const notMine = await otherClient
      .from("jobs")
      .insert({ reel_id: reel, kind: "render", version_id: version });
    expect(notMine.error?.code).toBe("42501");

    await setReelStatus(reel, "retiming");
    const notProcessed = await ownerClient
      .from("jobs")
      .insert({ reel_id: reel, kind: "render", version_id: version });
    expect(notProcessed.error?.code).toBe("42501");

    expect(await jobsOf(reel)).toEqual([]);
  });

  it("refuses a second render of the same version while the first is queued", async () => {
    const first = await ownerClient
      .from("jobs")
      .insert({ reel_id: reel, kind: "render", version_id: version });
    expect(first.error).toBeNull();
    const second = await ownerClient
      .from("jobs")
      .insert({ reel_id: reel, kind: "render", version_id: version });
    expect(second.error?.code).toBe("42501");
    const another = await ownerClient
      .from("jobs")
      .insert({ reel_id: reel, kind: "render", version_id: secondVersion });
    expect(another.error).toBeNull();
    expect((await jobsOf(reel)).map((job) => job.version_id)).toEqual([version, secondVersion]);
  });

  it("fails the check for a render without a version or a change with one", async () => {
    const noVersion = await ownerClient.from("jobs").insert({ reel_id: reel, kind: "render" });
    expect(noVersion.error).not.toBeNull();
    const changeWithVersion = await admin.from("jobs").insert({
      reel_id: reel,
      owner_id: owner.id,
      kind: "change",
      request: "lower",
      version_id: version,
    });
    expect(changeWithVersion.error?.code).toBe("23514");
    expect(await jobsOf(reel)).toEqual([]);
  });

  it("does not block a change, while a queued change still does", async () => {
    await ownerClient.from("jobs").insert({ reel_id: reel, kind: "render", version_id: version });
    const change = await ownerClient
      .from("jobs")
      .insert({ reel_id: reel, kind: "change", request: "move the title lower" });
    expect(change.error).toBeNull();
    const secondChange = await ownerClient
      .from("jobs")
      .insert({ reel_id: reel, kind: "change", request: "and bigger" });
    expect(secondChange.error?.code).toBe("42501");
  });

  it("reaches the worker with its version through claim_job", async () => {
    const { error } = await ownerClient
      .from("jobs")
      .insert({ reel_id: reel, kind: "render", version_id: version });
    expect(error).toBeNull();
    const claimed = await admin.rpc("claim_job", { p_worker: "export-test", p_lease_seconds: 60 });
    expect(claimed.error).toBeNull();
    expect(claimed.data).toEqual([
      expect.objectContaining({ reel_id: reel, kind: "render", version_id: version }),
    ]);
  });
});
