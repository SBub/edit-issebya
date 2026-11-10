import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ISSEBYA_PRESET,
  type NewVersion,
  type StoredVersion,
  type Transcript,
  type VersionRows,
  parseEdit,
  transcriptSchema,
} from "@edit-issebya/edit";
import { type Storage, fakeStorage } from "@edit-issebya/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveFirstVersion } from "./first-version.ts";
import {
  type AiRecord,
  type AiRecordCall,
  aiRecordKey,
  writeAiRecord,
} from "./decide/ai-record.ts";
import { answerOfRecord, runRelayout } from "./relayout.ts";
import { PermanentError, findCause, isTransient } from "./failure.ts";
import { cacheKey } from "./pipeline/fingerprint.ts";
import { TEST_JOB, recordingSteps, stepContext } from "./recording-steps.ts";
import { storageVersionBlobs } from "./version-store.ts";
import { toolPaths } from "./pipeline/tools.ts";

const PREFIX = "dev/";
const FIXTURES = new URL("../../../fixtures/pipeline/", import.meta.url);
const ANSWER = new URL("./decide/testdata/short-speech-answer.json", import.meta.url);
const REEL = TEST_JOB.reel_id;

let root: string;
let scratch: string;
let storage: Storage;
let fingerprints: Record<string, string>;
let rows: Map<string, StoredVersion & NewVersion>;
let current: string | null;
let ids: number;
let firstId: string;
let transcript: Transcript;
// The committed script's replies: the hook (role `hook`) and the components.
let replies: { role?: string; answer: unknown }[];

const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;

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

function relayoutRun(fontPair: "retro" | "bold" | "classic" | "script") {
  return runRelayout({
    ctx: stepContext(recordingSteps().steps),
    storage,
    rows: memoryRows(),
    blobs: storageVersionBlobs(storage),
    keyPrefix: PREFIX,
    scratchDir: scratch,
    tools: toolPaths(),
    fontPair,
    newId,
    log: () => {},
  });
}

// The version's AI record as the decide step writes it: the committed hook
// and components calls, each answer as the model's raw text.
async function recordAnswersFor(versionId: string) {
  const hook = replies.find((reply) => reply.role === "hook")!;
  const decide = replies.find((reply) => reply.role !== "hook")!;
  const call = (role: "hook" | "decide", answer: unknown): AiRecordCall =>
    ({
      attempt: 1,
      role,
      model: "test-model",
      prompt: "prompt",
      promptVersion: `${role}@v1`,
      schema: {},
      image: null,
      outputMode: "json",
      answerText: JSON.stringify(answer),
      finishReason: "stop",
    }) as AiRecordCall;
  const record: AiRecord = {
    format: 1,
    reel_id: REEL,
    version_id: versionId,
    prompt_version: "reel-components@v1",
    hook_prompt_version: "reel-hook@v1",
    calls: [call("hook", hook.answer), call("decide", decide.answer)],
  };
  await writeAiRecord(storage, PREFIX, record);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "relayout-storage-"));
  scratch = await mkdtemp(join(tmpdir(), "relayout-scratch-"));
  storage = fakeStorage({ root, uploadUrlBase: "" });
  const manifest = JSON.parse(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
    await readFile(new URL("manifest.json", FIXTURES), "utf8"),
  ) as { steps: { name: string; fingerprint: string; files: string[] }[] };
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
    fontPair: "classic",
    newId,
    log: () => {},
  });
  firstId = current!;
  transcript = transcriptSchema.parse(
    JSON.parse(
      new TextDecoder().decode(
        (await storage.get(cacheKey(PREFIX, "retime", fingerprints.retime!, "transcript.json")))!,
      ),
    ),
  );
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed script
  replies = JSON.parse(await readFile(ANSWER, "utf8")) as { role?: string; answer: unknown }[];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

async function storedEdit(version: StoredVersion) {
  const bytes = await storage.get(version.r2_key);
  return parseEdit(JSON.parse(new TextDecoder().decode(bytes!)), ISSEBYA_PRESET, transcript);
}

