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
import {
  localDbUrl,
  localSupabaseAdmin,
  localSupabaseClient,
} from "../test-support/local-supabase.ts";

const admin = localSupabaseAdmin();
const DAY_MS = 24 * 3600 * 1000;
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
let jobA: string;
let jobB: string;

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

// A finished render job, never claimable, as the worker leaves one.
async function doneRenderJob(reelId: string, ownerId: string, versionId: string) {
  const { data, error } = await admin
    .from("jobs")
    .insert({
      reel_id: reelId,
      owner_id: ownerId,
      kind: "render",
      version_id: versionId,
      status: "done",
      finished_at: new Date().toISOString(),
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) throw new Error(`render job not inserted: ${error?.message}`);
  return data.id;
}

async function renderJobsOf(reelId: string) {
  const { data, error } = await admin
    .from("jobs")
    .select("id, owner_id, kind, status, version_id")
    .eq("reel_id", reelId)
    .eq("kind", "render")
    .eq("status", "queued");
  expect(error).toBeNull();
  return data ?? [];
}

// An export row as the worker writes it (service role).
function exportRow(reelId: string, jobId: string, versionId: string, extra = {}) {
  const id = randomUUID();
  return {
    id,
    reel_id: reelId,
    owner_id: userA.id,
    job_id: jobId,
    version_id: versionId,
    r2_key: `test/exports/${reelId}/${id}.mp4`,
    bytes: 1234,
    ...extra,
  };
}

beforeAll(async () => {
  userA = await createTestUser(admin, "exports-a");
  userB = await createTestUser(admin, "exports-b");
  clientA = (await signedInClient(admin, userA.email)).client;
  clientB = (await signedInClient(admin, userB.email)).client;
  reelA = await insertReel(admin, { ownerId: userA.id, name: "a.mov", status: "processed" });
  otherReelA = await insertReel(admin, { ownerId: userA.id, name: "a2.mov", status: "processed" });
  reelB = await insertReel(admin, { ownerId: userB.id, name: "b.mov", status: "processed" });
  versionA = await saveVersion(reelA);
  otherVersionA = await saveVersion(otherReelA);
  versionB = await saveVersion(reelB);
  jobA = await doneRenderJob(reelA, userA.id, versionA);
  jobB = await doneRenderJob(reelB, userB.id, versionB);
});

afterAll(async () => {
  // Leave nothing claimable on the stack for the E2E specs.
  for (const reel of [reelA, otherReelA, reelB].filter(Boolean)) {
    await admin.from("jobs").delete().eq("reel_id", reel);
  }
  if (userA) await deleteTestUser(admin, userA.id);
  if (userB) await deleteTestUser(admin, userB.id);
});

describe("render jobs", () => {
  it("lets the owner queue a render of a version of their own reel", async () => {
    const { error } = await clientA
      .from("jobs")
      .insert({ reel_id: reelA, kind: "render", version_id: versionA });
    expect(error).toBeNull();
    expect(await renderJobsOf(reelA)).toEqual([
      expect.objectContaining({
        owner_id: userA.id,
        kind: "render",
        status: "queued",
        version_id: versionA,
      }),
    ]);
    await admin.from("jobs").delete().eq("reel_id", reelA).eq("status", "queued");
  });

  it("refuses another owner's reel and a version of another reel", async () => {
    const cases = [
      { client: clientA, row: { reel_id: reelB, kind: "render", version_id: versionB } },
      { client: clientA, row: { reel_id: reelA, kind: "render", version_id: otherVersionA } },
      { client: clientA, row: { reel_id: reelA, kind: "render", version_id: versionB } },
      { client: clientB, row: { reel_id: reelA, kind: "render", version_id: versionA } },
    ];
    for (const { client, row } of cases) {
      const { error } = await client.from("jobs").insert(row);
      expect(error).not.toBeNull();
    }
    expect(await renderJobsOf(reelA)).toEqual([]);
    expect(await renderJobsOf(reelB)).toEqual([]);
  });

  it("refuses a render without a version and one not queued", async () => {
    expect(
      (await clientA.from("jobs").insert({ reel_id: reelA, kind: "render" })).error,
    ).not.toBeNull();
    expect(
      (
        await clientA
          .from("jobs")
          .insert({ reel_id: reelA, kind: "render", version_id: versionA, status: "running" })
      ).error,
    ).not.toBeNull();
    const asAdmin = await admin
      .from("jobs")
      .insert({ reel_id: reelA, owner_id: userA.id, kind: "render" });
    expect(asAdmin.error?.message).toMatch(/jobs_version_check/);
    expect(await renderJobsOf(reelA)).toEqual([]);
  });

  it("refuses a version on a change or a restore job", async () => {
    const change = await clientA
      .from("jobs")
      .insert({ reel_id: reelA, kind: "change", request: "lower", version_id: versionA });
    expect(change.error).not.toBeNull();
    const restore = await clientA.from("jobs").insert({
      reel_id: reelA,
      kind: "restore",
      restore_version_id: versionA,
      version_id: versionA,
    });
    expect(restore.error).not.toBeNull();
    const asAdmin = await admin.from("jobs").insert({
      reel_id: reelA,
      owner_id: userA.id,
      kind: "restore",
      restore_version_id: versionA,
      version_id: versionA,
    });
    expect(asAdmin.error?.message).toMatch(/jobs_version_check/);
  });
});

describe("exports", () => {
  let exportA: string;

  it("expires exactly 24 hours after it was made and belongs to the reel's owner", async () => {
    const row = exportRow(reelA, jobA, versionA, {
      owner_id: userB.id,
      expires_at: new Date(Date.now() + 365 * DAY_MS).toISOString(),
    });
    const { data, error } = await admin
      .from("exports")
      .insert(row)
      .select("id, owner_id, created_at, expires_at")
      .single<{ id: string; owner_id: string; created_at: string; expires_at: string }>();
    expect(error).toBeNull();
    expect(data!.owner_id).toBe(userA.id);
    expect(Date.parse(data!.expires_at) - Date.parse(data!.created_at)).toBe(DAY_MS);
    exportA = data!.id;
  });

  it("keeps an older created_at's expiry 24 hours after it", async () => {
    const created = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    const otherJob = await doneRenderJob(reelA, userA.id, versionA);
    const { data, error } = await admin
      .from("exports")
      .insert(exportRow(reelA, otherJob, versionA, { created_at: created }))
      .select("id, expires_at")
      .single<{ id: string; expires_at: string }>();
    expect(error).toBeNull();
    expect(Date.parse(data!.expires_at)).toBe(Date.parse(created) + DAY_MS);
    await admin.from("exports").delete().eq("id", data!.id);
  });

  it("refuses a version of another reel and a second export of one job", async () => {
    const wrongVersion = await admin.from("exports").insert(exportRow(reelA, jobB, otherVersionA));
    expect(wrongVersion.error).not.toBeNull();
    const twice = await admin.from("exports").insert(exportRow(reelA, jobA, versionA));
    expect(twice.error).not.toBeNull();
  });

  it("is never updated, not even by the service role", async () => {
    const { error } = await admin.from("exports").update({ bytes: 1 }).eq("id", exportA);
    expect(error?.message).toMatch(/exports are immutable/);
  });

  it("is read by its owner only", async () => {
    const own = await clientA.from("exports").select("id").eq("reel_id", reelA);
    expect(own.error).toBeNull();
    expect(own.data).toEqual([{ id: exportA }]);
    const other = await clientB.from("exports").select("id");
    expect(other.error).toBeNull();
    expect(other.data).toEqual([]);
    const anon = await localSupabaseClient().from("exports").select("id");
    expect(anon.data ?? []).toEqual([]);
  });

  it("cannot be written by an owner", async () => {
    const insert = await clientA.from("exports").insert(exportRow(reelA, jobA, versionA));
    expect(insert.error).not.toBeNull();
    await clientA.from("exports").update({ bytes: 1 }).eq("id", exportA);
    await clientA.from("exports").delete().eq("id", exportA);
    const { data } = await admin.from("exports").select("id, bytes").eq("id", exportA);
    expect(data).toEqual([{ id: exportA, bytes: 1234 }]);
  });

  it("is in the Realtime publication", async () => {
    const db = new pg.Client({ connectionString: localDbUrl() });
    await db.connect();
    try {
      const { rows } = await db.query<{ tablename: string }>(
        `select tablename from pg_publication_tables
         where pubname = 'supabase_realtime' and schemaname = 'public'`,
      );
      expect(rows.map((r) => r.tablename)).toContain("exports");
    } finally {
      await db.end();
    }
  });
});
