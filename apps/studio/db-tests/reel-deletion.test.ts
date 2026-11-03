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

// Deleting a reel (app_docs/storage.md, "Deleting a reel"): delete_reel is the
// owner's only, takes the reel's versions, jobs, steps, exports and stored-file
// rows with it, and queues every key it had in storage_deletions, which the
// worker drains through pending_storage_deletions, finish_storage_deletion and
// fail_storage_deletion. record_stored_file on a deleted reel queues its key.

const admin = localSupabaseAdmin();
// Every key of this file lives under its own prefix, so no other test's queue
// rows are ever returned here.
const PREFIX = `del${randomUUID().slice(0, 8)}/`;
const OTHER_PREFIX = `oth${randomUUID().slice(0, 8)}/`;

let userA: { id: string; email: string };
let userB: { id: string; email: string };
let clientA: SupabaseClient;
let clientB: SupabaseClient;
let db: pg.Client;

async function reelOf(
  ownerId: string,
  status: Parameters<typeof insertReel>[1]["status"] = "processed",
  extra: { sourceKey?: boolean; uploadId?: string } = {},
): Promise<{ id: string; sourceKey: string | null }> {
  const id = await insertReel(admin, { ownerId, name: "d.mov", status });
  const sourceKey = extra.sourceKey ? `${PREFIX}reels/${id}/source/original.mov` : null;
  if (sourceKey) {
    await db.query("update public.reels set source_key = $2, source_upload_id = $3 where id = $1", [
      id,
      sourceKey,
      extra.uploadId ?? null,
    ]);
  }
  return { id, sourceKey };
}

async function record(reelId: string, key: string, kind = "rebuildable", step = "convert") {
  const { data, error } = await admin.rpc("record_stored_file", {
    p_reel_id: reelId,
    p_r2_key: key,
    p_step: step,
    p_kind: kind,
    p_bytes: 10,
  });
  if (error) throw new Error(`not recorded: ${error.message}`);
  return data as boolean;
}

async function queued(reelId: string) {
  const { rows } = await db.query<{ r2_key: string; upload_id: string | null }>(
    `select r2_key, upload_id from public.storage_deletions where reel_id = $1 order by r2_key`,
    [reelId],
  );
  return rows;
}

