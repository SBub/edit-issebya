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

// cancel_job (app_docs/export.md): the owner of a reel cancels their own
// render job while it is queued, running or waiting for the AI and has no
// export yet; claim_job never takes a cancelled job.

const admin = localSupabaseAdmin();
let userA: { id: string; email: string };
let userB: { id: string; email: string };
let clientA: SupabaseClient;
let clientB: SupabaseClient;
let reelA: string;
let reelB: string;
let versionA: string;

const INPUTS = {
  footage: { step: "retime", fingerprint: "f", file: "source.mp4" },
  transcript: { step: "retime", fingerprint: "f", file: "transcript.json" },
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

// A job as the worker or the owner leaves it, inserted with the secret key.
async function insertJob(row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin
    .from("jobs")
    .insert({ reel_id: reelA, owner_id: userA.id, ...row })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) throw new Error(`job not inserted: ${error?.message}`);
  return data.id;
}

const render = (extra: Record<string, unknown> = {}) =>
  insertJob({ kind: "render", version_id: versionA, ...extra });

const running = () =>
  render({
    status: "running",
    lease_holder: "w1",
    lease_expires_at: new Date(Date.now() + 300_000).toISOString(),
    started_at: new Date().toISOString(),
    attempts: 1,
  });

async function readJob(id: string) {
  const { data, error } = await admin
    .from("jobs")
    .select("status, finished_at, lease_expires_at")
    .eq("id", id)
    .single<{ status: string; finished_at: string | null; lease_expires_at: string | null }>();
  if (error || !data) throw new Error(`job not read: ${error?.message}`);
  return data;
}

async function cancel(client: SupabaseClient, jobId: string) {
  return client.rpc("cancel_job", { p_job_id: jobId });
}

async function clearJobs() {
  for (const reel of [reelA, reelB]) await admin.from("jobs").delete().eq("reel_id", reel);
}

beforeAll(async () => {
  userA = await createTestUser(admin, "cancel-a");
  userB = await createTestUser(admin, "cancel-b");
  clientA = (await signedInClient(admin, userA.email)).client;
  clientB = (await signedInClient(admin, userB.email)).client;
  reelA = await insertReel(admin, { ownerId: userA.id, name: "a.mov", status: "processed" });
  reelB = await insertReel(admin, { ownerId: userB.id, name: "b.mov", status: "processed" });
  versionA = await saveVersion(reelA);
});

afterAll(async () => {
  // Leave nothing claimable on the stack for the E2E specs.
  if (reelA && reelB) await clearJobs();
  if (userA) await deleteTestUser(admin, userA.id);
  if (userB) await deleteTestUser(admin, userB.id);
});

