import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Edit,
  ISSEBYA_PRESET,
  type NewVersion,
  type StoredCorrection,
  type StoredVersion,
  type Transcript,
  type VersionRows,
  captionBlocks,
  ownerTextOf,
  parseEdit,
  transcriptSchema,
} from "@edit-issebya/edit";
import { type Storage, fakeStorage } from "@edit-issebya/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AiRecord,
  type AiRecordCall,
  aiRecordKey,
  writeAiRecord,
} from "./decide/ai-record.ts";
import { PermanentError, findCause, isTransient } from "./failure.ts";
import { saveFirstVersion } from "./first-version.ts";
import { type OwnerEdit, parseOwnerEdit, runOwnerEdit } from "./owner-edit.ts";
import { cacheKey } from "./pipeline/fingerprint.ts";
import { toolPaths } from "./pipeline/tools.ts";
import { TEST_JOB, recordingSteps, stepContext } from "./recording-steps.ts";
import { runRelayout } from "./relayout.ts";
import { runRestore } from "./restore-step.ts";
import { storageVersionBlobs } from "./version-store.ts";

const PREFIX = "dev/";
const FIXTURES = new URL("../../../fixtures/pipeline/", import.meta.url);
const ANSWER = new URL("./decide/testdata/short-speech-answer.json", import.meta.url);
const REEL = TEST_JOB.reel_id;
// A ready library photo of the owner's, as the worker reads it.
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
let rows: Map<string, StoredVersion & NewVersion>;
let current: string | null;
let ids: number;
let firstId: string;
// Version 2: the committed answer placed by the engine (the hook and one accent).
let placedId: string;
let transcript: Transcript;
// The committed answers, and how a call of the AI record is written.
let hookAnswer: unknown;
let decideAnswer: Record<string, unknown>;
let aiCall: (role: "hook" | "decide", answer: unknown) => AiRecordCall;

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

function deps() {
  return {
    ctx: stepContext(recordingSteps().steps),
    storage,
    rows: memoryRows(),
    blobs: storageVersionBlobs(storage),
    keyPrefix: PREFIX,
    scratchDir: scratch,
    tools: toolPaths(),
    newId,
  };
}

// The reel's transcript corrections, as the table keeps them: one per word.
let corrected: Map<string, StoredCorrection>;
const corrections = {
  async write(reelId: string, ownerId: string, entries: readonly StoredCorrection[]) {
    expect([reelId, ownerId]).toEqual([REEL, TEST_JOB.owner_id]);
    for (const entry of entries) corrected.set(entry.word, entry);
  },
};
const readCorrections = async () => [...corrected.values()];

function ownerEditRun(ownerEdit: OwnerEdit) {
  return runOwnerEdit({
    ...deps(),
    ownerEdit,
    corrections,
    photos: {
      async readyPhotos(ownerId, ids) {
        expect(ownerId).toBe(TEST_JOB.owner_id);
        return new Map(ids.includes(PHOTO.id) ? [[PHOTO.id, PHOTO]] : []);
      },
    },
  });
}

async function editOf(id: string): Promise<Edit> {
  const bytes = await storage.get(rows.get(id)!.r2_key);
  const parsed = parseEdit(
    JSON.parse(new TextDecoder().decode(bytes!)),
    ISSEBYA_PRESET,
    transcript,
  );
  if (!parsed.ok) throw new Error(parsed.reasons.join("; "));
  return parsed.edit;
}

function overlay(edit: Edit, id: string) {
  const item = edit.tracks.overlays.find((entry) => entry.id === id);
  if (!item?.position || !item.size) throw new Error(`no placed overlay ${id}`);
  return { ...item, position: item.position, size: item.size };
}

async function refusal(run: Promise<void>): Promise<string> {
  const failed = await run.then(
    () => null,
    (error: unknown) => error,
  );
  expect(failed).toBeInstanceOf(Error);
  expect(isTransient(failed)).toBe(false);
  return String(findCause(failed, PermanentError)?.message);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "owner-edit-storage-"));
  scratch = await mkdtemp(join(tmpdir(), "owner-edit-scratch-"));
  storage = fakeStorage({ root, uploadUrlBase: "" });
  const manifest = JSON.parse(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
    await readFile(new URL("manifest.json", FIXTURES), "utf8"),
  ) as { steps: { name: string; fingerprint: string; files: string[] }[] };
  const fingerprints = Object.fromEntries(
    manifest.steps.map((step) => [step.name, step.fingerprint]),
  );
  for (const step of manifest.steps) {
    for (const file of step.files.filter((name) => name.endsWith(".json"))) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
      const bytes = await readFile(new URL(`${step.name}/${file}`, FIXTURES));
      await storage.put(cacheKey(PREFIX, step.name, step.fingerprint, file), new Uint8Array(bytes));
    }
  }
  rows = new Map();
  corrected = new Map();
  current = null;
  ids = 0;
  await saveFirstVersion({ ...deps(), fingerprints, fontPair: "classic", log: () => {} });
  firstId = current!;
  transcript = transcriptSchema.parse(
    JSON.parse(
      new TextDecoder().decode(
        (await storage.get(cacheKey(PREFIX, "retime", fingerprints.retime!, "transcript.json")))!,
      ),
    ),
  );
  // The committed answer as version 1's AI record, then placed by the engine
  // (a re-layout in the same pair): version 2 has the hook and an accent.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed script
  const replies = JSON.parse(await readFile(ANSWER, "utf8")) as {
    role?: string;
    answer: unknown;
  }[];
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
  hookAnswer = replies.find((reply) => reply.role === "hook")!.answer;
  decideAnswer = replies.find((reply) => reply.role !== "hook")!.answer as Record<string, unknown>;
  aiCall = call;
  await writeAiRecord(storage, PREFIX, {
    format: 1,
    reel_id: REEL,
    version_id: firstId,
    prompt_version: "reel-components@v1",
    hook_prompt_version: "reel-hook@v1",
    calls: [call("hook", hookAnswer), call("decide", decideAnswer)],
  });
  await runRelayout({ ...deps(), fontPair: "classic", log: () => {} });
  placedId = current!;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

