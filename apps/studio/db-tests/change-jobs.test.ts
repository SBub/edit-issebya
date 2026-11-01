import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signedInClient,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { claimableJobIds } from "../test-support/worker.ts";

const INPUTS = {
  footage: "1".repeat(64),
  transcript: "2".repeat(64),
  cutout: "3".repeat(64),
  headTrack: "4".repeat(64),
};

// The admin client plays the worker (secret key).
const admin = localSupabaseAdmin();
let owner: { id: string; email: string };
let other: { id: string; email: string };
let ownerClient: SupabaseClient;
let otherClient: SupabaseClient;
let reel: string;
let otherReel: string;
let version: string;
let otherVersion: string;

// A version row through save_version, as the worker saves one (no object is
// needed for the policy).
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

async function setReelStatus(status: string) {
  const { error } = await admin.from("reels").update({ status }).eq("id", reel);
  if (error) throw new Error(`reel not updated: ${error.message}`);
}

async function jobsOf(reelId: string) {
  const { data, error } = await admin
    .from("jobs")
    .select("kind, status, request, restore_version_id")
    .eq("reel_id", reelId);
  if (error) throw new Error(`jobs not read: ${error.message}`);
  return data;
}

beforeAll(async () => {
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  owner = await createTestUser(admin, "change-owner");
  other = await createTestUser(admin, "change-other");
  ownerClient = (await signedInClient(admin, owner.email)).client;
  otherClient = (await signedInClient(admin, other.email)).client;
  reel = await insertReel(admin, { ownerId: owner.id, name: "a.mov", status: "processed" });
  otherReel = await insertReel(admin, { ownerId: other.id, name: "b.mov", status: "processed" });
  version = await addVersion(reel, null);
  otherVersion = await addVersion(otherReel, null);
});

// Each test starts from a processed reel with no job, so the interim rule
// never refuses for a reason the test is not about.
afterEach(async () => {
  await admin.from("jobs").delete().in("reel_id", [reel, otherReel]);
  await setReelStatus("processed");
});

afterAll(async () => {
  if (owner) await deleteTestUser(admin, owner.id);
  if (other) await deleteTestUser(admin, other.id);
});

describe("change and restore jobs", () => {
  it("lets the owner queue a change with their words for their processed reel", async () => {
    const { error } = await ownerClient
      .from("jobs")
      .insert({ reel_id: reel, kind: "change", request: "move the title lower" });
    expect(error).toBeNull();
    expect(await jobsOf(reel)).toEqual([
      {
        kind: "change",
        status: "queued",
        request: "move the title lower",
        restore_version_id: null,
      },
    ]);
  });

  it("lets the owner queue a restore of a version of the same reel", async () => {
    const { error } = await ownerClient
      .from("jobs")
      .insert({ reel_id: reel, kind: "restore", restore_version_id: version });
    expect(error).toBeNull();
    expect(await jobsOf(reel)).toEqual([
      { kind: "restore", status: "queued", request: null, restore_version_id: version },
    ]);
  });

  it("refuses another user's change for the owner's reel", async () => {
    const { error } = await otherClient
      .from("jobs")
      .insert({ reel_id: reel, kind: "change", request: "make it mine" });
    expect(error?.code).toBe("42501");
    expect(await jobsOf(reel)).toEqual([]);
  });

  it("refuses a change without words, untrimmed or over 1000 characters", async () => {
    for (const request of [undefined, "   ", " padded ", "a".repeat(1001)]) {
      const { error } = await ownerClient
        .from("jobs")
        .insert({ reel_id: reel, kind: "change", ...(request === undefined ? {} : { request }) });
      expect(error, JSON.stringify(request)).not.toBeNull();
    }
    expect(await jobsOf(reel)).toEqual([]);
  });

  it("enforces the columns of each kind, even for the worker", async () => {
    const bad: Record<string, string>[] = [
      { reel_id: reel, owner_id: owner.id, kind: "restore" },
      { reel_id: reel, owner_id: owner.id, kind: "process", request: "sneaky" },
      {
        reel_id: reel,
        owner_id: owner.id,
        kind: "change",
        request: "ok",
        restore_version_id: version,
      },
      { reel_id: reel, owner_id: owner.id, kind: "export" },
    ];
    for (const row of bad) {
      const { error } = await admin.from("jobs").insert(row);
      expect(error?.code, JSON.stringify(row)).toBe("23514");
    }
  });

  it("refuses a restore naming a version of another reel", async () => {
    const { error } = await ownerClient
      .from("jobs")
      .insert({ reel_id: reel, kind: "restore", restore_version_id: otherVersion });
    expect(error?.code).toBe("42501");
    expect(await jobsOf(reel)).toEqual([]);
  });

  it("refuses a change while the reel is not processed", async () => {
    for (const status of ["received", "retiming", "failed"]) {
      await setReelStatus(status);
      const { error } = await ownerClient
        .from("jobs")
        .insert({ reel_id: reel, kind: "change", request: "lower title" });
      expect(error?.code, status).toBe("42501");
    }
    expect(await jobsOf(reel)).toEqual([]);
  });

  it("refuses a change or restore while a job of the reel is queued or running", async () => {
    for (const status of ["queued", "running"]) {
      const { error: setup } = await admin.from("jobs").insert({
        reel_id: reel,
        owner_id: owner.id,
        status,
        lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
      expect(setup).toBeNull();
      const change = await ownerClient
        .from("jobs")
        .insert({ reel_id: reel, kind: "change", request: "lower title" });
      expect(change.error?.code, status).toBe("42501");
      const restore = await ownerClient
        .from("jobs")
        .insert({ reel_id: reel, kind: "restore", restore_version_id: version });
      expect(restore.error?.code, status).toBe("42501");
      await admin.from("jobs").delete().eq("reel_id", reel);
    }
  });

  it("never lets the owner set status, lease or attempts", async () => {
    for (const extra of [
      { status: "done" },
      { lease_holder: "me" },
      { attempts: 5 },
      { owner_id: other.id },
    ]) {
      const { error } = await ownerClient
        .from("jobs")
        .insert({ reel_id: reel, kind: "change", request: "lower title", ...extra });
      expect(error?.code, JSON.stringify(extra)).toBe("42501");
    }
    expect(await jobsOf(reel)).toEqual([]);
  });

  it("hands the request and the restore target to the worker through claim_job", async () => {
    const { error } = await ownerClient
      .from("jobs")
      .insert({ reel_id: reel, kind: "change", request: "no accent on 'work'" });
    expect(error).toBeNull();
    const claimed = await admin.rpc("claim_job", { p_worker: "change-test", p_lease_seconds: 60 });
    expect(claimed.error).toBeNull();
    expect(claimed.data).toEqual([
      expect.objectContaining({
        reel_id: reel,
        kind: "change",
        request: "no accent on 'work'",
        restore_version_id: null,
      }),
    ]);
    await admin.from("jobs").delete().eq("reel_id", reel);

    await ownerClient
      .from("jobs")
      .insert({ reel_id: reel, kind: "restore", restore_version_id: version });
    const restore = await admin.rpc("claim_job", { p_worker: "change-test", p_lease_seconds: 60 });
    expect(restore.data).toEqual([
      expect.objectContaining({ kind: "restore", request: null, restore_version_id: version }),
    ]);
  });
});
