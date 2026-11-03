import type { Storage } from "@edit-issebya/storage";
import type { SupabaseClient } from "@supabase/supabase-js";

// A queued key of a deleted reel (`storage_deletions`), with the multipart
// upload still open on it, if any.
export interface PendingDeletion {
  id: string;
  key: string;
  uploadId: string | null;
}

// The queue delete_reel and record_stored_file fill: the due keys under a
// prefix (a key another live `stored_files` row holds is dropped first, never
// returned), and the two answers per key.
export interface StorageDeletionQueue {
  pending(prefix: string, limit: number): Promise<PendingDeletion[]>;
  done(id: string): Promise<void>;
  failed(id: string, message: string): Promise<void>;
}

export function supabaseStorageDeletions(db: SupabaseClient): StorageDeletionQueue {
  return {
    async pending(prefix, limit) {
      const { data, error } = await db.rpc("pending_storage_deletions", {
        p_prefix: prefix,
        p_limit: limit,
      });
      if (error) throw new Error(`storage deletions not read: ${error.message}`);
      return ((data ?? []) as { id: string; r2_key: string; upload_id: string | null }[]).map(
        (row) => ({ id: row.id, key: row.r2_key, uploadId: row.upload_id }),
      );
    },
    async done(id) {
      const { error } = await db.rpc("finish_storage_deletion", { p_id: id });
      if (error) throw new Error(`storage deletion not finished: ${error.message}`);
    },
    async failed(id, message) {
      const { error } = await db.rpc("fail_storage_deletion", { p_id: id, p_error: message });
      if (error) throw new Error(`storage deletion not marked failed: ${error.message}`);
    },
  };
}

// The poll's check: the id of one due row under the prefix, nothing else. It
// never writes; a key another row holds is left for pending_storage_deletions,
// which the pass in the drain's claim calls and which drops it there.
export async function dueStorageDeletionIds(db: SupabaseClient, prefix: string): Promise<string[]> {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("storage_deletions")
    .select("id")
    .like("r2_key", `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    .lte("not_before", now)
    .limit(1);
  if (error) throw new Error(`storage deletions not checked: ${error.message}`);
  return (data ?? []).map((row: { id: string }) => row.id);
}

export interface StorageDeletionCounts {
  removed: number;
  failed: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// One pass over the deleted reels' keys under the worker's prefix, between
// jobs: an open multipart upload is aborted first, then the object is deleted
// from the raw storage (never a job's). A deleted object's queue row goes; a
// failed one stays, due again ten minutes on, so a later pass retries it, and
// the pass goes on with the next key. Only a failed read of the queue throws.
export async function runStorageDeletions({
  queue,
  storage,
  keyPrefix,
  limit = 200,
  log = console.log,
}: {
  queue: StorageDeletionQueue;
  storage: Pick<Storage, "delete" | "abortMultipartUpload">;
  keyPrefix: string;
  limit?: number;
  log?: (message: string) => void;
}): Promise<StorageDeletionCounts> {
  const rows = await queue.pending(keyPrefix, limit);
  const counts: StorageDeletionCounts = { removed: 0, failed: 0 };
  for (const row of rows) {
    try {
      if (row.uploadId) await storage.abortMultipartUpload(row.key, { uploadId: row.uploadId });
      await storage.delete(row.key);
    } catch (error) {
      counts.failed += 1;
      const message = messageOf(error);
      log(`storage deletions: ${row.key} not deleted: ${message}`);
      try {
        await queue.failed(row.id, message);
      } catch (marking) {
        // The row stays due: the next pass tries it again.
        log(`storage deletions: ${row.key} not marked failed: ${messageOf(marking)}`);
      }
      continue;
    }
    try {
      await queue.done(row.id);
      counts.removed += 1;
    } catch (error) {
      // The object is gone; the next pass deletes it again (a no-op) and
      // removes the row then.
      counts.failed += 1;
      log(`storage deletions: ${row.key} deleted, row not removed: ${messageOf(error)}`);
    }
  }
  if (rows.length > 0) {
    log(`storage deletions: ${counts.removed} objects removed, ${counts.failed} failed`);
  }
  return counts;
}
