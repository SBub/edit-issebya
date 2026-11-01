import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestUser,
  deleteTestUser,
  insertReel,
  signedInClient,
} from "../test-support/fixtures.ts";
import { localSupabaseAdmin, localSupabaseClient } from "../test-support/local-supabase.ts";

const WINDOW_MS = 5_000;
const COLUMNS = "reel_id, owner_id, step, r2_key, bytes, kind, deleted_at";

const admin = localSupabaseAdmin();
const workerId = `db-test-${crypto.randomUUID()}`;
let userA: { id: string; email: string };
let userB: { id: string; email: string };
let clientA: SupabaseClient;
let clientB: SupabaseClient;
let channel: RealtimeChannel | null = null;

beforeAll(async () => {
  userA = await createTestUser(admin, "stored-a");
  userB = await createTestUser(admin, "stored-b");
  clientA = (await signedInClient(admin, userA.email)).client;
  clientB = (await signedInClient(admin, userB.email)).client;
});

afterAll(async () => {
  if (channel) await clientA.removeChannel(channel);
  await admin.from("worker_status").delete().eq("worker_id", workerId);
  // Remove the queued jobs first, then the users (cascade).
  if (userA) await admin.from("jobs").delete().eq("owner_id", userA.id);
  if (userA) await deleteTestUser(admin, userA.id);
  if (userB) await deleteTestUser(admin, userB.id);
});

function record(reelId: string, key: string, bytes: number, client = admin) {
  return client.rpc("record_stored_file", {
    p_reel_id: reelId,
    p_owner_id: userA.id,
    p_step: "convert",
    p_r2_key: key,
    p_bytes: bytes,
    p_kind: "rebuildable",
  });
}

describe("finish_upload", () => {
  it("records the source in stored_files with the job", async () => {
    const id = crypto.randomUUID();
    const key = `dev/reels/${id}/source/original.mp4`;
    const insert = await clientA
      .from("reels")
      .insert({ id, source_name: "up.mp4", source_key: key });
    expect(insert.error).toBeNull();
    expect((await clientA.rpc("finish_upload", { p_reel_id: id, p_bytes: 4321 })).error).toBeNull();

    const { data } = await admin.from("stored_files").select(COLUMNS).eq("reel_id", id);
    expect(data).toEqual([
      {
        reel_id: id,
        owner_id: userA.id,
        step: "upload",
        r2_key: key,
        bytes: 4321,
        kind: "source",
        deleted_at: null,
      },
    ]);
    await admin.from("jobs").delete().eq("reel_id", id);
  });
});

describe("stored_files RLS", () => {
  let reelA: string;
  let rowId: string;

  beforeAll(async () => {
    reelA = await insertReel(admin, { ownerId: userA.id, name: "rls.mov", status: "received" });
    const { data, error } = await record(reelA, `dev/reels/${reelA}/cache/c.mp4`, 10);
    expect(error).toBeNull();
    rowId = data as string;
  });

  it("lets the owner read their rows and nobody else", async () => {
    expect((await clientA.from("stored_files").select("id").eq("reel_id", reelA)).data).toEqual([
      { id: rowId },
    ]);
    expect((await clientB.from("stored_files").select("id").eq("reel_id", reelA)).data).toEqual([]);
    const anon = await localSupabaseClient().from("stored_files").select("id");
    expect(anon.data ?? []).toEqual([]);
  });

  it("changes nothing on the owner's insert, update or delete", async () => {
    await clientA.from("stored_files").insert({
      reel_id: reelA,
      owner_id: userA.id,
      step: "x",
      r2_key: `dev/reels/${reelA}/cache/x.mp4`,
      bytes: 1,
      kind: "kept",
    });
    await clientA.from("stored_files").update({ bytes: 999 }).eq("id", rowId);
    await clientA.from("stored_files").delete().eq("id", rowId);
    const { data } = await admin.from("stored_files").select("id, bytes").eq("reel_id", reelA);
    expect(data).toEqual([{ id: rowId, bytes: 10 }]);
  });
});

