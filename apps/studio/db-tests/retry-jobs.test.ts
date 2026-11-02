import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signedInClient,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";

// The Retry button's insert (app_docs/failures.md): a new job naming a failed
// job of the same reel, kind and parameters in `retry_of_job_id`, once; and the
// checks on the refused reel and the waiting job.

const admin = localSupabaseAdmin();
let userA: { id: string; email: string };
let userB: { id: string; email: string };
let clientA: SupabaseClient;
let clientB: SupabaseClient;
let reelA: string;
let otherReelA: string;
let reelB: string;
let versionA: string;
let failedProcess: string;
let failedChange: string;
let failedRender: string;
let doneProcess: string;
let failedB: string;

const REQUEST = "move the title lower";
const INPUTS = {
  footage: { step: "retime", fingerprint: "f", file: "source.mp4" },
  transcript: { step: "retime", fingerprint: "f", file: "transcript.json" },
  cutout: { step: "remove_background", fingerprint: "r", file: "subject.webm" },
  head_track: { step: "head_track", fingerprint: "h", file: "head-track.json" },
};

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

// A finished job, as the worker leaves it (service role).
async function endedJob(
  reelId: string,
  ownerId: string,
  status: "failed" | "done",
  extra: Record<string, string> = {},
): Promise<string> {
  const { data, error } = await admin
    .from("jobs")
    .insert({
      reel_id: reelId,
      owner_id: ownerId,
      kind: "process",
      status,
      error_tail: status === "failed" ? "boom" : null,
      finished_at: new Date().toISOString(),
      ...extra,
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) throw new Error(`job not inserted: ${error?.message}`);
  return data.id;
}

async function retriesOf(jobId: string) {
  const { data, error } = await admin
    .from("jobs")
    .select("id, owner_id, reel_id, kind, status, request, version_id, retry_of_job_id")
    .eq("retry_of_job_id", jobId);
  expect(error).toBeNull();
  return data ?? [];
}

beforeAll(async () => {
  userA = await createTestUser(admin, "retry-jobs-a");
  userB = await createTestUser(admin, "retry-jobs-b");
  clientA = (await signedInClient(admin, userA.email)).client;
  clientB = (await signedInClient(admin, userB.email)).client;
  reelA = await insertReel(admin, { ownerId: userA.id, name: "a.mov", status: "processed" });
  otherReelA = await insertReel(admin, { ownerId: userA.id, name: "a2.mov", status: "processed" });
  reelB = await insertReel(admin, { ownerId: userB.id, name: "b.mov", status: "processed" });
  versionA = await saveVersion(reelA);
  failedProcess = await endedJob(reelA, userA.id, "failed");
  failedChange = await endedJob(reelA, userA.id, "failed", { kind: "change", request: REQUEST });
  failedRender = await endedJob(reelA, userA.id, "failed", {
    kind: "render",
    version_id: versionA,
  });
  doneProcess = await endedJob(reelA, userA.id, "done");
  failedB = await endedJob(reelB, userB.id, "failed");
});

// Leave nothing claimable on the stack for the E2E specs.
afterEach(async () => {
  for (const reel of [reelA, otherReelA, reelB].filter(Boolean)) {
    await admin.from("jobs").delete().eq("reel_id", reel).in("status", ["queued", "waiting_ai"]);
  }
});

afterAll(async () => {
  if (userA) await deleteTestUser(admin, userA.id);
  if (userB) await deleteTestUser(admin, userB.id);
});

describe("retry jobs", () => {
  it("lets the owner retry their failed process, change and render job", async () => {
    const rows: Record<string, string>[] = [
      { reel_id: reelA, kind: "process", retry_of_job_id: failedProcess },
      { reel_id: reelA, kind: "change", request: REQUEST, retry_of_job_id: failedChange },
      { reel_id: reelA, kind: "render", version_id: versionA, retry_of_job_id: failedRender },
    ];
    for (const row of rows) {
      const { error } = await clientA.from("jobs").insert(row);
      expect(error, row.kind).toBeNull();
    }
    expect(await retriesOf(failedProcess)).toEqual([
      expect.objectContaining({ owner_id: userA.id, kind: "process", status: "queued" }),
    ]);
    expect(await retriesOf(failedChange)).toEqual([
      expect.objectContaining({ kind: "change", request: REQUEST, status: "queued" }),
    ]);
    expect(await retriesOf(failedRender)).toEqual([
      expect.objectContaining({ kind: "render", version_id: versionA, status: "queued" }),
    ]);
  });

  it("lets one retry per failed job through", async () => {
    const row = { reel_id: reelA, kind: "process", retry_of_job_id: failedProcess };
    expect((await clientA.from("jobs").insert(row)).error).toBeNull();
    const second = await clientA.from("jobs").insert(row);
    expect(second.error?.code).toBe("23505");
    expect(await retriesOf(failedProcess)).toHaveLength(1);
  });

  it("refuses a retry of anything but the owner's failed job with the same parameters", async () => {
    const refused: [string, SupabaseClient, Record<string, string>][] = [
      ["a done job", clientA, { reel_id: reelA, kind: "process", retry_of_job_id: doneProcess }],
      [
        "another reel's job",
        clientA,
        { reel_id: otherReelA, kind: "process", retry_of_job_id: failedProcess },
      ],
      [
        "a different kind",
        clientA,
        { reel_id: reelA, kind: "process", retry_of_job_id: failedChange },
      ],
      [
        "a different request",
        clientA,
        { reel_id: reelA, kind: "change", request: "other words", retry_of_job_id: failedChange },
      ],
      [
        "another owner's job, on their own reel",
        clientB,
        { reel_id: reelB, kind: "process", retry_of_job_id: failedProcess },
      ],
      [
        "another owner's job, named from the owner's reel",
        clientA,
        { reel_id: reelA, kind: "process", retry_of_job_id: failedB },
      ],
    ];
    for (const [what, client, row] of refused) {
      const { error } = await client.from("jobs").insert(row);
      expect(error, what).not.toBeNull();
    }
    for (const job of [doneProcess, failedProcess, failedChange, failedB]) {
      expect(await retriesOf(job)).toEqual([]);
    }
  });

  it("never lets the owner write status, waiting_reason or not_before", async () => {
    for (const extra of [
      { status: "queued" },
      { status: "waiting_ai" },
      { waiting_reason: "the usage limit is reached" },
      { not_before: new Date().toISOString() },
    ]) {
      const { error } = await clientA
        .from("jobs")
        .insert({ reel_id: reelA, kind: "process", ...extra });
      expect(error, JSON.stringify(extra)).not.toBeNull();
    }
  });
});

describe("refused reels", () => {
  it("needs a message exactly when refused", async () => {
    const reel = await insertReel(admin, { ownerId: userA.id, status: "uploaded" });
    const noMessage = await admin.from("reels").update({ status: "refused" }).eq("id", reel);
    expect(noMessage.error?.message).toMatch(/reels_refusal_check/);
    const notRefused = await admin
      .from("reels")
      .update({ status: "processed", refusal_message: "This clip has no sound." })
      .eq("id", reel);
    expect(notRefused.error?.message).toMatch(/reels_refusal_check/);
    const both = await admin
      .from("reels")
      .update({ status: "refused", refusal_message: "This clip has no sound." })
      .eq("id", reel);
    expect(both.error).toBeNull();
    for (const status of ["checking_footage", "refused"]) {
      expect((await admin.from("reels").select("id").eq("status", status)).error).toBeNull();
    }
  });

  it("never lets the owner write a refusal message", async () => {
    const { error } = await clientA
      .from("reels")
      .insert({ id: randomUUID(), source_name: "x.mov", refusal_message: "no" });
    expect(error).not.toBeNull();
  });
});

describe("waiting jobs and steps", () => {
  const later = () => new Date(Date.now() + 3_600_000).toISOString();

  it("needs a reason and a next try exactly when waiting for the AI", async () => {
    const base = { reel_id: otherReelA, owner_id: userA.id, kind: "process" };
    for (const row of [
      { ...base, status: "waiting_ai" },
      { ...base, status: "waiting_ai", waiting_reason: "the usage limit is reached" },
      { ...base, status: "waiting_ai", not_before: later() },
      { ...base, status: "queued", waiting_reason: "the usage limit is reached" },
      { ...base, status: "failed", not_before: later() },
    ]) {
      const { error } = await admin.from("jobs").insert(row);
      expect(error?.message, JSON.stringify(row)).toMatch(/jobs_waiting_check/);
    }
    const { error } = await admin.from("jobs").insert({
      ...base,
      status: "waiting_ai",
      waiting_reason: "the usage limit is reached",
      not_before: later(),
    });
    expect(error).toBeNull();
  });

  it("accepts a waiting step row", async () => {
    const { data, error } = await admin
      .from("steps")
      .insert({
        job_id: doneProcess,
        reel_id: reelA,
        owner_id: userA.id,
        name: "decide",
        status: "waiting",
        error_tail: "the usage limit is reached",
        summary: "decide waiting for the AI",
        finished_at: new Date().toISOString(),
      })
      .select("status")
      .single();
    expect(error).toBeNull();
    expect(data).toEqual({ status: "waiting" });
  });
});