// Version 3: the committed answer with one VISUAL over the sentence instead
// of the accent (on the short clip the accent holds the screen), placed by the
// engine. Records are never rewritten: this swaps version 2's.
async function placeVisualVersion(): Promise<string> {
  await storage.delete(aiRecordKey(PREFIX, REEL, placedId));
  await writeAiRecord(storage, PREFIX, {
    format: 1,
    reel_id: REEL,
    version_id: placedId,
    prompt_version: "reel-components@v1",
    hook_prompt_version: "reel-hook@v1",
    calls: [
      aiCall("hook", hookAnswer),
      aiCall("decide", {
        ...decideAnswer,
        accents: [],
        lists: [],
        visuals: [{ from: "w0001", to: "w0010", description: "a messy desk at night" }],
      }),
    ],
  });
  await runRelayout({ ...deps(), fontPair: "classic", log: () => {} });
  return current!;
}

describe("parseOwnerEdit", () => {
  it("reads the version and the moves, and nothing else", () => {
    const version_id = "11111111-1111-4111-8111-111111111111";
    expect(
      parseOwnerEdit({ version_id, moves: [{ id: "hook", x: 1, y: 2, size: 30 }], more: 1 }),
    ).toEqual({ versionId: version_id, moves: [{ id: "hook", x: 1, y: 2, size: 30 }] });
    expect(parseOwnerEdit(null)).toBeNull();
    expect(parseOwnerEdit("moves")).toBeNull();
    expect(parseOwnerEdit({ version_id, moves: [] })).toBeNull();
    expect(parseOwnerEdit({ version_id: "1", moves: [{ id: "a", x: 1, y: 2, size: 30 }] })).toBe(
      null,
    );
  });

  it("reads added cards, alone or with moves, and refuses a malformed one", () => {
    const version_id = "11111111-1111-4111-8111-111111111111";
    const add = {
      id: "owner-visual-1",
      photo_id: PHOTO.id,
      word: "w0003",
      x: 40,
      y: 300,
      width: 360,
    };
    expect(parseOwnerEdit({ version_id, moves: [], adds: [add] })).toEqual({
      versionId: version_id,
      moves: [],
      adds: [add],
    });
    const swap = { id: "visual-1", kind: "box", x: 1, y: 2, width: 300, photo_id: PHOTO.id };
    expect(parseOwnerEdit({ version_id, moves: [swap], adds: [add] })).toEqual({
      versionId: version_id,
      moves: [swap],
      adds: [add],
    });
    expect(parseOwnerEdit({ version_id, moves: [], adds: [] })).toBeNull();
    for (const bad of [
      { ...add, id: "visual-9" },
      { ...add, photo_id: "kitchen" },
      { ...add, word: "" },
      { ...add, width: 0 },
    ]) {
      expect(parseOwnerEdit({ version_id, moves: [], adds: [bad] })).toBeNull();
    }
  });
});

describe("parseOwnerEdit, text edits", () => {
  const version_id = "00000000-0000-4000-8000-000000000002";

  it("reads text edits, alone or with moves, and refuses a malformed one", () => {
    const text = { id: "accent-1", text: "a real test" };
    expect(parseOwnerEdit({ version_id, moves: [], texts: [text] })).toEqual({
      versionId: version_id,
      moves: [],
      texts: [text],
    });
    const move = { id: "accent-1", x: 1, y: 2, size: 30 };
    expect(
      parseOwnerEdit({ version_id, moves: [move], texts: [{ ...text, part: "key" }] }),
    ).toEqual({ versionId: version_id, moves: [move], texts: [{ ...text, part: "key" }] });
    expect(parseOwnerEdit({ version_id, moves: [], texts: [] })).toBeNull();
    for (const bad of [
      "accent-1",
      [{ id: "accent-1" }],
      [{ id: "accent-1", text: " padded" }],
      [text, text],
    ]) {
      expect(parseOwnerEdit({ version_id, moves: [], texts: bad })).toBeNull();
    }
  });
});

