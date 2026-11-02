import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signedInClient,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";
import { claimableJobIds } from "../test-support/worker.ts";

// Waiting for the AI, the per-job retry and their guards (app_docs/failures.md).
const admin = localSupabaseAdmin();
let userA: { id: string; email: string };
let userB: { id: string; email: string };
let clientA: SupabaseClient;
let clientB: SupabaseClient;
const reels: string[] = [];

interface ClaimedRow {
  id: string;
  status: string;
  attempts: number;
  waiting_reason: string | null;
  not_before: string | null;
  started_at: string | null;
  lease_holder: string | null;
}

const INPUTS = {
  footage: { step: "retime", fingerprint: "f", file: "source.mp4" },
  transcript: { step: "retime", fingerprint: "f", file: "transcript.json" },
  cutout: { step: "remove_background", fingerprint: "r", file: "subject.webm" },
  head_track: { step: "head_track", fingerprint: "h", file: "head-track.json" },
};

async function reel(ownerId: string, status: "processed" | "uploaded" = "processed") {
  const id = await insertReel(admin, { ownerId, status });
  reels.push(id);
  return id;
}

async function saveVersion(reelId: string): Promise<string> {
  const id = randomUUID();
  const { error } = await admin.rpc("save_version", {
    p_id: id,
    p_reel_id: reelId,
    p_parent_id: null,
    p_restored_from_id: null,
    p_request: null,
    p_model: null,
    p_prompt_version: null,
    p_change_summary: "test",
    p_checks: [],
    p_inputs: INPUTS,
    p_r2_key: `test/reels/${reelId}/versions/${id}.json`,
  });
  if (error) throw new Error(`version not saved: ${error.message}`);
  return id;
}

async function insertJob(row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from("jobs").insert(row).select("id").single();
  if (error || !data) throw new Error(`job not inserted: ${error?.message}`);
  return data.id as string;
}

async function readJob(id: string): Promise<ClaimedRow> {
  const { data, error } = await admin
    .from("jobs")
    .select("id, status, attempts, waiting_reason, not_before, started_at, lease_holder")
    .eq("id", id)
    .single();
  if (error || !data) throw new Error(`job not read: ${error?.message}`);
  return data as ClaimedRow;
}

async function claim(worker: string): Promise<ClaimedRow[]> {
  const { data, error } = await admin.rpc("claim_job", { p_worker: worker, p_lease_seconds: 300 });
  if (error) throw new Error(`claim_job failed: ${error.message}`);
  return data as ClaimedRow[];
}

function waitForAi(jobId: string, worker: string, reason = "usage limit reached", seconds = 900) {
  return admin.rpc("wait_for_ai", {
    p_job_id: jobId,
    p_worker: worker,
    p_reason: reason,
    p_retry_after_seconds: seconds,
  });
}

beforeAll(async () => {
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  userA = await createTestUser(admin, "failures-a");
  userB = await createTestUser(admin, "failures-b");
  clientA = (await signedInClient(admin, userA.email)).client;
  clientB = (await signedInClient(admin, userB.email)).client;
});

afterAll(async () => {
  // Leave nothing claimable on the stack for the E2E specs.
  for (const id of reels) await admin.from("jobs").delete().eq("reel_id", id);
  if (userA) await deleteTestUser(admin, userA.id);
  if (userB) await deleteTestUser(admin, userB.id);
});

