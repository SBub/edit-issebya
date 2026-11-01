import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VERSION_COLUMNS, type VersionRow } from "../src/lib/versions.ts";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signedInClient,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin, localSupabaseClient } from "../test-support/local-supabase.ts";

const admin = localSupabaseAdmin();
let owner: { id: string; email: string };
let other: { id: string; email: string };
let ownerClient: SupabaseClient;
let otherClient: SupabaseClient;
let reel: string;
let otherReel: string;
const saved: string[] = [];

const INPUTS = {
  footage: { step: "retime", fingerprint: "f", file: "source.mp4" },
  transcript: { step: "retime", fingerprint: "f", file: "transcript.json" },
  cutout: { step: "remove_background", fingerprint: "r", file: "subject.webm" },
  head_track: { step: "head_track", fingerprint: "h", file: "head-track.json" },
};

function args(reelId: string, id: string, parentId: string | null) {
  return {
    p_id: id,
    p_reel_id: reelId,
    p_parent_id: parentId,
    p_restored_from_id: null,
    p_request: null,
    p_model: null,
    p_prompt_version: null,
    p_change_summary: "test",
    p_checks: [],
    p_inputs: INPUTS,
    p_r2_key: `test/reels/${reelId}/versions/${id}.json`,
  };
}

async function currentOf(reelId: string): Promise<string | null> {
  const { data, error } = await admin
    .from("reels")
    .select("current_version_id")
    .eq("id", reelId)
    .single();
  if (error || !data) throw new Error(`reel not read: ${error?.message}`);
  return (data as { current_version_id: string | null }).current_version_id;
}

beforeAll(async () => {
  owner = await createTestUser(admin, "versions-owner");
  other = await createTestUser(admin, "versions-other");
  ownerClient = (await signedInClient(admin, owner.email)).client;
  otherClient = (await signedInClient(admin, other.email)).client;
  reel = await insertReel(admin, { ownerId: owner.id, name: "versions.mov", status: "received" });
  otherReel = await insertReel(admin, { ownerId: other.id, name: "other.mov", status: "received" });
});

afterAll(async () => {
  if (owner) await deleteTestUser(admin, owner.id);
  if (other) await deleteTestUser(admin, other.id);
});

describe("save_version", () => {
  it("numbers versions 1, 2, 3 and moves current_version_id", async () => {
    let parent: string | null = null;
    for (const expected of [1, 2, 3]) {
      const id = randomUUID();
      const { data, error } = await admin.rpc("save_version", args(reel, id, parent));
      expect(error).toBeNull();
      expect(data).toBe(expected);
      expect(await currentOf(reel)).toBe(id);
      saved.push(id);
      parent = id;
    }
    const { data } = await admin
      .from("versions")
      .select("id, number, parent_id, owner_id")
      .eq("reel_id", reel)
      .order("number");
    expect(data).toEqual([
      { id: saved[0], number: 1, parent_id: null, owner_id: owner.id },
      { id: saved[1], number: 2, parent_id: saved[0], owner_id: owner.id },
      { id: saved[2], number: 3, parent_id: saved[1], owner_id: owner.id },
    ]);
  });

  it("refuses a stale parent", async () => {
    const { error } = await admin.rpc("save_version", args(reel, randomUUID(), saved[0]!));
    expect(error?.message).toMatch(/is not the current version/);
    expect(await currentOf(reel)).toBe(saved[2]);
  });

  it("refuses a parent from another reel", async () => {
    const { error: first } = await admin.rpc("save_version", args(otherReel, randomUUID(), null));
    expect(first).toBeNull();
    // The other reel's current version is its own; naming this reel's as parent is stale.
    const { error } = await admin.rpc("save_version", args(otherReel, randomUUID(), saved[2]!));
    expect(error).not.toBeNull();
  });

  it("stores the decide records it is given, and defaults them when not", async () => {
    const own = await insertReel(admin, {
      ownerId: owner.id,
      name: "records.mov",
      status: "received",
    });
    const withRecords = randomUUID();
    const { error } = await admin.rpc("save_version", {
      ...args(own, withRecords, null),
      p_used_free_field: true,
      p_unexpressed: ["a slow zoom"],
      p_free_field: [{ item: "title", reason: "letter spacing" }],
      p_rejected_reasons: ["safe-box title: runs past the safe box"],
    });
    expect(error).toBeNull();
    const plain = randomUUID();
    const second = await admin.rpc("save_version", args(own, plain, withRecords));
    expect(second.error).toBeNull();
    const { data } = await admin
      .from("versions")
      .select("id, used_free_field, unexpressed, free_field, rejected_reasons")
      .eq("reel_id", own)
      .order("number");
    expect(data).toEqual([
      {
        id: withRecords,
        used_free_field: true,
        unexpressed: ["a slow zoom"],
        free_field: [{ item: "title", reason: "letter spacing" }],
        rejected_reasons: ["safe-box title: runs past the safe box"],
      },
      { id: plain, used_free_field: false, unexpressed: [], free_field: [], rejected_reasons: [] },
    ]);
  });

  it("cannot be executed by anon or an authenticated user", async () => {
    for (const client of [localSupabaseClient(), ownerClient]) {
      const { error } = await client.rpc("save_version", args(reel, randomUUID(), saved[2]!));
      expect(error).not.toBeNull();
    }
    expect(await currentOf(reel)).toBe(saved[2]);
  });
});

