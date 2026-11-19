import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Edit,
  ISSEBYA_PRESET,
  type NewVersion,
  type StoredCorrection,
  type StoredVersion,
  type VersionRows,
  captionBlocks,
  parseEdit,
  transcriptSchema,
  type FontPairId,
} from "@edit-issebya/edit";
import { type Storage, fakeStorage } from "@edit-issebya/storage";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AI_MODEL,
  type AiRunner,
  type FakeAiRunner,
  type ScriptedReply,
  fakeAiRunner,
} from "../ai.ts";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import {
  AiUnavailable,
  AnswerRefused,
  PermanentError,
  findCause,
  isTransient,
} from "../failure.ts";
import { type Telemetry, createTelemetry } from "../telemetry.ts";
import { saveFirstVersion } from "../first-version.ts";
import { cacheKey } from "../pipeline/fingerprint.ts";
import { FROZEN_CLOCK, TEST_JOB, recordingSteps, stepContext } from "../recording-steps.ts";
import { storageVersionBlobs } from "../version-store.ts";
import { runOwnerEdit } from "../owner-edit.ts";
import { toolPaths } from "../pipeline/tools.ts";
import { BEHIND_TRANSCRIPT, behindEdit, fakeMaskSpawn } from "../cutout/test-support.ts";
import type { SpawnTool } from "../step-runner.ts";
import { fakePromptSource } from "../../test-support/fake-prompts.ts";
import { type PromptSource, PromptUnavailable } from "../prompts/source.ts";
import { runDecide } from "./run-decide.ts";
import { aiRecordKey } from "./ai-record.ts";

const PREFIX = "dev/";
const FIXTURES = new URL("../../../../fixtures/pipeline/", import.meta.url);
const ANSWER = new URL("./testdata/short-speech-answer.json", import.meta.url);
// The 47 s reel's head track, in the packages/edit fixtures (see useLongReel).
const LONG_HEAD_TRACK = new URL(
  "../../../../packages/edit/src/testdata/rethink-work/head-track.json",
  import.meta.url,
);

interface Manifest {
  steps: { name: string; fingerprint: string; files: string[] }[];
}

type Json = Record<string, unknown>;
// A scripted reply carrying an answer, for the double.
interface Answered {
  answer: unknown;
  usage?: { input_tokens?: number; output_tokens?: number; cost_usd?: number };
  model?: string;
}
const answered = (answer: unknown): Answered => ({ answer });

let root: string;
let scratch: string;
let storage: Storage;
let fingerprints: Record<string, string>;
let rows: Map<string, StoredVersion & NewVersion>;
let current: string | null;
let ids: number;
let firstId: string;
// The committed E2E script: the decide reply whose answer passes.
let scripted: Answered & { answer: Json };
// The committed hook reply (role `hook`), the text the reel opens with.
let hookReply: { role: "hook"; answer: { text: string } };
const HOOK_TEXT = "A short test for the real studio";

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
    fontPair: "classic",
    newId,
    log: () => {},
  });
  firstId = current!;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed script
  const replies = JSON.parse(await readFile(ANSWER, "utf8")) as (Answered & { role?: string })[];
  const hook = replies.find((reply) => reply.role === "hook") as unknown as typeof hookReply;
  const decide = replies.find((reply) => reply.role !== "hook");
  if (!hook || !decide) throw new Error("the committed script names a hook and a decide reply");
  hookReply = hook;
  scripted = decide as Answered & { answer: Json };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

type Answer = Json & { word_fixes: Json[]; visuals: Json[] };

// The good answer, changed by `change`.
function answer(change: (answer: Answer) => void = () => {}) {
  const copy = structuredClone(scripted.answer) as Answer;
  change(copy);
  return copy;
}

// A word fixed twice: the decide schema refuses it (`answer-schema`), so the
// answer goes back once with the reason.
const fixedTwice = () =>
  answered(
    answer((a) => {
      a.word_fixes = [
        { word: "w0003", text: "Studio" },
        { word: "w0003", text: "Stadium" },
      ];
    }),
  );

async function decide(
  ai: AiRunner,
  telemetry?: Telemetry,
  prompts: PromptSource = fakePromptSource(),
  ownerPair: () => Promise<FontPairId> = CLASSIC_PAIR,
) {
  const { steps, calls } = recordingSteps();
  const run = runDecide({
    ctx: stepContext(steps, { ...(telemetry ? { telemetry } : {}), clock: FROZEN_CLOCK }),
    storage,
    rows: memoryRows(),
    blobs: storageVersionBlobs(storage),
    keyPrefix: PREFIX,
    ai,
    prompts,
    scratchDir: scratch,
    ownerFontPair: ownerPair,
    newId,
    log: () => {},
  });
  return { run, calls };
}

const CLASSIC_PAIR = async (): Promise<FontPairId> => "classic";

// The decide step's answer calls (the decide attempts), without the hook calls.
function editorCalls(ai: FakeAiRunner) {
  return ai.calls.filter((call) => call.role !== "hook");
}

// The double for a run: the hook calls' replies (by default the committed
// hook) and the decide calls' replies, each in its own order.
function aiScript(replies: ScriptedReply[], hooks: ScriptedReply[] = [hookReply]): FakeAiRunner {
  return fakeAiRunner([...hooks, ...replies]);
}

function lastCall(calls: ReturnType<typeof recordingSteps>["calls"]) {
  return calls.at(-1)!;
}