describe("record_stored_file", () => {
  it("is refused for authenticated and anon", async () => {
    const reel = await insertReel(admin, { ownerId: userA.id, name: "r.mov", status: "received" });
    expect((await record(reel, `dev/reels/${reel}/cache/a.mp4`, 1, clientA)).error).not.toBeNull();
    expect(
      (await record(reel, `dev/reels/${reel}/cache/a.mp4`, 1, localSupabaseClient())).error,
    ).not.toBeNull();
    expect((await admin.from("stored_files").select("id").eq("reel_id", reel)).data).toEqual([]);
  });

  it("keeps one live row per reel and key, and a new one after deletion", async () => {
    const reel = await insertReel(admin, { ownerId: userA.id, name: "r.mov", status: "received" });
    const key = `dev/reels/${reel}/cache/converted.mp4`;
    const first = await record(reel, key, 100);
    const second = await record(reel, key, 200);
    expect(second.data).toBe(first.data);
    const live = () =>
      admin.from("stored_files").select("bytes").eq("reel_id", reel).is("deleted_at", null);
    expect((await live()).data).toEqual([{ bytes: 200 }]);

    await admin
      .from("stored_files")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", first.data as string);
    const third = await record(reel, key, 300);
    expect(third.error).toBeNull();
    expect(third.data).not.toBe(first.data);
    expect((await live()).data).toEqual([{ bytes: 300 }]);
    const { count } = await admin
      .from("stored_files")
      .select("id", { count: "exact", head: true })
      .eq("reel_id", reel);
    expect(count).toBe(2);
  });
});

describe("worker_status", () => {
  it("is read by signed-in users, written only by the worker", async () => {
    const write = await admin
      .from("worker_status")
      .upsert({ worker_id: workerId, free_disk_bytes: 1, waiting_reason: null });
    expect(write.error).toBeNull();

    const read = await clientA.from("worker_status").select("worker_id").eq("worker_id", workerId);
    expect(read.data).toEqual([{ worker_id: workerId }]);
    const anon = await localSupabaseClient().from("worker_status").select("worker_id");
    expect(anon.data ?? []).toEqual([]);

    expect(
      (await clientA.from("worker_status").insert({ worker_id: `${workerId}-x` })).error,
    ).not.toBeNull();
    await clientA
      .from("worker_status")
      .update({ waiting_reason: "hacked" })
      .eq("worker_id", workerId);
    const after = await admin
      .from("worker_status")
      .select("waiting_reason")
      .eq("worker_id", workerId)
      .single();
    expect(after.data).toEqual({ waiting_reason: null });
  });

  it("delivers a waiting reason to a signed-in user over Realtime", async () => {
    const { client, session } = await signedInClient(admin, userA.email);
    clientA = client;
    await client.realtime.setAuth(session.access_token);
    const seen: { waiting_reason: string | null }[] = [];
    let arrived!: () => void;
    const arrival = new Promise<void>((resolve) => (arrived = resolve));
    channel = client.channel(`worker-status-${crypto.randomUUID()}`);
    await new Promise<void>((resolve, reject) => {
      channel!
        .on("system", {}, (message: { extension?: string; status?: string }) => {
          if (message.extension !== "postgres_changes") return;
          if (message.status === "ok") resolve();
          else reject(new Error(`postgres_changes not attached: ${JSON.stringify(message)}`));
        })
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "worker_status",
            filter: `worker_id=eq.${workerId}`,
          },
          (payload) => {
            seen.push(payload.new as { waiting_reason: string | null });
            arrived();
          },
        )
        .subscribe((status, err) => {
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            reject(err ?? new Error(`channel ${status}`));
          }
        });
    });

    const reason = "waiting: 7.2 GB free on the worker's disk, needs 10 GB";
    const { error } = await admin
      .from("worker_status")
      .upsert({ worker_id: workerId, free_disk_bytes: 1, waiting_reason: reason });
    expect(error).toBeNull();
    await Promise.race([
      arrival,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("nothing received")), WINDOW_MS),
      ),
    ]);
    expect(seen[0]).toMatchObject({ worker_id: workerId, waiting_reason: reason });
  }, 30_000);
});
