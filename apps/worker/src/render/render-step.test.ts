import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
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
import { withMasks } from "../cutout/spans.ts";
import { keepLease } from "../lease.ts";
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

  it("fails the step naming a missing footage file and records nothing", async () => {
    const key = cacheKey(
      PREFIX,
      inputs.footage.step,
      inputs.footage.fingerprint,
      inputs.footage.file,
    );
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

describe("runRender with a behind big word", () => {
  let projectFiles: string[];

  // The fixture edit with one big word behind the speaker over its whole speech,
  // and its mask stored. A VISUAL would name no file; a big word has a mask.
  beforeEach(async () => {
    const { edit, transcript } = await fixtureEdit();
    const behind = withMasks(
      {
        ...edit,
        tracks: {
          ...edit.tracks,
          behind: [
            {
              id: "behind-word",
              kind: "word",
              text: "WORK",
              position: { x: 100, y: 700 },
              size: 200,
              start: { word: "w0001" },
              end: { word: "w0010", edge: "end" },
            },
          ],
        },
      },
      transcript,
    );
    await storage.put(version.r2_key, editBytes(behind));
    version = { ...version, inputs: behind.inputs };
    for (const mask of behind.inputs.masks!) {
      await storage.put(
        cacheKey(PREFIX, mask.step, mask.fingerprint, mask.file),
        new TextEncoder().encode("mask"),
      );
    }
    projectFiles = [];
  });

  function runBehind() {
    const { steps, calls } = recordingSteps();
    const spawnTool: SpawnTool = async (call) => {
      if (call.args.includes("-o")) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
        projectFiles = await readdir(join(call.args[2]!), { recursive: true });
      }
      return fakeSpawn(call, new AbortController().signal, () => {});
    };
    const done = runRender({
      ctx: stepContext(steps, { job: JOB }),
      storage,
      rows,
      exports: exportsStore,
      keyPrefix: PREFIX,
      scratchDir: join(root, "scratch"),
      tools: TOOLS,
      versionId: VERSION_ID,
      ensureInputs: async () => {},
      newId: () => EXPORT_ID,
      spawnTool,
      env: {},
      cutouts: {
        storage,
        keyPrefix: PREFIX,
        scratchDir: join(root, "scratch"),
        tools: TOOLS,
        spawnTool,
      },
    });
    return { done, calls };
  }

  it("reuses the stored mask and places only the mask in the project", async () => {
    const { done, calls } = runBehind();
    await done;
    expect(calls[0]).toMatchObject({ call: "skipped", name: "cutout", summary: "cut-out reused" });
    const [mask] = version.inputs.masks!;
    expect(projectHtml).toContain(`src="masks/${mask!.fingerprint}.mp4"`);
    expect(projectHtml).not.toContain("photos/");
    expect(projectFiles).toEqual(expect.arrayContaining([`masks/${mask!.fingerprint}.mp4`]));
    expect(projectFiles.some((file) => file.startsWith("photos"))).toBe(false);
    expect(inserted).toHaveLength(1);
  });
});

// The owner closes the export (cancel_job): the lease keeper's cancel check
// aborts the signal, as in runJob.
describe("runRender cancelled", () => {
  const KEY = `${PREFIX}exports/${TEST_JOB.reel_id}/${EXPORT_ID}.mp4`;

  // Processes whose command line names this test's temp folder (the render
  // double's output is inside it).
  async function childrenOf(folder: string): Promise<string[]> {
    const { stdout } = await promisify(execFile)("ps", ["-ax", "-o", "command="]);
    return stdout.split("\n").filter((line) => line.includes(folder));
  }

  function cancellable(cancelledNow: () => boolean) {
    const lease = keepLease({
      renew: async () => true,
      everyMs: 60_000,
      cancelled: async () => cancelledNow(),
      cancelCheckEveryMs: 50,
    });
    return lease;
  }

  it("aborts the running render, kills its child and writes no export row and no object", async () => {
    const { steps, calls } = recordingSteps();
    // The cancel lands once the render reported progress.
    const lease = cancellable(() => calls.some((call) => call.call === "progress"));
    const discarded: string[] = [];
    const started = performance.now();
    try {
      await expect(
        runRender({
          ctx: stepContext(steps, {
            job: JOB,
            signal: lease.signal,
            checkCancelled: () => lease.checkCancelled(),
          }),
          storage,
          rows,
          exports: exportsStore,
          keyPrefix: PREFIX,
          scratchDir: join(root, "scratch"),
          tools: TOOLS,
          versionId: VERSION_ID,
          ensureInputs: async () => {},
          newId: () => EXPORT_ID,
          // The real child process: the render double replays its progress
          // over 30 seconds unless it is killed.
          env: { E2E_MOCK_RENDER: "true", E2E_MOCK_RENDER_SECONDS: "30" },
          discardExport: async (key) => {
            discarded.push(key);
          },
        }),
      ).rejects.toMatchObject({ name: "JobCancelled" });
    } finally {
      lease.stop();
    }
    // Stopped within seconds, not after the double's 30.
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(await childrenOf(root)).toEqual([]);
    // The step row stays as the abort left it: started, some progress, no
    // done or failed row.
    expect(calls.map((call) => call.call)).toContain("start");
    expect(calls.some((call) => call.call === "done" || call.call === "failed")).toBe(false);
    expect(inserted).toEqual([]);
    expect(await storage.list(`${PREFIX}exports/`)).toEqual([]);
    expect(discarded).toEqual([]);
  }, 30_000);

  it("stops before the render step when the cancel came before it", async () => {
    const { steps, calls } = recordingSteps();
    let cancelledNow = false;
    const lease = cancellable(() => cancelledNow);
    try {
      await expect(
        runRender({
          ctx: stepContext(steps, {
            job: JOB,
            signal: lease.signal,
            checkCancelled: () => lease.checkCancelled(),
          }),
          storage,
          rows,
          exports: exportsStore,
          keyPrefix: PREFIX,
          scratchDir: join(root, "scratch"),
          tools: TOOLS,
          versionId: VERSION_ID,
          // The pipeline's hits run, then the owner cancels.
          ensureInputs: async () => {
            cancelledNow = true;
          },
          newId: () => EXPORT_ID,
          spawnTool: fakeSpawn,
          env: {},
        }),
      ).rejects.toMatchObject({ name: "JobCancelled" });
    } finally {
      lease.stop();
    }
    expect(calls).toEqual([]);
    expect(spawned).toEqual([]);
    expect(inserted).toEqual([]);
    expect(await storage.list(`${PREFIX}exports/`)).toEqual([]);
  });

  it("discards the uploaded file when the export row is refused for a cancelled job", async () => {
    const { steps, calls } = recordingSteps();
    let cancelledNow = false;
    const lease = cancellable(() => cancelledNow);
    const discarded: string[] = [];
    try {
      await expect(
        runRender({
          ctx: stepContext(steps, {
            job: JOB,
            signal: lease.signal,
            checkCancelled: () => lease.checkCancelled(),
          }),
          storage,
          rows,
          // The database refuses the row: the owner cancelled after the upload.
          exports: {
            async forJob() {
              return null;
            },
            async insert() {
              cancelledNow = true;
              throw new Error("export refused: the job was cancelled");
            },
          },
          keyPrefix: PREFIX,
          scratchDir: join(root, "scratch"),
          tools: TOOLS,
          versionId: VERSION_ID,
          ensureInputs: async () => {},
          newId: () => EXPORT_ID,
          spawnTool: fakeSpawn,
          env: {},
          discardExport: async (key) => {
            discarded.push(key);
            await storage.delete(key);
          },
        }),
      ).rejects.toThrow(/cancelled/);
    } finally {
      lease.stop();
    }
    expect(discarded).toEqual([KEY]);
    expect(await storage.list(`${PREFIX}exports/`)).toEqual([]);
    // Aborted, so the step wrote no done or failed row.
    expect(calls.some((call) => call.call === "done" || call.call === "failed")).toBe(false);
  });
});
