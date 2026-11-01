import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NewVersion, VersionRow, VersionStore } from "@edit-issebya/edit";
import { type Storage, cacheKey, fakeStorage } from "@edit-issebya/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AiRunner, type FakeAnswer, fakeAiRunner } from "../ai.ts";
import { TEST_JOB, recordingSteps, stepContext } from "../recording-steps.ts";
import { firstVersion } from "../steps/first-version.ts";
import { decide } from "./decide.ts";

const PREFIX = "dev/";
const V1 = "11111111-2b4f-4c6d-8e0a-1f2b3c4d5e6f";
const V2 = "22222222-2b4f-4c6d-8e0a-1f2b3c4d5e6f";
const VERSIONS = `${PREFIX}reels/${TEST_JOB.reel_id}/versions/`;

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
// The upload E2E's script: an answer that passes every check on this reel.
const [SCRIPTED] = await json<{ output: Answer }[]>(
  new URL("fixtures/decide/short-speech.json", root),
);
const GOOD = SCRIPTED!.output;

interface Answer {
  tracks: Record<string, Record<string, unknown>[]>;
  change_summary: string;
  fixed_words: unknown[];
  unexpressed: string[];
  free_field: { item: string; why: string }[];
}

function variant(change: (answer: Answer) => void): Answer {
  const answer = structuredClone(GOOD);
  change(answer);
  return answer;
}

// Schema-valid, but measured it runs past the safe box's right edge.
const WIDE_TITLE = variant((answer) => {
  const title = answer.tracks.overlays!.find((overlay) => overlay.id === "title")!;
  title.text = "a title much too long for one line";
  title.style = { position: { x: 140, y: 270 } };
});
const WIDE_REASON = "title: outside the safe box (right)";

// In memory, like save_version: numbered rows, a current pointer, and a
// refused parent that is no longer current.
function memoryVersions() {
  const rows: VersionRow[] = [];
  let current: string | null = null;
  const store: VersionStore = {
    async current() {
      const row = rows.find((candidate) => candidate.id === current);
      return row ? { id: row.id, number: row.number } : null;
    },
    async get(id) {
      return rows.find((row) => row.id === id) ?? null;
    },
    async insert(row: NewVersion) {
      if (row.parent_id !== current) throw new Error("parent is not the current version");
      const saved = { ...row, number: rows.length + 1 };
      rows.push(saved);
      current = saved.id;
      return saved;
    },
  };
  return { rows, store, currentId: () => current };
}

let storage: Storage;
let storageRoot: string;
let scratch: string;
let versions: ReturnType<typeof memoryVersions>;

beforeEach(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), "decide-storage-"));
  scratch = await mkdtemp(join(tmpdir(), "decide-scratch-"));
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
  await firstVersion({
    ctx: stepContext(recordingSteps().steps),
    storage,
    keyPrefix: PREFIX,
    fingerprints: FINGERPRINTS,
    versions: versions.store,
    newId: () => V1,
  });
});

