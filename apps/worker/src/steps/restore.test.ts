import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Storage, cacheKey, fakeStorage } from "@edit-issebya/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAiRunner } from "../ai.ts";
import { decide } from "../decide/decide.ts";
import { memoryVersions } from "../memory-versions.ts";
import { TEST_JOB, recordingSteps, stepContext } from "../recording-steps.ts";
import { firstVersion } from "./first-version.ts";
import { restore } from "./restore.ts";

const PREFIX = "dev/";
const V1 = "11111111-2b4f-4c6d-8e0a-1f2b3c4d5e6f";
const V2 = "22222222-2b4f-4c6d-8e0a-1f2b3c4d5e6f";
const V3 = "33333333-2b4f-4c6d-8e0a-1f2b3c4d5e6f";
const V4 = "44444444-2b4f-4c6d-8e0a-1f2b3c4d5e6f";
const OTHER_REEL = "9a9a9a9a-0d3b-4a7e-8c6f-2b9d4e1a7c30";

const root = new URL("../../../../", import.meta.url);
const fixtures = new URL("fixtures/pipeline/", root);

async function json<T>(url: URL): Promise<T> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- committed fixtures
  return JSON.parse(await readFile(url, "utf8")) as T;
}

const manifest = await json<{ steps: { name: string; fingerprint: string }[] }>(
  new URL("manifest.json", fixtures),
);
const FINGERPRINTS = Object.fromEntries(
  manifest.steps.map((step) => [step.name, step.fingerprint]),
);
const [FIRST] = await json<{ output: unknown }[]>(
  new URL("fixtures/decide/short-speech.json", root),
);
const [CHANGED] = await json<{ output: unknown }[]>(
  new URL("fixtures/decide/change-request.json", root),
);

let storage: Storage;
let storageRoot: string;
let scratch: string;
let versions: ReturnType<typeof memoryVersions>;

// Versions 1 (preset), 2 (AI) and 3 (a change request), 3 current.
beforeEach(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), "restore-storage-"));
  scratch = await mkdtemp(join(tmpdir(), "restore-scratch-"));
  storage = fakeStorage({ root: storageRoot, uploadUrlBase: "" });
  for (const [step, file] of [
    ["retime", "transcript.json"],
    ["retime", "retime.json"],
    ["head_track", "head-track.json"],
  ] as const) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- committed fixtures
    const bytes = new Uint8Array(await readFile(new URL(`${step}/${file}`, fixtures)));
    await storage.put(cacheKey(PREFIX, step, FINGERPRINTS[step]!, file), bytes);
  }
  versions = memoryVersions();
  const ctx = stepContext(recordingSteps().steps);
  const base = { ctx, storage, keyPrefix: PREFIX, fingerprints: FINGERPRINTS };
  const store = versions.store;
  await firstVersion({ ...base, versions: store, newId: () => V1 });
  const ai = (answer: { output: unknown }) => fakeAiRunner([answer]);
  await decide({ ...base, scratchDir: scratch, versions: store, ai: ai(FIRST!), newId: () => V2 });
  await decide({
    ...base,
    scratchDir: scratch,
    versions: store,
    ai: ai(CHANGED!),
    request: "fewer accents",
    newId: () => V3,
  });
});

afterEach(async () => {
  await rm(storageRoot, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

function run(fromId: string | null, signal?: AbortSignal) {
  const { steps, calls } = recordingSteps();
  const job = { ...TEST_JOB, kind: "restore", restore_version_id: fromId };
  const done = restore({
    ctx: stepContext(steps, { job, ...(signal ? { signal } : {}) }),
    storage,
    keyPrefix: PREFIX,
    versions: versions.store,
    fromId,
    newId: () => V4,
  });
  return { done, calls };
}

describe("restore", () => {
  it("copies an old version's bytes into a new current version and never touches the old one", async () => {
    const before = structuredClone(versions.rows);
    const v1Bytes = await storage.get(before[0]!.r2_key);
    const { done, calls } = run(V1);
    await done;
    expect(versions.rows).toHaveLength(4);
    expect(versions.rows.slice(0, 3)).toEqual(before);
    const v4 = versions.rows[3]!;
    expect(v4).toMatchObject({
      id: V4,
      number: 4,
      restored_from_id: V1,
      parent_id: V3,
      request: null,
      change_summary: "restored version 1",
    });
    expect(versions.currentId()).toBe(V4);
    expect(await storage.get(v4.r2_key)).toEqual(v1Bytes);
    expect(await storage.get(before[0]!.r2_key)).toEqual(v1Bytes);
    expect(calls.flatMap((call) => (call.call === "start" ? [call.name] : []))).toEqual([
      "restore",
    ]);
    const finished = calls.find((call) => call.call === "done");
    expect(finished?.call === "done" && finished.summary).toMatch(
      /^restored version 1 as version 4, /,
    );
  });

  it("fails on a version of another reel", async () => {
    const other = versions.rows[0]!;
    versions.rows[0] = { ...other, reel_id: OTHER_REEL };
    const { done } = run(V1);
    await expect(done).rejects.toThrow(/^no version /);
    expect(versions.rows).toHaveLength(3);
    expect(versions.currentId()).toBe(V3);
  });

  it("writes nothing once the lease is lost", async () => {
    const lost = new AbortController();
    lost.abort(new Error("lease lost"));
    const { done } = run(V1, lost.signal);
    await expect(done).rejects.toThrow();
    expect(versions.rows).toHaveLength(3);
    expect(await storage.get(`${PREFIX}reels/${TEST_JOB.reel_id}/versions/${V4}.json`)).toBeNull();
  });
});
