import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Edit,
  type VersionRow,
  restoreVersion,
  saveVersion,
  supabaseVersionStore,
} from "@edit-issebya/edit";
import { type Storage, fakeStorage } from "@edit-issebya/storage";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signedInClient,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin, localSupabaseClient } from "../test-support/local-supabase.ts";

const INPUTS = {
  footage: "1".repeat(64),
  transcript: "2".repeat(64),
  cutout: "3".repeat(64),
  headTrack: "4".repeat(64),
};

function editWith(text: string): Edit {
  return {
    format: 1,
    inputs: INPUTS,
    tracks: {
      footage: [],
      cutout: [],
      captions: [{ id: "c1", start: { word: "w0001" }, end: { word: "w0001" }, text }],
      overlays: [],
      transitions: [],
      sounds: [],
    },
  };
}

const meta = (summary: string) => ({
  request: null,
  model: null,
  promptVersion: null,
  changeSummary: summary,
  checks: { ok: true, reasons: [] },
});

describe("versions", () => {
  // The admin client plays the worker (secret key).
  const admin = localSupabaseAdmin();
  const store = supabaseVersionStore(admin);
  let root: string;
  let storage: Storage;
  let owner: { id: string; email: string };
  let other: { id: string; email: string };
  let ownerClient: SupabaseClient;
  let otherClient: SupabaseClient;
  let reel: string;
  let otherReel: string;
  const saved: VersionRow[] = [];
  let restored: VersionRow;

  const target = (id: string) => ({ objects: storage, store, prefix: "test/", reelId: reel, id });

  async function readRows(ids: string[]) {
    const { data, error } = await admin.from("versions").select("*").in("id", ids).order("number");
    expect(error).toBeNull();
    return data;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "versions-db-"));
    storage = fakeStorage({ root, uploadUrlBase: "" });
    owner = await createTestUser(admin, "versions-owner");
    other = await createTestUser(admin, "versions-other");
    reel = await insertReel(admin, { ownerId: owner.id, name: "a.mov", status: "received" });
    otherReel = await insertReel(admin, { ownerId: other.id, name: "b.mov", status: "received" });
    ownerClient = (await signedInClient(admin, owner.email)).client;
    otherClient = (await signedInClient(admin, other.email)).client;
    for (const [index, text] of ["one", "two", "three"].entries()) {
      saved.push(
        await saveVersion({
          ...target(crypto.randomUUID()),
          edit: editWith(text),
          meta: meta(`v${index + 1}`),
        }),
      );
    }
  });

  afterAll(async () => {
    if (owner) await deleteTestUser(admin, owner.id);
    if (other) await deleteTestUser(admin, other.id);
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("restores v1 after v3 as v4, leaving v1 to v3 as they were", async () => {
    expect(saved.map((row) => row.number)).toEqual([1, 2, 3]);
    expect(saved.map((row) => row.parent_id)).toEqual([null, saved[0]!.id, saved[1]!.id]);
    const before = await readRows(saved.map((row) => row.id));

    restored = await restoreVersion({ ...target(crypto.randomUUID()), fromId: saved[0]!.id });
    expect(restored).toMatchObject({
      number: 4,
      parent_id: saved[2]!.id,
      restored_from_id: saved[0]!.id,
      change_summary: "restored version 1",
      model: null,
      request: null,
    });
    expect(await storage.get(restored.r2_key)).toEqual(await storage.get(saved[0]!.r2_key));
    const { data: reelRow } = await admin
      .from("reels")
      .select("current_version_id")
      .eq("id", reel)
      .single();
    expect(reelRow).toEqual({ current_version_id: restored.id });
    expect(await readRows(saved.map((row) => row.id))).toEqual(before);
  });

  it("refuses an existing version key and inserts no row", async () => {
    const { count: before } = await admin
      .from("versions")
      .select("id", { count: "exact", head: true })
      .eq("reel_id", reel);
    await expect(
      saveVersion({ ...target(saved[1]!.id), edit: editWith("again"), meta: meta("again") }),
    ).rejects.toThrow(/version object already exists/);
    const { count: after } = await admin
      .from("versions")
      .select("id", { count: "exact", head: true })
      .eq("reel_id", reel);
    expect(after).toBe(before);
  });

  it("refuses a stale parent in save_version", async () => {
    const id = crypto.randomUUID();
    await expect(
      store.insert({
        id,
        reel_id: reel,
        parent_id: saved[0]!.id,
        restored_from_id: null,
        request: null,
        model: null,
        prompt_version: null,
        change_summary: "stale",
        checks: { ok: true, reasons: [] },
        inputs: INPUTS,
        r2_key: `test/reels/${reel}/versions/${id}.json`,
      }),
    ).rejects.toThrow(/is not the current version/);
  });

  it("lets the owner read their four versions and nobody else any", async () => {
    const { data: own, error } = await ownerClient
      .from("versions")
      .select("number")
      .eq("reel_id", reel)
      .order("number");
    expect(error).toBeNull();
    expect(own).toEqual([{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4 }]);

    const { data: theirs } = await otherClient.from("versions").select("id").eq("reel_id", reel);
    expect(theirs).toEqual([]);
    const { data: otherReels } = await otherClient
      .from("reels")
      .select("id, current_version_id")
      .eq("id", otherReel);
    expect(otherReels).toEqual([{ id: otherReel, current_version_id: null }]);

    const { data: anon } = await localSupabaseClient().from("versions").select("id");
    expect(anon ?? []).toEqual([]);
  });

  it("never lets a signed-in user write a version or call save_version", async () => {
    const row = saved[0]!;
    const { error: insertError } = await ownerClient.from("versions").insert({
      reel_id: reel,
      owner_id: owner.id,
      number: 99,
      checks: {},
      inputs: {},
      r2_key: `test/reels/${reel}/versions/x.json`,
    });
    expect(insertError).not.toBeNull();

    await ownerClient.from("versions").update({ change_summary: "changed" }).eq("id", row.id);
    await ownerClient.from("versions").delete().eq("id", row.id);
    const after = await readRows([row.id]);
    expect(after?.[0]).toMatchObject({ id: row.id, change_summary: "v1" });

    const { error: rpcError } = await ownerClient.rpc("save_version", {
      p_id: crypto.randomUUID(),
      p_reel_id: reel,
      p_parent_id: restored.id,
      p_restored_from_id: null,
      p_request: null,
      p_model: null,
      p_prompt_version: null,
      p_change_summary: "mine",
      p_checks: {},
      p_inputs: {},
      p_r2_key: "test/x.json",
    });
    expect(rpcError).not.toBeNull();
  });

  it("refuses an update of a saved version, even with the secret key", async () => {
    const { error } = await admin
      .from("versions")
      .update({ change_summary: "rewritten" })
      .eq("id", saved[1]!.id);
    expect(error?.message).toMatch(/versions are immutable/);
  });
});

