import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EditInputs,
  ISSEBYA_PRESET,
  type StoredVersion,
  type VersionRows,
  build,
  editBytes,
  versionKey,
} from "@edit-issebya/edit";
import { type Storage, fakeStorage } from "@edit-issebya/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editMeasurer } from "../edit-measurer.ts";
import { cacheKey } from "../pipeline/fingerprint.ts";
import type { ToolPaths } from "../pipeline/tools.ts";
import { TEST_JOB, recordingSteps, stepContext } from "../recording-steps.ts";
import type { ChildRun, SpawnTool, ToolCall } from "../step-runner.ts";
import type { ExportStore, NewExport } from "./export-store.ts";
import { FAKE_RENDER, STUB_EXPORT } from "./render-call.ts";
import { runRender } from "./render-step.ts";
import { fixtureEdit, fixtureManifest, fixturePath } from "./render-test-support.ts";

const PREFIX = "dev/";
const VERSION_ID = "9d7c1f5e-3a2b-4c6d-8e9f-0a1b2c3d4e5f";
const EXPORT_ID = "3e0c7b1a-5d2f-4a6e-9b8c-1f2e3d4c5b6a";
const JOB = { ...TEST_JOB, kind: "render", version_id: VERSION_ID };
const TOOLS: ToolPaths = {
  ffmpeg: "ffmpeg",
  ffprobe: "ffprobe",
  hyperframes: ["/usr/bin/node", "/hf/bin/hyperframes.mjs"],
};

let root: string;
let storage: Storage;
let version: StoredVersion;
let spawned: ToolCall[];
let projectHtml: string | null;
let inserted: NewExport[];
let existing: string | null;

const ok = (): ChildRun => ({
  code: 0,
  exitSignal: null,
  report: "",
  output: "",
  stdout: "",
  groupPeakBytes: 300 * 1024 * 1024,
});

// HyperFrames writes some bytes at `-o`; the render double copies the stub.
const fakeSpawn: SpawnTool = async (call) => {
  spawned.push(call);
  if (call.args[0] === FAKE_RENDER) {
    await copyFile(call.args[1]!, call.args[2]!);
  } else {
    const projectDir = call.args[2]!;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    projectHtml = await readFile(join(projectDir, "index.html"), "utf8");
    const output = call.args[call.args.indexOf("-o") + 1]!;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    await writeFile(output, new Uint8Array(2048).fill(7));
  }
  return ok();
};

const rows: VersionRows = {
  async current() {
    return version.id;
  },
  async get(id) {
    return id === version.id ? version : null;
  },
  async save() {
    throw new Error("a render never saves a version");
  },
};

const exportsStore: ExportStore = {
  async forJob() {
    return existing;
  },
  async insert(row) {
    inserted.push(row);
  },
};

let inputs: EditInputs;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "render-step-"));
  storage = fakeStorage({ root: join(root, "store"), uploadUrlBase: "" });
  const manifest = await fixtureManifest();
  for (const step of manifest.steps) {
    for (const file of step.files) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
      const bytes = await readFile(fixturePath(step.name, file));
      await storage.put(cacheKey(PREFIX, step.name, step.fingerprint, file), new Uint8Array(bytes));
    }
  }
  const fixture = await fixtureEdit();
  inputs = fixture.inputs;
  const key = versionKey(PREFIX, TEST_JOB.reel_id, VERSION_ID);
  await storage.put(key, editBytes(fixture.edit));
  version = {
    id: VERSION_ID,
    reel_id: TEST_JOB.reel_id,
    number: 2,
    parent_id: null,
    restored_from_id: null,
    checks: [],
    inputs,
    r2_key: key,
  };
  spawned = [];
  projectHtml = null;
  inserted = [];
  existing = null;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function run(
  steps: ReturnType<typeof recordingSteps>["steps"],
  {
    env = {},
    ensureInputs = vi.fn(async () => {}),
  }: { env?: NodeJS.ProcessEnv; ensureInputs?: () => Promise<unknown> } = {},
) {
  return runRender({
    ctx: stepContext(steps, { job: JOB }),
    storage,
    rows,
    exports: exportsStore,
    keyPrefix: PREFIX,
    scratchDir: join(root, "scratch"),
    tools: TOOLS,
    versionId: VERSION_ID,
    ensureInputs,
    newId: () => EXPORT_ID,
    spawnTool: fakeSpawn,
    env,
  });
}

