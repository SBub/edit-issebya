import type {
  EditInputs,
  NewVersion,
  StoredVersion,
  VersionBlobs,
  VersionRows,
} from "@edit-issebya/edit";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editBytes, versionKey } from "@edit-issebya/edit";
import { type Storage, fakeStorage } from "@edit-issebya/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withMasks } from "./cutout/spans.ts";
import {
  BEHIND_HEAD_TRACK,
  BEHIND_TRANSCRIPT,
  behindEdit,
  fakeMaskSpawn,
} from "./cutout/test-support.ts";
import { cacheKey } from "./pipeline/fingerprint.ts";
import { storageVersionBlobs } from "./version-store.ts";
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
      change_title: null,
      change_summary: "Back to how v1 looked",
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

describe("runRestore of a version with a behind item", () => {
  let root: string;
  let storage: Storage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "restore-cutout-"));
    storage = fakeStorage({ root: join(root, "store"), uploadUrlBase: "" });
    const edit = withMasks(behindEdit(), BEHIND_TRANSCRIPT, BEHIND_HEAD_TRACK);
    const ref = edit.inputs.transcript;
    await storage.put(
      cacheKey(PREFIX, ref.step, ref.fingerprint, ref.file),
      new TextEncoder().encode(JSON.stringify(BEHIND_TRANSCRIPT)),
    );
    const footage = edit.inputs.footage;
    await storage.put(
      cacheKey(PREFIX, footage.step, footage.fingerprint, footage.file),
      new TextEncoder().encode("footage"),
    );
    // The head track the masks' crops are read from.
    const track = edit.inputs.head_track;
    await storage.put(
      cacheKey(PREFIX, track.step, track.fingerprint, track.file),
      new TextEncoder().encode(JSON.stringify(BEHIND_HEAD_TRACK)),
    );
    const key = versionKey(PREFIX, REEL, V1);
    await storage.put(key, editBytes(edit));
    // The first mask is still stored; the second was slimmed.
    const [first] = edit.inputs.masks!;
    await storage.put(
      cacheKey(PREFIX, first!.step, first!.fingerprint, first!.file),
      new TextEncoder().encode("stored"),
    );
    rows.set(V1, { ...rows.get(V1)!, inputs: edit.inputs, r2_key: key });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("rebuilds the slimmed mask, then saves the copy of the old bytes", async () => {
    const recorded = recordingSteps();
    const spawn = fakeMaskSpawn();
    await runRestore({
      ctx: stepContext(recorded.steps),
      rows: memoryRows(),
      blobs: storageVersionBlobs(storage),
      keyPrefix: PREFIX,
      versionId: V1,
      newId: () => NEW,
      cutouts: {
        storage,
        keyPrefix: PREFIX,
        scratchDir: join(root, "scratch"),
        tools: { ffmpeg: "ffmpeg", ffprobe: "ffprobe", hyperframes: ["node", "hf.mjs"] },
        spawnTool: spawn.spawnTool,
        env: { E2E_MOCK_MASK: "true" },
      },
    });
    expect(spawn.calls).toHaveLength(1);
    const names = recorded.calls.flatMap((call) => (call.call === "start" ? [call.name] : []));
    expect(names).toEqual(["cutout", "restore"]);
    const [, second] = rows.get(V1)!.inputs.masks!;
    expect(
      await storage.head(cacheKey(PREFIX, second!.step, second!.fingerprint, second!.file)),
    ).not.toBeNull();
    const row = rows.get(NEW)!;
    expect(row.restored_from_id).toBe(V1);
    expect(await storage.get(row.r2_key)).toEqual(await storage.get(rows.get(V1)!.r2_key));
  });
});
