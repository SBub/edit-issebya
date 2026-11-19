import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
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
import { type OwnerEdit, runOwnerEdit } from "./owner-edit.ts";
import { answerOfRecord, runRelayout } from "./relayout.ts";
import { runRestore } from "./restore-step.ts";
import { PermanentError, findCause, isTransient } from "./failure.ts";
import { cacheKey } from "./pipeline/fingerprint.ts";
import { TEST_JOB, recordingSteps, stepContext } from "./recording-steps.ts";
import { storageVersionBlobs } from "./version-store.ts";
import { toolPaths } from "./pipeline/tools.ts";
import { createTelemetry } from "./telemetry.ts";

const PREFIX = "dev/";
const FIXTURES = new URL("../../../fixtures/pipeline/", import.meta.url);
const ANSWER = new URL("./decide/testdata/short-speech-answer.json", import.meta.url);
const REEL = TEST_JOB.reel_id;
// A ready library photo of the owner's, as the worker reads it (16:9).
const PHOTO = {
  id: "8b0c2d7e-4b8f-4a51-9f0c-2d1e3f4a5b6c",
  description: "a bright kitchen with a laptop on the table",
  tags: ["kitchen", "laptop"],
  large_key: "dev/library/kitchen/large.jpg",
  width: 1600,
  height: 900,
};

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