describe("runDecide", () => {
  it("passes the committed E2E answer in one round, saving version 2", async () => {
    const ai = aiScript([scripted]);
    const { run, calls } = await decide(ai);
    await run;
    // The hook call first, then the components.
    expect(ai.calls).toHaveLength(2);
    expect(ai.calls[0]!.role).toBe("hook");
    expect(ai.calls[0]!.prompt).toContain("This is a short test clip");
    expect(ai.calls[1]!.role).toBe("decide");
    // The components' prompt carries the hook as data, and writes none.
    expect(ai.calls[1]!.prompt).toContain(`"text": "${HOOK_TEXT}"`);
    expect(ai.calls[1]!.prompt).not.toContain('"kind": "hook"');
    expect(rows.size).toBe(2);
    const v2 = rows.get(current!)!;
    expect(v2).toMatchObject({
      number: 2,
      parent_id: firstId,
      request: null,
      model: AI_MODEL,
      prompt_version: "reel-components@v1",
      // A new version has no title and no summary.
      change_title: null,
      change_summary: null,
      checks: [],
      used_free_field: false,
      unexpressed: [],
      free_field: [],
      rejected_reasons: [],
      checklist: [],
    });
    const done = lastCall(calls);
    if (done.call !== "done") throw new Error(JSON.stringify(calls));
    // On the 2.7 s clip the accent on w0005 is said while the hook shows: the
    // hook keeps its whole window (0.2 s to the reel's end) and the accent is
    // placed around it on its own words.
    expect(done.summary).toMatch(
      /^version 2: 1 accent, 0 transitions, hook set, 1 word fixed, under a second$/,
    );
    expect(v2.engine_record).toContainEqual(
      expect.objectContaining({ item: "hook", component: "HOOK", start: 0.2 }),
    );
    expect(v2.engine_record).not.toContainEqual(
      expect.objectContaining({ item: "hook", outcome: "retimed" }),
    );
    expect(v2.engine_record).toContainEqual(
      expect.objectContaining({ item: "accent-1", component: "ACCENT" }),
    );
    // The schema the AI got is this reel's, and the prompt carries its words.
    expect(JSON.stringify(ai.calls[1]!.schema)).toContain('"w0010"');
    // The AI record beside the version: all three calls, prompt, schema and raw answer.
    const record = JSON.parse(
      new TextDecoder().decode(
        (await storage.get(aiRecordKey(PREFIX, TEST_JOB.reel_id!, current!)))!,
      ),
    ) as { version_id: string; prompt_version: string; calls: Json[] };
    expect(record).toMatchObject({
      format: 1,
      reel_id: TEST_JOB.reel_id,
      version_id: current,
      prompt_version: "reel-components@v1",
      hook_prompt_version: "reel-hook@v1",
      intensity: "intense",
      target_picks: expect.any(Number),
    });
    expect(record.calls.map((call) => call.promptVersion)).toEqual([
      "reel-hook@v1",
      "reel-components@v1",
    ]);
    expect(record.calls.map((call) => [call.role, call.attempt])).toEqual([
      ["hook", 1],
      ["decide", 1],
    ]);
    expect(record.calls[0]).toMatchObject({
      model: AI_MODEL,
      prompt: ai.calls[0]!.prompt,
      schema: ai.calls[0]!.schema,
      outputMode: "json_schema",
      answerText: JSON.stringify(hookReply.answer),
      usage: { inputTokens: 300, outputTokens: 40, costUsd: 0.0015 },
      error: null,
    });
    expect(record.calls[1]).toMatchObject({
      model: AI_MODEL,
      prompt: ai.calls[1]!.prompt,
      schema: ai.calls[1]!.schema,
      outputMode: "json_schema",
      answerText: JSON.stringify(scripted.answer),
      usage: { inputTokens: 1500, outputTokens: 456, costUsd: 0.0123 },
      error: null,
    });

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
    // The written hook, its own text and no words, and the accent shown beside it.
    expect(stored.tracks.overlays).toEqual([
      expect.objectContaining({
        id: "hook",
        kind: "hook",
        text: "A short test for the real studio",
      }),
      expect.objectContaining({ id: "accent-1", kind: "accent" }),
    ]);
    // The scratch folder is gone.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's temp folder
    expect(await readdir(scratch)).toEqual([]);
  });

  it("sets the new version in the owner's pair, and the version it decided from keeps its own", async () => {
    const ai = aiScript([scripted]);
    const { run } = await decide(ai, undefined, fakePromptSource(), async () => "retro");
    await run;
    const saved = rows.get(current!)!;
    expect(saved.number).toBe(2);
    const stored = JSON.parse(new TextDecoder().decode((await storage.get(saved.r2_key))!));
    expect(stored.font_pair).toBe("retro");
    const from = rows.get(firstId)!;
    const before = JSON.parse(new TextDecoder().decode((await storage.get(from.r2_key))!));
    expect(before.font_pair).toBe("classic");
  });

  it("saves version 1 with only the hook added for an answer with no choices", async () => {
    const empty = answered(
      answer((a) => {
        a.accents = [];
        a.lists = [];
        a.word_fixes = [];
      }),
    );
    const ai = aiScript([empty]);
    const { run } = await decide(ai);
    await run;
    const read = async (id: string) =>
      JSON.parse(new TextDecoder().decode((await storage.get(rows.get(id)!.r2_key))!)) as Json;
    const before = await read(firstId);
    const after = await read(current!);
    // Every reel has a hook now: version 1's tracks, plus the hook alone.
    expect(after.tracks).toEqual({
      ...(before.tracks as Json),
      overlays: [expect.objectContaining({ id: "hook", kind: "hook", text: HOOK_TEXT })],
    });
    // The hook is the only difference, and a new version saves no title or summary.
    expect(rows.get(current!)).toMatchObject({ change_title: null, change_summary: null });
  });

  it("retries once with the first answer's reasons, then saves (verification 2)", async () => {
    const ai = aiScript([fixedTwice(), scripted]);
    const { run } = await decide(ai);
    await run;
    expect(editorCalls(ai)).toHaveLength(2);
    expect(editorCalls(ai)[1]!.prompt).toMatch(/Your previous answer was refused/);
    expect(editorCalls(ai)[1]!.prompt).toMatch(/- word_fixes: w0003 is fixed twice/);
    const v2 = rows.get(current!)!;
    // The model is the last one reported (the second round's).
    expect(v2).toMatchObject({
      number: 2,
      parent_id: firstId,
      checks: [],
      model: AI_MODEL,
    });
    expect(v2.rejected_reasons).toHaveLength(1);
    expect(v2.rejected_reasons[0]).toMatch(/^word_fixes: w0003 is fixed twice$/);
  });

  it("sends an over-long hook back once to the hook call with the reason, then saves", async () => {
    const long = "This short test clip is for the real studio";
    const ai = aiScript([scripted], [{ role: "hook", answer: { text: long } }, hookReply]);
    const { run } = await decide(ai);
    await run;
    const hooks = ai.calls.filter((call) => call.role === "hook");
    expect(hooks).toHaveLength(2);
    expect(hooks[1]!.prompt).toMatch(/Your previous answer was refused/);
    expect(hooks[1]!.prompt).toContain("- text: a hook has at most 7 words");
    // The components were asked once: the hook's refusal never reaches them.
    expect(editorCalls(ai)).toHaveLength(1);
    expect(rows.get(current!)!.rejected_reasons).toEqual([]);
  });

  it("fails the step when the hook fails twice, writing nothing and calling no components", async () => {
    const long: ScriptedReply = {
      role: "hook",
      answer: { text: "This short test clip is for the real studio" },
    };
    const ai = aiScript([scripted], [long, long]);
    const { run, calls } = await decide(ai);
    await expect(run).rejects.toThrow(/the hook failed twice/);
    const failed = lastCall(calls);
    if (failed.call !== "failed") throw new Error(JSON.stringify(calls));
    expect(failed.tail).toMatch(/^decide: the hook failed twice, version 1 stays current\n/);
    expect(failed.tail).toMatch(/round 1:\n- text: a hook has at most 7 words\nround 2:\n- text: /);
    expect(ai.calls.map((call) => call.role)).toEqual(["hook", "hook"]);
    expect(current).toBe(firstId);
    expect(rows.size).toBe(1);
  });

  it("retries a hook refused by its schema once, then saves", async () => {
    // A labelled hook reply that is not an object (a string is not labelled):
    // refused by its schema, then the retry passes.
    const ai = aiScript([scripted], [{ role: "hook", answer: "not a hook" }, hookReply]);
    const { run } = await decide(ai);
    await run;
    expect(ai.calls.map((call) => call.role)).toEqual(["hook", "hook", "decide"]);
    expect(rows.get(current!)!.rejected_reasons).toEqual([]);
  });

  it("fails after two refused answers and writes nothing (verification 3)", async () => {
    const ai = aiScript([fixedTwice(), fixedTwice()]);
    const { run, calls } = await decide(ai);
    await expect(run).rejects.toThrow(/the answer failed twice/);
    const failed = lastCall(calls);
    if (failed.call !== "failed") throw new Error(JSON.stringify(calls));
    expect(failed.tail).toMatch(/^decide: the answer failed twice, version 1 stays current\n/);
    expect(failed.tail).toMatch(
      /round 1:\n- word_fixes: w0003 is fixed twice\nround 2:\n- word_fixes: w0003 is fixed twice/,
    );
    expect(current).toBe(firstId);
    expect(rows.size).toBe(1);
    expect(await storage.list(`${PREFIX}reels/${TEST_JOB.reel_id}/versions/`)).toHaveLength(1);
  });

  it("throws with the rule names of both rounds as data, the tail unchanged", async () => {
    const ai = aiScript(["not json", fixedTwice()]);
    const { run, calls } = await decide(ai);
    const error = await run.catch((thrown: unknown) => thrown);
    const refused = findCause(error, AnswerRefused);
    expect(refused?.rules).toEqual(["answer-json", "answer-schema"]);
    expect(refused?.rounds).toBe(2);
    const failed = lastCall(calls);
    if (failed.call !== "failed") throw new Error(JSON.stringify(calls));
    expect(failed.tail).toMatch(
      /round 1:\n- the answer was not valid JSON[^\n]*\nround 2:\n- word_fixes: w0003 is fixed twice/,
    );
  });

  it("puts reel.tracks_items on the decide span after a save", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = createTelemetry(
      {},
      { spanProcessors: [new SimpleSpanProcessor({ exporter })] },
    );
    const { steps } = recordingSteps();
    await runDecide({
      ctx: stepContext(steps, { telemetry }),
      storage,
      rows: memoryRows(),
      blobs: storageVersionBlobs(storage),
      keyPrefix: PREFIX,
      ai: aiScript([scripted]),
      prompts: fakePromptSource(),
      scratchDir: scratch,
      ownerFontPair: CLASSIC_PAIR,
      newId,
      log: () => {},
    });
    const span = exporter.getFinishedSpans().find((s) => s.name === "step decide");
    const stored = JSON.parse(
      new TextDecoder().decode((await storage.get(rows.get(current!)!.r2_key))!),
    ) as { tracks: Record<string, unknown[]> };
    const items = Object.values(stored.tracks).reduce((sum, track) => sum + track.length, 0);
    expect(items).toBeGreaterThan(0);
    expect(span?.attributes["reel.tracks_items"]).toBe(items);
    await telemetry.shutdown();
  });

  it("retries a broken JSON answer (verification 4)", async () => {
    const ai = aiScript(["not json", scripted]);
    const { run } = await decide(ai);
    await run;
    expect(editorCalls(ai)).toHaveLength(2);
    const v2 = rows.get(current!)!;
    expect(v2.number).toBe(2);
    expect(v2.rejected_reasons.join("\n")).toMatch(/not valid JSON/);
  });

  it("writes the AI usage exactly as reported, summed over two rounds (verification 5)", async () => {
    const withUsage = (input: number, output: number, cost: number, model: string) => ({
      ...answered(answer()),
      // The 300 cache-write tokens count as input.
      usage: { input_tokens: input + 300, output_tokens: output, cost_usd: cost },
      model,
    });
    const one = await decide(aiScript([withUsage(1200, 456, 0.0123, "claude-x")]));
    await one.run;
    const done = lastCall(one.calls);
    if (done.call !== "done") throw new Error("not done");
    // The hook call (300 in, 40 out) and the decide answer add up.
    expect(done.measurements).toMatchObject({
      ai_input_tokens: 1800,
      ai_output_tokens: 496,
      ai_model: "claude-x",
    });
    expect(done.measurements.ai_cost_usd).toBeCloseTo(0.0138, 10);

    const bad = {
      ...fixedTwice(),
      usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.01 },
    };
    const two = await decide(aiScript([bad, withUsage(1200, 456, 0.0123, "claude-x")]));
    await two.run;
    const second = lastCall(two.calls);
    if (second.call !== "done") throw new Error("not done");
    // The refused attempt's tokens count too: the hook, the refused answer and
    // the retry.
    expect(second.measurements.ai_input_tokens).toBe(1810);
    expect(second.measurements.ai_output_tokens).toBe(501);
    expect(second.measurements.ai_cost_usd).toBeCloseTo(0.0238, 10);
    expect(second.measurements.ai_model).toBe("claude-x");
  });

  it("records the usage on a failed decide too", async () => {
    const bad = {
      ...fixedTwice(),
      usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.01 },
    };
    const { run, calls } = await decide(aiScript([bad, bad]));
    await expect(run).rejects.toThrow();
    const failed = lastCall(calls);
    if (failed.call !== "failed") throw new Error("not failed");
    // The hook (300 in, 40 out) and the two refused answers (10 in, 5 out each).
    expect(failed.measurements).toMatchObject({
      ai_input_tokens: 320,
      ai_output_tokens: 50,
    });
    expect(failed.measurements.ai_cost_usd).toBeCloseTo(0.0215, 10);
  });

  it("refuses an answer carrying a time or a position, as the schema's", async () => {
    const placed = answered(
      answer((a) => {
        (a.accents as Json[])[0]!.start = { time: 0.9 };
        (a.accents as Json[])[0]!.position = { x: 500, y: 400, align: "center" };
      }),
    );
    const ai = aiScript([placed, scripted]);
    const { run } = await decide(ai);
    await run;
    expect(editorCalls(ai)).toHaveLength(2);
    const v2 = rows.get(current!)!;
    expect(v2.rejected_reasons.join("\n")).toMatch(/^accents\.0: .*"start".*"position"/m);
    expect(v2).toMatchObject({ used_free_field: false, free_field: [] });
  });

  it("places the answer's words: the fix lands on its caption, and the hook keeps its window", async () => {
    const { run } = await decide(
      aiScript([
        answered(
          answer((a) => {
            a.lists = [{ items: [{ from: "w0006", to: "w0008", key_from: "w0007" }] }];
          }),
        ),
      ]),
    );
    await run;
    const stored = JSON.parse(
      new TextDecoder().decode((await storage.get(rows.get(current!)!.r2_key))!),
    ) as { tracks: Record<string, Json[]> };
    // The accent and the transition said in the hook's window are shown with it,
    // each noted; nothing cuts the hook.
    expect(stored.tracks.overlays!.map((item) => item.id)).toEqual(["hook", "accent-1"]);
    expect(stored.tracks.transitions!.map((item) => item.id)).toEqual(["transition-1"]);
    const record = rows.get(current!)!.engine_record as { item: string; outcome: string }[];
    expect(record).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ item: "hook", component: "HOOK", start: 0.2 }),
        expect.objectContaining({ item: "accent-1", component: "ACCENT" }),
        expect.objectContaining({ item: "transition-1", component: "LIST" }),
      ]),
    );
    expect(record.filter((note) => note.item === "hook" && note.outcome === "retimed")).toEqual([]);
    expect(stored.tracks.captions!.find((item) => item.id === "cw0010")!.text).toBe("Studio");
  });

  it("never refuses an answer over layout: a wide accent said through the hook is placed around it, noted and logged", async () => {
    const wide = answered(
      answer((a) => {
        a.accents = [{ from: "w0001", to: "w0010" }];
        a.lists = [];
      }),
    );
    const ai = aiScript([wide]);
    const lines: string[] = [];
    const { steps } = recordingSteps();
    await runDecide({
      ctx: stepContext(steps),
      storage,
      rows: memoryRows(),
      blobs: storageVersionBlobs(storage),
      keyPrefix: PREFIX,
      ai,
      prompts: fakePromptSource(),
      scratchDir: scratch,
      ownerFontPair: CLASSIC_PAIR,
      newId,
      log: (line) => lines.push(line),
    });
    expect(editorCalls(ai)).toHaveLength(1);
    const v2 = rows.get(current!)!;
    expect(v2).toMatchObject({ number: 2, checks: [], rejected_reasons: [] });
    // The wide accent runs through the hook's window on its own words; neither
    // cuts the other, and the accent is placed off the hook (wrapped and, with
    // the hook in the upper third, moved or shrunk), noted.
    const record = v2.engine_record as { item: string; outcome: string }[];
    const accentNotes = record.filter((note) => note.item === "accent-1");
    expect(accentNotes.length).toBeGreaterThan(0);
    for (const note of accentNotes) {
      expect(["placed", "moved", "shrunk", "wrapped"]).toContain(note.outcome);
    }
    expect(record.filter((note) => note.item === "hook" && note.outcome === "retimed")).toEqual([]);
    // One engine record line per version, with the reel id; no engine bug line.
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith(`engine record, reel ${TEST_JOB.reel_id}, version 2: `)).toBe(true);
    expect(lines[0]).toMatch(/accent-1 (placed|moved|shrunk|wrapped) \((zone|size)\): /);
  });

  it("asks at most twice, however many bad answers are scripted", async () => {
    const ai = aiScript([fixedTwice(), fixedTwice(), fixedTwice()]);
    const { run } = await decide(ai);
    await expect(run).rejects.toThrow();
    expect(editorCalls(ai)).toHaveLength(2);
  });

  it("keeps the failure tail within 20 lines when there are many reasons", async () => {
    const many = answered(
      answer((a) => {
        // Eleven fixes of one word: ten "fixed twice" reasons.
        a.word_fixes = Array.from({ length: 11 }, () => ({ word: "w0003", text: "Studio" }));
      }),
    );
    const { run, calls } = await decide(aiScript([many, many]));
    await expect(run).rejects.toThrow();
    const failed = lastCall(calls);
    if (failed.call !== "failed") throw new Error("not failed");
    const lines = failed.tail.split("\n");
    expect(lines.length).toBeLessThanOrEqual(20);
    expect(lines[0]).toMatch(/^decide: the answer failed twice/);
    expect(failed.tail).toMatch(/- and 3 more\nround 2:/);
    expect(failed.tail).toMatch(/round 2:\n- word_fixes: w0003 is fixed twice/);
  });
});

