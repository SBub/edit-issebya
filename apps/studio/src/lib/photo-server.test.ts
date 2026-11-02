import type { SupabaseClient } from "@supabase/supabase-js";
import type { Storage } from "@edit-issebya/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ErrorCapture } from "./error-tracking";
import { deletePhoto, finishPhotoUpload, loadLibrary, startPhotoUpload } from "./photo-server";
import { MAX_PHOTO_BYTES, type PhotoRow } from "./photos";
import { PART_URL_SECONDS } from "./upload-server";

const PHOTO = "0b9f6c1e-3c1d-4c8e-9a51-2f4d7b6e8a10";
const OTHER = "1c8e7d2f-4d2e-4d9f-8b62-3e5c8f7a9b21";
const KEY = `dev/library/${PHOTO}/original.jpg`;
const UPLOAD = "upload-1";

function row(overrides: Partial<PhotoRow> = {}): PhotoRow {
  return {
    id: PHOTO,
    status: "uploading",
    file_name: "a.jpg",
    content_type: "image/jpeg",
    r2_key: KEY,
    upload_id: UPLOAD,
    bytes: null,
    width: null,
    height: null,
    description: null,
    tags: [],
    thumbnail_key: null,
    large_key: null,
    created_at: "2026-11-02T10:00:00.000Z",
    ...overrides,
  };
}

