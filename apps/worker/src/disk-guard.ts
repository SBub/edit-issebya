import { mkdir, statfs } from "node:fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isE2EMockStorage } from "@edit-issebya/storage";

type Env = Record<string, string | undefined>;

const GB = 1024 ** 3;

// Where the worker says why it is not claiming, read live by the studio.
export interface WorkerStatusStore {
  write(status: { freeDiskBytes: number; waitingReason: string | null }): Promise<void>;
}

export function supabaseWorkerStatusStore(db: SupabaseClient, workerId: string): WorkerStatusStore {
  return {
    async write({ freeDiskBytes, waitingReason }) {
      const { error } = await db.from("worker_status").upsert(
        {
          worker_id: workerId,
          free_disk_bytes: Math.max(0, Math.round(freeDiskBytes)),
          waiting_reason: waitingReason,
        },
        { onConflict: "worker_id" },
      );
      if (error) throw new Error(`worker status not written: ${error.message}`);
    },
  };
}

export function waitingReason(freeBytes: number, minGb: number): string {
  return `waiting: ${(freeBytes / GB).toFixed(1)} GB free on the worker's disk, needs ${minGb} GB`;
}

// The free space of the scratch volume. Under E2E_MOCK_STORAGE=true only,
// E2E_MOCK_FREE_DISK_GB replaces it; otherwise that variable is ignored.
export async function freeDiskBytes(dir: string, env: Env = process.env): Promise<number> {
  if (isE2EMockStorage(env)) {
    const raw = env.E2E_MOCK_FREE_DISK_GB?.trim();
    const value = raw ? Number(raw) : Number.NaN;
    if (Number.isFinite(value) && value >= 0) return value * GB;
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the configured scratch directory
  await mkdir(dir, { recursive: true });
  const info = await statfs(dir);
  return info.bavail * info.bsize;
}

export interface DiskGuard {
  // True when there is room for a job; otherwise the reason is written.
  check(): Promise<boolean>;
}

export function createDiskGuard({
  freeBytes,
  minFreeDiskGb,
  status,
  log = (reason) => console.warn(`worker: ${reason}`),
}: {
  freeBytes: () => Promise<number>;
  minFreeDiskGb: number;
  status: WorkerStatusStore;
  log?: (reason: string) => void;
}): DiskGuard {
  // undefined until the first write, so the first check always writes.
  let written: string | null | undefined;
  return {
    async check() {
      const free = await freeBytes();
      const reason = free < minFreeDiskGb * GB ? waitingReason(free, minFreeDiskGb) : null;
      // Only a change is written, so idle ticks do not churn Realtime.
      if (reason !== written) {
        await status.write({ freeDiskBytes: free, waitingReason: reason });
        written = reason;
        if (reason) log(reason);
      }
      return reason === null;
    },
  };
}

// Never calls claim below the minimum.
export function claimIfRoom<T>(guard: DiskGuard, claim: () => Promise<T | null>) {
  return async (): Promise<T | null> => ((await guard.check()) ? claim() : null);
}
