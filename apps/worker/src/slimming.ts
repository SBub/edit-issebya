import type { Storage } from "@edit-issebya/storage";
import type { ExportTime, LiveFile, StoredFileStore } from "./stored-files.ts";

// Rebuildable files go strictly more than seven days after the reel's last export.
const SLIM_AFTER_MS = 7 * 24 * 3600 * 1000;
// An export lives 24 hours.
const EXPORT_LIFETIME_MS = 24 * 3600 * 1000;
export const HOUSEKEEPING_EVERY_MS = 3600 * 1000;

interface Group {
  ids: string[];
  keys: string[];
}

export interface Slimming {
  rebuildable: Group;
  exports: Group;
}

function lastExports(exportTimes: ExportTime[]): Map<string, number> {
  const last = new Map<string, number>();
  for (const { reel_id, created_at } of exportTimes) {
    const at = Date.parse(created_at);
    last.set(reel_id, Math.max(last.get(reel_id) ?? at, at));
  }
  return last;
}

// Pure: which rebuildable keys and which expired exports to delete at `now`.
// A rebuildable key goes only when every live row using it belongs to a reel
// whose last export is more than seven days old; a never-exported reel keeps it.
// Source, kept and version rows are never selected.
export function selectSlimming(files: LiveFile[], exportTimes: ExportTime[], now: Date): Slimming {
  const last = lastExports(exportTimes);
  const eligible = (reelId: string) => {
    const at = last.get(reelId);
    return at !== undefined && now.getTime() - at > SLIM_AFTER_MS;
  };

  const byKey = new Map<string, LiveFile[]>();
  for (const file of files) {
    if (file.kind !== "rebuildable") continue;
    byKey.set(file.r2_key, [...(byKey.get(file.r2_key) ?? []), file]);
  }
  const rebuildable: Group = { ids: [], keys: [] };
  for (const [key, rows] of byKey) {
    if (!rows.every((row) => eligible(row.reel_id))) continue;
    rebuildable.keys.push(key);
    rebuildable.ids.push(...rows.map((row) => row.id));
  }

  const expired = files.filter(
    (file) =>
      file.kind === "export" && now.getTime() - Date.parse(file.created_at) > EXPORT_LIFETIME_MS,
  );
  return {
    rebuildable,
    exports: {
      ids: expired.map((file) => file.id),
      keys: [...new Set(expired.map((file) => file.r2_key))],
    },
  };
}

// Marks the rows deleted first, then deletes the objects, so a deletion is
// never silent. A delete that throws is logged with its key and the row stays
// marked. Missing objects (an export R2's lifecycle already removed) are fine.
export async function housekeep({
  files,
  storage,
  now,
  log,
}: {
  files: StoredFileStore;
  storage: Pick<Storage, "delete">;
  now: Date;
  log: (line: string) => void;
}): Promise<void> {
  const [live, exportTimes] = await Promise.all([
    files.liveFiles(["rebuildable", "export"]),
    files.exportTimes(),
  ]);
  const selection = selectSlimming(live, exportTimes, now);
  const reelOf = new Map(live.map((file) => [file.id, file.reel_id]));

  const remove = async (group: Group) => {
    if (group.ids.length === 0) return [];
    const marked = await files.markDeleted(group.ids);
    for (const key of group.keys) {
      try {
        await storage.delete(key);
      } catch (error) {
        log(`housekeeping: ${key} not deleted: ${(error as Error).message}`);
      }
    }
    return marked;
  };

  const slimmed = await remove(selection.rebuildable);
  const reels = new Set(slimmed.map((id) => reelOf.get(id)));
  log(`housekeeping: slimmed ${slimmed.length} files of ${reels.size} reels`);
  const expired = await remove(selection.exports);
  log(`housekeeping: expired ${expired.length} exports`);
}

// Runs `run` at most every `everyMs` by the injected clock (first call is due).
// A failure is logged, never thrown, so housekeeping never blocks claiming.
export function createHousekeeping({
  everyMs,
  now,
  run,
  log = (line, error) => console.error(line, error),
}: {
  everyMs: number;
  now: () => Date;
  run: () => Promise<void>;
  log?: (line: string, error: unknown) => void;
}) {
  let lastRun: number | null = null;
  const due = () => lastRun === null || now().getTime() - lastRun >= everyMs;
  return {
    due,
    async maybeRun(): Promise<void> {
      if (!due()) return;
      lastRun = now().getTime();
      try {
        await run();
      } catch (error) {
        log("housekeeping failed:", error);
      }
    },
  };
}
