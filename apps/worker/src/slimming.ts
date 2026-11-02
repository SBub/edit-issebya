import type { Storage } from "@edit-issebya/storage";
import { formatBytes } from "./format.ts";
import type { StoredFile, StoredFileRecords } from "./stored-files.ts";

export interface SlimmingCounts {
  rebuildable: number;
  rebuildableBytes: number;
  exports: number;
  exportBytes: number;
  failed: number;
}

// One slimming pass under the worker's key prefix: the database selects and
// marks deleted, in one statement each, the rebuildable files no reel needs
// any more and the files of expired exports; then each returned object is
// deleted from storage (the raw storage, never a job's). A failed delete is
// logged and the pass goes on: the row stays deleted, and a later job that
// finds the object records a fresh row.
export async function runSlimming({
  records,
  storage,
  keyPrefix,
  now,
  log = console.log,
}: {
  records: StoredFileRecords;
  storage: Storage;
  keyPrefix: string;
  now: Date;
  log?: (message: string) => void;
}): Promise<SlimmingCounts> {
  const rebuildable = await records.slimRebuildable(now, keyPrefix);
  const expired = await records.expireExports(now, keyPrefix);
  let failed = 0;
  for (const file of [...rebuildable, ...expired]) {
    try {
      await storage.delete(file.key);
    } catch (error) {
      failed += 1;
      log(
        `slimming: ${file.key} not deleted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const total = (files: StoredFile[]) => files.reduce((sum, file) => sum + file.bytes, 0);
  const counts = {
    rebuildable: rebuildable.length,
    rebuildableBytes: total(rebuildable),
    exports: expired.length,
    exportBytes: total(expired),
    failed,
  };
  log(
    `slimming: ${counts.rebuildable} rebuildable files (${formatBytes(counts.rebuildableBytes)}), ` +
      `${counts.exports} expired exports (${formatBytes(counts.exportBytes)}) deleted`,
  );
  return counts;
}

export interface Slimmer {
  // Runs a pass when at least `everyMs` passed since the last one started (the
  // first call always runs). Never throws.
  maybeRun(): Promise<void>;
}

export function createSlimmer({
  everyMs = 3_600_000,
  clock = () => new Date(),
  run,
  onError = (error) => console.error("slimming: failed:", error),
}: {
  everyMs?: number;
  clock?: () => Date;
  run: (now: Date) => Promise<unknown>;
  onError?: (error: unknown) => void;
}): Slimmer {
  let last: number | null = null;
  return {
    async maybeRun() {
      const now = clock();
      if (last !== null && now.getTime() - last < everyMs) return;
      last = now.getTime();
      try {
        await run(now);
      } catch (error) {
        onError(error);
      }
    },
  };
}
