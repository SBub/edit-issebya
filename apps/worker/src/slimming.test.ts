import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Storage, fakeStorage } from "@edit-issebya/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MemoryRow, memoryStoredFiles } from "./memory-stored-files.ts";
import { createHousekeeping, housekeep, selectSlimming } from "./slimming.ts";
import type { StoredFileKind } from "./stored-files.ts";

const NOW = new Date("2026-11-20T12:00:00Z");
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

let next = 0;
function row(reel: string, kind: StoredFileKind, key: string, createdAgo = 30 * DAY): MemoryRow {
  next += 1;
  return {
    id: `r${next}`,
    reel_id: reel,
    owner_id: "o1",
    step: kind === "export" ? "export" : "convert",
    r2_key: key,
    bytes: 10,
    kind,
    created_at: ago(createdAgo),
    deleted_at: null,
  };
}

// Reel A: exported 8 days ago, with every kind of file.
function reelA() {
  return [
    row("A", "source", "dev/reels/a/source/original.mp4"),
    row("A", "kept", "dev/reels/a/preview/preview.mp4"),
    row("A", "version", "dev/reels/a/versions/v1.json"),
    row("A", "rebuildable", "dev/reels/a/cache/converted.mp4"),
    row("A", "rebuildable", "dev/reels/a/cache/cutout.mov"),
    row("A", "export", "dev/reels/a/exports/e1.mp4", 8 * DAY),
  ];
}

function select(rows: MemoryRow[]) {
  const live = rows.filter((r) => !r.deleted_at);
  const exportTimes = rows.filter((r) => r.kind === "export");
  return selectSlimming(live, exportTimes, NOW);
}

describe("selectSlimming", () => {
  it("selects only the rebuildable files of a reel exported more than seven days ago", () => {
    const rows = reelA();
    expect(select(rows).rebuildable).toEqual({
      ids: [rows[3]!.id, rows[4]!.id],
      keys: ["dev/reels/a/cache/converted.mp4", "dev/reels/a/cache/cutout.mov"],
    });
  });

  it("keeps a reel exported six days ago, and one exported exactly seven days ago", () => {
    for (const age of [6 * DAY, 7 * DAY]) {
      const rows = [
        row("B", "rebuildable", "dev/reels/b/cache/converted.mp4"),
        row("B", "export", "dev/reels/b/exports/e1.mp4", age),
      ];
      expect(select(rows).rebuildable).toEqual({ ids: [], keys: [] });
    }
  });

  it("never slims a reel that was never exported", () => {
    const rows = [row("C", "rebuildable", "dev/reels/c/cache/converted.mp4", 30 * DAY)];
    expect(select(rows).rebuildable).toEqual({ ids: [], keys: [] });
  });

  it("dates the reel by its newest export, including expired and deleted ones", () => {
    const rows = [
      row("B", "rebuildable", "dev/reels/b/cache/converted.mp4"),
      row("B", "export", "dev/reels/b/exports/e1.mp4", 20 * DAY),
      { ...row("B", "export", "dev/reels/b/exports/e2.mp4", 3 * DAY), deleted_at: ago(DAY) },
    ];
    expect(select(rows).rebuildable).toEqual({ ids: [], keys: [] });
  });

  it("keeps an object shared with a reel exported yesterday, and slims the unshared one", () => {
    const shared = "dev/cache/fingerprint/abc.mp4";
    const rows = [
      row("A", "rebuildable", shared),
      row("A", "rebuildable", "dev/reels/a/cache/cutout.mov"),
      row("A", "export", "dev/reels/a/exports/e1.mp4", 8 * DAY),
      row("D", "rebuildable", shared),
      row("D", "export", "dev/reels/d/exports/e1.mp4", DAY - HOUR),
    ];
    expect(select(rows).rebuildable).toEqual({
      ids: [rows[1]!.id],
      keys: ["dev/reels/a/cache/cutout.mov"],
    });
  });

  it("keeps an object shared with a never-exported reel", () => {
    const shared = "dev/cache/fingerprint/abc.mp4";
    const rows = [
      row("A", "rebuildable", shared),
      row("A", "export", "dev/reels/a/exports/e1.mp4", 8 * DAY),
      row("C", "rebuildable", shared),
    ];
    expect(select(rows).rebuildable).toEqual({ ids: [], keys: [] });
  });

  it("deletes a shared object with all its rows when every reel using it is eligible", () => {
    const shared = "dev/cache/fingerprint/abc.mp4";
    const rows = [
      row("A", "rebuildable", shared),
      row("A", "export", "dev/reels/a/exports/e1.mp4", 8 * DAY),
      row("E", "rebuildable", shared),
      row("E", "export", "dev/reels/e/exports/e1.mp4", 9 * DAY),
    ];
    expect(select(rows).rebuildable).toEqual({ ids: [rows[0]!.id, rows[2]!.id], keys: [shared] });
  });

  it("expires exports older than 24 hours", () => {
    const rows = [
      row("A", "export", "dev/reels/a/exports/old.mp4", 25 * HOUR),
      row("A", "export", "dev/reels/a/exports/new.mp4", 23 * HOUR),
    ];
    expect(select(rows).exports).toEqual({
      ids: [rows[0]!.id],
      keys: ["dev/reels/a/exports/old.mp4"],
    });
  });
});

