import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signedInClient,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";

// The worker's failure columns on `jobs` and the reel size columns on `reels`
// (app_docs/status.md, app_docs/measurement.md): their checks, and an owner
// reading but never writing them.

const admin = localSupabaseAdmin();
let user: { id: string; email: string };
let client: SupabaseClient;
let reelId: string;
let refusedJob: string;

async function insertJob(values: Record<string, unknown>) {
  return admin
    .from("jobs")
    .insert({
      reel_id: reelId,
      owner_id: user.id,
      kind: "change",
      request: "make it pop",
      finished_at: new Date().toISOString(),
      ...values,
    })
    .select("id")
    .single<{ id: string }>();
}

beforeAll(async () => {
  user = await createTestUser(admin, "failure-size-columns");
  client = (await signedInClient(admin, user.email)).client;
  reelId = await insertReel(admin, { ownerId: user.id, name: "size.mov", status: "processed" });
  const { data, error } = await insertJob({
    status: "failed",
    error_tail: "the answer failed the checks",
    failure_kind: "answer_refused",
    failure_rules: ["behind-caption", "safe-box"],
  });
  if (error || !data) throw new Error(`job not inserted: ${error?.message}`);
  refusedJob = data.id;
});

afterAll(async () => {
  if (user) await deleteTestUser(admin, user.id);
});

describe("jobs failure columns", () => {
  it("refuses a failure kind outside the three values", async () => {
    const { error } = await insertJob({ status: "failed", failure_kind: "exploded" });
    expect(error?.message).toMatch(/jobs_failure_kind_check/);
  });

  it("refuses a failure kind on a job that is not failed", async () => {
    const { error } = await insertJob({ status: "done", failure_kind: "transient" });
    expect(error?.message).toMatch(/jobs_failure_state_check/);
  });

  it("accepts each kind on a failed job", async () => {
    for (const kind of ["transient", "failed"]) {
      const { error } = await insertJob({ status: "failed", failure_kind: kind });
      expect(error).toBeNull();
    }
  });

  it("refuses rules without answer_refused, or with 0 or 21 entries", async () => {
    const wrongKind = await insertJob({
      status: "failed",
      failure_kind: "failed",
      failure_rules: ["safe-box"],
    });
    expect(wrongKind.error?.message).toMatch(/jobs_failure_rules_check/);
    const none = await insertJob({
      status: "failed",
      failure_kind: "answer_refused",
      failure_rules: [],
    });
    expect(none.error?.message).toMatch(/jobs_failure_rules_check/);
    const tooMany = await insertJob({
      status: "failed",
      failure_kind: "answer_refused",
      failure_rules: Array.from({ length: 21 }, (_, i) => `rule-${i}`),
    });
    expect(tooMany.error?.message).toMatch(/jobs_failure_rules_check/);
  });

  it("lets the owner read the kind and rules of their own job", async () => {
    const { data, error } = await client
      .from("jobs")
      .select("failure_kind, failure_rules")
      .eq("id", refusedJob)
      .single();
    expect(error).toBeNull();
    expect(data).toEqual({
      failure_kind: "answer_refused",
      failure_rules: ["behind-caption", "safe-box"],
    });
  });

  it("never lets the owner update the kind or rules", async () => {
    const { error } = await client
      .from("jobs")
      .update({ failure_kind: "transient", failure_rules: null })
      .eq("id", refusedJob);
    expect(error?.message).toMatch(/permission denied/);
    const { data } = await admin
      .from("jobs")
      .select("failure_kind")
      .eq("id", refusedJob)
      .single<{ failure_kind: string }>();
    expect(data?.failure_kind).toBe("answer_refused");
  });

  it("never lets the owner insert a job with a failure kind", async () => {
    const { error } = await client
      .from("jobs")
      .insert({ reel_id: reelId, kind: "process", failure_kind: "transient" });
    expect(error?.message).toMatch(/permission denied/);
  });
});

describe("reels size columns", () => {
  it("refuses non-positive seconds, width, height and a negative word count", async () => {
    for (const values of [
      { source_seconds: 0 },
      { source_width: 0 },
      { source_height: -1 },
      { word_count: -1 },
    ]) {
      const { error } = await admin.from("reels").update(values).eq("id", reelId);
      expect(error?.message, JSON.stringify(values)).toMatch(/check/);
    }
  });

  it("accepts the worker's values and lets the owner read them", async () => {
    const values = { source_seconds: 52.4, source_width: 1080, source_height: 1920, word_count: 0 };
    const { error } = await admin.from("reels").update(values).eq("id", reelId);
    expect(error).toBeNull();
    const { data } = await client
      .from("reels")
      .select("source_seconds, source_width, source_height, word_count")
      .eq("id", reelId)
      .single();
    expect(data).toEqual(values);
  });

  it("never lets the owner update the size columns", async () => {
    for (const values of [
      { source_seconds: 10 },
      { source_width: 10 },
      { source_height: 10 },
      { word_count: 10 },
    ]) {
      const { error } = await client.from("reels").update(values).eq("id", reelId);
      expect(error?.message, JSON.stringify(values)).toMatch(/permission denied/);
    }
  });
});