describe("runDecide when the AI is not available", () => {
  const USAGE_LIMIT = new URL("./testdata/ai-credits-used-up.json", import.meta.url);

  it("throws AiUnavailable on the first call, writes the row waiting and saves nothing", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
    const limit = JSON.parse(await readFile(USAGE_LIMIT, "utf8")) as ScriptedReply;
    const ai = aiScript([limit, scripted]);
    const { run, calls } = await decide(ai);
    const error = await run.catch((caught: unknown) => caught);
    expect((error as Error).cause).toBeInstanceOf(AiUnavailable);
    expect(editorCalls(ai)).toHaveLength(1);
    expect(current).toBe(firstId);
    expect(rows.size).toBe(1);
    expect(calls.map((c) => c.call)).toEqual(["start", "waiting"]);
    expect(lastCall(calls)).toMatchObject({ reason: "the OpenRouter credits are used up" });
  });

  it("throws AiUnavailable on the second call too", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
    const limit = JSON.parse(await readFile(USAGE_LIMIT, "utf8")) as ScriptedReply;
    const ai = aiScript([fixedTwice(), limit]);
    const { run, calls } = await decide(ai);
    await expect(run).rejects.toThrow();
    expect(editorCalls(ai)).toHaveLength(2);
    expect(lastCall(calls).call).toBe("waiting");
  });

  it("fails transiently, before any AI call, when a prompt PostHog cannot serve is needed", async () => {
    const ai = aiScript([scripted]);
    const prompts: PromptSource = {
      async get(name) {
        if (name === "reel-components") {
          throw new PromptUnavailable(name, "production", "PostHog did not answer");
        }
        return fakePromptSource().get(name);
      },
    };
    const { run, calls } = await decide(ai, undefined, prompts);
    const error = (await run.catch((caught: unknown) => caught)) as Error;
    expect(ai.calls).toHaveLength(0);
    expect(isTransient(error)).toBe(true);
    expect(error.message).toContain(
      "prompts: reel-components (label production) could not be fetched: PostHog did not answer",
    );
    expect(current).toBe(firstId);
    // Transient: the step runner's one automatic retry, then the failure.
    expect(calls.map((c) => c.call)).toEqual(["start", "failed", "start", "failed"]);
  });

  it("never retries a network error from the AI call: at most two AI calls", async () => {
    let made = 0;
    const ai: AiRunner = {
      async call() {
        made += 1;
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      },
    };
    const { run, calls } = await decide(ai);
    const error = (await run.catch((caught: unknown) => caught)) as Error;
    expect(made).toBe(1);
    expect(error.cause).toBeInstanceOf(PermanentError);
    expect(isTransient(error)).toBe(false);
    expect(calls.map((c) => c.call)).toEqual(["start", "failed"]);
  });
});

