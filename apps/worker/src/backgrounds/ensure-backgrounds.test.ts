import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backgroundMapSchema } from "@edit-issebya/edit";
import { type Storage, fakeStorage } from "@edit-issebya/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheKey } from "../pipeline/fingerprint.ts";
import { recordingSteps, stepContext } from "../recording-steps.ts";
import type { SpawnTool, ToolCall } from "../step-runner.ts";
import { classifyKey } from "../stored-files.ts";
import { BACKGROUND_SETTINGS } from "./background-map.ts";
import { backgroundsFingerprint, backgroundsKey, ensureBackgrounds } from "./ensure-backgrounds.ts";

const PREFIX = "dev/";
const FOOTAGE = { step: "retime", fingerprint: "a".repeat(64), file: "source.mp4" };
const tools = {
  ffmpeg: "ffmpeg",
  ffprobe: "ffprobe",
  hyperframes: ["node", "hf.mjs"] as [string, string],
};

let root: string;
let scratch: string;
let storage: Storage;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "backgrounds-storage-"));
  scratch = await mkdtemp(join(tmpdir(), "backgrounds-scratch-"));
  storage = fakeStorage({ root, uploadUrlBase: "" });
  await storage.put(
    cacheKey(PREFIX, FOOTAGE.step, FOOTAGE.fingerprint, FOOTAGE.file),
    new TextEncoder().encode("footage"),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

// ffmpeg's double: three mid-grey frames written to its last argument.
function fakeFfmpeg(): { spawnTool: SpawnTool; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  const spawnTool: SpawnTool = async (call) => {
    calls.push(call);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's temp folder
    await writeFile(call.args.at(-1)!, Buffer.alloc(36 * 64 * 3 * 3, 128));
    return { code: 0, exitSignal: null, report: "", output: "", stdout: "", groupPeakBytes: null };
  };
  return { spawnTool, calls };
}

async function ensure(recordStored?: (key: string, bytes: number) => Promise<void>) {
  const { steps, calls } = recordingSteps();
  const spawn = fakeFfmpeg();
  const map = await ensureBackgrounds({
    ctx: stepContext(steps),
    storage,
    keyPrefix: PREFIX,
    scratchDir: scratch,
    footage: FOOTAGE,
    tools,
    spawnTool: spawn.spawnTool,
    recordStored,
  });
  return { map, calls, toolCalls: spawn.calls };
}

describe("ensureBackgrounds", () => {
  it("samples the footage once in a backgrounds step and stores the map under its fingerprint", async () => {
    const { map, calls, toolCalls } = await ensure();
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.file).toBe("ffmpeg");
    expect(toolCalls[0]!.args).toContain("fps=2,scale=36:64:flags=area,format=rgb24");
    expect(map.frames).toHaveLength(3);
    const key = backgroundsKey(PREFIX, FOOTAGE);
    expect(key).toBe(`dev/cache/backgrounds/${backgroundsFingerprint(FOOTAGE)}/backgrounds.json`);
    const stored = JSON.parse(new TextDecoder().decode((await storage.get(key))!)) as unknown;
    expect(backgroundMapSchema.parse(stored)).toEqual(map);
    expect(calls.filter((call) => call.call === "start").map((call) => call.name)).toEqual([
      "backgrounds",
    ]);
    expect(calls.find((call) => call.call === "done")).toMatchObject({
      summary: expect.stringMatching(/^backgrounds of 3 frames/),
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's temp folder
    expect(await readdir(scratch)).toEqual([]);
  });

  it("reuses a stored map: no ffmpeg, a hit row, its size recorded", async () => {
    const made = (await ensure()).map;
    const recorded: [string, number][] = [];
    const { map, calls, toolCalls } = await ensure(async (key, bytes) => {
      recorded.push([key, bytes]);
    });
    expect(toolCalls).toHaveLength(0);
    expect(map).toEqual(made);
    expect(calls).toEqual([
      expect.objectContaining({
        call: "skipped",
        name: "backgrounds",
        summary: "backgrounds reused",
      }),
    ]);
    const key = backgroundsKey(PREFIX, FOOTAGE);
    expect(recorded).toEqual([[key, (await storage.head(key))!.bytes]]);
  });

  it("is a new map for new footage or new settings, rebuildable in storage", () => {
    const fp = backgroundsFingerprint(FOOTAGE);
    expect(backgroundsFingerprint({ ...FOOTAGE, fingerprint: "b".repeat(64) })).not.toBe(fp);
    expect(BACKGROUND_SETTINGS).toEqual({ everySeconds: 0.5, columns: 36, rows: 64 });
    expect(classifyKey(PREFIX, backgroundsKey(PREFIX, FOOTAGE))).toEqual({
      kind: "rebuildable",
      step: "backgrounds",
    });
  });

  it("fails the step when the footage is missing", async () => {
    await storage.delete(cacheKey(PREFIX, FOOTAGE.step, FOOTAGE.fingerprint, FOOTAGE.file));
    await expect(ensure()).rejects.toThrow(/input missing/);
  });
});
