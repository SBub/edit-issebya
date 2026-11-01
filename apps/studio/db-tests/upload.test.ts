import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Storage, fakeMultipart, fakeStorage } from "@edit-issebya/storage";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abortUploadFor,
  createUploadFor,
  finishUploadFor,
  signUploadRequestFor,
} from "../src/lib/upload-service.ts";
import { createTestUser, deleteTestUser, signedInClient } from "../test-support/fixtures.ts";
import { localSupabaseAdmin } from "../test-support/local-supabase.ts";

// The upload service with the signed-in users' real clients (RLS) and the
// folder fake: who may sign, finish and abort, and that finishing is idempotent.

const admin = localSupabaseAdmin();
let root: string;
let storage: Storage;
let multipart: ReturnType<typeof fakeMultipart>;
let userA: { id: string; email: string };
let userB: { id: string; email: string };
let clientA: SupabaseClient;
let clientB: SupabaseClient;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "upload-db-"));
  storage = fakeStorage({ root, uploadUrlBase: "/up/" });
  multipart = fakeMultipart({ root });
  userA = await createTestUser(admin, "upload-a");
  userB = await createTestUser(admin, "upload-b");
  clientA = (await signedInClient(admin, userA.email)).client;
  clientB = (await signedInClient(admin, userB.email)).client;
});

afterAll(async () => {
  for (const user of [userA, userB]) {
    if (!user) continue;
    await admin.from("jobs").delete().eq("owner_id", user.id);
    await deleteTestUser(admin, user.id);
  }
  if (root) await rm(root, { recursive: true, force: true });
});

async function newUpload(client: SupabaseClient = clientA) {
  const created = await createUploadFor(client, "dev/", {
    name: "clip.mp4",
    bytes: 1000,
    type: "video/mp4",
  });
  if (created.status !== "ready") throw new Error(`upload not created: ${created.status}`);
  const uploadId = await multipart.create(created.key);
  return { reelId: created.reelId, key: created.key, uploadId };
}

async function state(reelId: string) {
  const reel = await admin.from("reels").select("status, source_bytes").eq("id", reelId).single();
  const jobs = await admin.from("jobs").select("id, kind").eq("reel_id", reelId);
  return { reel: reel.data, jobs: jobs.data };
}

async function uploadWholeObject(key: string, uploadId: string): Promise<number> {
  const chunks = [new Uint8Array(700).fill(1), new Uint8Array(300).fill(2)];
  const parts = [];
  for (const [index, chunk] of chunks.entries()) {
    parts.push({
      partNumber: index + 1,
      etag: await multipart.putPart(key, uploadId, index + 1, chunk),
    });
  }
  await multipart.complete(key, uploadId, parts);
  return 1000;
}

describe("signing", () => {
  it("signs only for the caller's own uploading reel", async () => {
    const { reelId, key, uploadId } = await newUpload();
    const requests = [
      { method: "POST", key },
      { method: "PUT", key, uploadId, partNumber: 1 },
      { method: "GET", key, uploadId },
      { method: "POST", key, uploadId },
    ];
    for (const request of requests) {
      expect(await signUploadRequestFor(clientA, storage, request)).toMatchObject({
        status: "signed",
      });
      expect(await signUploadRequestFor(clientB, storage, request)).toEqual({
        status: "refused",
      });
    }
    expect(
      await signUploadRequestFor(clientA, storage, { method: "DELETE", key, uploadId }),
    ).toEqual({ status: "refused" });
    expect(await signUploadRequestFor(clientA, storage, { method: "PUT", key })).toEqual({
      status: "refused",
    });

    expect(await finishUploadFor(clientB, storage, reelId)).toEqual({ status: "refused" });
    expect(await abortUploadFor(clientB, storage, { reelId, uploadId })).toEqual({
      status: "refused",
    });
    expect(await multipart.listParts(key, uploadId)).toEqual([]);
    expect(await state(reelId)).toEqual({
      reel: { status: "uploading", source_bytes: null },
      jobs: [],
    });
  });

  it("refuses once the reel is past uploading", async () => {
    const { reelId, key, uploadId } = await newUpload();
    await uploadWholeObject(key, uploadId);
    expect((await finishUploadFor(clientA, storage, reelId)).status).toBe("finished");
    expect(
      await signUploadRequestFor(clientA, storage, { method: "PUT", key, uploadId, partNumber: 1 }),
    ).toEqual({ status: "refused" });
  });
});

describe("finishing", () => {
  it("answers incomplete before storage holds the object", async () => {
    const { reelId } = await newUpload();
    expect(await finishUploadFor(clientA, storage, reelId)).toEqual({ status: "incomplete" });
    expect((await state(reelId)).reel).toEqual({ status: "uploading", source_bytes: null });
  });

  it("queues exactly one job however often it is called, in sequence or at once", async () => {
    const sequential = await newUpload();
    const bytes = await uploadWholeObject(sequential.key, sequential.uploadId);
    const first = await finishUploadFor(clientA, storage, sequential.reelId);
    const second = await finishUploadFor(clientA, storage, sequential.reelId);
    expect(first).toMatchObject({ status: "finished", reelId: sequential.reelId });
    expect(second).toEqual(first);

    const concurrent = await newUpload();
    await uploadWholeObject(concurrent.key, concurrent.uploadId);
    const answers = await Promise.all([
      finishUploadFor(clientA, storage, concurrent.reelId),
      finishUploadFor(clientA, storage, concurrent.reelId),
    ]);
    expect(answers[0]).toMatchObject({ status: "finished" });
    expect(answers[1]).toEqual(answers[0]);

    for (const [reelId, answer] of [
      [sequential.reelId, first],
      [concurrent.reelId, answers[0]],
    ] as const) {
      const { reel, jobs } = await state(reelId);
      expect(reel).toEqual({ status: "uploaded", source_bytes: bytes });
      expect(jobs).toEqual([{ id: (answer as { jobId: string }).jobId, kind: "process" }]);
    }
  });
});

describe("aborting", () => {
  it("removes the parts, marks the reel failed and is harmless twice", async () => {
    const { reelId, key, uploadId } = await newUpload();
    await multipart.putPart(key, uploadId, 1, new Uint8Array([1]));
    expect(await abortUploadFor(clientA, storage, { reelId, uploadId })).toEqual({
      status: "aborted",
    });
    await expect(multipart.listParts(key, uploadId)).rejects.toThrow(/no such upload/);
    expect(await state(reelId)).toEqual({
      reel: { status: "failed", source_bytes: null },
      jobs: [],
    });
    expect(await abortUploadFor(clientA, storage, { reelId, uploadId })).toEqual({
      status: "aborted",
    });

    const finished = await clientA.rpc("finish_upload", { p_reel_id: reelId, p_bytes: 10 });
    expect(finished.error).not.toBeNull();
    expect((await state(reelId)).jobs).toEqual([]);
  });
});
