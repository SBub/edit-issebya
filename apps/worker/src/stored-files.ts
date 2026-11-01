import type { SupabaseClient } from "@supabase/supabase-js";
import type { Storage } from "@edit-issebya/storage";
import type { ClaimedJob } from "./queue.ts";

// The five kinds of stored_files (app_docs/storage.md). `source` is recorded
// only by the studio's finish_upload.
export type StoredFileKind = "source" | "kept" | "rebuildable" | "version" | "export";

// Identifiers and times only, never content.
export interface LiveFile {
  id: string;
  reel_id: string;
  r2_key: string;
  kind: StoredFileKind;
  created_at: string;
}

export interface ExportTime {
  reel_id: string;
  created_at: string;
}

// The rows the worker writes and reads, behind an interface so storage writes
// and slimming are tested without a database.
export interface StoredFileStore {
  record(row: {
    reelId: string;
    ownerId: string;
    step: string;
    key: string;
    bytes: number;
    kind: StoredFileKind;
  }): Promise<void>;
  liveFiles(kinds: StoredFileKind[]): Promise<LiveFile[]>;
  // Every export row, deleted or not: an expired export still dates the last export.
  exportTimes(): Promise<ExportTime[]>;
  // Marks the rows still live and returns their ids; a row already marked is never counted twice.
  markDeleted(ids: string[]): Promise<string[]>;
}

export function supabaseStoredFileStore(db: SupabaseClient): StoredFileStore {
  return {
    async record(row) {
      const { error } = await db.rpc("record_stored_file", {
        p_reel_id: row.reelId,
        p_owner_id: row.ownerId,
        p_step: row.step,
        p_r2_key: row.key,
        p_bytes: row.bytes,
        p_kind: row.kind,
      });
      if (error) throw new Error(`stored file not recorded: ${error.message}`);
    },
    async liveFiles(kinds) {
      const { data, error } = await db
        .from("stored_files")
        .select("id, reel_id, r2_key, kind, created_at")
        .is("deleted_at", null)
        .in("kind", kinds);
      if (error) throw new Error(`stored files not read: ${error.message}`);
      return (data ?? []) as LiveFile[];
    },
    async exportTimes() {
      const { data, error } = await db
        .from("stored_files")
        .select("reel_id, created_at")
        .eq("kind", "export");
      if (error) throw new Error(`export times not read: ${error.message}`);
      return (data ?? []) as ExportTime[];
    },
    async markDeleted(ids) {
      if (ids.length === 0) return [];
      const { data, error } = await db
        .from("stored_files")
        .update({ deleted_at: new Date().toISOString() })
        .in("id", ids)
        .is("deleted_at", null)
        .select("id");
      if (error) throw new Error(`stored files not marked deleted: ${error.message}`);
      return (data ?? []).map((row: { id: string }) => row.id);
    },
  };
}

// The only way worker code writes to storage: every put records a row for the
// job's reel. No delete and no signUpload: steps can do neither.
export function recordedStorage(storage: Storage, files: StoredFileStore, job: ClaimedJob) {
  return {
    head: storage.head.bind(storage),
    get: storage.get.bind(storage),
    signDownload: storage.signDownload.bind(storage),
    async put(
      key: string,
      body: Uint8Array,
      {
        kind,
        step,
        contentType,
      }: { kind: Exclude<StoredFileKind, "source">; step: string; contentType?: string },
    ): Promise<void> {
      if ((kind as StoredFileKind) === "source") {
        throw new Error("source files are recorded by finish_upload, never by the worker");
      }
      await storage.put(key, body, { contentType });
      await files.record({
        reelId: job.reel_id,
        ownerId: job.owner_id,
        step,
        key,
        bytes: body.byteLength,
        kind,
      });
    },
  };
}

export type RecordedStorage = ReturnType<typeof recordedStorage>;
