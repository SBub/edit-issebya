import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Storage, cacheKey, fakeStorage } from "@edit-issebya/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AiRunner, fakeAiRunner } from "./ai.ts";
import { changeJob } from "./change-job.ts";
import { decide } from "./decide/decide.ts";
import { memoryVersions } from "./memory-versions.ts";
import { TEST_JOB, recordingSteps, stepContext } from "./recording-steps.ts";
import { firstVersion } from "./steps/first-version.ts";

const PREFIX = "dev/";
const V1 = "11111111-2b4f-4c6d-8e0a-1f2b3c4d5e6f";
const V2 = "22222222-2b4f-4c6d-8e0a-1f2b3c4d5e6f";
const V3 = "33333333-2b4f-4c6d-8e0a-1f2b3c4d5e6f";
const VERSIONS = `${PREFIX}reels/${TEST_JOB.reel_id}/versions/`;
const REQUEST = "no accent on 'work'";
const CHANGE_JOB = { ...TEST_JOB, kind: "change", request: REQUEST };

const root = new URL("../../../", import.meta.url);
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
const [CHANGED] = await json<{ output: { change_summary: string } }[]>(
  new URL("fixtures/decide/change-request.json", root),
);
const BROKEN = await json<{ output: unknown }[]>(new URL("fixtures/decide/fail-twice.json", root));

let storage: Storage;
let storageRoot: string;
let scratch: string;
let versions: ReturnType<typeof memoryVersions>;

// Version 1 from the preset, version 2 from the AI: a processed reel.
beforeEach(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), "change-storage-"));
  scratch = await mkdtemp(join(tmpdir(), "change-scratch-"));
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
  await firstVersion({ ...base, versions: versions.store, newId: () => V1 });
  await decide({
    ...base,
    scratchDir: scratch,
    versions: versions.store,
    ai: fakeAiRunner([FIRST!]),
    newId: () => V2,
  });
});

afterEach(async () => {
  await rm(storageRoot, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

function run(ai: AiRunner, request: string | null = REQUEST) {
  const { steps, calls } = recordingSteps();
  const done = changeJob({
    ctx: stepContext(steps, { job: { ...CHANGE_JOB, request } }),
    storage,
    keyPrefix: PREFIX,
    scratchDir: scratch,
    versions: versions.store,
    request,
    ai,
    newId: () => V3,
  });
  const started = () => calls.flatMap((call) => (call.call === "start" ? [call.name] : []));
  return { done, calls, started };
}

describe("changeJob", () => {
  it("runs only decide, with the request, and saves the next version from the current one", async () => {
    const ai = fakeAiRunner([CHANGED!]);
    const { done, started } = run(ai);
    await done;
    expect(started()).toEqual(["decide"]);
    expect(ai.prompts).toHaveLength(1);
    expect(ai.prompts[0]).toContain(REQUEST);
    expect(versions.rows).toHaveLength(3);
    expect(versions.rows[2]).toMatchObject({
      id: V3,
      number: 3,
      parent_id: V2,
      request: REQUEST,
      change_summary: CHANGED!.output.change_summary,
      inputs: versions.rows[1]!.inputs,
    });
    expect(versions.currentId()).toBe(V3);
  });

  it("saves nothing and keeps the current version after a double failure", async () => {
    const ai = fakeAiRunner(BROKEN);
    const { done, started, calls } = run(ai);
    await expect(done).rejects.toThrow(/^decide failed twice/);
    expect(started()).toEqual(["decide"]);
    expect(ai.prompts).toHaveLength(2);
    const failed = calls.find((call) => call.call === "failed");
    expect(failed?.call === "failed" && failed.tail).toMatch(/\nround 1: .+\nround 2: .+$/);
    expect(versions.rows).toHaveLength(2);
    expect(versions.currentId()).toBe(V2);
    expect(await storage.list(VERSIONS)).toEqual(
      [`${VERSIONS}${V1}.json`, `${VERSIONS}${V2}.json`].sort(),
    );
  });

  it("fails without a step when the reel has no current version", async () => {
    versions = memoryVersions();
    const { done, calls } = run(fakeAiRunner([CHANGED!]));
    await expect(done).rejects.toThrow("change: no current version");
    expect(calls).toEqual([]);
  });

  it("fails without a step when the job has no request", async () => {
    const { done, calls } = run(fakeAiRunner([CHANGED!]), "   ");
    await expect(done).rejects.toThrow("change: job has no request");
    expect(calls).toEqual([]);
  });
});