describe("runRender", () => {
  it("renders the version, uploads the MP4 and records the export", async () => {
    const { steps, calls } = recordingSteps();
    const ensureInputs = vi.fn(async () => {});
    await run(steps, { ensureInputs });

    expect(ensureInputs).toHaveBeenCalledOnce();
    // The render reads progress: 100 lands before the done row.
    expect(calls.map((call) => call.call)).toEqual(["start", "progress", "done"]);
    expect(calls[1]).toEqual({ call: "progress", stepId: "s1", percent: 100 });
    const done = calls[2]!;
    expect(done.call === "done" && done.summary).toMatch(/^exported, under a second, 2\.0 KB$/);
    expect(done.call === "done" && done.measurements.peak_rss_bytes).toBe(300 * 1024 * 1024);
    expect(done.call === "done" && done.measurements.bytes_in).toBeGreaterThan(0);

    const key = `${PREFIX}exports/${TEST_JOB.reel_id}/${EXPORT_ID}.mp4`;
    expect((await storage.head(key))?.bytes).toBe(2048);
    expect(inserted).toEqual([
      {
        id: EXPORT_ID,
        reel_id: TEST_JOB.reel_id,
        owner_id: TEST_JOB.owner_id,
        job_id: TEST_JOB.id,
        version_id: VERSION_ID,
        r2_key: key,
        bytes: 2048,
      },
    ]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.sampleGroupMemory).toBe(true);
    expect(spawned[0]!.args).toContain("--no-browser-gpu");
    // The scratch folder is gone.
    expect(await storage.list(`${PREFIX}exports/`)).toEqual([key]);
  });

  it("renders exactly the page the shared builder makes", async () => {
    await run(recordingSteps().steps);
    const { edit, transcript, headTrack } = await fixtureEdit();
    const { html } = build(edit, transcript, headTrack, ISSEBYA_PRESET, await editMeasurer());
    expect(projectHtml).toBe(html);
  });

  it("copies the stub under the render double", async () => {
    await run(recordingSteps().steps, { env: { E2E_MOCK_RENDER: "true" } });
    expect(spawned[0]!.args[0]).toBe(FAKE_RENDER);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed stub
    expect(inserted[0]!.bytes).toBe((await stat(STUB_EXPORT)).size);
  });

  it("is a hit on a retried job whose export is recorded: nothing spawned or written", async () => {
    existing = EXPORT_ID;
    const { steps, calls } = recordingSteps();
    const ensureInputs = vi.fn(async () => {});
    await run(steps, { ensureInputs });
    expect(calls).toMatchObject([
      { call: "skipped", name: "render", summary: "export kept, reused" },
    ]);
    expect(ensureInputs).not.toHaveBeenCalled();
    expect(spawned).toEqual([]);
    expect(inserted).toEqual([]);
    expect(await storage.list(`${PREFIX}exports/`)).toEqual([]);
  });

  it("fails the step naming a missing cut-out and records nothing", async () => {
    const key = cacheKey(PREFIX, inputs.cutout.step, inputs.cutout.fingerprint, inputs.cutout.file);
    await storage.delete(key);
    const { steps, calls } = recordingSteps();
    await expect(run(steps)).rejects.toThrow(/input missing/);
    const failed = calls.find((call) => call.call === "failed");
    expect(failed?.call === "failed" && failed.tail).toContain(key);
    expect(spawned).toEqual([]);
    expect(inserted).toEqual([]);
  });

  it("refuses a version of another reel", async () => {
    version = { ...version, reel_id: "11111111-2222-4333-8444-555555555555" };
    await expect(run(recordingSteps().steps)).rejects.toThrow(/not a version of this reel/);
    expect(inserted).toEqual([]);
  });
});
