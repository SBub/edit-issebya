import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ISSEBYA,
  type NewVersion,
  type VersionRow,
  type VersionStore,
  parseEdit,
} from "@edit-issebya/edit";
import { type Storage, fakeStorage } from "@edit-issebya/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_JOB, recordingSteps, stepContext } from "../recording-steps.ts";
import { cacheKey } from "../pipeline/fingerprint.ts";
import { firstVersion } from "./first-version.ts";

const PREFIX = "dev/";
const VERSION_ID = "7d3c1a9e-2b4f-4c6d-8e0a-1f2b3c4d5e6f";

// The fixture clip's fingerprints and its retime transcript and head track.
const fixtures = new URL("../../../../fixtures/pipeline/", import.meta.url);
const manifest = JSON.parse(
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture manifest
  await readFile(new URL("manifest.json", fixtures), "utf8"),
) as { steps: { name: string; fingerprint: string }[] };
const FINGERPRINTS = Object.fromEntries(
  manifest.steps.map((step) => [step.name, step.fingerprint]),
);

let root: string;
let storage: Storage;

// In memory, like save_version: numbered rows and a current pointer.
function memoryVersions(start: VersionRow[] = []) {
  const rows: VersionRow[] = [...start];
  const store: VersionStore = {
    async current() {
      const last = rows.at(-1);
      return last ? { id: last.id, number: last.number } : null;
    },
    async get(id) {
      return rows.find((row) => row.id === id) ?? null;
    },
    async insert(row: NewVersion) {
      const saved = { ...row, number: rows.length + 1 };
      rows.push(saved);
      return saved;
    },
  };
  return { rows, store };
}

function run(store: VersionStore, signal?: AbortSignal) {
  const { steps, calls } = recordingSteps();
  const done = firstVersion({
    ctx: stepContext(steps, signal ? { signal } : {}),
    storage,
    keyPrefix: PREFIX,
    fingerprints: FINGERPRINTS,
    versions: store,
    newId: () => VERSION_ID,
  });
  return { done, calls };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "first-version-"));
  storage = fakeStorage({ root, uploadUrlBase: "" });
  for (const [step, file] of [
    ["retime", "transcript.json"],
    ["head_track", "head-track.json"],
  ] as const) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- committed fixtures
    const bytes = new Uint8Array(await readFile(new URL(`${step}/${file}`, fixtures)));
    await storage.put(cacheKey(PREFIX, step, FINGERPRINTS[step]!, file), bytes);
  }
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("firstVersion", () => {
  it("saves version 1 with the right key, inputs and no model", async () => {
    const { rows, store } = memoryVersions();
    const { done, calls } = run(store);
    await done;
    expect(rows).toHaveLength(1);
    const key = `${PREFIX}reels/${TEST_JOB.reel_id}/versions/${VERSION_ID}.json`;
    expect(rows[0]).toMatchObject({
      id: VERSION_ID,
      reel_id: TEST_JOB.reel_id,
      number: 1,
      parent_id: null,
      restored_from_id: null,
      model: null,
      request: null,
      prompt_version: null,
      change_summary: "automatic first version from the issebya style",
      checks: { ok: true, reasons: [] },
      r2_key: key,
      inputs: {
        footage: FINGERPRINTS.retime,
        transcript: FINGERPRINTS.retime,
        cutout: FINGERPRINTS.remove_background,
        headTrack: FINGERPRINTS.head_track,
      },
    });
    const transcript = JSON.parse(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- committed fixture
      await readFile(new URL("retime/transcript.json", fixtures), "utf8"),
    );
    const edit = parseEdit(new TextDecoder().decode((await storage.get(key))!), {
      transcript,
      preset: ISSEBYA,
    });
    expect(edit.tracks.captions).toHaveLength(transcript.words.length);
    expect(calls.map((call) => call.call)).toEqual(["start", "done"]);
    expect(calls[1]).toMatchObject({
      summary: expect.stringMatching(/^version 1 saved, /),
      measurements: { cpu_ms: null, peak_rss_bytes: null, bytes_in: null, bytes_out: null },
    });
  });

  it("writes nothing on a retry once a version is saved", async () => {
    const { rows, store } = memoryVersions();
    await run(store).done;
    const before = await storage.list(`${PREFIX}reels/`);
    const { done, calls } = run(store);
    await done;
    expect(rows).toHaveLength(1);
    expect(await storage.list(`${PREFIX}reels/`)).toEqual(before);
    expect(calls[1]).toMatchObject({
      summary: expect.stringMatching(/^version 1 already saved, /),
    });
  });

  it("writes nothing after a lost lease", async () => {
    const { rows, store } = memoryVersions();
    const controller = new AbortController();
    controller.abort();
    const { done, calls } = run(store, controller.signal);
    await expect(done).rejects.toThrow();
    expect(rows).toHaveLength(0);
    expect(await storage.list(`${PREFIX}reels/`)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("fails the step when the transcript is missing", async () => {
    await storage.delete(cacheKey(PREFIX, "retime", FINGERPRINTS.retime!, "transcript.json"));
    const { store } = memoryVersions();
    const { done, calls } = run(store);
    await expect(done).rejects.toThrow(/first_version: input missing: .*transcript\.json/);
    expect(calls.map((call) => call.call)).toEqual(["start", "failed"]);
  });
});
