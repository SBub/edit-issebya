import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestUser, deleteTestUser, signedInClient } from "../test-support/fixtures.ts";
import {
  localDbUrl,
  localSupabaseAdmin,
  localSupabaseClient,
} from "../test-support/local-supabase.ts";
import { claimableJobIds } from "../test-support/worker.ts";

// The photo library's table and functions (app_docs/photo-library.md):
// owner-only RLS, the column-limited insert of an uploading photo, the status
// and ready checks, finish_photo_upload, delete_photo, record_photo_file and
// the jobs, steps and stored-file rows that name a photo.

const admin = localSupabaseAdmin();
const PREFIX = `photos${randomUUID().slice(0, 8)}/`;
const MAX_BYTES = 25 * 1024 * 1024;

let userA: { id: string; email: string };
let userB: { id: string; email: string };
let clientA: SupabaseClient;
let clientB: SupabaseClient;
let db: pg.Client;

const keyFor = (id: string, ext = "jpg") => `${PREFIX}library/${id}/original.${ext}`;

// An uploading photo inserted by its owner, the way the studio does.
async function ownPhoto(client: SupabaseClient = clientA): Promise<string> {
  const id = randomUUID();
  const { error } = await client.from("photos").insert({
    id,
    file_name: "beach.jpg",
    r2_key: keyFor(id),
    content_type: "image/jpeg",
    upload_id: `upload-${id}`,
  });
  if (error) throw new Error(`photo not inserted: ${error.message}`);
  return id;
}

async function photoRow(id: string) {
  const { rows } = await db.query<{ status: string; bytes: string | null }>(
    "select status, bytes from public.photos where id = $1",
    [id],
  );
  return rows[0] ?? null;
}

async function jobsOf(photoId: string) {
  const { rows } = await db.query<{ id: string; kind: string; owner_id: string }>(
    "select id, kind, owner_id from public.jobs where photo_id = $1 order by created_at",
    [photoId],
  );
  return rows;
}

async function filesOf(photoId: string) {
  const { rows } = await db.query<{
    r2_key: string;
    kind: string;
    step: string;
    bytes: string;
    owner_id: string;
    reel_id: string | null;
  }>(
    `select r2_key, kind, step, bytes, owner_id, reel_id from public.stored_files
     where photo_id = $1 order by created_at, r2_key`,
    [photoId],
  );
  return rows;
}

beforeAll(async () => {
  const leftover = await claimableJobIds(admin);
  if (leftover.length > 0) {
    throw new Error(
      `claimable jobs already on the local stack (a crashed run or a connected dev worker): ${leftover.join(", ")}`,
    );
  }
  userA = await createTestUser(admin, "photos-a");
  userB = await createTestUser(admin, "photos-b");
  clientA = (await signedInClient(admin, userA.email)).client;
  clientB = (await signedInClient(admin, userB.email)).client;
  db = new pg.Client({ connectionString: localDbUrl() });
  await db.connect();
});

afterAll(async () => {
  // Leave nothing claimable on the stack for the E2E specs.
  for (const user of [userA, userB]) {
    if (!user) continue;
    await db?.query(
      `update public.jobs set status = 'done', lease_expires_at = null,
         waiting_reason = null, not_before = null
       where owner_id = $1 and status in ('queued', 'running', 'waiting_ai')`,
      [user.id],
    );
  }
  await db?.end();
  if (userA) await deleteTestUser(admin, userA.id);
  if (userB) await deleteTestUser(admin, userB.id);
});