describe("runOwnerEdit, text edits", () => {
  it("saves a text the owner fixed as a new version: only that element's words, its time and every other element kept", async () => {
    const before = await editOf(placedId);
    const accent = overlay(before, "accent-1");
    const spoken = accent.words!.map((id) => transcript.words.find((word) => word.id === id)!.text);
    await ownerEditRun({
      versionId: placedId,
      moves: [],
      texts: [{ id: "accent-1", text: "a fixed line" }],
    });
    expect(rows.size).toBe(3);
    const saved = rows.get(current!)!;
    expect(saved).toMatchObject({ number: 3, parent_id: placedId, edited_from_id: placedId });
    const after = await editOf(saved.id);
    const now = overlay(after, "accent-1");
    expect(now.text).toBe("a fixed line");
    expect([now.words, now.start, now.end, now.size]).toEqual([
      accent.words,
      accent.start,
      accent.end,
      accent.size,
    ]);
    // The box keeps its top.
    expect(now.position.y).toBe(accent.position.y);
    // Only that element: the hook, the captions (those of the same spoken
    // words too) and the sounds are the edited version's.
    expect(after.tracks.overlays.filter((item) => item.id !== "accent-1")).toEqual(
      before.tracks.overlays.filter((item) => item.id !== "accent-1"),
    );
    expect(after.tracks.captions).toEqual(before.tracks.captions);
    expect(after.tracks.sounds).toEqual(before.tracks.sounds);
    expect(after.duration).toBe(before.duration);
    // One learning record for the text, none for a move.
    expect(saved.owner_moves).toEqual([]);
    expect(saved.owner_texts).toHaveLength(1);
    expect(saved.owner_texts[0]).toMatchObject({
      item: "accent-1",
      part: null,
      component: "ACCENT",
      variant: "accent/above-head",
      after: "a fixed line",
      words: spoken.join(" "),
      word_ids: accent.words,
    });
    expect(saved.owner_texts[0]!.before.length).toBeGreaterThan(0);
    expect(saved.owner_texts[0]!.before).not.toBe("a fixed line");
    // The edited version is not rewritten.
    expect(overlay(await editOf(placedId), "accent-1").text).toBe(accent.text);
  });

  it("fixes a word of a caption block's group and of the hook, and applies a move after the text", async () => {
    const before = await editOf(placedId);
    const block = captionBlocks(before, transcript)[0]!;
    const group = block.groups[0]!;
    const fixed = group.captions.map((_, index) => (index === 0 ? "fixed" : `w${index}`)).join(" ");
    const hook = overlay(before, "hook");
    await ownerEditRun({
      versionId: placedId,
      moves: [{ id: "hook", x: hook.position.x, y: hook.position.y + 40, size: hook.size }],
      texts: [
        { id: block.id, part: group.id, text: fixed },
        { id: "hook", text: "A new hook line" },
      ],
    });
    const saved = rows.get(current!)!;
    const after = await editOf(saved.id);
    expect(
      group.captions.map((id) => after.tracks.captions.find((item) => item.id === id)!.text),
    ).toEqual(fixed.split(" "));
    for (const id of group.captions) {
      const was = before.tracks.captions.find((item) => item.id === id)!;
      const now = after.tracks.captions.find((item) => item.id === id)!;
      expect([now.words, now.start, now.end, now.size]).toEqual([
        was.words,
        was.start,
        was.end,
        was.size,
      ]);
    }
    expect(overlay(after, "hook")).toMatchObject({
      text: "A new hook line",
      position: { x: hook.position.x, y: hook.position.y + 40 },
    });
    expect(overlay(after, "accent-1")).toEqual(overlay(before, "accent-1"));
    expect(saved.owner_texts.map((record) => [record.item, record.part, record.component])).toEqual(
      [
        [block.id, group.id, "CAPTION"],
        ["hook", null, "HOOK"],
      ],
    );
    expect(saved.owner_texts[1]).toMatchObject({
      words: "",
      word_ids: [],
      after: "A new hook line",
    });
    // The hook moved too: its move has its own record.
    expect(saved.owner_moves.map((record) => record.item)).toEqual(["hook"]);
    // The caption fix is a transcript correction of the reel, per spoken word,
    // with the word as the transcript has it; the hook's text is the hook's only.
    const spoken = new Map(transcript.words.map((word) => [word.id, word.text]));
    const words = group.captions.flatMap(
      (id) => before.tracks.captions.find((item) => item.id === id)!.words,
    );
    expect([...corrected.values()]).toEqual(
      words.map((word, index) => ({
        word,
        text: fixed.split(" ")[index],
        original: spoken.get(word),
      })),
    );
  });

  it("writes no correction for a fix typed into an accent or the hook", async () => {
    await ownerEditRun({
      versionId: placedId,
      moves: [],
      texts: [
        { id: "accent-1", text: "a fixed line" },
        { id: "hook", text: "A new hook line" },
      ],
    });
    expect(rows.size).toBe(3);
    expect(corrected.size).toBe(0);
  });

  it("refuses an empty text, one too long, an element that is no text and a text that changes nothing, writing no version", async () => {
    const texts = (text: string, id = "accent-1") =>
      ownerEditRun({ versionId: placedId, moves: [], texts: [{ id, text }] });
    expect(await refusal(texts(""))).toMatch(
      /the texts are refused: accent-1: A text cannot be empty/,
    );
    expect(await refusal(texts("a".repeat(201)))).toMatch(
      /accent-1: This text can be at most \d+ characters \(it has 201\)/,
    );
    expect(await refusal(texts("a card", "visual-1"))).toMatch(
      /visual-1: not a text of this version/,
    );
    // The text it already shows is no edit.
    const same = ownerTextOf(
      await editOf(placedId),
      { id: "accent-1" },
      { transcript, preset: ISSEBYA_PRESET },
    )!.text;
    expect(await refusal(texts(same))).toMatch(/nothing was moved, resized or edited/);
    expect(rows.size).toBe(2);
    expect(current).toBe(placedId);
  });
});