// A font pair change on a version that shows library photos: a picture does
// not depend on the font, so the owner's photos stay.
describe("runRelayout with the owner's library photos", () => {
  const deps = () => ({
    ctx: stepContext(recordingSteps().steps),
    storage,
    rows: memoryRows(),
    blobs: storageVersionBlobs(storage),
    keyPrefix: PREFIX,
    scratchDir: scratch,
    tools: toolPaths(),
    newId,
  });
  const ownerEditRun = (ownerEdit: OwnerEdit) =>
    runOwnerEdit({
      ...deps(),
      ownerEdit,
      photos: {
        async readyPhotos(_owner, photoIds) {
          return new Map(photoIds.includes(PHOTO.id) ? [[PHOTO.id, PHOTO]] : []);
        },
      },
    });
  const editOf = async (id: string) => {
    const parsed = await storedEdit(rows.get(id)!);
    if (!parsed.ok) throw new Error(parsed.reasons.join("; "));
    return parsed.edit;
  };
  const visualOf = async (versionId: string, id: string) => {
    const item = (await editOf(versionId)).tracks.behind?.find((entry) => entry.id === id);
    if (item?.kind !== "visual") throw new Error(`no visual ${id} in ${versionId}`);
    return item;
  };

  // Version 2: the committed hook and one VISUAL over the sentence, placed by
  // the engine in the classic pair (the card shows a stand-in).
  async function placeVisualVersion(): Promise<string> {
    const hook = replies.find((reply) => reply.role === "hook")!;
    const decide = replies.find((reply) => reply.role !== "hook")!;
    const call = (role: "hook" | "decide", answer: unknown) =>
      ({ attempt: 1, role, answerText: JSON.stringify(answer) }) as unknown as AiRecordCall;
    await writeAiRecord(storage, PREFIX, {
      format: 1,
      reel_id: REEL,
      version_id: firstId,
      prompt_version: "reel-components@v1",
      hook_prompt_version: "reel-hook@v1",
      calls: [
        call("hook", hook.answer),
        call("decide", {
          ...(decide.answer as Record<string, unknown>),
          accents: [],
          lists: [],
          visuals: [{ from: "w0001", to: "w0010", description: "a messy desk at night" }],
        }),
      ],
    });
    await relayoutRun("classic");
    return current!;
  }

  // The engine's card of `versionId` swapped for the library photo, in place.
  async function swapPicture(versionId: string): Promise<string> {
    const card = await visualOf(versionId, "visual-1");
    await ownerEditRun({
      versionId,
      moves: [
        {
          id: card.id,
          kind: "box",
          x: card.box.x,
          y: card.box.y,
          width: card.box.width,
          photo_id: PHOTO.id,
        },
      ],
    });
    return current!;
  }

  it("places a card the owner gave a library photo again with that photo, at the photo's aspect", async () => {
    const swapped = await swapPicture(await placeVisualVersion());
    expect((await editOf(swapped)).inputs.photos).toEqual([PHOTO.id]);

    await relayoutRun("bold");

    const saved = rows.get(current!)!;
    expect(saved).toMatchObject({ number: 4, parent_id: swapped });
    expect(saved.inputs.photos).toEqual([PHOTO.id]);
    const edit = await editOf(saved.id);
    expect(edit.font_pair).toBe("bold");
    expect(edit.inputs.photos).toEqual([PHOTO.id]);
    const card = await visualOf(saved.id, "visual-1");
    expect(card.photo).toEqual({ id: PHOTO.id, width: 1600, height: 900 });
    expect("image" in card).toBe(false);
    expect(card.description).toBe("a messy desk at night");
    // The engine placed it for the photo, not for the stand-in it replaced.
    expect(Math.abs(card.box.height - (card.box.width * 900) / 1600)).toBeLessThanOrEqual(1);
    expect(saved.checks).toEqual([]);
    // The version it was laid out from still shows the photo too.
    expect((await visualOf(swapped, "visual-1")).photo?.id).toBe(PHOTO.id);
  });

  it("keeps the photo through a second font pair change", async () => {
    await swapPicture(await placeVisualVersion());
    await relayoutRun("bold");
    await relayoutRun("retro");
    const edit = await editOf(current!);
    expect(edit.font_pair).toBe("retro");
    expect(edit.inputs.photos).toEqual([PHOTO.id]);
    expect((await visualOf(current!, "visual-1")).photo?.id).toBe(PHOTO.id);
  });

  it("keeps a card the owner added as it was, on top of the engine's cards, with its click", async () => {
    const withVisual = await placeVisualVersion();
    await ownerEditRun({
      versionId: withVisual,
      moves: [],
      adds: [
        { id: "owner-visual-1", photo_id: PHOTO.id, word: "w0004", x: 600, y: 300, width: 360 },
      ],
    });
    const added = await visualOf(current!, "owner-visual-1");

    await relayoutRun("script");

    const edit = await editOf(current!);
    expect(edit.font_pair).toBe("script");
    expect(edit.tracks.behind!.map((item) => item.id)).toEqual(["visual-1", "owner-visual-1"]);
    expect(await visualOf(current!, "owner-visual-1")).toEqual(added);
    // The engine's own card keeps its stand-in: only the added card has a photo.
    expect((await visualOf(current!, "visual-1")).image).toBeDefined();
    expect(edit.inputs.photos).toEqual([PHOTO.id]);
    expect(edit.tracks.sounds.map((sound) => sound.id)).toContain("click-owner-visual-1");
  });

  it("names no photo when the version shows none: a stale name in the inputs is not carried", async () => {
    const withVisual = await placeVisualVersion();
    await relayoutRun("bold");
    const edit = await editOf(current!);
    expect(edit.inputs.photos).toBeUndefined();
    expect((await visualOf(current!, "visual-1")).image).toBeDefined();
    expect(rows.get(current!)!.parent_id).toBe(withVisual);
  });

  it("finds the answer of a version the owner went back to, so its texts and its photo stay", async () => {
    const swapped = await swapPicture(await placeVisualVersion());
    // Another version on top, then back to the one with the photo: a going
    // back copies the bytes and has no AI record of its own.
    await relayoutRun("retro");
    await runRestore({ ...deps(), versionId: swapped });
    const restored = current!;
    expect(await storage.get(aiRecordKey(PREFIX, REEL, restored))).toBeNull();

    await relayoutRun("bold");

    const saved = rows.get(current!)!;
    expect(saved.parent_id).toBe(restored);
    const edit = await editOf(saved.id);
    expect(edit.font_pair).toBe("bold");
    expect(edit.tracks.overlays.some((item) => item.kind === "hook")).toBe(true);
    expect((await visualOf(saved.id, "visual-1")).photo?.id).toBe(PHOTO.id);
    expect(edit.inputs.photos).toEqual([PHOTO.id]);
    // The record is copied under the new version, so the next one finds it there.
    expect(await storage.get(aiRecordKey(PREFIX, REEL, saved.id))).not.toBeNull();
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

// The job's span tree and its failure record: the stages are children of the
// step span, and a refused answer is one ERROR record of the relayout step.
describe("runRelayout spans and failures", () => {
  it("nests load, engine and save under the step span, with the job's pair and the stage counts", async () => {
    await recordAnswersFor(firstId);
    const spans = new InMemorySpanExporter();
    const telemetry = createTelemetry(
      {},
      { spanProcessors: [new SimpleSpanProcessor({ exporter: spans })] },
    );
    await runRelayout({
      ctx: stepContext(recordingSteps().steps, { telemetry }),
      storage,
      rows: memoryRows(),
      blobs: storageVersionBlobs(storage),
      keyPrefix: PREFIX,
      scratchDir: scratch,
      tools: toolPaths(),
      fontPair: "bold",
      newId,
      log: () => {},
    });
    const finished = spans.getFinishedSpans();
    const byName = (name: string) => finished.find((span) => span.name === name);
    const step = byName("step relayout");
    expect(step?.attributes["relayout.font_pair"]).toBe("bold");
    for (const name of ["relayout.load", "relayout.engine", "relayout.save_version"]) {
      expect(byName(name)?.parentSpanContext?.spanId).toBe(step?.spanContext().spanId);
    }
    expect(byName("relayout.load")?.attributes).toMatchObject({
      "relayout.version": 1,
      "relayout.ai_record": true,
      "relayout.ai_calls": 2,
      "relayout.inputs": "footage=retime,transcript=retime,head_track=head_track",
    });
    expect(byName("relayout.engine")?.attributes).toMatchObject({
      "relayout.font_pair": "bold",
      "relayout.from_version_id": firstId,
    });
    expect(byName("relayout.engine")?.attributes["relayout.picks_placed"]).toBeGreaterThan(0);
    expect(byName("relayout.engine")?.attributes["relayout.checks"]).toBe(0);
    await telemetry.shutdown();
  });

  it("logs a refused stored answer as one ERROR record of the relayout step, with the job id", async () => {
    await writeAiRecord(storage, PREFIX, {
      format: 1,
      reel_id: REEL,
      version_id: firstId,
      prompt_version: "reel-components@v1",
      hook_prompt_version: "reel-hook@v1",
      calls: [{ attempt: 1, role: "decide", answerText: "not json" } as unknown as AiRecordCall],
    });
    const logs = new InMemoryLogRecordExporter();
    const telemetry = createTelemetry(
      {},
      { logProcessors: [new SimpleLogRecordProcessor({ exporter: logs })] },
    );
    const failed = await runRelayout({
      ctx: stepContext(recordingSteps().steps, { telemetry }),
      storage,
      rows: memoryRows(),
      blobs: storageVersionBlobs(storage),
      keyPrefix: PREFIX,
      scratchDir: scratch,
      tools: toolPaths(),
      fontPair: "retro",
      newId,
      log: () => {},
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(Error);
    const records = logs.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.severityNumber).toBe(SeverityNumber.ERROR);
    expect(record?.body).toMatch(/^relayout failed: /);
    expect(record?.attributes).toMatchObject({
      "job.id": TEST_JOB.id,
      "step.name": "relayout",
      "reel.id": REEL,
    });
    await telemetry.shutdown();
  });
});
