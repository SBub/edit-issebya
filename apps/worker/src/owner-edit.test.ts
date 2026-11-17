import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Edit,
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

function ownerEditRun(ownerEdit: OwnerEdit) {
  return runOwnerEdit({ ...deps(), ownerEdit });
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
    // Version 3: the committed answer with one VISUAL over the sentence instead
    // of the accent (on the short clip the accent holds the screen), placed by
    // the engine. Records are never rewritten: the test swaps version 2's.
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
    const withVisual = current!;
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
  });

  it("refuses a move that leaves the safe zone, writing no version", async () => {
    const reason = await refusal(
      ownerEditRun({ versionId: placedId, moves: [{ id: "accent-1", x: 0, y: 900, size: 110 }] }),
    );
    expect(reason).toMatch(/accent-1: runs past the safe zone/);
    expect(rows.size).toBe(2);
    expect(current).toBe(placedId);
  });

  it("refuses a caption, an unknown component and a size under 30 px", async () => {
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
    expect(reason).toMatch(/nothing was moved or resized/);
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