describe("a font pair change after the owner's edits", () => {
  it("keeps every text fix and every place of the owner's version in the new pair, and says so in the step's line", async () => {
    const before = await editOf(placedId);
    const accent = overlay(before, "accent-1");
    const block = captionBlocks(before, transcript)[0]!;
    const group = block.groups[0]!;
    const first = before.tracks.captions.find((item) => item.id === group.id)!;
    const fixed = group.captions.map((_, index) => (index === 0 ? "fixed" : `w${index}`)).join(" ");
    await ownerEditRun({
      versionId: placedId,
      moves: [
        { id: "accent-1", x: 150, y: 950, size: 80 },
        {
          id: block.id,
          x: Math.min(
            ...before.tracks.captions
              .filter((item) => block.groups.some((entry) => entry.captions.includes(item.id)))
              .map((item) => item.position!.x),
          ),
          y: first.position!.y - 90,
          size: first.size!,
        },
      ],
      texts: [
        { id: "accent-1", text: "a fixed line" },
        { id: block.id, part: group.id, text: fixed },
        { id: "hook", text: "A new hook line" },
      ],
    });
    const owned = await editOf(current!);
    expect(owned.owner!.texts).toContain("accent-1");
    expect(owned.owner!.placed).toContain("accent-1");
    const ownedAccent = overlay(owned, "accent-1");
    const ownedFirst = owned.tracks.captions.find((item) => item.id === group.id)!;

    const { steps, calls } = recordingSteps();
    await runRelayout({
      ...deps(),
      ctx: stepContext(steps),
      fontPair: "bold",
      corrections: readCorrections,
      log: () => {},
    });
    const saved = rows.get(current!)!;
    expect(saved.number).toBe(4);
    const after = await editOf(saved.id);
    expect(after.font_pair).toBe("bold");
    // The texts, on their own elements; the accent's words and time as they were.
    const now = overlay(after, "accent-1");
    expect(now.text).toBe("a fixed line");
    expect([now.words, now.start, now.end]).toEqual([accent.words, accent.start, accent.end]);
    expect(overlay(after, "hook").text).toBe("A new hook line");
    expect(
      group.captions.map((id) => after.tracks.captions.find((item) => item.id === id)!.text),
    ).toEqual(fixed.split(" "));
    // The places: the owner's size and top (the centre line is kept, so the
    // left edge follows the new font's widths).
    expect(now.size).toBe(80);
    expect(now.position.y).toBe(ownedAccent.position.y);
    const afterFirst = after.tracks.captions.find((item) => item.id === group.id)!;
    expect(afterFirst.position!.y).toBe(ownedFirst.position!.y);
    expect(afterFirst.size).toBe(ownedFirst.size);
    // The marks go with the version, and no edit was lost.
    expect(after.owner!.placed).toEqual(owned.owner!.placed);
    expect(after.owner!.texts).toEqual(
      expect.arrayContaining(["accent-1", "hook", ...group.captions]),
    );
    expect(
      (saved.engine_record as { rule: string; outcome: string }[]).filter(
        (note) => note.rule === "owner-edit" && note.outcome === "dropped",
      ),
    ).toEqual([]);
    const done = calls.at(-1)!;
    if (done.call !== "done") throw new Error(JSON.stringify(done));
    expect(done.summary).toMatch(
      /^version 4: set in the bold font pair, from version 3, \d+ of your edits kept(, |$)/,
    );
    // A second change carries them again.
    await runRelayout({
      ...deps(),
      fontPair: "retro",
      corrections: readCorrections,
      log: () => {},
    });
    const again = await editOf(current!);
    expect(overlay(again, "accent-1")).toMatchObject({ text: "a fixed line", size: 80 });
    expect(overlay(again, "hook").text).toBe("A new hook line");
    expect(
      group.captions.map((id) => again.tracks.captions.find((item) => item.id === id)!.text),
    ).toEqual(fixed.split(" "));
  });

  it("writes the captions from the reel's corrections, never from the version's own caption texts", async () => {
    const before = await editOf(placedId);
    const block = captionBlocks(before, transcript)[0]!;
    const group = block.groups[0]!;
    const fixed = group.captions.map((_, index) => (index === 0 ? "fixed" : `w${index}`)).join(" ");
    await ownerEditRun({
      versionId: placedId,
      moves: [],
      texts: [{ id: block.id, part: group.id, text: fixed }],
    });
    // The owner corrects the first word once more, in a later save: the reel
    // keeps the newest text for that word.
    const first = [...corrected.values()][0]!;
    corrected.set(first.word, { ...first, text: "newest" });
    const { steps, calls } = recordingSteps();
    await runRelayout({
      ...deps(),
      ctx: stepContext(steps),
      fontPair: "bold",
      corrections: readCorrections,
      log: () => {},
    });
    const after = await editOf(current!);
    expect(
      group.captions.map((id) => after.tracks.captions.find((item) => item.id === id)!.text),
    ).toEqual(["newest", ...fixed.split(" ").slice(1)]);
    expect(after.owner!.texts).toEqual(expect.arrayContaining(group.captions));
    const done = calls.at(-1)!;
    if (done.call !== "done") throw new Error(JSON.stringify(done));
    expect(done.summary).toContain(`${group.captions.length} of your edits kept`);
    // With no correction kept for the reel the captions say the spoken words.
    await runRelayout({ ...deps(), fontPair: "retro", log: () => {} });
    const plain = await editOf(current!);
    expect(
      group.captions.map((id) => plain.tracks.captions.find((item) => item.id === id)!.text),
    ).toEqual(group.captions.map(() => undefined));
  });

  it("changes nothing for a version the owner never edited", async () => {
    const { steps, calls } = recordingSteps();
    await runRelayout({ ...deps(), ctx: stepContext(steps), fontPair: "bold", log: () => {} });
    const after = await editOf(current!);
    expect(after.owner).toBeUndefined();
    const done = calls.at(-1)!;
    if (done.call !== "done") throw new Error(JSON.stringify(done));
    expect(done.summary).toMatch(/^version 3: set in the bold font pair, from version 2(, |$)/);
    expect(done.summary).not.toMatch(/your edits/);
  });
});