describe("waiting for the AI", () => {
  let waiting: string;
  let other: string;

  it("needs a reason and a next try, and nothing else carries them", async () => {
    const reelId = await reel(userA.id);
    const job = await insertJob({ reel_id: reelId, owner_id: userA.id, status: "failed" });
    const bare = await admin.from("jobs").update({ status: "waiting_ai" }).eq("id", job);
    expect(bare.error?.code).toBe("23514");
    const half = await admin
      .from("jobs")
      .update({ status: "waiting_ai", waiting_reason: "usage limit reached" })
      .eq("id", job);
    expect(half.error?.code).toBe("23514");
    const stray = await admin
      .from("jobs")
      .update({ waiting_reason: "usage limit reached", not_before: new Date().toISOString() })
      .eq("id", job);
    expect(stray.error?.code).toBe("23514");
  });

  it("wait_for_ai moves this worker's leased job, 15 minutes ahead by the database clock", async () => {
    const reelId = await reel(userA.id);
    waiting = await insertJob({ reel_id: reelId, owner_id: userA.id });
    expect((await claim("w1")).map((row) => row.id)).toEqual([waiting]);

    const wrong = await waitForAi(waiting, "w2");
    expect(wrong.error).toBeNull();
    expect(wrong.data).toBe(false);
    expect((await waitForAi(waiting, "w1", "")).error).not.toBeNull();
    expect((await waitForAi(waiting, "w1", "x".repeat(201))).error).not.toBeNull();
    expect((await waitForAi(waiting, "w1", "usage limit reached", 30)).error).not.toBeNull();

    const moved = await waitForAi(waiting, "w1");
    expect(moved.error).toBeNull();
    expect(moved.data).toBe(true);
    const row = await readJob(waiting);
    expect(row).toMatchObject({
      status: "waiting_ai",
      waiting_reason: "usage limit reached",
      lease_holder: null,
    });
    // Both stamps come from the database clock.
    const ahead = new Date(row.not_before!).getTime() - new Date(row.started_at!).getTime();
    expect(ahead).toBeGreaterThanOrEqual(900_000);
    expect(ahead).toBeLessThan(910_000);
    // A waiting job is no longer leased: a second wait writes nothing.
    expect((await waitForAi(waiting, "w1")).data).toBe(false);
  });

  it("claim_job skips it until its next try and takes another reel's job meanwhile", async () => {
    const otherReel = await reel(userB.id);
    other = await insertJob({ reel_id: otherReel, owner_id: userB.id });
    expect((await claim("w3")).map((row) => row.id)).toEqual([other]);
    await admin
      .from("jobs")
      .update({ status: "done", lease_expires_at: null, finished_at: new Date().toISOString() })
      .eq("id", other);
    expect(await claim("w3")).toEqual([]);
  });

  it("claims it once its next try has come, clearing the reason and counting the attempt", async () => {
    const { started_at } = await readJob(waiting);
    const past = new Date(new Date(started_at!).getTime() - 60_000).toISOString();
    const { error } = await admin.from("jobs").update({ not_before: past }).eq("id", waiting);
    expect(error).toBeNull();
    const [claimed] = await claim("w4");
    expect(claimed).toMatchObject({
      id: waiting,
      status: "running",
      attempts: 2,
      waiting_reason: null,
      not_before: null,
      lease_holder: "w4",
    });
    await admin
      .from("jobs")
      .update({ status: "done", lease_expires_at: null, finished_at: new Date().toISOString() })
      .eq("id", waiting);
  });

  it("accepts a waiting step row", async () => {
    const reelId = await reel(userA.id);
    const job = await insertJob({ reel_id: reelId, owner_id: userA.id, status: "failed" });
    const { error } = await admin.from("steps").insert({
      job_id: job,
      reel_id: reelId,
      owner_id: userA.id,
      name: "decide",
      status: "waiting_ai",
    });
    expect(error).toBeNull();
  });

  it("refuses the owner both wait_for_ai and claim_job", async () => {
    const wait = await clientA.rpc("wait_for_ai", {
      p_job_id: randomUUID(),
      p_worker: "x",
      p_reason: "usage limit reached",
      p_retry_after_seconds: 900,
    });
    expect(wait.error).not.toBeNull();
    const claimed = await clientA.rpc("claim_job", { p_worker: "x", p_lease_seconds: 300 });
    expect(claimed.error).not.toBeNull();
  });
});