describe("photos", () => {
  it("are read by their owner only", async () => {
    const id = await ownPhoto();
    const own = await clientA.from("photos").select("id, status, owner_id").eq("id", id);
    expect(own.error).toBeNull();
    expect(own.data).toEqual([{ id, status: "uploading", owner_id: userA.id }]);
    const other = await clientB.from("photos").select("id").eq("id", id);
    expect(other.error).toBeNull();
    expect(other.data).toEqual([]);
    const anon = await localSupabaseClient().from("photos").select("id");
    expect(anon.data ?? []).toEqual([]);
  });

  it("accept only the owner's own uploading row under its own key", async () => {
    const id = randomUUID();
    const otherKey = await clientA.from("photos").insert({
      id,
      file_name: "x.jpg",
      r2_key: keyFor(randomUUID()),
      content_type: "image/jpeg",
    });
    expect(otherKey.error).not.toBeNull();

    const notOriginal = await clientA.from("photos").insert({
      id,
      file_name: "x.jpg",
      r2_key: `${PREFIX}library/${id}/large.jpg`,
      content_type: "image/jpeg",
    });
    expect(notOriginal.error).not.toBeNull();

    for (const extra of [
      { status: "ready" },
      { status: "uploading" },
      { owner_id: userB.id },
      { bytes: 10 },
      { description: "a beach" },
    ]) {
      const { error } = await clientA.from("photos").insert({
        id,
        file_name: "x.jpg",
        r2_key: keyFor(id),
        content_type: "image/jpeg",
        ...extra,
      });
      expect({ extra, refused: error !== null }).toEqual({ extra, refused: true });
    }

    const badType = await clientA.from("photos").insert({
      id,
      file_name: "x.gif",
      r2_key: keyFor(id),
      content_type: "image/gif",
    });
    expect(badType.error).not.toBeNull();

    const anon = await localSupabaseClient()
      .from("photos")
      .insert({
        id,
        file_name: "x.jpg",
        r2_key: keyFor(id),
        content_type: "image/jpeg",
      });
    expect(anon.error).not.toBeNull();
    expect(await photoRow(id)).toBeNull();
  });

  it("cannot be updated or deleted directly by their owner", async () => {
    const id = await ownPhoto();
    await clientA.from("photos").update({ status: "ready", description: "x" }).eq("id", id);
    await clientA.from("photos").delete().eq("id", id);
    expect(await photoRow(id)).toEqual({ status: "uploading", bytes: null });
  });

  it("refuse an unknown status and an incomplete ready row", async () => {
    const id = await ownPhoto();
    const ready = (tags: string[], description: string | null = "A beach at dawn.") =>
      db.query(
        `update public.photos
         set status = 'ready', description = $2, tags = $3, width = 10, height = 10,
             thumbnail_key = 't', large_key = 'l'
         where id = $1`,
        [id, description, tags],
      );
    await expect(
      db.query("update public.photos set status = 'gone' where id = $1", [id]),
    ).rejects.toThrow(/photos_status_check/);
    await expect(ready(["beach", "sea", "dawn"], null)).rejects.toThrow(/photos_ready_check/);
    await expect(ready(["beach", "sea"])).rejects.toThrow(/photos_ready_check/);
    await expect(ready(["a", "b", "c", "d", "e", "f", "g", "h", "i"])).rejects.toThrow(/check/);
    await expect(ready(["beach", "Sea", "dawn"])).rejects.toThrow(/check/);
    await expect(ready(["beach", "sea", "dawn"], "x".repeat(201))).rejects.toThrow(/check/);
    await ready(["beach", "sea", "dawn"]);
    expect((await photoRow(id))?.status).toBe("ready");
  });

  it("are in the Realtime publication", async () => {
    const { rows } = await db.query(
      `select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'photos'`,
    );
    expect(rows).toHaveLength(1);
  });
});

describe("finish_photo_upload", () => {
  it("queues one describe job and records the original once, idempotently", async () => {
    const id = await ownPhoto();
    const first = await clientA.rpc("finish_photo_upload", { p_photo_id: id, p_bytes: 1234 });
    expect(first.error).toBeNull();
    expect(await photoRow(id)).toEqual({ status: "describing", bytes: "1234" });
    const jobs = await jobsOf(id);
    expect(jobs).toEqual([{ id: first.data, kind: "describe_photo", owner_id: userA.id }]);
    expect(await filesOf(id)).toEqual([
      {
        r2_key: keyFor(id),
        kind: "kept",
        step: "upload",
        bytes: "1234",
        owner_id: userA.id,
        reel_id: null,
      },
    ]);

    const again = await clientA.rpc("finish_photo_upload", { p_photo_id: id, p_bytes: 1234 });
    expect(again.error).toBeNull();
    expect(again.data).toBe(first.data);
    expect(await jobsOf(id)).toHaveLength(1);
    expect(await filesOf(id)).toHaveLength(1);
  });

  it("is refused for another user, anon, and a size outside 1 to 25 MiB", async () => {
    const id = await ownPhoto();
    const other = await clientB.rpc("finish_photo_upload", { p_photo_id: id, p_bytes: 10 });
    expect(other.error).not.toBeNull();
    const anon = await localSupabaseClient().rpc("finish_photo_upload", {
      p_photo_id: id,
      p_bytes: 10,
    });
    expect(anon.error).not.toBeNull();
    for (const bytes of [0, MAX_BYTES + 1]) {
      const { error } = await clientA.rpc("finish_photo_upload", {
        p_photo_id: id,
        p_bytes: bytes,
      });
      expect({ bytes, refused: error !== null }).toEqual({ bytes, refused: true });
    }
    const missing = await clientA.rpc("finish_photo_upload", {
      p_photo_id: randomUUID(),
      p_bytes: 10,
    });
    expect(missing.error).not.toBeNull();
    expect(await photoRow(id)).toEqual({ status: "uploading", bytes: null });
    expect(await jobsOf(id)).toEqual([]);
  });
});

