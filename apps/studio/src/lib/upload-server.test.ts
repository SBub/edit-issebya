import type { SupabaseClient } from "@supabase/supabase-js";
import type { Storage } from "@edit-issebya/storage";
import { describe, expect, it, vi } from "vitest";
import {
  PART_URL_SECONDS,
  abortUpload,
  completeUpload,
  createUpload,
  listParts,
  parseParts,
  signPart,
} from "./upload-server";

const REEL = "0b9f6c1e-3c1d-4c8e-9a51-2f4d7b6e8a10";
const KEY = `dev/reels/${REEL}/source/original.mp4`;
const UPLOAD = "upload-1";

interface Row {
  id: string;
  status: string;
  source_key: string;
  source_upload_id: string;
}

// A Supabase client stand-in: the signed-in user (or none), the rows RLS
// would let them see, and a record of inserts and RPCs.
function client({ user = true, rows = [] as Row[], rpcError = null as unknown } = {}) {
  const inserts: unknown[] = [];
  const rpcs: { name: string; args: unknown }[] = [];
  const supabase = {
    auth: { getUser: async () => ({ data: { user: user ? { id: "u" } : null } }) },
    from: () => ({
      select: () => ({
        eq: (_column: string, value: string) => ({
          maybeSingle: async () => ({
            data: rows.find((row) => row.source_upload_id === value) ?? null,
            error: null,
          }),
        }),
      }),
      insert: async (row: unknown) => {
        inserts.push(row);
        return { error: null };
      },
    }),
    rpc: async (name: string, args: unknown) => {
      rpcs.push({ name, args });
      return { data: "job", error: rpcError };
    },
  } as unknown as SupabaseClient;
  return { supabase, inserts, rpcs };
}

function storage(overrides: Partial<Storage> = {}) {
  return {
    createMultipartUpload: vi.fn(async () => ({ uploadId: UPLOAD })),
    signUploadPart: vi.fn(
      async (key: string, o: { uploadId: string; partNumber: number }) =>
        `https://r2/${key}?u=${o.uploadId}&p=${o.partNumber}`,
    ),
    listUploadParts: vi.fn(async () => [{ partNumber: 1, etag: "aa", bytes: 10 }]),
    completeMultipartUpload: vi.fn(async () => "completed" as const),
    abortMultipartUpload: vi.fn(async () => undefined),
    head: vi.fn(async () => ({ bytes: 36700160, etag: "x" })),
    ...overrides,
  } as unknown as Storage & Record<string, ReturnType<typeof vi.fn>>;
}

const uploading: Row = { id: REEL, status: "uploading", source_key: KEY, source_upload_id: UPLOAD };

describe("createUpload", () => {
  const input = { name: "clip.mp4", bytes: 1000, type: "video/mp4" };

  it("creates the multipart upload, then the reel with its upload id", async () => {
    const { supabase, inserts } = client();
    const store = storage();
    const answer = await createUpload({ supabase, storage: store, prefix: "dev/" }, input);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.value.uploadId).toBe(UPLOAD);
    expect(answer.value.key).toBe(`dev/reels/${answer.value.reelId}/source/original.mp4`);
    expect(inserts).toEqual([
      {
        id: answer.value.reelId,
        source_name: "clip.mp4",
        source_key: answer.value.key,
        source_upload_id: UPLOAD,
      },
    ]);
  });

  it("refuses a bad request before any call, and a signed-out caller", async () => {
    const store = storage();
    const { supabase } = client();
    expect(
      await createUpload({ supabase, storage: store, prefix: "dev/" }, { ...input, bytes: 0 }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      await createUpload(
        { supabase, storage: store, prefix: "dev/" },
        { ...input, bytes: 5 * 1024 ** 3 + 1 },
      ),
    ).toMatchObject({ ok: false, status: 400, error: "too-large" });
    expect(
      await createUpload(
        { supabase: client({ user: false }).supabase, storage: store, prefix: "" },
        input,
      ),
    ).toMatchObject({ ok: false, status: 401 });
    expect(store.createMultipartUpload).not.toHaveBeenCalled();
  });

  it("aborts the multipart upload when the reel cannot be inserted", async () => {
    const store = storage();
    const supabase = {
      ...client().supabase,
      from: () => ({ insert: async () => ({ error: { code: "42501", message: "rls" } }) }),
    } as unknown as SupabaseClient;
    expect(await createUpload({ supabase, storage: store, prefix: "dev/" }, input)).toMatchObject({
      ok: false,
      status: 500,
    });
    expect(store.abortMultipartUpload).toHaveBeenCalledOnce();
  });
});

