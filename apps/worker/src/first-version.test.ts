import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ISSEBYA_PRESET,
  type NewVersion,
  type StoredVersion,
  type VersionRows,
  parseEdit,
  transcriptSchema,
  versionKey,
} from "@edit-issebya/edit";
import { type Storage, fakeStorage } from "@edit-issebya/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveFirstVersion } from "./first-version.ts";
import { cacheKey } from "./pipeline/fingerprint.ts";
import { TEST_JOB, recordingSteps, stepContext } from "./recording-steps.ts";
import { storageVersionBlobs } from "./version-store.ts";

const PREFIX = "dev/";
const FIXTURES = new URL("../../../fixtures/pipeline/", import.meta.url);
const VERSION_ID = "9d7c1f5e-3a2b-4c6d-8e9f-0a1b2c3d4e5f";

interface Manifest {
  steps: { name: string; fingerprint: string; files: string[] }[];
}

let root: string;
let storage: Storage;
let fingerprints: Record<string, string>;
let rows: Map<string, StoredVersion & NewVersion>;
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
      const number = rows.size + 1;
      rows.set(row.id, { ...row, number });
      current = row.id;
      return number;
    },
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "first-version-"));
  storage = fakeStorage({ root, uploadUrlBase: "" });
  const manifest = JSON.parse(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
    await readFile(new URL("manifest.json", FIXTURES), "utf8"),
  ) as Manifest;
  fingerprints = Object.fromEntries(manifest.steps.map((step) => [step.name, step.fingerprint]));
  // Only the JSON outputs the step reads.
  for (const step of manifest.steps) {
    for (const file of step.files.filter((name) => name.endsWith(".json"))) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
      const bytes = await readFile(new URL(`${step.name}/${file}`, FIXTURES));
      await storage.put(cacheKey(PREFIX, step.name, step.fingerprint, file), new Uint8Array(bytes));
    }
  }
  rows = new Map();
  current = null;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function run(steps: ReturnType<typeof recordingSteps>["steps"]) {
  return saveFirstVersion({
    ctx: stepContext(steps),
    storage,
    rows: memoryRows(),
    blobs: storageVersionBlobs(storage),
    keyPrefix: PREFIX,
    fingerprints,
    newId: () => VERSION_ID,
  });
}

describe("saveFirstVersion", () => {
  it("saves version 1 from the preset, its edit under the version key", async () => {
    const { steps, calls } = recordingSteps();
    await run(steps);

    expect(rows.size).toBe(1);
    const row = rows.get(VERSION_ID)!;
    const key = versionKey(PREFIX, TEST_JOB.reel_id, VERSION_ID);
    expect(row).toMatchObject({
      number: 1,
      reel_id: TEST_JOB.reel_id,
      parent_id: null,
      restored_from_id: null,
      request: null,
      model: null,
      prompt_version: null,
      change_summary: "automatic first version from the issebya style",
      checks: [],
      r2_key: key,
    });
    expect(row.inputs.transcript).toEqual({
      step: "retime",
      fingerprint: fingerprints.retime,
      file: "transcript.json",
    });

    const transcript = transcriptSchema.parse(
      JSON.parse(
        new TextDecoder().decode(
          (await storage.get(cacheKey(PREFIX, "retime", fingerprints.retime!, "transcript.json")))!,
        ),
      ),
    );
    const stored = JSON.parse(new TextDecoder().decode((await storage.get(key))!));
    const parsed = parseEdit(stored, ISSEBYA_PRESET, transcript);
    expect(parsed.ok).toBe(true);
    expect(stored.tracks.captions).toHaveLength(transcript.words.length);

    expect(calls.map((call) => call.call)).toEqual(["start", "done"]);
    const done = calls[1]!;
    expect(done.call === "done" && done.summary).toMatch(
      /^version 1 saved, under a second, [\d.]+ KB$/,
    );
  });

  it("records a hit and writes nothing when the reel already has a version", async () => {
    await run(recordingSteps().steps);
    const before = await storage.list(`${PREFIX}reels/`);
    const { steps, calls } = recordingSteps();
    await run(steps);
    expect(rows.size).toBe(1);
    expect(await storage.list(`${PREFIX}reels/`)).toEqual(before);
    expect(calls).toMatchObject([
      { call: "skipped", name: "first_version", summary: "first version kept, reused" },
    ]);
  });
});