describe("runDecide with a visual", () => {
  // A VISUAL over the fixture's one sentence, w0001 to w0010 (about 2.6 s).
  const visualItem = (description = "a messy desk at night"): Json => ({
    from: "w0001",
    to: "w0010",
    description,
  });
  const behindAnswer = (items: Json[] = [visualItem()]) =>
    answered(
      answer((a) => {
        // No accents and no transition: on the 2.7 s clip the title or the
        // transition would hold the screen.
        a.accents = [];
        a.lists = [];
        a.visuals = items;
      }),
    );
  // The hook holds the 2.7 s clip's first seconds, so a visual needs speech
  // after its window (0.2 s to 3 s): the 47 s reel of the packages/edit
  // fixtures, "how we allocate our resources, what we do." (w18 to w25,
  // 5.2 s to 7.3 s), written over the clip's transcript and head track.
  const longVisualAnswer = () =>
    answered(
      answer((a) => {
        a.accents = [];
        a.lists = [];
        a.word_fixes = [];
        a.visuals = [{ from: "w18", to: "w25", description: "a messy desk at night" }];
      }),
    );
  async function useLongReel() {
    const fixtureRow = rows.get(current!)!;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
    const headTrack = await readFile(LONG_HEAD_TRACK);
    const inputs = {
      footage: { step: "retime", fingerprint: fingerprints.retime!, file: "source.mp4" },
      transcript: { step: "retime", fingerprint: fingerprints.retime!, file: "transcript.json" },
      head_track: {
        step: "head_track",
        fingerprint: fingerprints.head_track!,
        file: "head-track.json",
      },
    };
    await storage.put(
      cacheKey(PREFIX, "retime", fingerprints.retime!, "transcript.json"),
      new TextEncoder().encode(JSON.stringify(BEHIND_TRANSCRIPT)),
    );
    await storage.put(
      cacheKey(PREFIX, "head_track", fingerprints.head_track!, "head-track.json"),
      new Uint8Array(headTrack),
    );
    const edit = { ...behindEdit(), inputs };
    await storage.put(fixtureRow.r2_key, new TextEncoder().encode(JSON.stringify(edit)));
    rows.set(current!, { ...fixtureRow, inputs });
  }
  async function decideBehind(
    ai: AiRunner,
    spawnTool: SpawnTool,
    { telemetry }: { telemetry?: Telemetry } = {},
  ) {
    const footage = cacheKey(PREFIX, "retime", fingerprints.retime!, "source.mp4");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
    const bytes = await readFile(new URL("retime/source.mp4", FIXTURES));
    await storage.put(footage, new Uint8Array(bytes));
    const { steps, calls } = recordingSteps();
    const run = runDecide({
      ctx: stepContext(steps, telemetry ? { telemetry } : {}),
      storage,
      rows: memoryRows(),
      blobs: storageVersionBlobs(storage),
      keyPrefix: PREFIX,
      ai,
      prompts: fakePromptSource(),
      scratchDir: scratch,
      ownerFontPair: CLASSIC_PAIR,
      newId,
      spawnTool,
      env: { E2E_MOCK_MASK: "true" },
      log: () => {},
    });
    return { run, calls };
  }

  it("decides a visual: the schema names no photo, and the visual is shown beside the hook, in the record", async () => {
    const ai = aiScript([behindAnswer()]);
    const spawn = fakeMaskSpawn();
    const { run } = await decideBehind(ai, spawn.spawnTool);
    await run;
    const components = editorCalls(ai)[0]!;
    expect(JSON.stringify(components.schema)).not.toContain("photo_id");
    // Nothing behind is placed, so no mask is made and nothing is cut out.
    expect(spawn.calls).toHaveLength(0);
    const v2 = rows.get(current!)!;
    // The visual shares the hook's time and is placed in its own spot: its
    // note says so, and nothing lacked a spot.
    const record = v2.engine_record as { item: string; outcome: string }[];
    expect(record).toContainEqual(
      expect.objectContaining({ item: "visual-1", component: "VISUAL", outcome: "placed" }),
    );
    expect(record.filter((note) => note.outcome === "no-spot")).toEqual([]);
  });

  it("places a visual over the footage on a long reel: its frame needs no cut-out", async () => {
    await useLongReel();
    const ai = aiScript([longVisualAnswer()]);
    const spawn = fakeMaskSpawn();
    const { run } = await decideBehind(ai, spawn.spawnTool);
    await run;
    const v2 = rows.get(current!)!;
    const edit = JSON.parse(new TextDecoder().decode(await storage.get(v2.r2_key)!)) as {
      tracks: { behind?: { kind: string }[] };
    };
    expect(edit.tracks.behind).toEqual([expect.objectContaining({ kind: "visual" })]);
    expect(edit.tracks.behind?.[0]).not.toHaveProperty("layer");
    expect(spawn.calls).toHaveLength(0);
  });

  it("takes three visuals with no count to refuse: the hook holds the clip and every visual is shown, in the record", async () => {
    const three = behindAnswer([visualItem(), visualItem("a calm lake"), visualItem("a red door")]);
    const ai = aiScript([three]);
    const { run } = await decideBehind(ai, fakeMaskSpawn().spawnTool);
    await run;
    const v2 = rows.get(current!)!;
    expect(v2.rejected_reasons).toEqual([]);
    const record = v2.engine_record as { item: string; component: string }[];
    for (const item of ["visual-1", "visual-2", "visual-3"]) {
      expect(record).toContainEqual(expect.objectContaining({ item, component: "VISUAL" }));
    }
    expect(record).toContainEqual(
      expect.objectContaining({ item: "hook", component: "HOOK", start: 0.2 }),
    );
  });
});

