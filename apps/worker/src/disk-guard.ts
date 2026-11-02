import { statfs } from "node:fs/promises";
import { isE2EMockStorage } from "@edit-issebya/storage";
import type { SupabaseClient } from "@supabase/supabase-js";

type Env = Record<string, string | undefined>;

const GB = 1024 ** 3;

// The free bytes of the volume holding the folder.
export type FreeBytes = (dir: string) => Promise<number>;

// What an unprivileged process may still write: available blocks times their size.
export const statfsFreeBytes: FreeBytes = async (dir) => {
  const info = await statfs(dir);
  return info.bavail * info.bsize;
};

// The disk the guard reads. Under E2E_MOCK_STORAGE set to exactly "true",
// E2E_MOCK_FREE_DISK_GB (when set) replaces it, so a spec can make the worker
// wait; anywhere else that variable is ignored.
export function freeBytesFn(env: Env = process.env): FreeBytes {
  const raw = env.E2E_MOCK_FREE_DISK_GB?.trim();
  if (!isE2EMockStorage(env) || !raw) return statfsFreeBytes;
  const gb = Number(raw);
  if (!Number.isFinite(gb) || gb < 0) {
    throw new Error(`E2E_MOCK_FREE_DISK_GB must be a number of GB, got ${raw}`);
  }
  return async () => Math.round(gb * GB);
}

// Why the worker is not claiming, as the studio shows it under a queued job.
export function waitingReason(freeBytes: number, minFreeDiskGb: number): string {
  return `waiting: ${(freeBytes / GB).toFixed(1)} GB free on the worker's disk, needs ${minFreeDiskGb} GB`;
}

export interface WorkerStatusStore {
  set(row: { freeDiskBytes: number; waitingReason: string | null }): Promise<void>;
  // The long-running worker's heartbeat: never touches the waiting reason.
  heartbeat(row: { freeDiskBytes: number }): Promise<void>;
}

// This worker's `worker_status` row, through the service role client.
export function supabaseWorkerStatus(db: SupabaseClient, workerId: string): WorkerStatusStore {
  return {
    async set({ freeDiskBytes, waitingReason }) {
      const { error } = await db.from("worker_status").upsert(
        {
          worker_id: workerId,
          free_disk_bytes: freeDiskBytes,
          waiting_reason: waitingReason,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "worker_id" },
      );
      if (error) throw new Error(`worker status not written: ${error.message}`);
    },
    async heartbeat({ freeDiskBytes }) {
      const now = new Date().toISOString();
      // free_disk_bytes too: a first upsert inserts the row, which needs it.
      const { error } = await db.from("worker_status").upsert(
        {
          worker_id: workerId,
          free_disk_bytes: freeDiskBytes,
          heartbeat_at: now,
          updated_at: now,
        },
        { onConflict: "worker_id" },
      );
      if (error) throw new Error(`worker heartbeat not written: ${error.message}`);
    },
  };
}

// Claims only while the scratch volume has at least the minimum free: below
// it, `claim` is never called, the reason is written and logged, and null
// comes back (the same as no job). At or above it the reason is cleared.
export async function guardedClaim<T>({
  dir,
  minFreeDiskGb,
  freeBytes,
  status,
  claim,
  log = console.warn,
}: {
  dir: string;
  minFreeDiskGb: number;
  freeBytes: FreeBytes;
  status: WorkerStatusStore;
  claim: () => Promise<T | null>;
  log?: (message: string) => void;
}): Promise<T | null> {
  const free = await freeBytes(dir);
  if (free < minFreeDiskGb * GB) {
    const reason = waitingReason(free, minFreeDiskGb);
    await status.set({ freeDiskBytes: free, waitingReason: reason });
    log(`worker: ${reason}`);
    return null;
  }
  await status.set({ freeDiskBytes: free, waitingReason: null });
  return claim();
}