afterEach(async () => {
  await rm(storageRoot, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

function run(ai: AiRunner, signal?: AbortSignal) {
  const { steps, calls } = recordingSteps();
  const done = decide({
    ctx: stepContext(steps, signal ? { signal } : {}),
    storage,
    keyPrefix: PREFIX,
    scratchDir: scratch,
    fingerprints: FINGERPRINTS,
    versions: versions.store,
    ai,
    newId: () => V2,
  });
  return { done, calls };
}

function doneCall(calls: ReturnType<typeof recordingSteps>["calls"]) {
  const done = calls.find((call) => call.call === "done");
  if (done?.call !== "done") throw new Error(`no done call: ${JSON.stringify(calls)}`);
  return done;
}

function failedCall(calls: ReturnType<typeof recordingSteps>["calls"]) {
  const failed = calls.find((call) => call.call === "failed");
  if (failed?.call !== "failed") throw new Error(`no failed call: ${JSON.stringify(calls)}`);
  return failed;
}

const answer = (output: unknown): FakeAnswer => ({ output });

describe("decide", () => {
  it("retries once with the reasons and saves version 2 from version 1", async () => {
    const ai = fakeAiRunner([
      answer(WIDE_TITLE),
      { output: GOOD, usage: { model: "claude-test" } },
    ]);
    const { done, calls } = run(ai);
    await done;
    expect(ai.prompts).toHaveLength(2);
    expect(ai.prompts[1]).toContain("## Your previous answer failed these checks");
    expect(ai.prompts[1]).toContain(WIDE_REASON);
    expect(versions.rows).toHaveLength(2);
    const [v1, v2] = versions.rows;
    expect(v2).toMatchObject({
      id: V2,
      number: 2,
      parent_id: V1,
      restored_from_id: null,
      request: null,
      model: "claude-test",
      prompt_version: "decide-1",
      change_summary: GOOD.change_summary,
      checks: { ok: true, reasons: [] },
      inputs: v1!.inputs,
      used_free_field: false,
      free_field: [],
      unexpressed: [],
      r2_key: `${VERSIONS}${V2}.json`,
    });
    expect(versions.currentId()).toBe(V2);
    expect(await storage.get(v2!.r2_key)).not.toBeNull();
    expect(doneCall(calls).summary).toMatch(
      /^decided: 1 accent, 1 transition, title set, 1 word fixed, retried once, /,
    );
  });

  it("asks once when the first answer passes", async () => {
    const ai = fakeAiRunner([answer(GOOD)]);
    const { done, calls } = run(ai);
    await done;
    expect(ai.prompts).toHaveLength(1);
    expect(doneCall(calls).summary).toMatch(
      /^decided: 1 accent, 1 transition, title set, 1 word fixed, under a second$/,
    );
  });

  it("fails with both rounds in the tail and changes nothing after two refusals", async () => {
    const glossary = variant((a) => (a.tracks.captions![0]!.text = "Locking"));
    const ai = fakeAiRunner([answer(WIDE_TITLE), answer(glossary)]);
    const { done, calls } = run(ai);
    await expect(done).rejects.toThrow(/^decide failed twice/);
    expect(ai.prompts).toHaveLength(2);
    const failed = failedCall(calls);
    expect(failed.tail).toBe(
      `decide failed twice\nround 1: ${WIDE_REASON}\nround 2: c-w0001: glossary: "Locking" should be "lock-in"`,
    );
    expect(versions.rows).toHaveLength(1);
    expect(versions.currentId()).toBe(V1);
    expect(await storage.list(VERSIONS)).toEqual([`${VERSIONS}${V1}.json`]);
  });

  it("caps each round's reasons so both rounds fit the tail", async () => {
    const many = variant((a) => {
      for (const caption of a.tracks.captions!) caption.style = { position: { x: 850, y: 1300 } };
    });
    const { done, calls } = run(fakeAiRunner([answer(many)]));
    await expect(done).rejects.toThrow();
    const lines = failedCall(calls).tail.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^round 1: .*; and 2 more$/);
    expect(lines[2]).toMatch(/^round 2: .*; and 2 more$/);
  });

  it("retries an answer that is not JSON", async () => {
    const ai = fakeAiRunner([{ stdout: "not json" }, answer(GOOD)]);
    const { done } = run(ai);
    await done;
    expect(ai.prompts).toHaveLength(2);
    expect(ai.prompts[1]).toContain("answer: claude's result is not JSON");
    expect(versions.rows).toHaveLength(2);
  });

  it("fails at once, without a retry, on an error result", async () => {
    const ai = fakeAiRunner([{ stdout: JSON.stringify({ is_error: true, result: "quota" }) }]);
    const { done, calls } = run(ai);
    await expect(done).rejects.toThrow(/quota/);
    expect(ai.prompts).toHaveLength(1);
    expect(failedCall(calls).summary).toMatch(/^decide failed, /);
    expect(versions.rows).toHaveLength(1);
  });

  it("stores the reported usage exactly, and sums two calls", async () => {
    const usage = { inputTokens: 1234, outputTokens: 567, costUsd: 0.0123, model: "claude-test" };
    const once = run(fakeAiRunner([{ output: GOOD, usage }]));
    await once.done;
    expect(doneCall(once.calls).ai).toEqual(usage);

    // Another reel state: version 1 current again.
    versions = memoryVersions();
    await firstVersion({
      ctx: stepContext(recordingSteps().steps),
      storage,
      keyPrefix: PREFIX,
      fingerprints: FINGERPRINTS,
      versions: versions.store,
      newId: () => "33333333-2b4f-4c6d-8e0a-1f2b3c4d5e6f",
    });
    const twice = recordingSteps();
    await decide({
      ctx: stepContext(twice.steps),
      storage,
      keyPrefix: PREFIX,
      scratchDir: scratch,
      fingerprints: FINGERPRINTS,
      versions: versions.store,
      ai: fakeAiRunner([
        {
          output: WIDE_TITLE,
          usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.25, model: "claude-a" },
        },
        {
          output: GOOD,
          usage: { inputTokens: 234, outputTokens: 67, costUsd: 0.5, model: "claude-b" },
        },
      ]),
      newId: () => "44444444-2b4f-4c6d-8e0a-1f2b3c4d5e6f",
    });
    expect(doneCall(twice.calls).ai).toEqual({
      inputTokens: 1234,
      outputTokens: 567,
      costUsd: 0.75,
      model: "claude-b",
    });
  });

  it("stores the usage on a failed step too", async () => {
    const usage = { inputTokens: 10, outputTokens: 5, costUsd: 0.25, model: "claude-test" };
    const { done, calls } = run(fakeAiRunner([{ output: WIDE_TITLE, usage }]));
    await expect(done).rejects.toThrow();
    expect(failedCall(calls).ai).toEqual({
      ...usage,
      inputTokens: 20,
      outputTokens: 10,
      costUsd: 0.5,
    });
  });

  it("does not decide a reel whose current version came from the AI", async () => {
    await run(fakeAiRunner([answer(GOOD)])).done;
    const ai = fakeAiRunner([answer(GOOD)]);
    const { done, calls } = run(ai);
    await done;
    expect(ai.prompts).toHaveLength(0);
    expect(versions.rows).toHaveLength(2);
    expect(doneCall(calls).summary).toMatch(/^version 2 already decided, /);
  });

  it("writes nothing when the lease is lost during the call", async () => {
    const controller = new AbortController();
    const fake = fakeAiRunner([answer(GOOD)]);
    const ai: AiRunner = {
      async runJson(call) {
        const result = await fake.runJson(call);
        controller.abort();
        return result;
      },
    };
    const { done, calls } = run(ai, controller.signal);
    await expect(done).rejects.toThrow();
    expect(versions.rows).toHaveLength(1);
    expect(await storage.list(VERSIONS)).toEqual([`${VERSIONS}${V1}.json`]);
    expect(calls.map((call) => call.call)).toEqual(["start"]);
  });

  it("records the free field and what could not be expressed", async () => {
    const styled = variant((a) => {
      a.tracks.captions![0]!.custom = "letter-spacing: 2px";
      a.free_field = [{ item: "c-w0001", why: "a little more air" }];
      a.unexpressed = ["a slow zoom on the last word"];
    });
    await run(fakeAiRunner([answer(styled)])).done;
    expect(versions.rows[1]).toMatchObject({
      used_free_field: true,
      free_field: [{ item: "c-w0001", why: "a little more air" }],
      unexpressed: ["a slow zoom on the last word"],
    });
  });

  it("works in the job's scratch folder and removes it", async () => {
    const cwds: (string | undefined)[] = [];
    const fake = fakeAiRunner([answer(GOOD)]);
    await run({
      runJson(call) {
        cwds.push(call.cwd);
        return fake.runJson(call);
      },
    }).done;
    expect(cwds).toEqual([join(scratch, `job-${TEST_JOB.id}`, "decide")]);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's own scratch folder
    expect(await readdir(join(scratch, `job-${TEST_JOB.id}`))).toEqual([]);
  });
});