describe("runOwnerEdit", () => {
  it("saves the moves as a new version after the current one, marked as the owner's, leaving the edited version as it was", async () => {
    const before = await editOf(placedId);
    const beforeBytes = await storage.get(rows.get(placedId)!.r2_key);
    const accent = overlay(before, "accent-1");
    const hook = overlay(before, "hook");
    await ownerEditRun({
      versionId: placedId,
      moves: [
        { id: "accent-1", x: 120, y: 900, size: accent.size },
        { id: "hook", x: hook.position.x, y: hook.position.y, size: 66 },
      ],
    });
    expect(rows.size).toBe(3);
    const saved = rows.get(current!)!;
    expect(saved).toMatchObject({
      number: 3,
      parent_id: placedId,
      edited_from_id: placedId,
      restored_from_id: null,
      request: null,
      model: null,
      change_title: null,
      change_summary: null,
    });
    const after = await editOf(saved.id);
    expect(overlay(after, "accent-1")).toMatchObject({
      position: { x: 120, y: 900, align: "left" },
      size: accent.size,
    });
    expect(overlay(after, "hook")).toMatchObject({ position: hook.position, size: 66 });
    // Nothing else moved: the captions, the words and the times are the same.
    expect(after.tracks.captions).toEqual(before.tracks.captions);
    expect(after.tracks.sounds).toEqual(before.tracks.sounds);
    expect(after.font_pair).toBe(before.font_pair);
    // The edited version is not rewritten.
    expect(await storage.get(rows.get(placedId)!.r2_key)).toEqual(beforeBytes);
    expect(rows.get(placedId)!.edited_from_id ?? null).toBeNull();
  });

  it("keeps a learning record per moved component: the engine's box, the owner's and the moment", async () => {
    const before = await editOf(placedId);
    const accent = overlay(before, "accent-1");
    const hook = overlay(before, "hook");
    await ownerEditRun({
      versionId: placedId,
      moves: [
        { id: "accent-1", x: 120, y: 900, size: accent.size },
        // Named, but where it already is: no record.
        { id: "hook", x: hook.position.x, y: hook.position.y, size: hook.size },
      ],
    });
    const { owner_moves: records } = rows.get(current!)!;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      item: "accent-1",
      component: "ACCENT",
      variant: "accent/above-head",
      engine_version_id: placedId,
      engine: { x: accent.position.x, y: accent.position.y, size: accent.size },
      owner: { x: 120, y: 900, size: accent.size },
      moved: true,
      resized: false,
    });
    expect(records[0]!.text.length).toBeGreaterThan(0);
    expect(records[0]!.context.frame).toEqual({ width: 1080, height: 1920 });
    expect(records[0]!.context.font_pair).toBe("classic");
    expect(records[0]!.context.others.length).toBeGreaterThan(0);
  });

  it("sets a text's lines again to the wrap width an edge handle gave, and records it as a resize", async () => {
    const before = await editOf(placedId);
    const hook = overlay(before, "hook");
    await ownerEditRun({
      versionId: placedId,
      moves: [{ id: "hook", x: hook.position.x, y: hook.position.y, size: hook.size, width: 300 }],
    });
    const saved = overlay(await editOf(current!), "hook");
    expect(saved.size).toBe(hook.size);
    expect(saved.text).toBe(hook.text);
    expect(saved.breaks?.length ?? 0).toBeGreaterThan(hook.breaks?.length ?? 0);
    const { owner_moves: records } = rows.get(current!)!;
    expect(records[0]).toMatchObject({
      item: "hook",
      moved: false,
      resized: true,
      wrap_width: 300,
    });
  });

  it("copies the AI record under the new version, so a later re-layout finds the answer", async () => {
    await ownerEditRun({
      versionId: placedId,
      moves: [{ id: "accent-1", x: 120, y: 900, size: 110 }],
    });
    const copied = await storage.get(aiRecordKey(PREFIX, REEL, current!));
    expect(copied).not.toBeNull();
    const record = JSON.parse(new TextDecoder().decode(copied!)) as AiRecord;
    expect(record.version_id).toBe(current);
    expect(record.calls.map((call) => call.role)).toEqual(["hook", "decide"]);
  });

  it("edits an earlier version too: the new version comes after the current one", async () => {
    await runRestore({ ...deps(), versionId: firstId });
    const restored = current!;
    await ownerEditRun({
      versionId: placedId,
      moves: [{ id: "accent-1", x: 120, y: 900, size: 110 }],
    });
    expect(rows.get(current!)).toMatchObject({
      number: 4,
      parent_id: restored,
      edited_from_id: placedId,
    });
    expect(overlay(await editOf(current!), "accent-1").position).toMatchObject({ x: 120, y: 900 });
  });

  it("reads the engine's box from the engine-placed version when the owner edits their own edit again", async () => {
    const accent = overlay(await editOf(placedId), "accent-1");
    await ownerEditRun({
      versionId: placedId,
      moves: [{ id: "accent-1", x: 120, y: 900, size: accent.size }],
    });
    const firstEdit = current!;
    await ownerEditRun({
      versionId: firstEdit,
      moves: [{ id: "accent-1", x: 200, y: 1000, size: 77 }],
    });
    const saved = rows.get(current!)!;
    expect(saved).toMatchObject({ number: 4, parent_id: firstEdit, edited_from_id: firstEdit });
    expect(saved.owner_moves).toHaveLength(1);
    expect(saved.owner_moves[0]).toMatchObject({
      engine_version_id: placedId,
      engine: { x: accent.position.x, y: accent.position.y, size: accent.size },
      owner: { x: 200, y: 1000, size: 77 },
      moved: true,
      resized: true,
    });
  });

  it("moves and scales a VISUAL as a box, keeping its picture's aspect ratio, and records it", async () => {
    const withVisual = await placeVisualVersion();
    const visualOf = async (id: string) => {
      const item = (await editOf(id)).tracks.behind?.find((entry) => entry.kind === "visual");
      if (item?.kind !== "visual") throw new Error("no visual");
      return item;
    };
    const before = await visualOf(withVisual);
    const width = Math.round(before.box.width * 0.75);
    await ownerEditRun({
      versionId: withVisual,
      moves: [{ id: before.id, kind: "box", x: 120, y: 600, width }],
    });
    const after = await visualOf(current!);
    expect(after.box.x).toBe(120);
    expect(after.box.y).toBe(600);
    expect(after.box.width).toBe(width);
    expect(
      Math.abs(after.box.height / after.box.width - before.box.height / before.box.width),
    ).toBeLessThan(0.01);
    expect(after.image).toBe(before.image);
    const { owner_moves: records } = rows.get(current!)!;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      item: before.id,
      component: "VISUAL",
      engine: { ...before.box, size: null },
      owner: { ...after.box, size: null },
      moved: true,
      resized: true,
      rotated: false,
      engine_rotation: 0,
      owner_rotation: 0,
      wrap_width: null,
    });
    // The owner's version edited again: the card turned, its box kept. The
    // record compares with the engine's upright card.
    const scaled = current!;
    await ownerEditRun({
      versionId: scaled,
      moves: [{ id: before.id, kind: "box", x: 120, y: 600, width, rotation: -15 }],
    });
    const turned = await visualOf(current!);
    expect(turned.box).toEqual(after.box);
    expect(turned.rotation).toBe(-15);
    const { owner_moves: turnRecords } = rows.get(current!)!;
    expect(turnRecords[0]).toMatchObject({
      item: before.id,
      engine: { ...before.box, size: null },
      owner: { ...after.box, size: null },
      rotated: true,
      engine_rotation: 0,
      owner_rotation: -15,
    });
    // A card is free of the safe zone: dragged into the bottom right corner,
    // over the buttons' notch and partly past the frame's edge, it is saved.
    await ownerEditRun({
      versionId: current!,
      moves: [{ id: before.id, kind: "box", x: 900, y: 1700, width, rotation: 0 }],
    });
    const corner = await visualOf(current!);
    expect(corner.box).toMatchObject({ x: 900, y: 1700, width });
    expect(corner.box.x + corner.box.width).toBeGreaterThan(1080);
    // Less than a fifth of it inside the frame is refused, and nothing is saved.
    const saved = rows.size;
    const reason = await refusal(
      ownerEditRun({
        versionId: current!,
        moves: [{ id: before.id, kind: "box", x: 1050, y: 1880, width }],
      }),
    );
    expect(reason).toMatch(/less than a fifth of it is inside the frame/);
    expect(rows.size).toBe(saved);
  });

  it("swaps a VISUAL's picture for a library photo the worker reads and sizes itself, and records the swap", async () => {
    const withVisual = await placeVisualVersion();
    const before = (await editOf(withVisual)).tracks.behind!.find((item) => item.kind === "visual");
    if (before?.kind !== "visual") throw new Error("no visual");
    await ownerEditRun({
      versionId: withVisual,
      moves: [
        {
          id: before.id,
          kind: "box",
          x: before.box.x,
          y: before.box.y,
          width: before.box.width,
          photo_id: PHOTO.id,
        },
      ],
    });
    const saved = await editOf(current!);
    const card = saved.tracks.behind!.find((item) => item.id === before.id);
    expect(card).toMatchObject({
      photo: { id: PHOTO.id, width: 1600, height: 900 },
      box: {
        x: before.box.x,
        y: before.box.y,
        width: before.box.width,
        height: Math.round((before.box.width * 900) / 1600),
      },
    });
    expect(card && "image" in card).toBe(false);
    expect(saved.inputs.photos).toEqual([PHOTO.id]);
    const { owner_moves: records } = rows.get(current!)!;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      item: before.id,
      component: "VISUAL",
      swapped: true,
      added: false,
      photo_id: PHOTO.id,
      replaced: before.image,
      context: { photo: { description: PHOTO.description, tags: PHOTO.tags } },
    });
    expect(records[0]!.context.words.length).toBeGreaterThan(0);
  });

  it("adds a card showing a library photo over the engine's card, with a click only when no other is near, and records it as added", async () => {
    const withVisual = await placeVisualVersion();
    const engineCard = (await editOf(withVisual)).tracks.behind!.find(
      (item) => item.kind === "visual",
    )!;
    const word = transcript.words.find((entry) => entry.id === "w0004")!;
    await ownerEditRun({
      versionId: withVisual,
      moves: [],
      adds: [
        { id: "owner-visual-1", photo_id: PHOTO.id, word: word.id, x: 600, y: 300, width: 360 },
      ],
    });
    const saved = await editOf(current!);
    const added = saved.tracks.behind!.at(-1)!;
    // Last in the track: drawn on top of the engine's card.
    expect(added).toMatchObject({
      id: "owner-visual-1",
      kind: "visual",
      start: { word: word.id },
      photo: { id: PHOTO.id, width: 1600, height: 900 },
      box: { x: 600, y: 300, width: 360, height: 203 },
    });
    expect(saved.tracks.behind!.map((item) => item.id)).toEqual([engineCard.id, "owner-visual-1"]);
    expect(saved.inputs.photos).toEqual([PHOTO.id]);
    // Its click: more than the gap from the engine card's click at w0001.
    expect(saved.tracks.sounds.map((sound) => sound.id)).toContain("click-owner-visual-1");
    const { owner_moves: records } = rows.get(current!)!;
    expect(records).toEqual([
      expect.objectContaining({
        item: "owner-visual-1",
        component: "VISUAL",
        added: true,
        engine: null,
        moved: false,
        resized: false,
        swapped: false,
        photo_id: PHOTO.id,
        replaced: null,
      }),
    ]);
    expect(records[0]!.context.others.map((other) => other.item)).toContain(engineCard.id);

    // A second card on the engine card's first word: its click would be
    // within the gap of that card's, so it gets none.
    const first = current!;
    await ownerEditRun({
      versionId: first,
      moves: [],
      adds: [
        { id: "owner-visual-2", photo_id: PHOTO.id, word: "w0001", x: 600, y: 900, width: 300 },
      ],
    });
    const again = await editOf(current!);
    expect(again.tracks.behind!.map((item) => item.id)).toEqual([
      engineCard.id,
      "owner-visual-1",
      "owner-visual-2",
    ]);
    expect(again.tracks.sounds.map((sound) => sound.id)).not.toContain("click-owner-visual-2");
  });

  it("refuses a photo that is not a ready photo in the owner's library, writing no version", async () => {
    const withVisual = await placeVisualVersion();
    const saved = rows.size;
    const reason = await refusal(
      ownerEditRun({
        versionId: withVisual,
        moves: [],
        adds: [
          {
            id: "owner-visual-1",
            photo_id: "00000000-0000-4000-8000-00000000abcd",
            word: "w0004",
            x: 600,
            y: 300,
            width: 360,
          },
        ],
      }),
    );
    expect(reason).toMatch(/is not a ready photo in the owner's library/);
    expect(rows.size).toBe(saved);
  });

  it("moves a caption block: every caption of the sentence, recorded as CAPTION against the engine's box", async () => {
    const before = await editOf(placedId);
    const block = captionBlocks(before, transcript)[0]!;
    const own = new Set(block.groups.flatMap((group) => group.captions));
    const first = before.tracks.captions.find((item) => item.id === block.groups[0]!.id)!;
    const corner = {
      x: Math.min(
        ...before.tracks.captions
          .filter((item) => own.has(item.id))
          .map((item) => item.position!.x),
      ),
      y: first.position!.y,
    };
    await ownerEditRun({
      versionId: placedId,
      moves: [{ id: block.id, x: corner.x, y: corner.y - 100, size: first.size! }],
    });
    expect(rows.size).toBe(3);
    const after = await editOf(current!);
    for (const item of after.tracks.captions) {
      const was = before.tracks.captions.find((entry) => entry.id === item.id)!;
      if (!own.has(item.id)) {
        expect(item).toEqual(was);
        continue;
      }
      expect(item.position).toEqual({
        x: was.position!.x,
        y: was.position!.y - 100,
        align: "left",
      });
      expect({ ...item, position: null }).toEqual({ ...was, position: null });
    }
    expect(after.tracks.overlays).toEqual(before.tracks.overlays);
    const { owner_moves: records } = rows.get(current!)!;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      item: block.id,
      component: "CAPTION",
      variant: "caption/default",
      engine_version_id: placedId,
      engine: { x: corner.x, y: corner.y, size: first.size },
      owner: { x: corner.x, y: corner.y - 100, size: first.size },
      moved: true,
      resized: false,
      wrap_width: null,
    });
    expect(records[0]!.context.others.some((other) => own.has(other.item))).toBe(false);
    // The safe zone binds it like any text.
    expect(
      await refusal(
        ownerEditRun({
          versionId: placedId,
          moves: [{ id: block.id, x: 0, y: corner.y, size: first.size! }],
        }),
      ),
    ).toMatch(/runs past the safe zone/);
    expect(rows.size).toBe(3);
  });

  it("refuses a move that leaves the safe zone, writing no version", async () => {
    const reason = await refusal(
      ownerEditRun({ versionId: placedId, moves: [{ id: "accent-1", x: 0, y: 900, size: 110 }] }),
    );
    expect(reason).toMatch(/accent-1: runs past the safe zone/);
    expect(rows.size).toBe(2);
    expect(current).toBe(placedId);
  });

  it("refuses a single caption, an unknown component and a size under 30 px", async () => {
    const caption = (await editOf(placedId)).tracks.captions[0]!.id;
    expect(
      await refusal(
        ownerEditRun({ versionId: placedId, moves: [{ id: caption, x: 100, y: 900, size: 50 }] }),
      ),
    ).toMatch(/not a text component of this version/);
    expect(
      await refusal(
        ownerEditRun({ versionId: placedId, moves: [{ id: "accent-9", x: 1, y: 900, size: 50 }] }),
      ),
    ).toMatch(/accent-9: not a text component of this version/);
    expect(
      await refusal(
        ownerEditRun({ versionId: placedId, moves: [{ id: "hook", x: 100, y: 900, size: 12 }] }),
      ),
    ).toMatch(/hook: size 12 is outside 30 to 400 px/);
    expect(rows.size).toBe(2);
  });

  it("refuses a save that moves nothing", async () => {
    const hook = overlay(await editOf(placedId), "hook");
    const reason = await refusal(
      ownerEditRun({
        versionId: placedId,
        moves: [{ id: "hook", x: hook.position.x, y: hook.position.y, size: hook.size }],
      }),
    );
    expect(reason).toMatch(/nothing was moved, resized or edited/);
    expect(rows.size).toBe(2);
  });

  it("refuses a version that is not one of the reel's", async () => {
    const reason = await refusal(
      ownerEditRun({
        versionId: "99999999-9999-4999-8999-999999999999",
        moves: [{ id: "hook", x: 100, y: 900, size: 50 }],
      }),
    );
    expect(reason).toMatch(/is not a version of this reel/);
    expect(rows.size).toBe(2);
  });
});
