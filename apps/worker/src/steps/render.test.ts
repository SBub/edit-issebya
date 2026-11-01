import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Edit,
  ISSEBYA,
  type Transcript,
  type VersionRow,
  baselineEdit,
  build,
  canonicalJson,
  createMeasurer,
  versionKey,
} from "@edit-issebya/edit";
import { type Storage, cacheKey, fakeStorage } from "@edit-issebya/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExportStore, NewExport } from "../export-store.ts";
import { TEST_JOB, recordingSteps, stepContext } from "../recording-steps.ts";
import type { ChildRun, SpawnTool, ToolCall } from "../step-runner.ts";
import type { ToolPaths } from "../pipeline/tools.ts";
import { exportKey, renderArgs } from "./render-args.ts";
import { render } from "./render.ts";
import { fontBytes } from "./version-io.ts";

const PREFIX = "dev/";
const VERSION_ID = "7d3c1a9e-2b4f-4c6d-8e0a-1f2b3c4d5e6f";
const EXPORT_ID = "3a4b5c6d-7e8f-4a0b-9c1d-2e3f4a5b6c7d";
const JOB = { ...TEST_JOB, kind: "render", version_id: VERSION_ID };
const TOOLS: ToolPaths = {
  ffmpeg: "ffmpeg",
  ffprobe: "ffprobe",
  hyperframes: ["/fake/node", "/fake/hyperframes.mjs"],
};

const fixtures = new URL("../../../../fixtures/pipeline/", import.meta.url);
const manifest = JSON.parse(
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture manifest
  await readFile(new URL("manifest.json", fixtures), "utf8"),
) as { steps: { name: string; fingerprint: string }[] };
const FP = Object.fromEntries(manifest.steps.map((step) => [step.name, step.fingerprint]));
const INPUTS: Edit["inputs"] = {
  footage: FP.retime!,
  transcript: FP.retime!,
  cutout: FP.remove_background!,
  headTrack: FP.head_track!,
};
const TRANSCRIPT = JSON.parse(
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- committed fixture
  await readFile(new URL("retime/transcript.json", fixtures), "utf8"),
) as Transcript;
const HEAD_TRACK = JSON.parse(
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- committed fixture
  await readFile(new URL("head_track/head-track.json", fixtures), "utf8"),
) as unknown;

// The baseline edit with one click on the first word, so the sound track is
// part of the page.
const firstWord = TRANSCRIPT.words[0]!.id;
const EDIT: Edit = (() => {
  const edit = baselineEdit(TRANSCRIPT, INPUTS, ISSEBYA);
  edit.tracks.sounds = [
    {
      id: "s1",
      sound: "click",
      start: { word: firstWord },
      end: { word: firstWord, offset: 0.2 },
    },
  ];
  return edit;
})();

let root: string;
let scratch: string;
let storage: Storage;

function versionRow(overrides: Partial<VersionRow> = {}): VersionRow {
  return {
    id: VERSION_ID,
    reel_id: TEST_JOB.reel_id,
    number: 2,
    parent_id: null,
    restored_from_id: null,
    request: null,
    model: null,
    prompt_version: null,
    change_summary: null,
    checks: { ok: true, reasons: [] },
    inputs: INPUTS,
    r2_key: versionKey(PREFIX, TEST_JOB.reel_id, VERSION_ID),
    used_free_field: false,
    free_field: [],
    unexpressed: [],
    ...overrides,
  };
}

function memoryExports() {
  const rows: NewExport[] = [];
  const store: ExportStore = {
    async insert(row) {
      rows.push(row);
      return { expires_at: "2026-11-02T00:00:00.000Z" };
    },
  };
  return { rows, store };
}

interface SeenProject {
  files: string[];
  html: string;
}

