import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ISSEBYA_PRESET,
  type NewVersion,
  type StoredVersion,
  type VersionRows,
  parseEdit,
  transcriptSchema,
} from "@edit-issebya/edit";
import { type Storage, fakeStorage } from "@edit-issebya/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeAiRunner, fakeAiRunner, resultEnvelope } from "../ai.ts";
import { saveFirstVersion } from "../first-version.ts";
import { cacheKey } from "../pipeline/fingerprint.ts";
import { TEST_JOB, recordingSteps, stepContext } from "../recording-steps.ts";
import { storageVersionBlobs } from "../version-store.ts";
import { runDecide } from "./run-decide.ts";

const PREFIX = "dev/";
const FIXTURES = new URL("../../../../fixtures/pipeline/", import.meta.url);
const ANSWER = new URL("./testdata/short-speech-answer.json", import.meta.url);

interface Manifest {
  steps: { name: string; fingerprint: string; files: string[] }[];
}

type Json = Record<string, unknown>;

let root: string;
let scratch: string;
let storage: Storage;
let fingerprints: Record<string, string>;
let rows: Map<string, StoredVersion & NewVersion>;
let current: string | null;
let ids: number;
let firstId: string;
// The committed E2E script: one envelope whose structured_output passes.
let scripted: Json;

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

const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "decide-storage-"));
  scratch = await mkdtemp(join(tmpdir(), "decide-scratch-"));
  storage = fakeStorage({ root, uploadUrlBase: "" });
  const manifest = JSON.parse(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
    await readFile(new URL("manifest.json", FIXTURES), "utf8"),
  ) as Manifest;
  fingerprints = Object.fromEntries(manifest.steps.map((step) => [step.name, step.fingerprint]));
  for (const step of manifest.steps) {
    for (const file of step.files.filter((name) => name.endsWith(".json"))) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
      const bytes = await readFile(new URL(`${step.name}/${file}`, FIXTURES));
      await storage.put(cacheKey(PREFIX, step.name, step.fingerprint, file), new Uint8Array(bytes));
    }
  }
  rows = new Map();
  current = null;
  ids = 0;
  await saveFirstVersion({
    ctx: stepContext(recordingSteps().steps),
    storage,
    rows: memoryRows(),
    blobs: storageVersionBlobs(storage),
    keyPrefix: PREFIX,
    fingerprints,
    newId,
  });
  firstId = current!;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed script
  scripted = JSON.parse(await readFile(ANSWER, "utf8")) as Json;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

// The good answer, changed by `change`.
function answer(change: (answer: Json & { tracks: Record<string, Json[]> }) => void = () => {}) {
  const copy = structuredClone(scripted.structured_output) as Json & {
    tracks: Record<string, Json[]>;
  };
  change(copy);
  return copy;
}

// The title moved so its text runs past the safe box's right edge.
const offSafeBox = () =>
  resultEnvelope(
    answer((a) => {
      const title = a.tracks.overlays!.find((item) => item.id === "title")!;
      title.position = { x: 860, y: 420, align: "left" };
    }),
  );

async function decide(ai: FakeAiRunner) {
  const { steps, calls } = recordingSteps();
  const run = runDecide({
    ctx: stepContext(steps),
    storage,
    rows: memoryRows(),
    blobs: storageVersionBlobs(storage),
    keyPrefix: PREFIX,
    ai,
    scratchDir: scratch,
    newId,
  });
  return { run, calls };
}

function lastCall(calls: ReturnType<typeof recordingSteps>["calls"]) {
  return calls.at(-1)!;
}