describe("cancel_job", () => {
  it("cancels the owner's own queued render", async () => {
    const { data: queued, error: queueError } = await clientA
      .from("jobs")
      .insert({ reel_id: reelA, kind: "render", version_id: versionA })
      .select("id")
      .single<{ id: string }>();
    expect(queueError).toBeNull();
    const { data, error } = await cancel(clientA, queued!.id);
    expect(error).toBeNull();
    expect(data).toBe(true);
    const job = await readJob(queued!.id);
    expect(job.status).toBe("cancelled");
    expect(job.finished_at).not.toBeNull();
    // A second cancel finds nothing live.
    expect((await cancel(clientA, queued!.id)).data).toBe(false);
    await clearJobs();
  });

  it("cancels the owner's own running render and clears its lease", async () => {
    const id = await running();
    const { data, error } = await cancel(clientA, id);
    expect(error).toBeNull();
    expect(data).toBe(true);
    expect(await readJob(id)).toMatchObject({ status: "cancelled", lease_expires_at: null });
    await clearJobs();
  });

  it("refuses another owner's job and changes nothing", async () => {
    const id = await render();
    const { data, error } = await cancel(clientB, id);
    expect(error).toBeNull();
    expect(data).toBe(false);
    expect((await readJob(id)).status).toBe("queued");
    await clearJobs();
  });

  it("refuses a job of another kind", async () => {
    const change = await insertJob({ kind: "change", request: "make it shorter" });
    expect((await cancel(clientA, change)).data).toBe(false);
    expect((await readJob(change)).status).toBe("queued");
    await clearJobs();
  });

  it("refuses a done or failed render", async () => {
    const done = await render({ status: "done", finished_at: new Date().toISOString() });
    const failed = await render({
      status: "failed",
      finished_at: new Date().toISOString(),
      error_tail: "render failed",
    });
    expect((await cancel(clientA, done)).data).toBe(false);
    expect((await cancel(clientA, failed)).data).toBe(false);
    expect((await readJob(done)).status).toBe("done");
    expect((await readJob(failed)).status).toBe("failed");
    await clearJobs();
  });

  it("refuses a running render whose export is already recorded", async () => {
    const id = await running();
    const exportId = randomUUID();
    const inserted = await admin.from("exports").insert({
      id: exportId,
      reel_id: reelA,
      owner_id: userA.id,
      job_id: id,
      version_id: versionA,
      r2_key: `test/exports/${reelA}/${exportId}.mp4`,
      bytes: 10,
    });
    expect(inserted.error).toBeNull();
    expect((await cancel(clientA, id)).data).toBe(false);
    expect((await readJob(id)).status).toBe("running");
    await clearJobs();
  });

  it("refuses an export row for a cancelled job, even from the service role", async () => {
    const id = await running();
    expect((await cancel(clientA, id)).data).toBe(true);
    const exportId = randomUUID();
    const { error } = await admin.from("exports").insert({
      id: exportId,
      reel_id: reelA,
      owner_id: userA.id,
      job_id: id,
      version_id: versionA,
      r2_key: `test/exports/${reelA}/${exportId}.mp4`,
      bytes: 10,
    });
    expect(error?.message).toMatch(/the job was cancelled/);
    await clearJobs();
  });

  it("cannot be executed by anon", async () => {
    const id = await render();
    const { error } = await cancel(localSupabaseClient(), id);
    expect(error).not.toBeNull();
    expect((await readJob(id)).status).toBe("queued");
    const db = new pg.Client({ connectionString: localDbUrl() });
    await db.connect();
    try {
      const { rows } = await db.query<{ anon: boolean; authenticated: boolean }>(
        `select has_function_privilege('anon', 'public.cancel_job(uuid)', 'execute') as anon,
                has_function_privilege('authenticated', 'public.cancel_job(uuid)', 'execute')
                  as authenticated`,
      );
      expect(rows[0]).toEqual({ anon: false, authenticated: true });
    } finally {
      await db.end();
    }
    await clearJobs();
  });

  it("gives the owner no general update right on jobs", async () => {
    const id = await render();
    await clientA.from("jobs").update({ status: "cancelled" }).eq("id", id);
    expect((await readJob(id)).status).toBe("queued");
    await clearJobs();
  });
});

describe("claim_job and a cancelled job", () => {
  it("never claims a cancelled render, and it holds no later job of the reel back", async () => {
    // The cancelled render is the oldest job on the stack; a later process
    // job of the same reel is what claim_job takes.
    const cancelled = await render({ created_at: new Date(Date.now() - 600_000).toISOString() });
    expect((await cancel(clientA, cancelled)).data).toBe(true);
    const later = await insertJob({
      kind: "change",
      request: "make it shorter",
      created_at: new Date(Date.now() - 300_000).toISOString(),
    });

    const first = await admin.rpc("claim_job", { p_worker: "cancel-test", p_lease_seconds: 60 });
    expect(first.error).toBeNull();
    expect((first.data as { id: string }[]).map((job) => job.id)).toEqual([later]);
    const second = await admin.rpc("claim_job", { p_worker: "cancel-test", p_lease_seconds: 60 });
    expect(second.data).toEqual([]);
    expect((await readJob(cancelled)).status).toBe("cancelled");
    await clearJobs();
  });
});
