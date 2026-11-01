// Test helper: a StoredFileStore in memory that mirrors the table's unique
// index (one live row per reel and key) and record_stored_file's upsert.
import type { StoredFileKind, StoredFileStore } from "./stored-files.ts";

export interface MemoryRow {
  id: string;
  reel_id: string;
  owner_id: string;
  step: string;
  r2_key: string;
  bytes: number;
  kind: StoredFileKind;
  created_at: string;
  deleted_at: string | null;
}

export function memoryStoredFiles(rows: MemoryRow[] = [], now = () => new Date()) {
  const calls: string[] = [];
  let next = rows.length;
  const store: StoredFileStore = {
    async record({ reelId, ownerId, step, key, bytes, kind }) {
      calls.push(`record ${key}`);
      const live = rows.find((r) => r.reel_id === reelId && r.r2_key === key && !r.deleted_at);
      if (live) {
        Object.assign(live, { step, bytes, kind });
        return;
      }
      next += 1;
      rows.push({
        id: `f${next}`,
        reel_id: reelId,
        owner_id: ownerId,
        step,
        r2_key: key,
        bytes,
        kind,
        created_at: now().toISOString(),
        deleted_at: null,
      });
    },
    async liveFiles(kinds) {
      return rows
        .filter((r) => !r.deleted_at && kinds.includes(r.kind))
        .map(({ id, reel_id, r2_key, kind, created_at }) => ({
          id,
          reel_id,
          r2_key,
          kind,
          created_at,
        }));
    },
    async exportTimes() {
      return rows
        .filter((r) => r.kind === "export")
        .map(({ reel_id, created_at }) => ({ reel_id, created_at }));
    },
    async markDeleted(ids) {
      calls.push(`markDeleted ${ids.join(",")}`);
      const marked = rows.filter((r) => ids.includes(r.id) && !r.deleted_at);
      for (const row of marked) row.deleted_at = now().toISOString();
      return marked.map((r) => r.id);
    },
  };
  return { store, rows, calls };
}