describe("runDecide starting over", () => {
  it("decides from version 1, saving a new version after the current one", async () => {
    const first = await decide(aiScript([scripted]));
    await first.run;
    const v2 = current!;
    const empty = answered(
      answer((a) => {
        a.accents = [];
        a.lists = [];
        a.word_fixes = [];
      }),
    );
    const ai = aiScript([empty]);
    const { steps, calls } = recordingSteps();
    await runDecide({
      ctx: stepContext(steps),
      storage,
      rows: memoryRows(),
      blobs: storageVersionBlobs(storage),
      keyPrefix: PREFIX,
      ai,
      prompts: fakePromptSource(),
      scratchDir: scratch,
      ownerFontPair: CLASSIC_PAIR,
      newId,
      startFrom: firstId,
      log: () => {},
    });
    const v3 = rows.get(current!)!;
    expect(v3).toMatchObject({
      number: 3,
      parent_id: v2,
      request: null,
    });
    // From version 1: no choices, so version 3 is version 1 plus the hook alone
    // (version 2 had a transition and an accent, neither carried over).
    const read = async (id: string) =>
      JSON.parse(new TextDecoder().decode((await storage.get(rows.get(id)!.r2_key))!)) as Json;
    const from = await read(firstId);
    const made = await read(current!);
    expect(made.tracks).toEqual({
      ...(from.tracks as Json),
      overlays: [expect.objectContaining({ id: "hook", kind: "hook", text: HOOK_TEXT })],
    });
    expect(ai.calls.map((call) => call.role)).toEqual(["hook", "decide"]);
    expect(v3).toMatchObject({ change_title: null, change_summary: null });
    const done = lastCall(calls);
    if (done.call !== "done") throw new Error(JSON.stringify(calls));
    expect(done.summary).toMatch(/^version 3: .*started over from version 1/);
  });

  it("keeps only the owner's transcript corrections: the captions and the AI read them, and no place, size or element text is carried", async () => {
    const first = await decide(aiScript([scripted]));
    await first.run;
    const preset = ISSEBYA_PRESET;
    const transcript = transcriptSchema.parse(
      JSON.parse(
        new TextDecoder().decode(
          (await storage.get(cacheKey(PREFIX, "retime", fingerprints.retime!, "transcript.json")))!,
        ),
      ),
    );
    const read = async (id: string) => {
      const parsed = parseEdit(
        JSON.parse(new TextDecoder().decode((await storage.get(rows.get(id)!.r2_key))!)),
        preset,
        transcript,
      );
      if (!parsed.ok) throw new Error(parsed.reasons.join("; "));
      return parsed.edit;
    };
    const v2 = await read(current!);
    const block = captionBlocks(v2, transcript)[0]!;
    const group = block.groups[0]!;
    const fixed = group.captions
      .map((_, index) => (index === 0 ? "OWNERFIX" : `w${index}`))
      .join(" ");
    const blockTop = v2.tracks.captions.find((item) => item.id === group.id)!.position!.y;
    const blockLeft = Math.min(
      ...v2.tracks.captions
        .filter((item) => block.groups.some((entry) => entry.captions.includes(item.id)))
        .map((item) => item.position!.x),
    );
    // The reel's corrections, as the table keeps them.
    const corrected = new Map<string, StoredCorrection>();
    await runOwnerEdit({
      ctx: stepContext(recordingSteps().steps),
      storage,
      rows: memoryRows(),
      blobs: storageVersionBlobs(storage),
      keyPrefix: PREFIX,
      scratchDir: scratch,
      tools: toolPaths(),
      newId,
      corrections: {
        async write(_reel, _owner, entries) {
          for (const entry of entries) corrected.set(entry.word, entry);
        },
      },
      ownerEdit: {
        versionId: current!,
        moves: [
          {
            id: block.id,
            x: blockLeft,
            y: blockTop - 80,
            size: v2.tracks.captions.find((item) => item.id === group.id)!.size!,
          },
        ],
        texts: [
          { id: "hook", text: "My own hook line" },
          { id: "accent-1", text: "my accent" },
          { id: block.id, part: group.id, text: fixed },
        ],
      },
    });
    const v3 = current!;
    expect((await read(v3)).owner!.texts).toContain("accent-1");
    const words = group.captions.flatMap(
      (id) => v2.tracks.captions.find((item) => item.id === id)!.words,
    );
    expect([...corrected.keys()]).toEqual(words);
    // A new answer: the same accent, and the curator fixing the owner's first
    // word its own way.
    const again = answered(
      answer((a) => {
        a.lists = [];
        a.word_fixes = [{ word: words[0]!, text: "curatorfix" }];
      }),
    );
    const ai = aiScript([again]);
    const { steps, calls } = recordingSteps();
    await runDecide({
      ctx: stepContext(steps),
      storage,
      rows: memoryRows(),
      blobs: storageVersionBlobs(storage),
      keyPrefix: PREFIX,
      ai,
      prompts: fakePromptSource(),
      scratchDir: scratch,
      ownerFontPair: CLASSIC_PAIR,
      corrections: async () => [...corrected.values()],
      newId,
      startFrom: firstId,
      log: () => {},
    });
    const v4 = rows.get(current!)!;
    expect(v4).toMatchObject({ number: 4, parent_id: v3 });
    const made = await read(v4.id);
    // The AI read the transcript with the owner's words, in both calls.
    expect(ai.calls.map((call) => call.role)).toEqual(["hook", "decide"]);
    for (const call of ai.calls) expect(call.prompt, call.role).toContain("OWNERFIX");
    // The captions show the corrections: the owner wins over the curator.
    const caption = (edit: Edit, id: string) => edit.tracks.captions.find((item) => item.id === id);
    expect(group.captions.map((id) => caption(made, id)!.text)).toEqual(fixed.split(" "));
    expect(made.owner).toEqual({ placed: [], texts: [...group.captions].sort() });
    // Nothing else of the owner's version: the hook and the accent are the
    // AI's, and the caption block is where the engine places it.
    const fresh = made.tracks.overlays.map((item) => [item.id, item.text]);
    expect(fresh).toContainEqual(["hook", HOOK_TEXT]);
    expect(fresh.find(([id]) => id === "accent-1")?.[1]).not.toBe("my accent");
    expect(caption(made, group.id)!.position!.y).not.toBe(blockTop - 80);
    // No edit is noted as kept or lost: a Start over carries none.
    expect(
      (v4.engine_record as { rule: string }[]).filter((note) => note.rule === "owner-edit"),
    ).toEqual([]);
    const done = lastCall(calls);
    if (done.call !== "done") throw new Error(JSON.stringify(calls));
    expect(done.summary).toContain(
      `started over from version 1, ${group.captions.length} word corrections of yours kept`,
    );
    expect(done.summary).not.toMatch(/your edits/);
    // The owner's caption texts are never counted as the curator's fixes.
    expect(done.summary).toMatch(/0 words fixed/);
  });

  it("refuses a version of another reel", async () => {
    rows.set("other", { ...rows.get(firstId)!, id: "other", reel_id: "another-reel" });
    const { steps } = recordingSteps();
    const run = runDecide({
      ctx: stepContext(steps),
      storage,
      rows: memoryRows(),
      blobs: storageVersionBlobs(storage),
      keyPrefix: PREFIX,
      ai: aiScript([]),
      prompts: fakePromptSource(),
      scratchDir: scratch,
      ownerFontPair: CLASSIC_PAIR,
      newId,
      startFrom: "other",
      log: () => {},
    });
    await expect(run).rejects.toThrow(/version other of this reel not found/);
  });
});