describe("delete_photo", () => {
  it("deletes the owner's photo with its jobs, steps and stored-file rows", async () => {
    const id = await ownPhoto();
    const finished = await clientA.rpc("finish_photo_upload", { p_photo_id: id, p_bytes: 50 });
    expect(finished.error).toBeNull();
    await db.query(
      `insert into public.steps (job_id, photo_id, owner_id, name, status)
       values ($1, $2, $3, 'photo_images', 'done')`,
      [finished.data, id, userA.id],
    );

    const other = await clientB.rpc("delete_photo", { p_photo_id: id });
    expect(other.error).not.toBeNull();
    const anon = await localSupabaseClient().rpc("delete_photo", { p_photo_id: id });
    expect(anon.error).not.toBeNull();
    expect(await photoRow(id)).not.toBeNull();

    const own = await clientA.rpc("delete_photo", { p_photo_id: id });
    expect(own.error).toBeNull();
    expect(await photoRow(id)).toBeNull();
    expect(await jobsOf(id)).toEqual([]);
    expect(await filesOf(id)).toEqual([]);
    const { rows } = await db.query("select 1 from public.steps where photo_id = $1", [id]);
    expect(rows).toEqual([]);

    const again = await clientA.rpc("delete_photo", { p_photo_id: id });
    expect(again.error).not.toBeNull();
  });
});

describe("record_photo_file", () => {
  it("records once per photo and key, takes the owner from the photo, and is service-only", async () => {
    const id = await ownPhoto();
    const key = `${PREFIX}library/${id}/thumbnail.jpg`;
    const args = {
      p_photo_id: id,
      p_r2_key: key,
      p_step: "photo_images",
      p_kind: "rebuildable",
      p_bytes: 77,
    };
    expect((await admin.rpc("record_photo_file", args)).error).toBeNull();
    expect((await admin.rpc("record_photo_file", args)).error).toBeNull();
    expect(await filesOf(id)).toEqual([
      {
        r2_key: key,
        kind: "rebuildable",
        step: "photo_images",
        bytes: "77",
        owner_id: userA.id,
        reel_id: null,
      },
    ]);
    const signedIn = await clientA.rpc("record_photo_file", { ...args, p_r2_key: `${key}.x` });
    expect(signedIn.error).not.toBeNull();
    expect(await filesOf(id)).toHaveLength(1);
  });

  it("lets a photo row record its deletion, and nothing else", async () => {
    const id = await ownPhoto();
    const key = `${PREFIX}library/${id}/large.jpg`;
    await admin.rpc("record_photo_file", {
      p_photo_id: id,
      p_r2_key: key,
      p_step: "photo_images",
      p_kind: "rebuildable",
      p_bytes: 5,
    });
    const bytes = await admin.from("stored_files").update({ bytes: 6 }).eq("photo_id", id);
    expect(bytes.error?.message).toMatch(/stored_files rows only record a deletion/);
    const mark = await admin
      .from("stored_files")
      .update({ deleted_at: new Date(Date.now() + 1000).toISOString() })
      .eq("photo_id", id);
    expect(mark.error).toBeNull();
  });
});

describe("jobs_target_check", () => {
  it("refuses a describe_photo job naming a reel or no photo, and a reel kind naming a photo", async () => {
    const id = await ownPhoto();
    const { rows } = await db.query<{ id: string }>(
      "insert into public.reels (owner_id, status) values ($1, 'received') returning id",
      [userA.id],
    );
    const reelId = rows[0]!.id;
    const insert = (reel: string | null, photo: string | null, kind: string) =>
      db.query(
        "insert into public.jobs (reel_id, photo_id, owner_id, kind, status) values ($1, $2, $3, $4, 'done')",
        [reel, photo, userA.id, kind],
      );
    await expect(insert(reelId, id, "describe_photo")).rejects.toThrow(/jobs_target_check/);
    await expect(insert(reelId, null, "describe_photo")).rejects.toThrow(/jobs_target_check/);
    await expect(insert(null, null, "describe_photo")).rejects.toThrow(/jobs_target_check/);
    await expect(insert(null, id, "process")).rejects.toThrow(/jobs_target_check/);
    await insert(null, id, "describe_photo");
  });

  it("never lets an owner insert a describe_photo job", async () => {
    const id = await ownPhoto();
    const { error } = await clientA.from("jobs").insert({ photo_id: id, kind: "describe_photo" });
    expect(error).not.toBeNull();
    expect(await jobsOf(id)).toEqual([]);
  });
});
