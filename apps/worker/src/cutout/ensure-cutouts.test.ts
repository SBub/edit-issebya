import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Storage, fakeStorage } from "@edit-issebya/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheKey } from "../pipeline/fingerprint.ts";
import { recordingSteps, stepContext } from "../recording-steps.ts";
import { classifyKey, recordingStorage } from "../stored-files.ts";
import { ensureCutouts } from "./ensure-cutouts.ts";
import { cutoutKey, plannedMasks } from "./spans.ts";
import { BEHIND_PHOTO, BEHIND_TRANSCRIPT, behindEdit, fakeMaskSpawn } from "./test-support.ts";

const PREFIX = "dev/";
const tools = {
  ffmpeg: "ffmpeg",
  ffprobe: "ffprobe",
  hyperframes: ["node", "hf.mjs"] as [string, string],
};

let root: string;
let scratch: string;
let storage: Storage;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cutout-storage-"));
  scratch = await mkdtemp(join(tmpdir(), "cutout-scratch-"));
  storage = fakeStorage({ root, uploadUrlBase: "" });
  const footage = behindEdit().inputs.footage;
  await storage.put(
    cacheKey(PREFIX, footage.step, footage.fingerprint, footage.file),
    new TextEncoder().encode("footage"),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

const keys = () =>
  plannedMasks(behindEdit(), BEHIND_TRANSCRIPT).map((mask) => cutoutKey(PREFIX, mask.fingerprint));

async function ensure(
  edit = behindEdit(),
  options: {
    photoIds?: string[];
    recordStored?: (key: string, bytes: number) => Promise<void>;
  } = {},
) {
  const { steps, calls } = recordingSteps();
  const spawn = fakeMaskSpawn();
  const result = await ensureCutouts({
    ctx: stepContext(steps),
    storage,
    keyPrefix: PREFIX,
    scratchDir: scratch,
    edit,
    transcript: BEHIND_TRANSCRIPT,
    photoIds: options.photoIds ?? [BEHIND_PHOTO],
    tools,
    spawnTool: spawn.spawnTool,
    env: { E2E_MOCK_MASK: "true" },
    recordStored: options.recordStored,
  });
  return { result, calls, toolCalls: spawn.calls };
}

const text = async (key: string) => new TextDecoder().decode((await storage.get(key)) ?? undefined);

describe("ensureCutouts", () => {
  it("makes every missing mask in one cutout step and names them in the inputs", async () => {
    const { result, calls, toolCalls } = await ensure();
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]!.args).toContain("5.100");
    expect(result.inputs.masks).toEqual(plannedMasks(behindEdit(), BEHIND_TRANSCRIPT));
    expect(result.inputs.photos).toEqual([BEHIND_PHOTO]);
    for (const key of keys()) expect(await storage.head(key)).not.toBeNull();
    const done = calls.filter((call) => call.call === "done");
    expect(calls.filter((call) => call.call === "start").map((call) => call.name)).toEqual([
      "cutout",
    ]);
    expect(done[0]!.summary).toMatch(/^2 cut-outs made, 0 reused, 5\.6 s masked/);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's temp folder
    expect(await readdir(scratch)).toEqual([]);
  });

  it("weights each span's frame progress by its length, so the step's progress keeps rising", async () => {
    const { toolCalls } = await ensure();
    const at = (index: number, pct: number) =>
      toolCalls[index]!.progress!(`@hf-progress {"pct":${pct}}`);
    // The spans are 2.867 s and 2.766 s long.
    expect([at(0, 0), at(0, 100), at(1, 0), at(1, 100)]).toEqual([0, 51, 51, 100]);
  });

  it("reuses stored masks: no spawn, a hit row, each recorded", async () => {
    for (const key of keys()) await storage.put(key, new TextEncoder().encode("stored"));
    const recorded: string[] = [];
    const { calls, toolCalls, result } = await ensure(behindEdit(), {
      recordStored: async (key) => {
        recorded.push(key);
      },
    });
    expect(toolCalls).toHaveLength(0);
    expect(calls).toEqual([
      expect.objectContaining({ call: "skipped", name: "cutout", summary: "cut-out reused" }),
    ]);
    expect(recorded).toEqual(keys());
    expect(result.inputs.masks).toHaveLength(2);
  });

  it("makes only the missing one and never overwrites a stored mask", async () => {
    const [first, second] = keys();
    await storage.put(first!, new TextEncoder().encode("stored"));
    const { toolCalls, calls } = await ensure();
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.args).toContain("19.967");
    expect(await text(first!)).toBe("stored");
    expect(await text(second!)).toBe("mask 1");
    expect(calls.find((call) => call.call === "done")).toMatchObject({
      summary: expect.stringMatching(/^1 cut-out made, 1 reused, 2\.8 s masked/),
    });
  });

  it("writes no row and names no masks without behind items", async () => {
    const edit = behindEdit();
    delete edit.tracks.behind;
    edit.inputs.masks = plannedMasks(behindEdit(), BEHIND_TRANSCRIPT);
    const { result, calls, toolCalls } = await ensure(edit);
    expect(calls).toEqual([]);
    expect(toolCalls).toEqual([]);
    expect(result.inputs).not.toHaveProperty("masks");
    expect(result.inputs).not.toHaveProperty("photos");
  });

  it("writes no row and names no masks for photos in front of the speaker only", async () => {
    const edit = behindEdit();
    edit.tracks.behind = edit.tracks.behind!.flatMap((item) =>
      item.kind === "photo" ? [{ ...item, layer: "front" as const }] : [],
    );
    const { result, calls, toolCalls } = await ensure(edit);
    expect(calls).toEqual([]);
    expect(toolCalls).toEqual([]);
    expect(result.inputs).not.toHaveProperty("masks");
    expect(result.inputs.photos).toEqual([BEHIND_PHOTO]);
    // Still only the owner's library photos.
    await expect(ensure(edit, { photoIds: [] })).rejects.toThrow(
      `cutout: photo ${BEHIND_PHOTO} is not in the library`,
    );
  });

  it("refuses a photo that is not in the owner's library", async () => {
    await expect(ensure(behindEdit(), { photoIds: [] })).rejects.toThrow(
      `cutout: photo ${BEHIND_PHOTO} is not in the library`,
    );
  });

  it("records each written mask as rebuildable, step cutout", async () => {
    const rows: { key: string; kind: string; step: string }[] = [];
    storage = recordingStorage(storage, {
      records: {
        async record(row) {
          rows.push({ key: row.key, kind: row.kind, step: row.step });
        },
        async slimRebuildable() {
          return [];
        },
        async expireExports() {
          return [];
        },
      },
      target: { reelId: "00000000-0000-4000-8000-000000000001" },
      keyPrefix: PREFIX,
    });
    await ensure();
    expect(rows).toEqual(keys().map((key) => ({ key, kind: "rebuildable", step: "cutout" })));
    expect(classifyKey(PREFIX, keys()[0]!)).toEqual({ kind: "rebuildable", step: "cutout" });
  });
});
