import { stat } from "node:fs/promises";
import type { Storage } from "@edit-issebya/storage";
import type { SupabaseClient } from "@supabase/supabase-js";
import { retentionOf } from "./pipeline/definition.ts";
import { supabaseFailure } from "./failure.ts";

export type StoredFileKind = "source" | "kept" | "rebuildable" | "version" | "export";

// What a stored file belongs to: a reel, or a library photo.
export type StoredFileTarget = { reelId: string } | { photoId: string };

export type StoredFileRow = StoredFileTarget & {
  key: string;
  step: string;
  kind: StoredFileKind;
  bytes: number;
};

// A claimed job's target: its reel, or its photo for a `describe_photo` job.
export function jobTarget(job: {
  reel_id: string | null;
  photo_id: string | null;
}): StoredFileTarget {
  if (job.reel_id) return { reelId: job.reel_id };
  if (job.photo_id) return { photoId: job.photo_id };
  throw new Error("stored-files: the job has neither a reel nor a photo");
}

export interface StoredFile {
  key: string;
  bytes: number;
}

// The `stored_files` rows: one per reel and key, written by the worker, and
// the two functions that select what may be deleted and mark it deleted in
// the same statement.
export interface StoredFileRecords {
  record(row: StoredFileRow): Promise<void>;
  slimRebuildable(now: Date, prefix: string): Promise<StoredFile[]>;
  expireExports(now: Date, prefix: string): Promise<StoredFile[]>;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CACHE = /^cache\/([a-z_]{1,40})\/[a-z0-9]+\/([a-z0-9._-]+)$/;
const VERSION = new RegExp(`^reels/${UUID}/versions/${UUID}\\.json$`);
const EXPORT = new RegExp(`^exports/${UUID}/${UUID}\\.mp4$`);
const SOURCE = new RegExp(`^reels/${UUID}/source/original\\.[a-z0-9]{1,10}$`);
const PHOTO_ORIGINAL = new RegExp(`^library/${UUID}/original\\.(jpg|png|heic|heif|webp)$`);
const PHOTO_DERIVED = new RegExp(`^library/${UUID}/(thumbnail|large)\\.jpg$`);

// The kind and step of a key, from its layout alone: a pipeline output
// (`<prefix>cache/<step>/<fp>/<file>`, kept or rebuildable by the step's
// tag), a version, an export, the raw footage, or a library photo (its
// original kept, its thumbnail and large copy rebuildable). Anything else
// throws, so nothing is ever written unrecorded.
export function classifyKey(prefix: string, key: string): { kind: StoredFileKind; step: string } {
  const unknown = () => new Error(`stored-files: unknown key layout: ${key}`);
  if (!key.startsWith(prefix)) throw unknown();
  const rest = key.slice(prefix.length);
  const cache = CACHE.exec(rest);
  if (cache) {
    const [, step, file] = cache;
    const retention = retentionOf(step!, file!);
    if (!retention) throw unknown();
    return { kind: retention, step: step! };
  }
  if (VERSION.test(rest)) return { kind: "version", step: "version" };
  if (EXPORT.test(rest)) return { kind: "export", step: "render" };
  if (SOURCE.test(rest)) return { kind: "source", step: "upload" };
  if (PHOTO_ORIGINAL.test(rest)) return { kind: "kept", step: "upload" };
  if (PHOTO_DERIVED.test(rest)) return { kind: "rebuildable", step: "photo_images" };
  throw unknown();
}

function storedFiles(data: unknown): StoredFile[] {
  return ((data ?? []) as { r2_key: string; bytes: number | string }[]).map((row) => ({
    key: row.r2_key,
    bytes: Number(row.bytes),
  }));
}

// The reel was deleted while its job ran: record_stored_file queued the key
// for deletion instead of recording it, and the job stops (it is `deleted`,
// never failed: run-job.ts asks whether the job's row is gone first).
export class TargetGone extends Error {
  constructor(key: string) {
    super(`stored-files: the reel is gone, ${key} queued for deletion`);
    this.name = "TargetGone";
  }
}

// The records through the worker's (service role) client.
export function supabaseStoredFiles(db: SupabaseClient): StoredFileRecords {
  return {
    async record(row) {
      const fields = { p_r2_key: row.key, p_step: row.step, p_kind: row.kind, p_bytes: row.bytes };
      if ("photoId" in row) {
        const { error, status } = await db.rpc("record_photo_file", {
          p_photo_id: row.photoId,
          ...fields,
        });
        if (error) throw supabaseFailure("stored file not recorded", { error, status });
        return;
      }
      const { data, error, status } = await db.rpc("record_stored_file", {
        p_reel_id: row.reelId,
        ...fields,
      });
      if (error) throw supabaseFailure("stored file not recorded", { error, status });
      // false: the reel no longer exists and the key is queued for deletion.
      if (data === false) throw new TargetGone(row.key);
    },
    async slimRebuildable(now, prefix) {
      const { data, error } = await db.rpc("slim_rebuildable_files", {
        p_now: now.toISOString(),
        p_prefix: prefix,
      });
      if (error) throw new Error(`rebuildable files not slimmed: ${error.message}`);
      return storedFiles(data);
    },
    async expireExports(now, prefix) {
      const { data, error } = await db.rpc("expire_export_files", {
        p_now: now.toISOString(),
        p_prefix: prefix,
      });
      if (error) throw new Error(`expired exports not marked: ${error.message}`);
      return storedFiles(data);
    },
  };
}

// Removes an export file the render uploaded but no `exports` row records (the
// job was cancelled, or the row was not written): `discard_export_file` marks
// its `stored_files` row deleted and returns it only while no export records
// the key, then the object is deleted from the raw storage (a job's storage
// refuses deletes). A recorded export is never touched; a failed removal is
// logged, never thrown, so the render's own outcome stands.
export function supabaseDiscardExport(
  db: SupabaseClient,
  rawStorage: Pick<Storage, "delete">,
  log: (message: string) => void = console.log,
): (key: string) => Promise<void> {
  return async (key) => {
    try {
      const { data, error } = await db.rpc("discard_export_file", { p_r2_key: key });
      if (error) throw new Error(error.message);
      for (const file of storedFiles(data)) await rawStorage.delete(file.key);
    } catch (error) {
      log(
        `render: ${key} not discarded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
}

// Every method of the storage interface, classified: adding one to the
// interface fails typecheck here until it is, so a new write method cannot
// skip recording.
export const STORAGE_METHODS: Record<keyof Storage, "read" | "write" | "refused"> = {
  createMultipartUpload: "read",
  signUploadPart: "read",
  listUploadParts: "read",
  completeMultipartUpload: "write",
  abortMultipartUpload: "read",
  signDownload: "read",
  head: "read",
  get: "read",
  getFile: "read",
  put: "write",
  putFileIfAbsent: "write",
  putIfAbsent: "write",
  delete: "refused",
  list: "read",
};

// A job's storage: reads pass through, every write records a `stored_files`
// row for the job's reel or photo after it succeeds (also when the object was
// already there: this reel needs it now too), and delete is refused (only the
// slimming task deletes). A failed record fails the job; the row is
// idempotent, so the retry records it.
export function recordingStorage(
  storage: Storage,
  {
    records,
    target,
    keyPrefix,
  }: { records: StoredFileRecords; target: StoredFileTarget; keyPrefix: string },
): Storage {
  async function recordKey(key: string, bytes: number | null) {
    if (bytes === null) throw new Error(`stored-files: no object after writing ${key}`);
    await records.record({ ...target, key, bytes, ...classifyKey(keyPrefix, key) });
  }
  const headBytes = async (key: string) => (await storage.head(key))?.bytes ?? null;

  const wrapped: Storage = {
    createMultipartUpload: (key, options) => storage.createMultipartUpload(key, options),
    signUploadPart: (key, options) => storage.signUploadPart(key, options),
    listUploadParts: (key, options) => storage.listUploadParts(key, options),
    abortMultipartUpload: (key, options) => storage.abortMultipartUpload(key, options),
    signDownload: (key, options) => storage.signDownload(key, options),
    head: (key, options) => storage.head(key, options),
    get: (key) => storage.get(key),
    getFile: (key, path, options) => storage.getFile(key, path, options),
    list: (prefix) => storage.list(prefix),

    async completeMultipartUpload(key, options) {
      classifyKey(keyPrefix, key);
      const result = await storage.completeMultipartUpload(key, options);
      if (result === "completed") await recordKey(key, await headBytes(key));
      return result;
    },
    async put(key, body, options) {
      classifyKey(keyPrefix, key);
      await storage.put(key, body, options);
      await recordKey(key, body.byteLength);
    },
    async putIfAbsent(key, body, options) {
      classifyKey(keyPrefix, key);
      const result = await storage.putIfAbsent(key, body, options);
      await recordKey(key, result === "written" ? body.byteLength : await headBytes(key));
      return result;
    },
    async putFileIfAbsent(key, path, options) {
      classifyKey(keyPrefix, key);
      const result = await storage.putFileIfAbsent(key, path, options);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the file the job just uploaded
      const bytes = result === "written" ? (await stat(path)).size : await headBytes(key);
      await recordKey(key, bytes);
      return result;
    },
    async delete(key) {
      throw new Error(`jobs never delete stored objects; the slimming task does (${key})`);
    },
  };
  return wrapped;
}