async function queueRow(key: string, reelId: string | null = null) {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.storage_deletions (r2_key, reel_id) values ($1, $2) returning id`,
    [key, reelId],
  );
  return rows[0]!.id;
}

async function count(table: string, reelId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `select count(*) as n from public.${table} where reel_id = $1`,
    [reelId],
  );
  return Number(rows[0]!.n);
}

async function pending(prefix = PREFIX, limit = 100) {
  const { data, error } = await admin.rpc("pending_storage_deletions", {
    p_prefix: prefix,
    p_limit: limit,
  });
  if (error) throw new Error(`pending not read: ${error.message}`);
  return data as { id: string; r2_key: string; upload_id: string | null }[];
}

beforeAll(async () => {
  userA = await createTestUser(admin, "reel-del-a");
  userB = await createTestUser(admin, "reel-del-b");
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
  await db?.query(
    "delete from public.storage_deletions where starts_with(r2_key, $1) or starts_with(r2_key, $2)",
    [PREFIX, OTHER_PREFIX],
  );
  await db?.end();
  if (userA) await deleteTestUser(admin, userA.id);
  if (userB) await deleteTestUser(admin, userB.id);
});

describe("delete_reel", () => {
  it("deletes the owner's reel with its versions, jobs, steps, exports and stored files", async () => {
    const { id, sourceKey } = await reelOf(userA.id, "processed", { sourceKey: true });
    const versionId = randomUUID();
    await db.query(
      `insert into public.versions (id, reel_id, owner_id, number, inputs, r2_key)
       values ($1, $2, $3, 1, '{}'::jsonb, $4)`,
      [versionId, id, userA.id, `${PREFIX}reels/${id}/versions/${versionId}.json`],
    );
    const { rows: jobs } = await db.query<{ id: string }>(
      `insert into public.jobs (reel_id, owner_id, kind, status, lease_holder, lease_expires_at, started_at)
       values ($1, $2, 'process', 'running', 'w', now() + interval '5 minutes', now()) returning id`,
      [id, userA.id],
    );
    const running = jobs[0]!.id;
    await db.query(
      `insert into public.steps (job_id, reel_id, owner_id, name, status)
       values ($1, $2, $3, 'convert', 'running')`,
      [running, id, userA.id],
    );
    const { rows: renders } = await db.query<{ id: string }>(
      `insert into public.jobs (reel_id, owner_id, kind, status, version_id)
       values ($1, $2, 'render', 'done', $3) returning id`,
      [id, userA.id, versionId],
    );
    const exportId = randomUUID();
    await db.query(
      `insert into public.exports (id, reel_id, owner_id, job_id, version_id, r2_key, bytes)
       values ($1, $2, $3, $4, $5, $6, 10)`,
      [exportId, id, userA.id, renders[0]!.id, versionId, `${PREFIX}exports/${id}/${exportId}.mp4`],
    );
    const live = `${PREFIX}cache/convert/a/footage.mp4`;
    const gone = `${PREFIX}cache/convert/b/footage.mp4`;
    expect(await record(id, live)).toBe(true);
    expect(await record(id, gone)).toBe(true);
    await db.query(
      "update public.stored_files set deleted_at = now() where reel_id = $1 and r2_key = $2",
      [id, gone],
    );
    // Recorded as the studio's finish_upload would: the source has a row too.
    expect(await record(id, sourceKey!, "source", "upload")).toBe(true);

    const own = await clientA.rpc("delete_reel", { p_reel_id: id });
    expect(own.error).toBeNull();

    const { rows: reel } = await db.query("select 1 from public.reels where id = $1", [id]);
    expect(reel).toEqual([]);
    for (const table of ["versions", "jobs", "steps", "exports", "stored_files"]) {
      expect({ table, n: await count(table, id) }).toEqual({ table, n: 0 });
    }
    expect(await queued(id)).toEqual(
      [live, gone, sourceKey!].sort().map((r2_key) => ({ r2_key, upload_id: null })),
    );

    const again = await clientA.rpc("delete_reel", { p_reel_id: id });
    expect(again.error?.code).toBe("P0002");
  });

  it("queues an uploading reel's source key with its multipart upload id", async () => {
    const uploadId = `up-${randomUUID()}`;
    const { id, sourceKey } = await reelOf(userA.id, "uploading", { sourceKey: true, uploadId });
    const own = await clientA.rpc("delete_reel", { p_reel_id: id });
    expect(own.error).toBeNull();
    expect(await queued(id)).toEqual([{ r2_key: sourceKey, upload_id: uploadId }]);
  });

  it("refuses another user and anon, and changes nothing", async () => {
    const { id } = await reelOf(userA.id, "processed", { sourceKey: true });
    const other = await clientB.rpc("delete_reel", { p_reel_id: id });
    expect(other.error?.code).toBe("P0002");
    const anon = await localSupabaseClient().rpc("delete_reel", { p_reel_id: id });
    expect(anon.error).not.toBeNull();
    const missing = await clientA.rpc("delete_reel", { p_reel_id: randomUUID() });
    expect(missing.error?.code).toBe("P0002");
    const { rows } = await db.query("select 1 from public.reels where id = $1", [id]);
    expect(rows).toHaveLength(1);
    expect(await queued(id)).toEqual([]);
  });
});

describe("storage_deletions", () => {
  it("is neither readable nor writable by a signed-in user", async () => {
    const select = await clientA.from("storage_deletions").select("id");
    expect(select.error).not.toBeNull();
    const insert = await clientA.from("storage_deletions").insert({ r2_key: `${PREFIX}x` });
    expect(insert.error).not.toBeNull();
    const update = await clientA.from("storage_deletions").update({ attempts: 9 }).eq("id", "x");
    expect(update.error).not.toBeNull();
    const remove = await clientA.from("storage_deletions").delete().eq("r2_key", `${PREFIX}x`);
    expect(remove.error).not.toBeNull();
    for (const fn of ["pending_storage_deletions", "finish_storage_deletion"]) {
      const call = await clientA.rpc(fn, { p_prefix: PREFIX, p_limit: 1, p_id: randomUUID() });
      expect({ fn, refused: call.error !== null }).toEqual({ fn, refused: true });
    }
  });
});

describe("record_stored_file", () => {
  it("records once on a live reel and answers true", async () => {
    const { id } = await reelOf(userA.id);
    const key = `${PREFIX}cache/convert/once/footage.mp4`;
    expect(await record(id, key)).toBe(true);
    expect(await record(id, key)).toBe(true);
    expect(await count("stored_files", id)).toBe(1);
  });

  it("queues the key and answers false once the reel is deleted", async () => {
    const { id } = await reelOf(userA.id);
    expect((await clientA.rpc("delete_reel", { p_reel_id: id })).error).toBeNull();
    const key = `${PREFIX}cache/convert/late/footage.mp4`;
    expect(await record(id, key)).toBe(false);
    expect(await count("stored_files", id)).toBe(0);
    expect(await queued(id)).toEqual([{ r2_key: key, upload_id: null }]);
  });
});

describe("the deletion queue", () => {
  it("drops a key another live row holds, returns only due rows under the prefix, honours the limit", async () => {
    const shared = `${PREFIX}cache/convert/shared/footage.mp4`;
    const { id: keeper } = await reelOf(userB.id);
    expect(await record(keeper, shared)).toBe(true);
    const { id: deleted } = await reelOf(userA.id);
    expect(await record(deleted, shared)).toBe(true);
    expect((await clientA.rpc("delete_reel", { p_reel_id: deleted })).error).toBeNull();
    expect(await queued(deleted)).toEqual([{ r2_key: shared, upload_id: null }]);

    const first = await queueRow(`${PREFIX}q/1.bin`);
    const second = await queueRow(`${PREFIX}q/2.bin`);
    const outside = await queueRow(`${OTHER_PREFIX}q/3.bin`);
    const later = await queueRow(`${PREFIX}q/4.bin`);
    await db.query(
      "update public.storage_deletions set not_before = now() + interval '1 hour' where id = $1",
      [later],
    );

    const due = await pending();
    const ids = due.map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining([first, second]));
    expect(ids).not.toContain(outside);
    expect(ids).not.toContain(later);
    // The shared key stays in storage for the reel still holding it.
    expect(due.map((row) => row.r2_key)).not.toContain(shared);
    expect(await queued(deleted)).toEqual([]);
    expect(await pending(PREFIX, 1)).toHaveLength(1);
    const outOfRange = await admin.rpc("pending_storage_deletions", {
      p_prefix: PREFIX,
      p_limit: 0,
    });
    expect(outOfRange.error).not.toBeNull();
  });

  it("keeps a failed row for ten minutes and removes a finished one", async () => {
    const key = `${PREFIX}retry/x.bin`;
    const id = await queueRow(key);
    const failed = await admin.rpc("fail_storage_deletion", { p_id: id, p_error: "boom" });
    expect(failed.error).toBeNull();
    const { rows } = await db.query<{ attempts: number; last_error: string; wait: number }>(
      `select attempts, last_error,
              extract(epoch from (not_before - now()))::float as wait
       from public.storage_deletions where id = $1`,
      [id],
    );
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.last_error).toBe("boom");
    expect(rows[0]!.wait).toBeGreaterThan(9 * 60);
    expect(rows[0]!.wait).toBeLessThanOrEqual(10 * 60);
    expect((await pending()).map((row) => row.id)).not.toContain(id);

    const finished = await admin.rpc("finish_storage_deletion", { p_id: id });
    expect(finished.error).toBeNull();
    const { rows: left } = await db.query("select 1 from public.storage_deletions where id = $1", [
      id,
    ]);
    expect(left).toEqual([]);
  });
});