describe("retrying a failed job", () => {
  let reelId: string;
  let versionId: string;
  const failed: Record<string, string> = {};

  beforeAll(async () => {
    reelId = await reel(userA.id);
    versionId = await saveVersion(reelId);
    const base = { reel_id: reelId, owner_id: userA.id, status: "failed" };
    failed.process = await insertJob({ ...base, kind: "process" });
    failed.change = await insertJob({ ...base, kind: "change", request: "move the title lower" });
    failed.restore = await insertJob({ ...base, kind: "restore", restore_version_id: versionId });
    failed.render = await insertJob({ ...base, kind: "render", version_id: versionId });
  });

  it("lets the owner retry each kind of their failed job with its parameters", async () => {
    const rows = [
      { kind: "process" },
      { kind: "change", request: "move the title lower" },
      { kind: "restore", restore_version_id: versionId },
      { kind: "render", version_id: versionId },
    ];
    for (const row of rows) {
      const { error } = await clientA
        .from("jobs")
        .insert({ reel_id: reelId, ...row, retry_of_job_id: failed[row.kind] });
      expect(error, row.kind).toBeNull();
    }
    const { data } = await admin
      .from("jobs")
      .select("kind, status, retry_of_job_id")
      .eq("reel_id", reelId)
      .not("retry_of_job_id", "is", null);
    expect(data).toHaveLength(4);
    for (const row of data ?? []) {
      expect(row.status).toBe("queued");
      expect(row.retry_of_job_id).toBe(failed[row.kind as string]);
    }
  });

  it("refuses a second retry of the same job", async () => {
    const { error } = await clientA
      .from("jobs")
      .insert({ reel_id: reelId, kind: "process", retry_of_job_id: failed.process });
    expect(error?.code).toBe("23505");
  });

  it("refuses a retry of a job that did not fail", async () => {
    for (const status of ["queued", "done"]) {
      const target = await reel(userA.id);
      const job = await insertJob({ reel_id: target, owner_id: userA.id, status });
      const { error } = await clientA
        .from("jobs")
        .insert({ reel_id: target, kind: "process", retry_of_job_id: job });
      expect(error?.code, status).toBe("23514");
      await admin.from("jobs").delete().eq("id", job);
    }
  });

  it("refuses another reel's job, another kind or other parameters", async () => {
    const target = await reel(userA.id);
    const other = await reel(userA.id);
    const job = await insertJob({
      reel_id: target,
      owner_id: userA.id,
      status: "failed",
      kind: "change",
      request: "move the title lower",
    });
    const attempts = [
      { reel_id: other, kind: "change", request: "move the title lower" },
      { reel_id: target, kind: "process" },
      { reel_id: target, kind: "change", request: "move the title higher" },
    ];
    for (const row of attempts) {
      const { error } = await clientA.from("jobs").insert({ ...row, retry_of_job_id: job });
      expect(error?.code, JSON.stringify(row)).toBe("23514");
    }
  });

  it("refuses a retry on a refused reel", async () => {
    const target = await reel(userA.id);
    const job = await insertJob({ reel_id: target, owner_id: userA.id, status: "failed" });
    const refused = await admin
      .from("reels")
      .update({ status: "refused", refusal_message: "This clip has no sound." })
      .eq("id", target);
    expect(refused.error).toBeNull();
    const { error } = await clientA
      .from("jobs")
      .insert({ reel_id: target, kind: "process", retry_of_job_id: job });
    expect(error?.code).toBe("23514");
  });

  it("refuses another owner's job, on their reel or on one's own", async () => {
    const target = await reel(userA.id);
    const job = await insertJob({ reel_id: target, owner_id: userA.id, status: "failed" });
    const own = await reel(userB.id);
    const onTheirs = await clientB
      .from("jobs")
      .insert({ reel_id: target, kind: "process", retry_of_job_id: job });
    expect(onTheirs.error).not.toBeNull();
    const onOwn = await clientB
      .from("jobs")
      .insert({ reel_id: own, kind: "process", retry_of_job_id: job });
    expect(onOwn.error?.code).toBe("23514");
    const { data } = await admin.from("jobs").select("id").eq("retry_of_job_id", job);
    expect(data).toEqual([]);
  });
});