describe("runDecide spans", () => {
  // Every span an exporter kept, read before the telemetry is shut down.
  async function traced(ai: AiRunner) {
    const exporter = new InMemorySpanExporter();
    const telemetry = createTelemetry(
      {},
      { spanProcessors: [new SimpleSpanProcessor({ exporter })] },
    );
    const { run, calls } = await decide(ai, telemetry);
    const outcome: unknown = await run.then(
      () => null,
      (error: unknown) => error,
    );
    const spans = exporter.getFinishedSpans();
    await telemetry.shutdown();
    return { spans, outcome, calls };
  }

  type Spans = ReturnType<InMemorySpanExporter["getFinishedSpans"]>;
  // The spans whose parent is `parent`, in the order they ended: the
  // decide stages run one after another, so that is their order.
  const childrenOf = (spans: Spans, parent: Spans[number] | undefined) =>
    spans.filter((s) => s.parentSpanContext?.spanId === parent?.spanContext().spanId);
  const named = (spans: Spans, name: string) => spans.find((s) => s.name === name);

  // A reply that reports its usage and model, for the spans.
  const reported = (answer: unknown, model: string, output: number): Answered => ({
    ...answered(answer),
    usage: { input_tokens: 1150, output_tokens: output, cost_usd: 0.0123 },
    model,
  });

  it("traces a normal run as the decide stages, in order, with their facts", async () => {
    const ai = aiScript([reported(scripted.answer, AI_MODEL, 200)]);
    const { spans, outcome } = await traced(ai);
    expect(outcome).toBeNull();
    const decideSpan = named(spans, "step decide");
    expect(decideSpan?.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(childrenOf(spans, decideSpan).map((s) => s.name)).toEqual([
      "decide.load",
      "decide.prepare",
      "decide.hook",
      "decide.attempt",
      "decide.save_version",
    ]);
    // The hook's own call is a `chat` span under its attempt, before the components'.
    const hook = named(spans, "decide.hook");
    expect(hook?.attributes).toMatchObject({ "decide.attempt": 1, "decide.outcome": "ok" });
    expect(childrenOf(spans, hook).map((s) => s.name)).toEqual([`chat ${AI_MODEL}`]);
    // The attempt's call is a `chat` span named with the model, then the
    // layout engine's span under the attempt.
    const attempt = named(spans, "decide.attempt");
    expect(attempt?.attributes).toMatchObject({ "decide.attempt": 1, "decide.outcome": "ok" });
    expect(childrenOf(spans, attempt).map((s) => s.name)).toEqual([
      `chat ${AI_MODEL}`,
      "decide.engine",
    ]);
    const chat = childrenOf(spans, attempt).find((s) => s.name === `chat ${AI_MODEL}`);
    expect(chat?.kind).toBe(SpanKind.CLIENT);
    expect(chat?.attributes).toEqual({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openrouter",
      "edit_issebya.ai.prompt_version": "reel-components@v1",
      "gen_ai.request.model": AI_MODEL,
      "gen_ai.response.model": AI_MODEL,
      "gen_ai.usage.input_tokens": 1150,
      "gen_ai.usage.output_tokens": 200,
      "gen_ai.response.finish_reasons": ["stop"],
      "edit_issebya.ai.role": "decide",
      "edit_issebya.ai.output_mode": "json_schema",
      "edit_issebya.ai.cost_usd": 0.0123,
    });
    expect(named(spans, "decide.engine")?.attributes).toMatchObject({
      "decide.checks": 0,
    });
    for (const span of spans) {
      expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
      // No invented `ai.*` names anywhere: AI facts are `gen_ai.*` on the chat span.
      expect(Object.keys(span.attributes).filter((key) => key.startsWith("ai."))).toEqual([]);
    }
    // The stage spans carry no AI facts of their own.
    expect(Object.keys(attempt!.attributes).filter((key) => key.startsWith("gen_ai."))).toEqual([]);
  });

  it("traces a retry as two decide.attempt spans, numbered 1 and 2, the first refused", async () => {
    const ai = aiScript([fixedTwice(), scripted]);
    const { spans, outcome } = await traced(ai);
    expect(outcome).toBeNull();
    const attempts = spans.filter((s) => s.name === "decide.attempt");
    expect(attempts.map((s) => s.attributes["decide.attempt"])).toEqual([1, 2]);
    expect(attempts.map((s) => s.attributes["decide.outcome"])).toEqual(["refused", "ok"]);
    expect(attempts[0]!.attributes["decide.refused_by"]).toBe("answer-schema");
    // Both attempts made their call under themselves; only the second ran the
    // engine, since the first is refused by its schema before placement.
    expect(attempts.map((s) => childrenOf(spans, s).map((c) => c.name))).toEqual([
      [`chat ${AI_MODEL}`],
      [`chat ${AI_MODEL}`, "decide.engine"],
    ]);
  });

  it("marks the failing attempt's span as an error and the step fails as before", async () => {
    const ai: AiRunner = {
      async call() {
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      },
    };
    const { spans, outcome, calls } = await traced(ai);
    expect((outcome as Error).cause).toBeInstanceOf(PermanentError);
    // The hook is the first AI call, so its attempt is the one that fails.
    const attempt = named(spans, "decide.hook");
    expect(attempt?.attributes["decide.attempt"]).toBe(1);
    expect(attempt?.status.code).toBe(SpanStatusCode.ERROR);
    expect(attempt?.events.map((event) => event.name)).toEqual(["exception"]);
    expect(named(spans, "step decide")?.status.code).toBe(SpanStatusCode.ERROR);
    expect(calls.map((c) => c.call)).toEqual(["start", "failed"]);
  });

  it("decides and saves version 2 with telemetry that exports nothing", async () => {
    const ai = aiScript([scripted]);
    const { run } = await decide(ai);
    await run;
    expect(rows.size).toBe(2);
    expect(rows.get(current!)!.number).toBe(2);
  });
});
