import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Storage, fakeStorage } from "@edit-issebya/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSlimmer, runSlimming } from "./slimming.ts";
import type { StoredFile, StoredFileRecords } from "./stored-files.ts";

const PREFIX = "dev/";
const NOW = new Date("2026-11-01T12:00:00Z");
const REBUILDABLE = [
  { key: `${PREFIX}cache/convert/a/converted.mp4`, bytes: 2 * 1024 * 1024 },
  { key: `${PREFIX}cache/remove_background/a/subject.webm`, bytes: 1024 * 1024 },
];
const EXPIRED = [{ key: `${PREFIX}exports/r/e.mp4`, bytes: 512 * 1024 }];
const KEPT = [
  `${PREFIX}reels/r/source/original.mp4`,
  `${PREFIX}cache/preview_copies/a/footage-preview.mp4`,
  `${PREFIX}reels/r/versions/v.json`,
];

let root: string;
let storage: Storage;
let events: string[];
let logs: string[];

function fixedRecords(rebuildable: StoredFile[] = REBUILDABLE): StoredFileRecords {
  return {
    async record() {
      throw new Error("slimming records nothing");
    },
    async slimRebuildable(now, prefix) {
      events.push(`slim ${now.toISOString()} ${prefix}`);
      return rebuildable;
    },
    async expireExports(now, prefix) {
      events.push(`expire ${now.toISOString()} ${prefix}`);
      return EXPIRED;
    },
  };
}

function tracking(inner: Storage, fail: string | null = null): Storage {
  return {
    ...inner,
    async delete(key) {
      events.push(`delete ${key}`);
      if (key === fail) throw new Error("R2 unavailable");
      return inner.delete(key);
    },
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "slimming-"));
  storage = fakeStorage({ root, uploadUrlBase: "" });
  for (const key of [...REBUILDABLE.map((f) => f.key), ...EXPIRED.map((f) => f.key), ...KEPT]) {
    await storage.put(key, new Uint8Array(1));
  }
  events = [];
  logs = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("runSlimming", () => {
  it("deletes exactly the returned objects, after the database marked them", async () => {
    const counts = await runSlimming({
      records: fixedRecords(),
      storage: tracking(storage),
      keyPrefix: PREFIX,
      now: NOW,
      log: (message) => logs.push(message),
    });
    expect(events).toEqual([
      `slim ${NOW.toISOString()} ${PREFIX}`,
      `expire ${NOW.toISOString()} ${PREFIX}`,
      ...[...REBUILDABLE, ...EXPIRED].map((file) => `delete ${file.key}`),
    ]);
    expect(await storage.list(PREFIX)).toEqual([...KEPT].sort());
    expect(counts).toEqual({
      rebuildable: 2,
      rebuildableBytes: 3 * 1024 * 1024,
      exports: 1,
      exportBytes: 512 * 1024,
      failed: 0,
    });
    expect(logs).toEqual([
      "slimming: 2 rebuildable files (3.0 MB), 1 expired exports (512.0 KB) deleted",
    ]);
  });

  it("logs a failed delete and goes on with the rest", async () => {
    const counts = await runSlimming({
      records: fixedRecords(),
      storage: tracking(storage, REBUILDABLE[0]!.key),
      keyPrefix: PREFIX,
      now: NOW,
      log: (message) => logs.push(message),
    });
    expect(counts.failed).toBe(1);
    expect(logs[0]).toBe(`slimming: ${REBUILDABLE[0]!.key} not deleted: R2 unavailable`);
    expect(await storage.head(REBUILDABLE[1]!.key)).toBeNull();
    expect(await storage.head(EXPIRED[0]!.key)).toBeNull();
  });

  it("is fine with an object already gone", async () => {
    const gone = { key: `${PREFIX}cache/convert/gone/converted.mp4`, bytes: 1 };
    const counts = await runSlimming({
      records: fixedRecords([gone]),
      storage,
      keyPrefix: PREFIX,
      now: NOW,
      log: (message) => logs.push(message),
    });
    expect(counts.failed).toBe(0);
  });
});

describe("createSlimmer", () => {
  it("runs at most once an hour, the first call included", async () => {
    let now = NOW.getTime();
    const runs: string[] = [];
    const slimmer = createSlimmer({
      clock: () => new Date(now),
      run: async (at) => {
        runs.push(at.toISOString());
      },
    });
    await slimmer.maybeRun();
    now += 59 * 60_000;
    await slimmer.maybeRun();
    now += 60_000;
    await slimmer.maybeRun();
    expect(runs).toEqual([NOW.toISOString(), new Date(NOW.getTime() + 3_600_000).toISOString()]);
  });

  it("never throws out of maybeRun", async () => {
    const errors: unknown[] = [];
    const slimmer = createSlimmer({
      run: async () => {
        throw new Error("database down");
      },
      onError: (error) => errors.push(error),
    });
    await expect(slimmer.maybeRun()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});
