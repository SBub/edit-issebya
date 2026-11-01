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
// Every key of this file lives under its own prefix, so no other test's rows
// are ever slimmed or expired here.
const PREFIX = `stored${randomUUID().slice(0, 8)}/`;
const OTHER_PREFIX = `other${randomUUID().slice(0, 8)}/`;

const STORED_FILE_COLUMNS = [
  ["bytes", "bigint"],
  ["created_at", "timestamp with time zone"],
  ["deleted_at", "timestamp with time zone"],
  ["id", "uuid"],
  ["kind", "text"],
  ["owner_id", "uuid"],
  ["r2_key", "text"],
  ["reel_id", "uuid"],
  ["step", "text"],
];

const WORKER_STATUS_COLUMNS = [
  ["free_disk_bytes", "bigint"],
  ["updated_at", "timestamp with time zone"],
  ["waiting_reason", "text"],
  ["worker_id", "text"],
];

const INPUTS = {
  footage: { step: "retime", fingerprint: "f", file: "source.mp4" },
  transcript: { step: "retime", fingerprint: "f", file: "transcript.json" },
  cutout: { step: "remove_background", fingerprint: "r", file: "subject.webm" },
  head_track: { step: "head_track", fingerprint: "h", file: "head-track.json" },
};

let userA: { id: string; email: string };
let userB: { id: string; email: string };
let clientA: SupabaseClient;
let clientB: SupabaseClient;
const reels: string[] = [];