// Plays `hyperframes render`: records the call and the project folder as it
// is at spawn time, then writes `bytes` to the path after `-o`.
function fakeRender(bytes = "mp4 bytes") {
  const calls: ToolCall[] = [];
  const projects: SeenProject[] = [];
  const spawn: SpawnTool = async (call): Promise<ChildRun> => {
    calls.push(call);
    const project = call.args[2]!;
    projects.push({
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      files: (await readdir(project, { recursive: true })).sort(),
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      html: await readFile(join(project, "index.html"), "utf8"),
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    await writeFile(call.args[call.args.indexOf("-o") + 1]!, bytes);
    return { code: 0, exitSignal: null, report: "", output: "", stdout: "", groupPeakBytes: null };
  };
  return { spawn, calls, projects };
}

function run({
  row = versionRow(),
  versionId = VERSION_ID as string | null,
  spawn = fakeRender().spawn,
  signal,
}: {
  row?: VersionRow | null;
  versionId?: string | null;
  spawn?: SpawnTool;
  signal?: AbortSignal;
} = {}) {
  const { steps, calls } = recordingSteps();
  const exportsStore = memoryExports();
  const done = render({
    ctx: stepContext(steps, { job: JOB, ...(signal ? { signal } : {}) }),
    storage,
    keyPrefix: PREFIX,
    scratchDir: scratch,
    tools: TOOLS,
    versions: { get: async (id) => (row && row.id === id ? row : null) },
    exportsStore: exportsStore.store,
    versionId,
    spawnTool: spawn,
    newId: () => EXPORT_ID,
    rebuild: async () => {
      throw new Error("no rebuild expected");
    },
  });
  return { done, calls, exports: exportsStore.rows };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "render-store-"));
  scratch = await mkdtemp(join(tmpdir(), "render-scratch-"));
  storage = fakeStorage({ root, uploadUrlBase: "" });
  for (const [step, file] of [
    ["retime", "source.mp4"],
    ["retime", "transcript.json"],
    ["head_track", "head-track.json"],
    ["remove_background", "subject.webm"],
  ] as const) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- committed fixtures
    const bytes = new Uint8Array(await readFile(new URL(`${step}/${file}`, fixtures)));
    await storage.put(cacheKey(PREFIX, step, FP[step]!, file), bytes);
  }
  await storage.put(
    versionKey(PREFIX, TEST_JOB.reel_id, VERSION_ID),
    new TextEncoder().encode(canonicalJson(EDIT)),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

describe("render", () => {
  it("renders the built page unchanged, stores the MP4 and records the export", async () => {
    const fake = fakeRender();
    const { done, calls, exports } = run({ spawn: fake.spawn });
    await done;

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    const project = call.args[2]!;
    const output = call.args[call.args.indexOf("-o") + 1]!;
    expect(call.file).toBe(TOOLS.hyperframes[0]);
    expect(call.args).toEqual(renderArgs({ cli: TOOLS.hyperframes[1], project, output }));
    expect(call.sampleGroupMemory).toBe(true);
    expect(call.env?.HYPERFRAMES_NO_TELEMETRY).toBe("1");

    const measurer = createMeasurer(await fontBytes(ISSEBYA));
    let html: string;
    try {
      ({ html } = build({
        edit: EDIT,
        transcript: TRANSCRIPT,
        headTrack: HEAD_TRACK as never,
        preset: ISSEBYA,
        measurer,
      }));
    } finally {
      measurer.close();
    }
    const seen = fake.projects[0]!;
    expect(seen.html).toBe(html);
    for (const file of [
      "index.html",
      "footage.mp4",
      "subject.webm",
      join("assets", "fonts", "Raleway-Light.ttf"),
      join("assets", "fonts", "GolosText-Bold.ttf"),
      join("assets", "sounds", "mouse-click-trimmed.wav"),
    ]) {
      expect(seen.files).toContain(file);
    }

    const key = exportKey(PREFIX, TEST_JOB.reel_id, EXPORT_ID);
    expect(new TextDecoder().decode((await storage.get(key))!)).toBe("mp4 bytes");
    expect(exports).toEqual([
      {
        id: EXPORT_ID,
        reel_id: TEST_JOB.reel_id,
        owner_id: TEST_JOB.owner_id,
        job_id: TEST_JOB.id,
        version_id: VERSION_ID,
        r2_key: key,
        bytes: "mp4 bytes".length,
      },
    ]);
    expect(calls.map((c) => c.call)).toEqual(["start", "done"]);
    expect(calls[1]).toMatchObject({ summary: expect.stringMatching(/^exported, /) });
    expect(calls.some((c) => c.call === "reelStatus")).toBe(false);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect(await readdir(scratch)).toEqual([]);
  });

  it("fails without a version, with a missing one, or with one of another reel", async () => {
    await expect(run({ versionId: null }).done).rejects.toThrow("render: job has no version");
    await expect(run({ row: null }).done).rejects.toThrow("render: version not found");
    await expect(run({ row: versionRow({ reel_id: "another-reel" }) }).done).rejects.toThrow(
      "render: version belongs to another reel",
    );
  });

  it("fails the step on an empty output and stores nothing", async () => {
    const { done, calls, exports } = run({ spawn: fakeRender("").spawn });
    await expect(done).rejects.toThrow("render: HyperFrames wrote no video");
    expect(calls.map((c) => c.call)).toEqual(["start", "failed"]);
    expect(await storage.list(`${PREFIX}exports/`)).toEqual([]);
    expect(exports).toEqual([]);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect(await readdir(scratch)).toEqual([]);
  });

  it("writes no object and no row after a lost lease", async () => {
    const controller = new AbortController();
    const fake = fakeRender();
    const spawn: SpawnTool = async (call, signal, log) => {
      const result = await fake.spawn(call, signal, log);
      controller.abort();
      return result;
    };
    const { done, exports } = run({ spawn, signal: controller.signal });
    await expect(done).rejects.toThrow();
    expect(await storage.list(`${PREFIX}exports/`)).toEqual([]);
    expect(exports).toEqual([]);
  });

  it("rebuilds the inputs first when one is missing", async () => {
    await storage.delete(
      cacheKey(PREFIX, "remove_background", FP.remove_background!, "subject.webm"),
    );
    const { steps } = recordingSteps();
    let rebuilt = 0;
    await render({
      ctx: stepContext(steps, { job: JOB }),
      storage,
      keyPrefix: PREFIX,
      scratchDir: scratch,
      tools: TOOLS,
      versions: { get: async () => versionRow() },
      exportsStore: memoryExports().store,
      versionId: VERSION_ID,
      spawnTool: fakeRender().spawn,
      newId: () => EXPORT_ID,
      rebuild: async () => {
        rebuilt += 1;
        const cutout = new URL("remove_background/subject.webm", fixtures);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- committed fixture
        const bytes = new Uint8Array(await readFile(cutout));
        await storage.put(
          cacheKey(PREFIX, "remove_background", FP.remove_background!, "subject.webm"),
          bytes,
        );
        return { fingerprints: FP };
      },
    });
    expect(rebuilt).toBe(1);
    expect(await storage.list(`${PREFIX}exports/`)).toEqual([
      exportKey(PREFIX, TEST_JOB.reel_id, EXPORT_ID),
    ]);
  });
});
