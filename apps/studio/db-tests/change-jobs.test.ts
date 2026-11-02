import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signedInClient,
} from "../test-support/fixtures.ts";
import { localDbUrl, localSupabaseAdmin } from "../test-support/local-supabase.ts";

const admin = localSupabaseAdmin();
let userA: { id: string; email: string };
let userB: { id: string; email: string };
let clientA: SupabaseClient;
let clientB: SupabaseClient;
let reelA: string;
let otherReelA: string;
let reelB: string;
let versionA: string;
let otherVersionA: string;
let versionB: string;

const INPUTS = {
  footage: { step: "retime", fingerprint: "f", file: "source.mp4" },
  transcript: { step: "retime", fingerprint: "f", file: "transcript.json" },
  cutout: { step: "remove_background", fingerprint: "r", file: "subject.webm" },
  head_track: { step: "head_track", fingerprint: "h", file: "head-track.json" },
};

// Version 1 of a reel, saved the way the worker saves it.
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

async function jobsOf(reelId: string) {
  const { data, error } = await admin
    .from("jobs")
    .select("id, owner_id, kind, status, request, restore_version_id")
    .eq("reel_id", reelId)
    .order("created_at");
  expect(error).toBeNull();
  return data ?? [];
}

beforeAll(async () => {
  userA = await createTestUser(admin, "change-jobs-a");
  userB = await createTestUser(admin, "change-jobs-b");
  clientA = (await signedInClient(admin, userA.email)).client;
  clientB = (await signedInClient(admin, userB.email)).client;
  reelA = await insertReel(admin, { ownerId: userA.id, name: "a.mov", status: "processed" });
  otherReelA = await insertReel(admin, { ownerId: userA.id, name: "a2.mov", status: "processed" });
  reelB = await insertReel(admin, { ownerId: userB.id, name: "b.mov", status: "processed" });
  versionA = await saveVersion(reelA);
  otherVersionA = await saveVersion(otherReelA);
  versionB = await saveVersion(reelB);
});

afterAll(async () => {
  // Leave nothing claimable on the stack for the E2E specs.
  for (const reel of [reelA, otherReelA, reelB].filter(Boolean)) {
    await admin.from("jobs").delete().eq("reel_id", reel);
  }
  if (userA) await deleteTestUser(admin, userA.id);
  if (userB) await deleteTestUser(admin, userB.id);
});

describe("change jobs", () => {
  it("lets the owner queue a change with their words", async () => {
    const { error } = await clientA
      .from("jobs")
      .insert({ reel_id: reelA, kind: "change", request: "move the title lower" });
    expect(error).toBeNull();
    expect(await jobsOf(reelA)).toEqual([
      expect.objectContaining({
        owner_id: userA.id,
        kind: "change",
        status: "queued",
        request: "move the title lower",
        restore_version_id: null,
      }),
    ]);
    await admin.from("jobs").delete().eq("reel_id", reelA);
  });

  it("refuses a change for another owner's reel", async () => {
    const { error } = await clientB
      .from("jobs")
      .insert({ reel_id: reelA, kind: "change", request: "move the title lower" });
    expect(error).not.toBeNull();
    expect(await jobsOf(reelA)).toEqual([]);
  });

  it("refuses a change without valid words", async () => {
    for (const request of [undefined, "", "   ", " padded ", "a".repeat(1001)]) {
      const row = { reel_id: reelA, kind: "change", ...(request === undefined ? {} : { request }) };
      const { error } = await clientA.from("jobs").insert(row);
      expect(error, JSON.stringify(request)).not.toBeNull();
    }
    // The check holds for the service role too.
    const { error } = await admin
      .from("jobs")
      .insert({ reel_id: reelA, owner_id: userA.id, kind: "change" });
    expect(error?.message).toMatch(/jobs_request_check/);
    expect(await jobsOf(reelA)).toEqual([]);
  });

  it("accepts exactly 1000 characters", async () => {
    const { error } = await clientA
      .from("jobs")
      .insert({ reel_id: reelA, kind: "change", request: "a".repeat(1000) });
    expect(error).toBeNull();
    await admin.from("jobs").delete().eq("reel_id", reelA);
  });

  it("refuses a request on a process job", async () => {
    const { error } = await admin
      .from("jobs")
      .insert({ reel_id: reelA, owner_id: userA.id, kind: "process", request: "lower" });
    expect(error?.message).toMatch(/jobs_request_check/);
  });

  it("never lets the owner write status, lease or attempts", async () => {
    for (const extra of [
      { status: "running" },
      { lease_holder: "w1" },
      { attempts: 3 },
      { error_tail: "x" },
    ]) {
      const { error } = await clientA
        .from("jobs")
        .insert({ reel_id: reelA, kind: "change", request: "lower", ...extra });
      expect(error, JSON.stringify(extra)).not.toBeNull();
    }
    expect(await jobsOf(reelA)).toEqual([]);

    const { data } = await admin
      .from("jobs")
      .insert({ reel_id: reelA, owner_id: userA.id, kind: "change", request: "lower" })
      .select("id")
      .single();
    await clientA.from("jobs").update({ status: "done" }).eq("id", data!.id);
    expect((await jobsOf(reelA))[0]?.status).toBe("queued");
    await admin.from("jobs").delete().eq("reel_id", reelA);
  });
});

describe("restore jobs", () => {
  it("refuses a restore without a version", async () => {
    const { error } = await clientA.from("jobs").insert({ reel_id: reelA, kind: "restore" });
    expect(error).not.toBeNull();
    const asAdmin = await admin
      .from("jobs")
      .insert({ reel_id: reelA, owner_id: userA.id, kind: "restore" });
    expect(asAdmin.error?.message).toMatch(/jobs_restore_version_check/);
  });

  it("refuses a version of another reel, the owner's or not", async () => {
    for (const version of [otherVersionA, versionB]) {
      const { error } = await clientA
        .from("jobs")
        .insert({ reel_id: reelA, kind: "restore", restore_version_id: version });
      expect(error).not.toBeNull();
    }
    expect(await jobsOf(reelA)).toEqual([]);
  });

  it("refuses a version on a non-restore job", async () => {
    const { error } = await clientA.from("jobs").insert({
      reel_id: reelA,
      kind: "change",
      request: "lower",
      restore_version_id: versionA,
    });
    expect(error).not.toBeNull();
  });

  it("lets the owner go back to a version of the same reel", async () => {
    const { error } = await clientA
      .from("jobs")
      .insert({ reel_id: reelA, kind: "restore", restore_version_id: versionA });
    expect(error).toBeNull();
    expect(await jobsOf(reelA)).toEqual([
      expect.objectContaining({
        owner_id: userA.id,
        kind: "restore",
        status: "queued",
        request: null,
        restore_version_id: versionA,
      }),
    ]);
    await admin.from("jobs").delete().eq("reel_id", reelA);
  });
});

describe("Realtime publication", () => {
  it("still carries reels, jobs and versions", async () => {
    const db = new pg.Client({ connectionString: localDbUrl() });
    await db.connect();
    try {
      const { rows } = await db.query<{ tablename: string }>(
        `select tablename from pg_publication_tables
         where pubname = 'supabase_realtime' and schemaname = 'public'`,
      );
      expect(rows.map((r) => r.tablename)).toEqual(
        expect.arrayContaining(["reels", "jobs", "versions"]),
      );
    } finally {
      await db.end();
    }
  });
});