describe("runRelayout", () => {
  it("lays version 1 out again in the target pair as version 2 after it, leaving version 1 as it was", async () => {
    await relayoutRun("retro");
    expect(rows.size).toBe(2);
    const second = rows.get(current!)!;
    expect(second).toMatchObject({ number: 2, parent_id: firstId, request: null, model: null });
    expect(second.checks).toEqual([]);
    const parsed = await storedEdit(second);
    expect(parsed.ok && parsed.edit.font_pair).toBe("retro");
    // Version 1 is not rewritten: still the classic pair.
    const first = await storedEdit(rows.get(firstId)!);
    expect(first.ok && first.edit.font_pair).toBe("classic");
  });

  it("re-places the answer the version was decided from: the hook and the accents come back, with the AI record copied under the new id", async () => {
    await recordAnswersFor(firstId);
    await relayoutRun("bold");
    const second = rows.get(current!)!;
    const parsed = await storedEdit(second);
    if (!parsed.ok) throw new Error(parsed.reasons.join("; "));
    expect(parsed.edit.font_pair).toBe("bold");
    const hook = parsed.edit.tracks.overlays.find((item) => item.kind === "hook");
    expect(hook?.text).toBe("A short test for the real studio");
    expect(parsed.edit.tracks.overlays.some((item) => item.kind === "accent")).toBe(true);
    const copied = await storage.get(aiRecordKey(PREFIX, REEL, second.id));
    expect(copied).not.toBeNull();
    const record = JSON.parse(new TextDecoder().decode(copied!)) as AiRecord;
    expect(record.version_id).toBe(second.id);
    expect(record.calls.map((call) => call.role)).toEqual(["hook", "decide"]);
  });

  it("lays a re-laid version out again, from the copied record, in a third pair", async () => {
    await recordAnswersFor(firstId);
    await relayoutRun("bold");
    const second = current!;
    await relayoutRun("retro");
    expect(rows.get(current!)!.number).toBe(3);
    expect(rows.get(current!)!.parent_id).toBe(second);
    const parsed = await storedEdit(rows.get(current!)!);
    expect(parsed.ok && parsed.edit.tracks.overlays.some((item) => item.kind === "hook")).toBe(
      true,
    );
  });

  it("refuses a stored answer that is not JSON, writing no version", async () => {
    await writeAiRecord(storage, PREFIX, {
      format: 1,
      reel_id: REEL,
      version_id: firstId,
      prompt_version: "reel-components@v1",
      hook_prompt_version: "reel-hook@v1",
      calls: [
        {
          attempt: 1,
          role: "decide",
          answerText: "not json",
        } as unknown as AiRecordCall,
      ],
    });
    const failed = await relayoutRun("retro").then(
      () => null,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(Error);
    expect(isTransient(failed)).toBe(false);
    expect(String(findCause(failed, PermanentError)?.message)).toMatch(/is not JSON/);
    expect(rows.size).toBe(1);
  });
});

describe("answerOfRecord", () => {
  const transcriptOf = () => transcript;
  const decide = (answerText: string | null, attempt = 1) =>
    ({ attempt, role: "decide", answerText }) as unknown as AiRecordCall;
  const hook = (text: string) =>
    ({ attempt: 1, role: "hook", answerText: JSON.stringify({ text }) }) as unknown as AiRecordCall;
  const recordOf = (calls: AiRecordCall[]): AiRecord => ({
    format: 1,
    reel_id: REEL,
    version_id: firstId,
    prompt_version: "p",
    hook_prompt_version: "h",
    calls,
  });
  const components = () => replies.find((reply) => reply.role !== "hook")!.answer;

  it("is no answer at all for a version with no AI record (the first version)", () => {
    const answer = answerOfRecord(null, ISSEBYA_PRESET, transcriptOf());
    expect(answer).toEqual({
      accents: [],
      questions: [],
      big_words: [],
      visuals: [],
      lists: [],
      word_fixes: [],
      hook: null,
    });
  });

  it("takes the last decide call that answered, the one the version saved after a refused first try", () => {
    const refused = decide(JSON.stringify({ accents: [] }));
    const saved = decide(JSON.stringify(components()), 2);
    const answer = answerOfRecord(recordOf([refused, saved]), ISSEBYA_PRESET, transcriptOf());
    expect(answer.accents).toEqual((components() as { accents: unknown[] }).accents);
  });

  it("refuses a record with no decide answer", () => {
    expect(() =>
      answerOfRecord(recordOf([hook("A hook")]), ISSEBYA_PRESET, transcriptOf()),
    ).toThrow(/has no decide answer/);
  });

  it("reads the hook text from the last hook call", () => {
    const answer = answerOfRecord(
      recordOf([hook("First"), hook("Second"), decide(JSON.stringify(components()))]),
      ISSEBYA_PRESET,
      transcriptOf(),
    );
    expect(answer.hook).toEqual({ text: "Second" });
  });
});