describe("versions rows", () => {
  it("never change, even for the service role", async () => {
    const { error } = await admin
      .from("versions")
      .update({ change_summary: "rewritten" })
      .eq("id", saved[0]!);
    expect(error?.message).toMatch(/versions are immutable/);
  });

  it("refuse a current_version_id naming another reel's version", async () => {
    const { error } = await admin
      .from("reels")
      .update({ current_version_id: saved[0] })
      .eq("id", otherReel);
    expect(error?.message).toMatch(/foreign key/);
  });
});

describe("versions RLS", () => {
  it("lets the owner read their versions with the named columns", async () => {
    const { data, error } = await ownerClient
      .from("versions")
      .select(VERSION_COLUMNS)
      .eq("reel_id", reel)
      .order("number");
    expect(error).toBeNull();
    const rows = data as unknown as VersionRow[];
    expect(rows.map((row) => row.number)).toEqual([1, 2, 3]);
    expect(rows[0]).toMatchObject({ checks: [], inputs: INPUTS, model: null, request: null });
  });

  it("hides them from another user and from anon", async () => {
    for (const client of [otherClient, localSupabaseClient()]) {
      const { data } = await client.from("versions").select("id").eq("reel_id", reel);
      expect(data ?? []).toEqual([]);
    }
  });

  it("gives the owner no insert, update or delete", async () => {
    const insert = await ownerClient.from("versions").insert({
      id: randomUUID(),
      reel_id: reel,
      owner_id: owner.id,
      number: 9,
      inputs: INPUTS,
      r2_key: `test/reels/${reel}/versions/x.json`,
    });
    expect(insert.error).not.toBeNull();
    const update = await ownerClient
      .from("versions")
      .update({ change_summary: "mine" })
      .eq("id", saved[0]!)
      .select("id");
    expect(update.error !== null || (update.data ?? []).length === 0).toBe(true);
    const removal = await ownerClient.from("versions").delete().eq("id", saved[0]!).select("id");
    expect(removal.error !== null || (removal.data ?? []).length === 0).toBe(true);
    const { count } = await admin
      .from("versions")
      .select("id", { count: "exact", head: true })
      .eq("reel_id", reel);
    expect(count).toBe(3);
  });

  it("does not let the owner set reels.current_version_id", async () => {
    const { data, error } = await ownerClient
      .from("reels")
      .update({ current_version_id: saved[0] })
      .eq("id", reel)
      .select("id");
    expect(error !== null || (data ?? []).length === 0).toBe(true);
    expect(await currentOf(reel)).toBe(saved[2]);
  });
});