async function columnsOf(table: string) {
  const db = new pg.Client({ connectionString: localDbUrl() });
  await db.connect();
  try {
    const { rows } = await db.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
       where table_schema = 'public' and table_name = $1
       order by column_name`,
      [table],
    );
    return rows.map((r) => [r.column_name, r.data_type]);
  } finally {
    await db.end();
  }
}

async function reelOf(ownerId: string): Promise<string> {
  const id = await insertReel(admin, { ownerId, name: "s.mov", status: "processed" });
  reels.push(id);
  return id;
}

async function record(reelId: string, key: string, kind: string, bytes = 100, step = "convert") {
  const { error } = await admin.rpc("record_stored_file", {
    p_reel_id: reelId,
    p_r2_key: key,
    p_step: step,
    p_kind: kind,
    p_bytes: bytes,
  });
  if (error) throw new Error(`not recorded: ${error.message}`);
}

async function rowsOf(reelId: string) {
  const { data, error } = await admin
    .from("stored_files")
    .select("r2_key, kind, step, bytes, owner_id, deleted_at")
    .eq("reel_id", reelId)
    .order("r2_key");
  if (error) throw new Error(error.message);
  return data as {
    r2_key: string;
    kind: string;
    step: string;
    bytes: number;
    owner_id: string;
    deleted_at: string | null;
  }[];
}

// An export of the reel made at `createdAt`, as the worker records one: a
// new current version, a finished render job and the `exports` row.
async function exportAt(reelId: string, ownerId: string, createdAt: Date) {
  const versionId = randomUUID();
  const reel = await admin
    .from("reels")
    .select("current_version_id")
    .eq("id", reelId)
    .single<{ current_version_id: string | null }>();
  const saved = await admin.rpc("save_version", {
    p_id: versionId,
    p_reel_id: reelId,
    p_parent_id: reel.data?.current_version_id ?? null,
    p_restored_from_id: null,
    p_request: null,
    p_model: null,
    p_prompt_version: null,
    p_change_summary: "test",
    p_checks: [],
    p_inputs: INPUTS,
    p_r2_key: `${PREFIX}reels/${reelId}/versions/${versionId}.json`,
  });
  if (saved.error) throw new Error(`version not saved: ${saved.error.message}`);
  const job = await admin
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
  if (job.error || !job.data) throw new Error(`render job not inserted: ${job.error?.message}`);
  const id = randomUUID();
  const key = `${PREFIX}exports/${reelId}/${id}.mp4`;
  const inserted = await admin.from("exports").insert({
    id,
    reel_id: reelId,
    owner_id: ownerId,
    job_id: job.data.id,
    version_id: versionId,
    r2_key: key,
    bytes: 1234,
    created_at: createdAt.toISOString(),
  });
  if (inserted.error) throw new Error(`export not inserted: ${inserted.error.message}`);
  return key;
}

async function slim(now: Date, prefix = PREFIX) {
  const { data, error } = await admin.rpc("slim_rebuildable_files", {
    p_now: now.toISOString(),
    p_prefix: prefix,
  });
  if (error) throw new Error(`not slimmed: ${error.message}`);
  return (data as { r2_key: string; bytes: number }[]).map((r) => r.r2_key).sort();
}

beforeAll(async () => {
  userA = await createTestUser(admin, "stored-a");
  userB = await createTestUser(admin, "stored-b");
  clientA = (await signedInClient(admin, userA.email)).client;
  clientB = (await signedInClient(admin, userB.email)).client;
});

afterAll(async () => {
  // Leave nothing claimable on the stack for the E2E specs.
  for (const reel of reels) await admin.from("jobs").delete().eq("reel_id", reel);
  if (userA) await admin.from("jobs").delete().eq("owner_id", userA.id);
  if (userA) await deleteTestUser(admin, userA.id);
  if (userB) await deleteTestUser(admin, userB.id);
  await admin.from("worker_status").delete().like("worker_id", "stored-files-test-%");
});

describe("columns", () => {
  it("of stored_files are exactly the record's", async () => {
    expect(await columnsOf("stored_files")).toEqual(STORED_FILE_COLUMNS);
  });

  it("of worker_status are exactly the status's", async () => {
    expect(await columnsOf("worker_status")).toEqual(WORKER_STATUS_COLUMNS);
  });
});

describe("stored_files", () => {
  let reelA: string;
  const keyA = `${PREFIX}cache/convert/aaa/converted.mp4`;

  beforeAll(async () => {
    reelA = await reelOf(userA.id);
    await record(reelA, keyA, "rebuildable", 500);
  });

  it("takes the owner from the reel, whatever is passed", async () => {
    const reel = await reelOf(userA.id);
    const { error } = await admin.from("stored_files").insert({
      reel_id: reel,
      owner_id: userB.id,
      step: "convert",
      r2_key: `${PREFIX}cache/convert/own/converted.mp4`,
      bytes: 1,
      kind: "rebuildable",
    });
    expect(error).toBeNull();
    expect((await rowsOf(reel)).map((r) => r.owner_id)).toEqual([userA.id]);
    expect((await rowsOf(reelA))[0]!.owner_id).toBe(userA.id);
  });

  it("is read by its owner only", async () => {
    const own = await clientA.from("stored_files").select("r2_key").eq("reel_id", reelA);
    expect(own.error).toBeNull();
    expect(own.data).toEqual([{ r2_key: keyA }]);
    const other = await clientB.from("stored_files").select("r2_key");
    expect(other.error).toBeNull();
    expect(other.data).toEqual([]);
    const anon = await localSupabaseClient().from("stored_files").select("r2_key");
    expect(anon.data ?? []).toEqual([]);
  });

  it("cannot be written by an owner", async () => {
    const insert = await clientA.from("stored_files").insert({
      reel_id: reelA,
      owner_id: userA.id,
      step: "convert",
      r2_key: `${PREFIX}cache/convert/x/converted.mp4`,
      bytes: 1,
      kind: "kept",
    });
    expect(insert.error).not.toBeNull();
    await clientA
      .from("stored_files")
      .update({ deleted_at: new Date().toISOString() })
      .eq("reel_id", reelA);
    await clientA.from("stored_files").delete().eq("reel_id", reelA);
    expect(await rowsOf(reelA)).toEqual([expect.objectContaining({ r2_key: keyA, bytes: 500 })]);
    expect((await rowsOf(reelA))[0]!.deleted_at).toBeNull();
  });

  it("refuses every update but recording the deletion, even for the service role", async () => {
    const reel = await reelOf(userA.id);
    const key = `${PREFIX}cache/convert/upd/converted.mp4`;
    await record(reel, key, "rebuildable", 7);
    const bytes = await admin.from("stored_files").update({ bytes: 8 }).eq("reel_id", reel);
    expect(bytes.error?.message).toMatch(/stored_files rows only record a deletion/);
    const both = await admin
      .from("stored_files")
      .update({ bytes: 8, deleted_at: new Date(Date.now() + 1000).toISOString() })
      .eq("reel_id", reel);
    expect(both.error?.message).toMatch(/stored_files rows only record a deletion/);
    const deletedAt = new Date(Date.now() + 1000).toISOString();
    const mark = await admin
      .from("stored_files")
      .update({ deleted_at: deletedAt })
      .eq("reel_id", reel);
    expect(mark.error).toBeNull();
    const undelete = await admin
      .from("stored_files")
      .update({ deleted_at: null })
      .eq("reel_id", reel);
    expect(undelete.error?.message).toMatch(/stored_files rows only record a deletion/);
    const again = await admin
      .from("stored_files")
      .update({ deleted_at: new Date(Date.now() + 5000).toISOString() })
      .eq("reel_id", reel);
    expect(again.error?.message).toMatch(/stored_files rows only record a deletion/);
    expect(Date.parse((await rowsOf(reel))[0]!.deleted_at!)).toBe(Date.parse(deletedAt));
  });

  it("goes with its reel", async () => {
    const reel = await reelOf(userA.id);
    await record(reel, `${PREFIX}cache/convert/gone/converted.mp4`, "rebuildable");
    await admin.from("reels").delete().eq("id", reel);
    expect(await rowsOf(reel)).toEqual([]);
  });
});

describe("record_stored_file", () => {
  it("records once per reel and key, and again after the row is marked deleted", async () => {
    const reel = await reelOf(userA.id);
    const key = `${PREFIX}cache/transcribe/t/transcript.json`;
    await record(reel, key, "kept", 10, "transcribe");
    await record(reel, key, "kept", 10, "transcribe");
    expect(await rowsOf(reel)).toEqual([
      {
        r2_key: key,
        kind: "kept",
        step: "transcribe",
        bytes: 10,
        owner_id: userA.id,
        deleted_at: null,
      },
    ]);
    await admin
      .from("stored_files")
      .update({ deleted_at: new Date(Date.now() + 1000).toISOString() })
      .eq("reel_id", reel);
    await record(reel, key, "kept", 10, "transcribe");
    const rows = await rowsOf(reel);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.deleted_at === null)).toHaveLength(1);
  });

  it("gives another reel its own row for the same key", async () => {
    const one = await reelOf(userA.id);
    const two = await reelOf(userB.id);
    const key = `${PREFIX}cache/head_track/h/head-track.json`;
    await record(one, key, "kept", 3, "head_track");
    await record(two, key, "kept", 3, "head_track");
    expect((await rowsOf(one)).map((r) => r.owner_id)).toEqual([userA.id]);
    expect((await rowsOf(two)).map((r) => r.owner_id)).toEqual([userB.id]);
  });

  it("refuses an unknown kind and is not executable by a signed-in user", async () => {
    const reel = await reelOf(userA.id);
    await expect(record(reel, `${PREFIX}x/y.bin`, "other")).rejects.toThrow();
    const asOwner = await clientA.rpc("record_stored_file", {
      p_reel_id: reel,
      p_r2_key: `${PREFIX}x/y.bin`,
      p_step: "convert",
      p_kind: "kept",
      p_bytes: 1,
    });
    expect(asOwner.error).not.toBeNull();
    expect(await rowsOf(reel)).toEqual([]);
  });
});

describe("slim_rebuildable_files", () => {
  const now = new Date(Date.now() + 60_000);
  const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const key = (name: string) => `${PREFIX}cache/convert/${name}/converted.mp4`;
  let reelA: string;
  let reelB: string;
  let reelC: string;
  let reelD: string;
  let reelE: string;
  const outside = `${OTHER_PREFIX}cache/convert/out/converted.mp4`;

  beforeAll(async () => {
    reelA = await reelOf(userA.id);
    reelB = await reelOf(userA.id);
    reelC = await reelOf(userA.id);
    reelD = await reelOf(userA.id);
    reelE = await reelOf(userB.id);
    await exportAt(reelA, userA.id, daysAgo(8));
    await exportAt(reelB, userA.id, daysAgo(6));
    await exportAt(reelD, userA.id, daysAgo(8));
    await exportAt(reelE, userB.id, daysAgo(1));

    await record(reelA, key("a"), "rebuildable", 1000);
    await record(reelA, `${PREFIX}reels/${reelA}/source/original.mp4`, "source", 9, "upload");
    await record(reelA, `${PREFIX}cache/transcribe/a/transcript.json`, "kept", 5, "transcribe");
    await record(reelA, `${PREFIX}reels/${reelA}/versions/v.json`, "version", 4, "version");
    await record(reelA, outside, "rebuildable", 50);
    await record(reelB, key("b"), "rebuildable", 1000);
    await record(reelC, key("c"), "rebuildable", 1000);
    await record(reelD, key("d"), "rebuildable", 2000);
    await record(reelD, key("shared"), "rebuildable", 3000);
    await record(reelE, key("shared"), "rebuildable", 3000);
  });

  it("marks and returns only the rebuildable keys no reel needs any more", async () => {
    const { data, error } = await admin.rpc("slim_rebuildable_files", {
      p_now: now.toISOString(),
      p_prefix: PREFIX,
    });
    expect(error).toBeNull();
    expect(data).toEqual([
      { r2_key: key("a"), bytes: 1000 },
      { r2_key: key("d"), bytes: 2000 },
    ]);

    const live = (rows: Awaited<ReturnType<typeof rowsOf>>) =>
      rows.filter((r) => r.deleted_at === null).map((r) => r.r2_key);
    // Reel A: the rebuildable key is gone, the source, kept and version rows stay.
    const rowsA = await rowsOf(reelA);
    expect(rowsA.find((r) => r.r2_key === key("a"))!.deleted_at).not.toBeNull();
    expect(Date.parse(rowsA.find((r) => r.r2_key === key("a"))!.deleted_at!)).toBe(now.getTime());
    expect(live(rowsA).sort()).toEqual(
      [
        `${PREFIX}reels/${reelA}/source/original.mp4`,
        `${PREFIX}cache/transcribe/a/transcript.json`,
        `${PREFIX}reels/${reelA}/versions/v.json`,
        outside,
      ].sort(),
    );
    // Exported 6 days ago, never exported: kept.
    expect(live(await rowsOf(reelB))).toEqual([key("b")]);
    expect(live(await rowsOf(reelC))).toEqual([key("c")]);
    // D's own key went; the key E (exported yesterday) shares stays for both.
    expect(live(await rowsOf(reelD))).toEqual([key("shared")]);
    expect(live(await rowsOf(reelE))).toEqual([key("shared")]);
  });

  it("returns nothing when called again", async () => {
    expect(await slim(now)).toEqual([]);
  });

  it("never touches a key outside the prefix it is given", async () => {
    expect(await slim(now, `${PREFIX}cache/transcribe/`)).toEqual([]);
    expect((await rowsOf(reelA)).find((r) => r.r2_key === outside)!.deleted_at).toBeNull();
  });

  it("is not executable by a signed-in user", async () => {
    const { error } = await clientA.rpc("slim_rebuildable_files", {
      p_now: now.toISOString(),
      p_prefix: PREFIX,
    });
    expect(error).not.toBeNull();
  });
});

describe("expire_export_files", () => {
  it("marks and returns the files of expired exports only", async () => {
    const now = new Date(Date.now() + 60_000);
    const reel = await reelOf(userA.id);
    const old = await exportAt(reel, userA.id, new Date(now.getTime() - 25 * 3600 * 1000));
    const fresh = await exportAt(reel, userA.id, new Date(now.getTime() - 3600 * 1000));
    await record(reel, old, "export", 1234, "render");
    await record(reel, fresh, "export", 1234, "render");

    const { data, error } = await admin.rpc("expire_export_files", {
      p_now: now.toISOString(),
      p_prefix: PREFIX,
    });
    expect(error).toBeNull();
    expect(data).toEqual([{ r2_key: old, bytes: 1234 }]);
    const rows = await rowsOf(reel);
    expect(rows.find((r) => r.r2_key === old)!.deleted_at).not.toBeNull();
    expect(rows.find((r) => r.r2_key === fresh)!.deleted_at).toBeNull();

    const again = await admin.rpc("expire_export_files", {
      p_now: now.toISOString(),
      p_prefix: PREFIX,
    });
    expect(again.data).toEqual([]);
    const asOwner = await clientA.rpc("expire_export_files", {
      p_now: now.toISOString(),
      p_prefix: PREFIX,
    });
    expect(asOwner.error).not.toBeNull();
  });
});

describe("finish_upload", () => {
  it("records the source once, with the reel's key and the reported size", async () => {
    const id = randomUUID();
    const sourceKey = `${PREFIX}reels/${id}/source/original.mp4`;
    const inserted = await clientA
      .from("reels")
      .insert({ id, source_name: "up.mp4", source_key: sourceKey });
    expect(inserted.error).toBeNull();
    reels.push(id);
    expect((await clientA.rpc("finish_upload", { p_reel_id: id, p_bytes: 4321 })).error).toBeNull();
    expect((await clientA.rpc("finish_upload", { p_reel_id: id, p_bytes: 9999 })).error).toBeNull();
    expect(await rowsOf(id)).toEqual([
      {
        r2_key: sourceKey,
        kind: "source",
        step: "upload",
        bytes: 4321,
        owner_id: userA.id,
        deleted_at: null,
      },
    ]);
  });
});

describe("worker_status", () => {
  const workerId = `stored-files-test-${randomUUID()}`;

  beforeAll(async () => {
    const { error } = await admin.from("worker_status").upsert({
      worker_id: workerId,
      free_disk_bytes: 7,
      waiting_reason: "waiting: test",
    });
    if (error) throw new Error(error.message);
  });

  it("is read by every signed-in user, never by anon", async () => {
    for (const client of [clientA, clientB]) {
      const { data, error } = await client
        .from("worker_status")
        .select("worker_id, waiting_reason")
        .eq("worker_id", workerId);
      expect(error).toBeNull();
      expect(data).toEqual([{ worker_id: workerId, waiting_reason: "waiting: test" }]);
    }
    const anon = await localSupabaseClient().from("worker_status").select("worker_id");
    expect(anon.data ?? []).toEqual([]);
  });

  it("cannot be written by a signed-in user", async () => {
    const insert = await clientA
      .from("worker_status")
      .insert({ worker_id: `${workerId}-x`, free_disk_bytes: 1 });
    expect(insert.error).not.toBeNull();
    await clientA.from("worker_status").update({ waiting_reason: null }).eq("worker_id", workerId);
    await clientA.from("worker_status").delete().eq("worker_id", workerId);
    const { data } = await admin
      .from("worker_status")
      .select("worker_id, waiting_reason")
      .like("worker_id", `${workerId}%`);
    expect(data).toEqual([{ worker_id: workerId, waiting_reason: "waiting: test" }]);
  });

  it("is in the Realtime publication", async () => {
    const db = new pg.Client({ connectionString: localDbUrl() });
    await db.connect();
    try {
      const { rows } = await db.query<{ tablename: string }>(
        `select tablename from pg_publication_tables
         where pubname = 'supabase_realtime' and schemaname = 'public'`,
      );
      expect(rows.map((r) => r.tablename)).toContain("worker_status");
      expect(rows.map((r) => r.tablename)).not.toContain("stored_files");
    } finally {
      await db.end();
    }
  });
});
