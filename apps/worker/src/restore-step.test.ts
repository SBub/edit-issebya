import type {
  EditInputs,
  NewVersion,
  StoredVersion,
  VersionBlobs,
  VersionRows,
} from "@edit-issebya/edit";
import { versionKey } from "@edit-issebya/edit";
import { beforeEach, describe, expect, it } from "vitest";
import { TEST_JOB, recordingSteps, stepContext } from "./recording-steps.ts";
import { runRestore } from "./restore-step.ts";

const PREFIX = "dev/";
const REEL = TEST_JOB.reel_id;
const OTHER_REEL = "7a2d4c1e-9b3f-4e8a-b6c5-1d0e2f3a4b5c";
const V1 = "11111111-1111-4111-8111-111111111111";
const V2 = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const NEW = "44444444-4444-4444-8444-444444444444";

const INPUTS = {
  footage: { step: "retime", fingerprint: "f1", file: "source.mp4" },
} as unknown as EditInputs;

let rows: Map<string, StoredVersion & Partial<NewVersion>>;
let blobs: Map<string, Uint8Array>;
let current: string | null;

function memoryRows(): VersionRows {
  return {
    async current() {
      return current;
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async save(row) {
      if (row.parent_id !== current) throw new Error("stale parent");
      const number = [...rows.values()].filter((r) => r.reel_id === row.reel_id).length + 1;
      rows.set(row.id, { ...row, number });
      current = row.id;
      return number;
    },
  };
}

function memoryBlobs(): VersionBlobs {
  return {
    async get(key) {
      return blobs.get(key) ?? null;
    },
    async putIfAbsent(key, bytes) {
      if (blobs.has(key)) return "exists";
      blobs.set(key, bytes);
      return "written";
    },
  };
}

function stored(id: string, reelId: string, number: number, body: string): StoredVersion {
  const key = versionKey(PREFIX, reelId, id);
  blobs.set(key, new TextEncoder().encode(body));
  return {
    id,
    reel_id: reelId,
    number,
    parent_id: null,
    restored_from_id: null,
    checks: [],
    inputs: INPUTS,
    r2_key: key,
  };
}

beforeEach(() => {
  blobs = new Map();
  rows = new Map([
    [V1, stored(V1, REEL, 1, '{"v":1}')],
    [V2, { ...stored(V2, REEL, 2, '{"v":2}'), parent_id: V1 }],
    [OTHER, stored(OTHER, OTHER_REEL, 1, '{"other":1}')],
  ]);
  current = V2;
});

function run(versionId: string) {
  const recorded = recordingSteps();
  const done = runRestore({
    ctx: stepContext(recorded.steps),
    rows: memoryRows(),
    blobs: memoryBlobs(),
    keyPrefix: PREFIX,
    versionId,
    newId: () => NEW,
  });
  return { done, calls: recorded.calls };
}

describe("runRestore", () => {
  it("saves a new current version copying the old one's bytes", async () => {
    const before = new Map([...rows].map(([id, row]) => [id, { ...row }]));
    const beforeBlobs = new Map(blobs);
    const { done, calls } = run(V1);
    await done;

    const row = rows.get(NEW)!;
    expect(row).toMatchObject({
      reel_id: REEL,
      number: 3,
      parent_id: V2,
      restored_from_id: V1,
      change_summary: "restored version 1",
      r2_key: versionKey(PREFIX, REEL, NEW),
    });
    expect(current).toBe(NEW);
    expect(new TextDecoder().decode(blobs.get(row.r2_key))).toBe('{"v":1}');

    // History is never rewritten: the old rows and blobs are as they were.
    for (const [id, old] of before) expect(rows.get(id)).toEqual(old);
    for (const [key, bytes] of beforeBlobs) expect(blobs.get(key)).toBe(bytes);

    const finished = calls.find((call) => call.call === "done");
    expect(calls[0]).toMatchObject({ call: "start", name: "restore" });
    expect(finished && "summary" in finished && finished.summary).toMatch(
      /^version 3: restored from version 1, /,
    );
  });

  it("refuses a version of another reel and writes nothing", async () => {
    const { done, calls } = run(OTHER);
    await expect(done).rejects.toThrow(/is not a version of reel/);
    expect(rows.has(NEW)).toBe(false);
    expect(current).toBe(V2);
    expect(blobs.size).toBe(3);
    expect(calls.map((call) => call.call)).toEqual(["start", "failed"]);
  });
});