// A Supabase client stand-in: the signed-in user (or none), the rows RLS
// would let them see, and a record of inserts and RPCs.
function client({
  user = true,
  rows = [] as PhotoRow[],
  insertError = null as unknown,
  rpcError = null as unknown,
} = {}) {
  const inserts: unknown[] = [];
  const rpcs: { name: string; args: unknown }[] = [];
  const supabase = {
    auth: { getUser: async () => ({ data: { user: user ? { id: "u" } : null } }) },
    from: () => ({
      select: () => ({
        eq: (_column: string, value: string) => ({
          maybeSingle: async () => ({
            data: rows.find((r) => r.id === value) ?? null,
            error: null,
          }),
        }),
        order: () => ({ returns: async () => ({ data: rows, error: null }) }),
      }),
      insert: async (value: unknown) => {
        inserts.push(value);
        return { error: insertError };
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
  const calls: string[] = [];
  const store = {
    createMultipartUpload: vi.fn(async () => ({ uploadId: UPLOAD })),
    signUploadPart: vi.fn(
      async (key: string, o: { uploadId: string; partNumber: number }) =>
        `https://r2/${key}?u=${o.uploadId}&p=${o.partNumber}`,
    ),
    completeMultipartUpload: vi.fn(async () => "completed" as const),
    abortMultipartUpload: vi.fn(async (key: string) => {
      calls.push(`abort ${key}`);
    }),
    head: vi.fn(async () => ({ bytes: 4000, etag: "x" })),
    delete: vi.fn(async (key: string) => {
      calls.push(`delete ${key}`);
    }),
    signDownload: vi.fn(async (key: string) => `https://r2/${key}?signed`),
    ...overrides,
  } as unknown as Storage & Record<string, ReturnType<typeof vi.fn>>;
  return { store, calls };
}

const captured: string[] = [];
const errors: ErrorCapture = {
  capture(error) {
    captured.push(error.message);
  },
  async flush() {},
};

beforeEach(() => {
  captured.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("startPhotoUpload", () => {
  const input = { name: "a.jpg", size: 4000, type: "image/jpeg" };

  it("creates the upload, then the row with its upload id, then signs part 1", async () => {
    const { supabase, inserts } = client();
    const { store } = storage();
    const answer = await startPhotoUpload(
      { supabase, storage: store, errors, prefix: "dev/" },
      input,
    );
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    const key = `dev/library/${answer.value.photoId}/original.jpg`;
    expect(store.createMultipartUpload).toHaveBeenCalledWith(key, { contentType: "image/jpeg" });
    expect(inserts).toEqual([
      {
        id: answer.value.photoId,
        file_name: "a.jpg",
        r2_key: key,
        content_type: "image/jpeg",
        upload_id: UPLOAD,
      },
    ]);
    expect(store.signUploadPart).toHaveBeenCalledWith(key, {
      uploadId: UPLOAD,
      partNumber: 1,
      expiresInSeconds: PART_URL_SECONDS,
    });
    expect(answer.value.url).toBe(`https://r2/${key}?u=${UPLOAD}&p=1`);
  });

  it("refuses a signed-out caller, a bad type and an oversized file before any storage call", async () => {
    const { store } = storage();
    const deps = { storage: store, errors, prefix: "dev/" };
    expect(
      await startPhotoUpload({ ...deps, supabase: client({ user: false }).supabase }, input),
    ).toEqual({ ok: false, error: "signed-out" });
    expect(
      await startPhotoUpload(
        { ...deps, supabase: client().supabase },
        { ...input, name: "a.gif", type: "image/gif" },
      ),
    ).toEqual({ ok: false, error: "type" });
    expect(
      await startPhotoUpload(
        { ...deps, supabase: client().supabase },
        { ...input, size: MAX_PHOTO_BYTES + 1 },
      ),
    ).toEqual({ ok: false, error: "too-large" });
    expect(store.createMultipartUpload).not.toHaveBeenCalled();
  });

  it("answers unavailable without storage or a valid prefix", async () => {
    const { supabase } = client();
    expect(await startPhotoUpload({ supabase, storage: null, errors, prefix: "" }, input)).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(
      await startPhotoUpload({ supabase, storage: storage().store, errors, prefix: null }, input),
    ).toEqual({ ok: false, error: "unavailable" });
  });

  it("aborts the upload when the row is refused", async () => {
    const { supabase } = client({ insertError: { code: "42501", message: "denied" } });
    const { store, calls } = storage();
    const answer = await startPhotoUpload({ supabase, storage: store, errors, prefix: "" }, input);
    expect(answer).toEqual({ ok: false, error: "failed" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^abort library\/.+\/original\.jpg$/);
    expect(store.signUploadPart).not.toHaveBeenCalled();
    expect(captured).toEqual(["studio: photo not created"]);
  });
});

describe("finishPhotoUpload", () => {
  it("completes with the row's key and upload id, then finishes with storage's size", async () => {
    const { supabase, rpcs } = client({ rows: [row()] });
    const { store } = storage();
    const answer = await finishPhotoUpload(
      { supabase, storage: store, errors },
      { photoId: PHOTO, etag: '"abc123"' },
    );
    expect(answer).toEqual({ ok: true, value: { photoId: PHOTO } });
    expect(store.completeMultipartUpload).toHaveBeenCalledWith(KEY, {
      uploadId: UPLOAD,
      parts: [{ partNumber: 1, etag: "abc123" }],
    });
    expect(rpcs).toEqual([
      { name: "finish_photo_upload", args: { p_photo_id: PHOTO, p_bytes: 4000 } },
    ]);
  });

  it("finishes after a lost complete answer when the object is there", async () => {
    const { supabase, rpcs } = client({ rows: [row()] });
    const { store } = storage({ completeMultipartUpload: vi.fn(async () => "missing" as const) });
    expect(
      await finishPhotoUpload({ supabase, storage: store, errors }, { photoId: PHOTO, etag: "e" }),
    ).toMatchObject({ ok: true });
    expect(rpcs).toHaveLength(1);
  });

  it("answers upload-gone when neither the upload nor the object exists", async () => {
    const { supabase, rpcs } = client({ rows: [row()] });
    const { store } = storage({
      completeMultipartUpload: vi.fn(async () => "missing" as const),
      head: vi.fn(async () => null),
    });
    expect(
      await finishPhotoUpload({ supabase, storage: store, errors }, { photoId: PHOTO, etag: "e" }),
    ).toEqual({ ok: false, error: "upload-gone" });
    expect(rpcs).toEqual([]);
  });

  it("deletes an object over the limit (the browser's size lied) and its row", async () => {
    const { supabase, rpcs } = client({ rows: [row()] });
    const { store, calls } = storage({
      head: vi.fn(async () => ({ bytes: MAX_PHOTO_BYTES + 1, etag: "x" })),
    });
    expect(
      await finishPhotoUpload({ supabase, storage: store, errors }, { photoId: PHOTO, etag: "e" }),
    ).toEqual({ ok: false, error: "too-large" });
    expect(calls).toEqual([`delete ${KEY}`]);
    expect(rpcs).toEqual([{ name: "delete_photo", args: { p_photo_id: PHOTO } }]);
  });

  it("answers a repeat for a photo past uploading without any call", async () => {
    const { supabase, rpcs } = client({ rows: [row({ status: "describing" })] });
    const { store } = storage();
    expect(
      await finishPhotoUpload({ supabase, storage: store, errors }, { photoId: PHOTO, etag: "e" }),
    ).toEqual({ ok: true, value: { photoId: PHOTO } });
    expect(store.completeMultipartUpload).not.toHaveBeenCalled();
    expect(rpcs).toEqual([]);
  });

  it("answers another owner's photo, a bad id and a bad ETag as not found or gone", async () => {
    const { supabase, rpcs } = client({ rows: [row()] });
    const { store } = storage();
    const deps = { supabase, storage: store, errors };
    expect(await finishPhotoUpload(deps, { photoId: OTHER, etag: "e" })).toEqual({
      ok: false,
      error: "not-found",
    });
    expect(await finishPhotoUpload(deps, { photoId: "x", etag: "e" })).toEqual({
      ok: false,
      error: "not-found",
    });
    expect(await finishPhotoUpload(deps, { photoId: PHOTO, etag: "a b" })).toEqual({
      ok: false,
      error: "upload-gone",
    });
    expect(store.completeMultipartUpload).not.toHaveBeenCalled();
    expect(rpcs).toEqual([]);
  });

  it("refuses a signed-out caller", async () => {
    const { supabase } = client({ user: false, rows: [row()] });
    expect(
      await finishPhotoUpload(
        { supabase, storage: storage().store, errors },
        { photoId: PHOTO, etag: "e" },
      ),
    ).toEqual({ ok: false, error: "signed-out" });
  });
});

describe("deletePhoto", () => {
  const ready = row({
    status: "ready",
    upload_id: null,
    thumbnail_key: `w/library/${PHOTO}/thumbnail.jpg`,
    large_key: `w/library/${PHOTO}/large.jpg`,
  });

  it("deletes the row's three objects, then the row", async () => {
    const { supabase, rpcs } = client({ rows: [ready] });
    const { store, calls } = storage();
    expect(await deletePhoto({ supabase, storage: store, errors }, { photoId: PHOTO })).toEqual({
      ok: true,
      value: { photoId: PHOTO },
    });
    expect(calls).toEqual([
      `delete ${KEY}`,
      `delete w/library/${PHOTO}/thumbnail.jpg`,
      `delete w/library/${PHOTO}/large.jpg`,
    ]);
    expect(rpcs).toEqual([{ name: "delete_photo", args: { p_photo_id: PHOTO } }]);
  });

  it("aborts an unfinished upload first", async () => {
    const { supabase } = client({ rows: [row()] });
    const { store, calls } = storage();
    await deletePhoto({ supabase, storage: store, errors }, { photoId: PHOTO });
    expect(calls).toEqual([`abort ${KEY}`, `delete ${KEY}`]);
  });

  it("leaves the row when storage fails, so the owner can try again", async () => {
    const { supabase, rpcs } = client({ rows: [ready] });
    const { store } = storage({
      delete: vi.fn(async () => {
        throw new Error(`secret ${KEY}`);
      }),
    });
    expect(await deletePhoto({ supabase, storage: store, errors }, { photoId: PHOTO })).toEqual({
      ok: false,
      error: "failed",
    });
    expect(rpcs).toEqual([]);
    expect(captured).toEqual(["studio: photo files not deleted"]);
  });

  it("answers another owner's photo as not found and deletes nothing", async () => {
    const { supabase, rpcs } = client({ rows: [ready] });
    const { store, calls } = storage();
    expect(await deletePhoto({ supabase, storage: store, errors }, { photoId: OTHER })).toEqual({
      ok: false,
      error: "not-found",
    });
    expect(calls).toEqual([]);
    expect(rpcs).toEqual([]);
  });
});

describe("loadLibrary", () => {
  it("signs each photo's images on the server and never hands out a key", async () => {
    const ready = row({
      status: "ready",
      bytes: 4000,
      width: 1200,
      height: 900,
      description: "A test pattern.",
      tags: ["test pattern", "abstract", "colour bars"],
      thumbnail_key: "w/t.jpg",
      large_key: "w/l.jpg",
    });
    const { supabase } = client({ rows: [ready, row({ id: OTHER })] });
    const answer = await loadLibrary(
      { supabase, storage: storage().store, errors },
      Date.parse("2026-11-02T10:05:00.000Z"),
    );
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.value[0]).toMatchObject({
      id: PHOTO,
      status: "ready",
      fileName: "a.jpg",
      width: 1200,
      height: 900,
      description: "A test pattern.",
      tags: ["test pattern", "abstract", "colour bars"],
      thumbnailUrl: "https://r2/w/t.jpg?signed",
      largeUrl: "https://r2/w/l.jpg?signed",
    });
    expect(answer.value[1]).toMatchObject({ id: OTHER, thumbnailUrl: null, largeUrl: null });
    expect(JSON.stringify(answer.value)).not.toContain(KEY);
  });

  it("gives a neutral tile when signing fails", async () => {
    const { supabase } = client({ rows: [row({ status: "ready", thumbnail_key: "w/t.jpg" })] });
    const { store } = storage({
      signDownload: vi.fn(async () => {
        throw new Error("no");
      }),
    });
    const answer = await loadLibrary({ supabase, storage: store, errors });
    expect(answer).toMatchObject({ ok: true, value: [{ thumbnailUrl: null }] });
    expect(captured).toEqual(["studio: photo image not signed"]);
  });

  it("refuses a signed-out caller", async () => {
    const { supabase } = client({ user: false });
    expect(await loadLibrary({ supabase, storage: null, errors })).toEqual({
      ok: false,
      error: "signed-out",
    });
  });
});
