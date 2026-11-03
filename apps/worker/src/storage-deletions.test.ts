import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  type PendingDeletion,
  type StorageDeletionQueue,
  dueStorageDeletionIds,
  runStorageDeletions,
} from "./storage-deletions.ts";

const PREFIX = "dev/";

// A queue in memory, as the three functions behave: a failed row is not due
// again until `release()` (its ten minutes) has passed.
function memoryQueue(rows: PendingDeletion[]) {
  const queued = new Map(rows.map((row) => [row.id, row]));
  const waiting = new Set<string>();
  const events: string[] = [];
  const queue: StorageDeletionQueue = {
    async pending(prefix, limit) {
      events.push(`pending ${prefix} ${limit}`);
      return [...queued.values()]
        .filter((row) => row.key.startsWith(prefix) && !waiting.has(row.id))
        .slice(0, limit);
    },
    async done(id) {
      events.push(`done ${id}`);
      queued.delete(id);
    },
    async failed(id, message) {
      events.push(`failed ${id} ${message}`);
      waiting.add(id);
    },
  };
  return { queue, events, queued, release: () => waiting.clear() };
}

function stubStorage(failing: Set<string> = new Set()) {
  const events: string[] = [];
  return {
    events,
    storage: {
      async delete(key: string) {
        events.push(`delete ${key}`);
        if (failing.has(key)) throw new Error("R2 unavailable");
      },
      async abortMultipartUpload(key: string, { uploadId }: { uploadId: string }) {
        events.push(`abort ${key} ${uploadId}`);
      },
    },
  };
}

const ROWS: PendingDeletion[] = [
  { id: "1", key: `${PREFIX}reels/r/source/original.mov`, uploadId: "u1" },
  { id: "2", key: `${PREFIX}cache/convert/a/converted.mp4`, uploadId: null },
  { id: "3", key: `${PREFIX}reels/r/versions/v.json`, uploadId: null },
];

describe("runStorageDeletions", () => {
  it("deletes every pending key once, aborting an open upload first", async () => {
    const { queue, events, queued } = memoryQueue(ROWS);
    const { storage, events: stored } = stubStorage();
    const logs: string[] = [];
    const counts = await runStorageDeletions({
      queue,
      storage,
      keyPrefix: PREFIX,
      log: (line) => void logs.push(line),
    });
    expect(counts).toEqual({ removed: 3, failed: 0 });
    expect(stored).toEqual([
      `abort ${ROWS[0]!.key} u1`,
      `delete ${ROWS[0]!.key}`,
      `delete ${ROWS[1]!.key}`,
      `delete ${ROWS[2]!.key}`,
    ]);
    expect(events).toEqual([`pending ${PREFIX} 200`, "done 1", "done 2", "done 3"]);
    expect(queued.size).toBe(0);
    expect(logs).toEqual(["storage deletions: 3 objects removed, 0 failed"]);
  });

  it("keeps a failed key for a later pass, goes on with the others, then retries it", async () => {
    const { queue, events, queued, release } = memoryQueue(ROWS);
    const failing = new Set([ROWS[1]!.key]);
    const first = stubStorage(failing);
    const logs: string[] = [];
    const log = (line: string) => void logs.push(line);
    expect(
      await runStorageDeletions({ queue, storage: first.storage, keyPrefix: PREFIX, log }),
    ).toEqual({ removed: 2, failed: 1 });
    expect(events).toContain("failed 2 R2 unavailable");
    expect(events).not.toContain("done 2");
    expect([...queued.keys()]).toEqual(["2"]);
    expect(logs).toEqual([
      `storage deletions: ${ROWS[1]!.key} not deleted: R2 unavailable`,
      "storage deletions: 2 objects removed, 1 failed",
    ]);

    // Not due yet: nothing is tried and nothing logged.
    logs.length = 0;
    const idle = stubStorage();
    expect(
      await runStorageDeletions({ queue, storage: idle.storage, keyPrefix: PREFIX, log }),
    ).toEqual({ removed: 0, failed: 0 });
    expect(idle.events).toEqual([]);
    expect(logs).toEqual([]);

    release();
    const second = stubStorage();
    expect(
      await runStorageDeletions({ queue, storage: second.storage, keyPrefix: PREFIX, log }),
    ).toEqual({ removed: 1, failed: 0 });
    expect(second.events).toEqual([`delete ${ROWS[1]!.key}`]);
    expect(events.at(-1)).toBe("done 2");
    expect(queued.size).toBe(0);
  });

  it("throws when the queue cannot be read", async () => {
    const queue: StorageDeletionQueue = {
      async pending() {
        throw new Error("storage deletions not read: offline");
      },
      async done() {},
      async failed() {},
    };
    await expect(
      runStorageDeletions({ queue, storage: stubStorage().storage, keyPrefix: PREFIX }),
    ).rejects.toThrow(/offline/);
  });
});

// A client that records the one select the poll makes; it has no `rpc`, so a
// call to pending_storage_deletions would throw.
function selectStub(result: { data: { id: string }[] | null; error: { message: string } | null }) {
  const calls = {
    tables: [] as string[],
    columns: [] as string[],
    like: [] as [string, string][],
    lte: [] as [string, string][],
    limit: [] as number[],
  };
  const db = {
    from(table: string) {
      calls.tables.push(table);
      const builder = {
        select(columns: string) {
          calls.columns.push(columns);
          return builder;
        },
        like(column: string, pattern: string) {
          calls.like.push([column, pattern]);
          return builder;
        },
        lte(column: string, value: string) {
          calls.lte.push([column, value]);
          return builder;
        },
        limit(count: number) {
          calls.limit.push(count);
          return Promise.resolve(result);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

describe("dueStorageDeletionIds", () => {
  it("selects only the id of one due row under the prefix, with no rpc", async () => {
    const { db, calls } = selectStub({ data: [{ id: "d1" }], error: null });
    expect(await dueStorageDeletionIds(db, PREFIX)).toEqual(["d1"]);
    expect(calls.tables).toEqual(["storage_deletions"]);
    expect(calls.columns).toEqual(["id"]);
    expect(calls.like).toEqual([["r2_key", "dev/%"]]);
    expect(calls.lte).toHaveLength(1);
    expect(calls.lte[0]?.[0]).toBe("not_before");
    expect(new Date(calls.lte[0]?.[1] ?? "").toISOString()).toBe(calls.lte[0]?.[1]);
    expect(calls.limit).toEqual([1]);
  });

  it("matches the prefix literally, escaping like's wildcards", async () => {
    const { db, calls } = selectStub({ data: [], error: null });
    expect(await dueStorageDeletionIds(db, "a_b%/")).toEqual([]);
    expect(calls.like).toEqual([["r2_key", "a\\_b\\%/%"]]);
  });

  it("throws when the check fails", async () => {
    const { db } = selectStub({ data: null, error: { message: "down" } });
    await expect(dueStorageDeletionIds(db, PREFIX)).rejects.toThrow(
      "storage deletions not checked: down",
    );
  });
});