describe("runDecide", () => {
  it("passes the committed E2E answer in one round, saving version 2", async () => {
    const ai = fakeAiRunner([scripted]);
    const { run, calls } = await decide(ai);
    await run;
    expect(ai.calls).toHaveLength(1);
    expect(rows.size).toBe(2);
    const v2 = rows.get(current!)!;
    expect(v2).toMatchObject({
      number: 2,
      parent_id: firstId,
      request: null,
      model: "claude-opus-5-5",
      prompt_version: "decide-1",
      change_summary: (scripted.structured_output as Json).change_summary,
      checks: [],
      used_free_field: false,
      unexpressed: [],
      free_field: [],
      rejected_reasons: [],
    });
    const done = lastCall(calls);
    if (done.call !== "done") throw new Error(JSON.stringify(calls));
    expect(done.summary).toMatch(
      /^version 2: 1 accent, 1 transition, title set, 1 word fixed, under a second$/,
    );
    // The schema the AI got is this reel's, and the prompt carries its words.
    expect(JSON.stringify(ai.calls[0]!.schema)).toContain('"w0010"');
    expect(ai.calls[0]!.cwd.startsWith(join(scratch, "decide-"))).toBe(true);

    const transcript = transcriptSchema.parse(
      JSON.parse(
        new TextDecoder().decode(
          (await storage.get(cacheKey(PREFIX, "retime", fingerprints.retime!, "transcript.json")))!,
        ),
      ),
    );
    const stored = JSON.parse(new TextDecoder().decode((await storage.get(v2.r2_key))!));
    const parsed = parseEdit(stored, ISSEBYA_PRESET, transcript);
    expect(parsed.ok).toBe(true);
    expect(stored.inputs).toEqual(rows.get(firstId)!.inputs);
    // The scratch folder is gone.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's temp folder
    expect(await readdir(scratch)).toEqual([]);
  });

  it("retries once with the first answer's reasons, then saves (verification 2)", async () => {
    const ai = fakeAiRunner([offSafeBox(), scripted]);
    const { run } = await decide(ai);
    await run;
    expect(ai.calls).toHaveLength(2);
    expect(ai.calls[1]!.prompt).toMatch(/Your previous answer was refused/);
    expect(ai.calls[1]!.prompt).toMatch(/- safe-box title: /);
    const v2 = rows.get(current!)!;
    // The model is the last one reported (the second round's).
    expect(v2).toMatchObject({
      number: 2,
      parent_id: firstId,
      checks: [],
      model: "claude-opus-5-5",
    });
    expect(v2.rejected_reasons).toHaveLength(1);
    expect(v2.rejected_reasons[0]).toMatch(/^safe-box title: .* runs past the safe box/);
  });

  it("fails after two refused answers and writes nothing (verification 3)", async () => {
    const ai = fakeAiRunner([offSafeBox(), offSafeBox()]);
    const { run, calls } = await decide(ai);
    await expect(run).rejects.toThrow(/the answer failed twice/);
    const failed = lastCall(calls);
    if (failed.call !== "failed") throw new Error(JSON.stringify(calls));
    expect(failed.tail).toMatch(/^decide: the answer failed twice, version 1 stays current\n/);
    expect(failed.tail).toMatch(/round 1:\n- safe-box title: [^\n]*\nround 2:\n- safe-box title: /);
    expect(current).toBe(firstId);
    expect(rows.size).toBe(1);
    expect(await storage.list(`${PREFIX}reels/${TEST_JOB.reel_id}/versions/`)).toHaveLength(1);
  });

  it("retries a broken JSON answer (verification 4)", async () => {
    const ai = fakeAiRunner(["not json", scripted]);
    const { run } = await decide(ai);
    await run;
    expect(ai.calls).toHaveLength(2);
    const v2 = rows.get(current!)!;
    expect(v2.number).toBe(2);
    expect(v2.rejected_reasons.join("\n")).toMatch(/not valid JSON/);
  });

  it("writes the AI usage exactly as reported, summed over two rounds (verification 5)", async () => {
    const withUsage = (input: number, output: number, cost: number, model: string) => ({
      ...resultEnvelope(answer()),
      total_cost_usd: cost,
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 0,
        output_tokens: output,
      },
      modelUsage: { [model]: { outputTokens: output } },
    });
    const one = await decide(fakeAiRunner([withUsage(1200, 456, 0.0123, "claude-x")]));
    await one.run;
    const done = lastCall(one.calls);
    if (done.call !== "done") throw new Error("not done");
    expect(done.measurements).toMatchObject({
      ai_input_tokens: 1500,
      ai_output_tokens: 456,
      ai_cost_usd: 0.0123,
      ai_model: "claude-x",
    });

    const bad = {
      ...offSafeBox(),
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const two = await decide(fakeAiRunner([bad, withUsage(1200, 456, 0.0123, "claude-x")]));
    await two.run;
    const second = lastCall(two.calls);
    if (second.call !== "done") throw new Error("not done");
    expect(second.measurements.ai_input_tokens).toBe(1510);
    expect(second.measurements.ai_output_tokens).toBe(461);
    expect(second.measurements.ai_cost_usd).toBeCloseTo(0.0223, 10);
    expect(second.measurements.ai_model).toBe("claude-x");
  });

  it("records the usage on a failed decide too", async () => {
    const bad = {
      ...offSafeBox(),
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const { run, calls } = await decide(fakeAiRunner([bad, bad]));
    await expect(run).rejects.toThrow();
    const failed = lastCall(calls);
    if (failed.call !== "failed") throw new Error("not failed");
    expect(failed.measurements).toMatchObject({
      ai_input_tokens: 20,
      ai_output_tokens: 10,
      ai_cost_usd: 0.02,
    });
  });

  it("refuses a caption showing a glossary word's heard form", async () => {
    const locking = resultEnvelope(
      answer((a) => {
        a.tracks.captions![2]!.text = "Locking";
      }),
    );
    const ai = fakeAiRunner([locking, scripted]);
    const { run } = await decide(ai);
    await run;
    expect(ai.calls).toHaveLength(2);
    expect(rows.get(current!)!.rejected_reasons).toEqual([
      'glossary cw0003: caption cw0003 shows "Locking": write the glossary term "lock-in"',
    ]);
  });

  it("records the free field's use", async () => {
    const styled = resultEnvelope(
      answer((a) => {
        a.tracks.overlays![1]!.style = { "letter-spacing": "2px" };
        a.free_field = [{ item: "accent-test", reason: "letter spacing" }];
      }),
    );
    const { run } = await decide(fakeAiRunner([styled]));
    await run;
    expect(rows.get(current!)).toMatchObject({
      used_free_field: true,
      free_field: [{ item: "accent-test", reason: "letter spacing" }],
    });
  });

  it("asks at most twice, however many bad answers are scripted", async () => {
    const ai = fakeAiRunner([offSafeBox(), offSafeBox(), offSafeBox()]);
    const { run } = await decide(ai);
    await expect(run).rejects.toThrow();
    expect(ai.calls).toHaveLength(2);
  });

  it("keeps the failure tail within 20 lines when there are many reasons", async () => {
    const many = resultEnvelope(
      answer((a) => {
        for (const caption of a.tracks.captions!)
          caption.position = { x: 860, y: 700, align: "left" };
      }),
    );
    const { run, calls } = await decide(fakeAiRunner([many, many]));
    await expect(run).rejects.toThrow();
    const failed = lastCall(calls);
    if (failed.call !== "failed") throw new Error("not failed");
    const lines = failed.tail.split("\n");
    expect(lines.length).toBeLessThanOrEqual(20);
    expect(lines[0]).toMatch(/^decide: the answer failed twice/);
    expect(failed.tail).toMatch(/- and 3 more\nround 2:/);
  });
});