describe("housekeep", () => {
  let root: string;
  let storage: Storage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "slimming-"));
    storage = fakeStorage({ root, uploadUrlBase: "" });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("marks and deletes A's rebuildable files and expired export, and nothing else", async () => {
    const rows = [
      ...reelA(),
      row("B", "rebuildable", "dev/reels/b/cache/converted.mp4"),
      row("B", "export", "dev/reels/b/exports/e1.mp4", 6 * DAY),
    ];
    for (const r of rows) await storage.put(r.r2_key, new Uint8Array(r.bytes));
    // Reel B's export is past 24 hours too; its object went with R2's lifecycle rule.
    await storage.delete("dev/reels/b/exports/e1.mp4");
    const { store } = memoryStoredFiles(rows, () => NOW);
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);

    await housekeep({ files: store, storage, now: NOW, log });

    expect(await storage.list("")).toEqual([
      "dev/reels/a/preview/preview.mp4",
      "dev/reels/a/source/original.mp4",
      "dev/reels/a/versions/v1.json",
      "dev/reels/b/cache/converted.mp4",
    ]);
    const deleted = rows.filter((r) => r.deleted_at).map((r) => r.r2_key);
    expect(deleted).toEqual([
      "dev/reels/a/cache/converted.mp4",
      "dev/reels/a/cache/cutout.mov",
      "dev/reels/a/exports/e1.mp4",
      "dev/reels/b/exports/e1.mp4",
    ]);
    expect(lines).toEqual([
      "housekeeping: slimmed 2 files of 1 reels",
      "housekeeping: expired 2 exports",
    ]);

    lines.length = 0;
    await housekeep({ files: store, storage, now: NOW, log });
    expect(lines).toEqual([
      "housekeeping: slimmed 0 files of 0 reels",
      "housekeeping: expired 0 exports",
    ]);
    expect(rows.filter((r) => r.deleted_at)).toHaveLength(4);
  });

  it("marks the rows deleted before deleting the objects", async () => {
    const rows = reelA().filter((r) => r.kind === "rebuildable" || r.kind === "export");
    const { store, calls } = memoryStoredFiles(rows, () => NOW);
    const spy = {
      delete: async (key: string) => {
        calls.push(`delete ${key}`);
      },
    };
    await housekeep({ files: store, storage: spy, now: NOW, log: () => {} });
    expect(calls).toEqual([
      `markDeleted ${rows[0]!.id},${rows[1]!.id}`,
      "delete dev/reels/a/cache/converted.mp4",
      "delete dev/reels/a/cache/cutout.mov",
      `markDeleted ${rows[2]!.id}`,
      "delete dev/reels/a/exports/e1.mp4",
    ]);
  });

  it("logs a failed delete with its key and keeps going, the row marked", async () => {
    const rows = reelA().filter((r) => r.kind === "rebuildable");
    rows.push(row("A", "export", "dev/reels/a/exports/e1.mp4", 8 * DAY));
    const { store } = memoryStoredFiles(rows, () => NOW);
    const lines: string[] = [];
    const failing = {
      delete: async (key: string) => {
        if (key.endsWith("converted.mp4")) throw new Error("r2 down");
      },
    };
    await housekeep({ files: store, storage: failing, now: NOW, log: (l) => lines.push(l) });
    expect(lines[0]).toBe("housekeeping: dev/reels/a/cache/converted.mp4 not deleted: r2 down");
    expect(rows.every((r) => r.deleted_at)).toBe(true);
  });
});

describe("createHousekeeping", () => {
  it("is due at start, then not again until everyMs later", async () => {
    let now = NOW.getTime();
    const run = vi.fn(async () => {});
    const housekeeping = createHousekeeping({ everyMs: HOUR, now: () => new Date(now), run });
    expect(housekeeping.due()).toBe(true);
    await housekeeping.maybeRun();
    await housekeeping.maybeRun();
    expect(run).toHaveBeenCalledTimes(1);
    now += HOUR - 1;
    await housekeeping.maybeRun();
    expect(run).toHaveBeenCalledTimes(1);
    now += 1;
    await housekeeping.maybeRun();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("logs a failing run and resolves", async () => {
    const errors: unknown[] = [];
    const housekeeping = createHousekeeping({
      everyMs: HOUR,
      now: () => NOW,
      run: async () => {
        throw new Error("db down");
      },
      log: (_line, error) => errors.push(error),
    });
    await expect(housekeeping.maybeRun()).resolves.toBeUndefined();
    expect(errors).toEqual([new Error("db down")]);
  });
});