describe("reels.preview_copies_fingerprint", () => {
  const admin = localSupabaseAdmin();
  const FP = "f".repeat(64);
  let owner: { id: string; email: string };
  let other: { id: string; email: string };
  let ownerClient: SupabaseClient;
  let otherClient: SupabaseClient;
  let reel: string;

  beforeAll(async () => {
    owner = await createTestUser(admin, "previews-owner");
    other = await createTestUser(admin, "previews-other");
    reel = await insertReel(admin, { ownerId: owner.id, name: "a.mov", status: "processed" });
    ownerClient = (await signedInClient(admin, owner.email)).client;
    otherClient = (await signedInClient(admin, other.email)).client;
    // The admin client plays the worker (secret key).
    const { error } = await admin
      .from("reels")
      .update({ preview_copies_fingerprint: FP })
      .eq("id", reel);
    expect(error).toBeNull();
  });

  afterAll(async () => {
    if (owner) await deleteTestUser(admin, owner.id);
    if (other) await deleteTestUser(admin, other.id);
  });

  it("lets the owner read it and nobody else", async () => {
    const { data: own } = await ownerClient
      .from("reels")
      .select("preview_copies_fingerprint")
      .eq("id", reel);
    expect(own).toEqual([{ preview_copies_fingerprint: FP }]);
    const { data: theirs } = await otherClient
      .from("reels")
      .select("preview_copies_fingerprint")
      .eq("id", reel);
    expect(theirs).toEqual([]);
  });

  it("never lets a signed-in user write it", async () => {
    await ownerClient
      .from("reels")
      .update({ preview_copies_fingerprint: "0".repeat(64) })
      .eq("id", reel);
    const { data } = await admin
      .from("reels")
      .select("preview_copies_fingerprint")
      .eq("id", reel)
      .single();
    expect(data).toEqual({ preview_copies_fingerprint: FP });
  });

  it("refuses anything but a SHA-256 hex", async () => {
    const { error } = await admin
      .from("reels")
      .update({ preview_copies_fingerprint: "not-a-fingerprint" })
      .eq("id", reel);
    expect(error).not.toBeNull();
  });
});
