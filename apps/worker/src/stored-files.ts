import { stat } from "node:fs/promises";
import type { Storage } from "@edit-issebya/storage";
import type { SupabaseClient } from "@supabase/supabase-js";
import { retentionOf } from "./pipeline/definition.ts";

export type StoredFileKind = "source" | "kept" | "rebuildable" | "version" | "export";

export interface StoredFileRow {
  reelId: string;
  key: string;
  step: string;
  kind: StoredFileKind;
  bytes: number;
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

// The kind and step of a key, from its layout alone: a pipeline output
// (`<prefix>cache/<step>/<fp>/<file>`, kept or rebuildable by the step's
// tag), a version, an export or the raw footage. Anything else throws, so
// nothing is ever written unrecorded.
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
  throw unknown();
}

function storedFiles(data: unknown): StoredFile[] {
  return ((data ?? []) as { r2_key: string; bytes: number | string }[]).map((row) => ({
    key: row.r2_key,
    bytes: Number(row.bytes),
  }));
}

// The records through the worker's (service role) client.
export function supabaseStoredFiles(db: SupabaseClient): StoredFileRecords {
  return {
    async record(row) {
      const { error } = await db.rpc("record_stored_file", {
        p_reel_id: row.reelId,
        p_r2_key: row.key,
        p_step: row.step,
        p_kind: row.kind,
        p_bytes: row.bytes,
      });
      if (error) throw new Error(`stored file not recorded: ${error.message}`);
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
// row for the job's reel after it succeeds (also when the object was already
// there: this reel needs it now too), and delete is refused (only the
// slimming task deletes). A failed record fails the job; the row is
// idempotent, so the retry records it.
export function recordingStorage(
  storage: Storage,
  { records, reelId, keyPrefix }: { records: StoredFileRecords; reelId: string; keyPrefix: string },
): Storage {
  async function recordKey(key: string, bytes: number | null) {
    if (bytes === null) throw new Error(`stored-files: no object after writing ${key}`);
    await records.record({ reelId, key, bytes, ...classifyKey(keyPrefix, key) });
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