describe("signPart", () => {
  it("signs for the row's key and upload id, never the request's", async () => {
    const { supabase } = client({ rows: [uploading] });
    const store = storage();
    expect(
      await signPart({ supabase, storage: store }, { uploadId: UPLOAD, partNumber: "3" }),
    ).toEqual({
      ok: true,
      value: { url: `https://r2/${KEY}?u=${UPLOAD}&p=3` },
    });
    expect(store.signUploadPart).toHaveBeenCalledWith(KEY, {
      uploadId: UPLOAD,
      partNumber: 3,
      expiresInSeconds: PART_URL_SECONDS,
    });
  });

  it("answers 400, 401 and 404 on the right branches", async () => {
    const store = storage();
    const own = client({ rows: [uploading] }).supabase;
    for (const partNumber of ["0", "10001", "1.5", "-1", "x"]) {
      expect(
        await signPart({ supabase: own, storage: store }, { uploadId: UPLOAD, partNumber }),
      ).toMatchObject({ ok: false, status: 400 });
    }
    expect(
      await signPart({ supabase: own, storage: store }, { uploadId: "a/b", partNumber: "1" }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      await signPart(
        { supabase: client({ user: false }).supabase, storage: store },
        { uploadId: UPLOAD, partNumber: "1" },
      ),
    ).toMatchObject({ ok: false, status: 401 });
    // Another owner's reel is invisible through RLS: the same 404 as a missing one.
    expect(
      await signPart(
        { supabase: client({ rows: [] }).supabase, storage: store },
        { uploadId: UPLOAD, partNumber: "1" },
      ),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      await signPart(
        {
          supabase: client({ rows: [{ ...uploading, status: "uploaded" }] }).supabase,
          storage: store,
        },
        { uploadId: UPLOAD, partNumber: "1" },
      ),
    ).toMatchObject({ ok: false, status: 404 });
    expect(store.signUploadPart).not.toHaveBeenCalled();
  });
});

describe("listParts", () => {
  it("answers the stored parts in the uploader's shape", async () => {
    const { supabase } = client({ rows: [uploading] });
    expect(await listParts({ supabase, storage: storage() }, { uploadId: UPLOAD })).toEqual({
      ok: true,
      value: [{ PartNumber: 1, ETag: "aa", Size: 10 }],
    });
  });

  it("answers no parts for an upload storage no longer has", async () => {
    const { supabase } = client({ rows: [uploading] });
    const store = storage({ listUploadParts: vi.fn(async () => null) });
    expect(await listParts({ supabase, storage: store }, { uploadId: UPLOAD })).toEqual({
      ok: true,
      value: [],
    });
  });
});

describe("parseParts", () => {
  it("sorts, unquotes, and refuses repeats or bad numbers", () => {
    expect(
      parseParts([
        { PartNumber: 2, ETag: '"bb"' },
        { PartNumber: 1, ETag: "aa" },
      ]),
    ).toEqual([
      { partNumber: 1, etag: "aa" },
      { partNumber: 2, etag: "bb" },
    ]);
    expect(parseParts([])).toBeNull();
    expect(parseParts([{ PartNumber: 0, ETag: "aa" }])).toBeNull();
    expect(parseParts([{ PartNumber: 1, ETag: "a b" }])).toBeNull();
    expect(
      parseParts([
        { PartNumber: 1, ETag: "aa" },
        { PartNumber: 1, ETag: "bb" },
      ]),
    ).toBeNull();
  });
});

describe("completeUpload", () => {
  const parts = [{ PartNumber: 1, ETag: "aa" }];

  it("completes, then finishes with the size storage reports", async () => {
    const { supabase, rpcs } = client({ rows: [uploading] });
    const store = storage();
    expect(await completeUpload({ supabase, storage: store }, { uploadId: UPLOAD, parts })).toEqual(
      {
        ok: true,
        value: { reelId: REEL, key: KEY },
      },
    );
    expect(store.completeMultipartUpload).toHaveBeenCalledWith(KEY, {
      uploadId: UPLOAD,
      parts: [{ partNumber: 1, etag: "aa" }],
    });
    expect(rpcs).toEqual([{ name: "finish_upload", args: { p_reel_id: REEL, p_bytes: 36700160 } }]);
  });

  it("goes on when storage already completed it and the object is there", async () => {
    const { supabase, rpcs } = client({ rows: [uploading] });
    const store = storage({ completeMultipartUpload: vi.fn(async () => "missing" as const) });
    expect(
      (await completeUpload({ supabase, storage: store }, { uploadId: UPLOAD, parts })).ok,
    ).toBe(true);
    expect(rpcs).toHaveLength(1);
  });

  it("answers 409 when the upload and the object are both gone", async () => {
    const { supabase, rpcs } = client({ rows: [uploading] });
    const store = storage({
      completeMultipartUpload: vi.fn(async () => "missing" as const),
      head: vi.fn(async () => null),
    });
    expect(
      await completeUpload({ supabase, storage: store }, { uploadId: UPLOAD, parts }),
    ).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(rpcs).toEqual([]);
  });

  it("repeats for an already finished reel without completing again", async () => {
    const { supabase, rpcs } = client({ rows: [{ ...uploading, status: "uploaded" }] });
    const store = storage();
    expect(
      (await completeUpload({ supabase, storage: store }, { uploadId: UPLOAD, parts })).ok,
    ).toBe(true);
    expect(store.completeMultipartUpload).not.toHaveBeenCalled();
    expect(rpcs.map((rpc) => rpc.name)).toEqual(["finish_upload"]);
  });

  it("answers 404 for a failed or invisible reel, 401 signed out", async () => {
    const store = storage();
    for (const rows of [[], [{ ...uploading, status: "failed" }]]) {
      expect(
        await completeUpload(
          { supabase: client({ rows }).supabase, storage: store },
          { uploadId: UPLOAD, parts },
        ),
      ).toMatchObject({ ok: false, status: 404 });
    }
    expect(
      await completeUpload(
        { supabase: client({ user: false }).supabase, storage: store },
        { uploadId: UPLOAD, parts },
      ),
    ).toMatchObject({ ok: false, status: 401 });
    expect(store.completeMultipartUpload).not.toHaveBeenCalled();
  });
});

describe("abortUpload", () => {
  it("aborts in storage, then fails the reel", async () => {
    const { supabase, rpcs } = client({ rows: [uploading] });
    const store = storage();
    expect(await abortUpload({ supabase, storage: store }, { uploadId: UPLOAD })).toEqual({
      ok: true,
      value: { reelId: REEL },
    });
    expect(store.abortMultipartUpload).toHaveBeenCalledWith(KEY, { uploadId: UPLOAD });
    expect(rpcs).toEqual([{ name: "fail_upload", args: { p_reel_id: REEL } }]);
  });

  it("answers 404 for another owner's upload and touches nothing", async () => {
    const store = storage();
    expect(
      await abortUpload({ supabase: client().supabase, storage: store }, { uploadId: UPLOAD }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(store.abortMultipartUpload).not.toHaveBeenCalled();
  });
});
