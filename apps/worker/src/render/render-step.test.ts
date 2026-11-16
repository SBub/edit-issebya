import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { basename, dirname, join } from "node:path";
import {
  type EditInputs,
  ISSEBYA_PRESET,
  type StoredVersion,
  type VersionRows,
  build,
  editBytes,
  reelFrames,
  versionKey,
} from "@edit-issebya/edit";
import { type Storage, fakeStorage } from "@edit-issebya/storage";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { SpanStatusCode } from "@opentelemetry/api";
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withMasks } from "../cutout/spans.ts";
import { keepLease } from "../lease.ts";
import { editMeasurer } from "../edit-measurer.ts";
import { cacheKey } from "../pipeline/fingerprint.ts";
import type { ToolPaths } from "../pipeline/tools.ts";
import { TEST_JOB, recordingSteps, stepContext } from "../recording-steps.ts";
import type { ChildRun, SpawnTool, Tool, ToolCall } from "../step-runner.ts";
import { type Telemetry, createTelemetry } from "../telemetry.ts";
import type { ExportStore, NewExport } from "./export-store.ts";
import { FAKE_RENDER, STUB_EXPORT } from "./render-call.ts";
import { renderExport, renderVersion } from "./render-step.ts";
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
// The page of each project a HyperFrames call rendered: `full` (the single
// call's), or the composite's `front`, `sound` and `behind`.
let pages: Record<string, string>;
// The masks' concat list the composite read, when it had one.
let maskList: string | null;
let inserted: NewExport[];
let existing: string | null;

// Only a call that samples its tree reports a group peak, as the real spawner.
const ok = (call?: ToolCall, stdout = ""): ChildRun => ({
  code: 0,
  exitSignal: null,
  report: "",
  output: "",
  stdout,
  groupPeakBytes: !call || call.sampleGroupMemory ? 300 * 1024 * 1024 : null,
});

// What ffprobe says of the fixture footage (and, here, of every mask): 30 fps,
// 80 frames, 8-bit 4:2:0, with sound.
const PROBED = JSON.stringify({
  streams: [
    {
      codec_type: "video",
      width: 720,
      height: 1280,
      pix_fmt: "yuv420p",
      r_frame_rate: "30/1",
      avg_frame_rate: "30/1",
      nb_frames: "80",
    },
    { codec_type: "audio" },
  ],
});

const isDouble = (call: ToolCall) => call.args[0] === FAKE_RENDER;
const isProbe = (call: ToolCall) => call.file === TOOLS.ffprobe;
const isFfmpeg = (call: ToolCall) => call.file === TOOLS.ffmpeg;
const isHyperframes = (call: ToolCall) => call.args[0] === TOOLS.hyperframes[1];
// The composite's own pass: the one ffmpeg call with a filter graph.
const isComposite = (call: ToolCall) => isFfmpeg(call) && call.args.includes("-filter_complex");
// Which page a HyperFrames call renders, from its project's folder.
function pageOf(call: ToolCall): string {
  const folder = basename(dirname(call.args[2]!));
  return ["front", "sound", "behind"].includes(folder) ? folder : "full";
}

const bytes = () => new Uint8Array(2048).fill(7);

// Each tool leaves what the real one would: ffprobe its JSON, HyperFrames some
// bytes at `-o` (a folder of frames for a picture layer), ffmpeg some bytes at
// its output (its last argument); the render double does what its part does.
const fakeSpawn: SpawnTool = async (call) => {
  spawned.push(call);
  if (isProbe(call)) return ok(call, PROBED);
  if (isDouble(call)) {
    const [, part] = call.args;
    const output = call.args.at(-1)!;
    if (part === "layer" && !output.endsWith(".mp4")) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      await mkdir(output, { recursive: true });
    } else if (part === "layer" || (part === "ffmpeg" && call.args[4] === "-")) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      await writeFile(output, "placeholder");
    } else {
      await copyFile(part === "ffmpeg" ? call.args[4]! : call.args[1]!, output);
    }
    return ok(call);
  }
  if (isHyperframes(call)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    pages[pageOf(call)] = await readFile(join(call.args[2]!, "index.html"), "utf8");
    const output = call.args[call.args.indexOf("-o") + 1]!;
    if (call.args.includes("png-sequence")) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      await mkdir(output, { recursive: true });
    } else {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      await writeFile(output, bytes());
    }
    return ok(call);
  }
  if (isComposite(call) && call.args.includes("concat")) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    maskList = await readFile(call.args[call.args.indexOf("concat") + 4]!, "utf8");
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
  await writeFile(call.args.at(-1)!, bytes());
  return ok(call);
};

// The settings of the single call, whatever the version.
const SINGLE = { WORKER_RENDER_PATH: "single" };

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
  pages = {};
  maskList = null;
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
    // The pages run next to each other: at least one page's tree, at most both.
    const peak = done.call === "done" ? done.measurements.peak_rss_bytes! : 0;
    expect(peak).toBeGreaterThanOrEqual(300 * 1024 * 1024);
    expect(peak).toBeLessThanOrEqual(600 * 1024 * 1024);
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
    // The composite: the footage probed, the front and sound pages, the sound
    // cut, the footage's JPEG pass, then the one blend.
    expect(spawned.filter(isProbe)).toHaveLength(1);
    const hyperframes = spawned.filter(isHyperframes);
    expect(hyperframes.map(pageOf).sort()).toEqual(["front", "sound"]);
    for (const call of hyperframes) {
      expect(call.sampleGroupMemory).toBe(true);
      expect(call.args).toContain("--no-browser-gpu");
    }
    expect(spawned.filter(isFfmpeg)).toHaveLength(3);
    expect(spawned.at(-1)).toSatisfy(isComposite);
    expect(spawned).toHaveLength(6);
    // The scratch folder is gone.
    expect(await storage.list(`${PREFIX}exports/`)).toEqual([key]);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect(await readdir(join(root, "scratch"))).toEqual([]);
  });

  it("renders the version by the single call when the setting says so", async () => {
    const { steps, calls } = recordingSteps();
    await run(steps, { env: SINGLE });
    const done = calls.at(-1)!;
    expect(done.call === "done" && done.summary).toMatch(/^exported, under a second, 2\.0 KB$/);
    expect(done.call === "done" && done.measurements.peak_rss_bytes).toBe(300 * 1024 * 1024);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toSatisfy(isHyperframes);
    expect(spawned[0]!.sampleGroupMemory).toBe(true);
    expect(spawned[0]!.args).toContain("--no-browser-gpu");
    expect(spawned[0]!.args).not.toContain("--format");
    expect(inserted).toHaveLength(1);
  });

  it("refuses a render setting it does not know", async () => {
    await expect(
      run(recordingSteps().steps, { env: { WORKER_RENDER_MODE: "fast" } }),
    ).rejects.toThrow("WORKER_RENDER_MODE must be match or clean, got fast");
    expect(spawned).toEqual([]);
    expect(inserted).toEqual([]);
  });

  it("renders exactly the layer pages the shared builder makes", async () => {
    await run(recordingSteps().steps);
    const { edit, transcript, headTrack } = await fixtureEdit();
    const measurer = await editMeasurer();
    const page = (layer: "front" | "sound") =>
      build(edit, transcript, headTrack, ISSEBYA_PRESET, measurer, { layer }).html;
    // No cut-out span: no behind page, and never the full page.
    expect(pages).toEqual({ front: page("front"), sound: page("sound") });
  });

  it("renders exactly the full page the shared builder makes by the single call", async () => {
    await run(recordingSteps().steps, { env: SINGLE });
    const { edit, transcript, headTrack } = await fixtureEdit();
    const { html } = build(edit, transcript, headTrack, ISSEBYA_PRESET, await editMeasurer());
    expect(pages).toEqual({ full: html });
  });

  it("goes to the single call for a version the composite does not handle", async () => {
    const { edit } = await fixtureEdit();
    const styled = structuredClone(edit);
    styled.tracks.footage[0]!.style = { filter: "grayscale(1)" };
    await storage.put(version.r2_key, editBytes(styled));
    await run(recordingSteps().steps);
    expect(spawned).toHaveLength(1);
    expect(Object.keys(pages)).toEqual(["full"]);
    expect(pages.full).toContain("filter: grayscale(1)");
  });

  it("goes to the single call when the probed footage is not 30 fps", async () => {
    const slow: SpawnTool = async (call, signal, log) =>
      isProbe(call)
        ? (spawned.push(call), ok(call, PROBED.replaceAll("30/1", "25/1")))
        : fakeSpawn(call, signal, log);
    await runRender({
      ctx: stepContext(recordingSteps().steps, { job: JOB }),
      storage,
      rows,
      exports: exportsStore,
      keyPrefix: PREFIX,
      scratchDir: join(root, "scratch"),
      tools: TOOLS,
      versionId: VERSION_ID,
      ensureInputs: async () => {},
      newId: () => EXPORT_ID,
      spawnTool: slow,
      env: {},
    });
    expect(spawned.map((call) => (isProbe(call) ? "probe" : pageOf(call)))).toEqual([
      "probe",
      "full",
    ]);
    expect(inserted).toHaveLength(1);
  });

  it("runs the composite's double under the render double: every part a double, the stub copied", async () => {
    await run(recordingSteps().steps, { env: { E2E_MOCK_RENDER: "true" } });
    // Nothing probed and no sound cut: the two pages, the footage pass, the blend.
    expect(spawned.every(isDouble)).toBe(true);
    expect(spawned.map((call) => call.args[1]).sort()).toEqual([
      "ffmpeg",
      "ffmpeg",
      "layer",
      "layer",
    ]);
    expect(spawned.at(-1)!.args.slice(1, 5)).toEqual([
      "ffmpeg",
      "0.55",
      String(reelFrames((await fixtureEdit()).edit.duration)),
      STUB_EXPORT,
    ]);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed stub
    expect(inserted[0]!.bytes).toBe((await stat(STUB_EXPORT)).size);
  });

  it("copies the stub under the render double by the single call", async () => {
    await run(recordingSteps().steps, { env: { E2E_MOCK_RENDER: "true", ...SINGLE } });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args).toEqual([FAKE_RENDER, STUB_EXPORT, expect.any(String)]);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed stub
    expect(inserted[0]!.bytes).toBe((await stat(STUB_EXPORT)).size);
  });

  it("reads the step's progress from every process of the composite", async () => {
    await run(recordingSteps().steps);
    // Both pages, the footage pass and the blend; the probe and the cut report none.
    const part = (call: ToolCall) =>
      isHyperframes(call) ? pageOf(call) : isComposite(call) ? "composite" : "footage";
    const parsers = new Map(
      spawned.filter((call) => call.progress).map((call) => [part(call), call.progress!]),
    );
    expect([...parsers.keys()].sort()).toEqual(["composite", "footage", "front", "sound"]);
    expect(spawned.filter((call) => !call.progress)).toHaveLength(2);
    const [front, sound, footage, composite] = ["front", "sound", "footage", "composite"].map(
      (name) => parsers.get(name),
    );
    const hf = (pct: number) => `@hf-progress {"pct":${pct}}`;
    // Nothing done yet is nothing to write.
    expect(footage!("frame=0")).toBeNull();
    expect(front!(hf(0))).toBeNull();
    // Each part moves the step's one percentage by its own weight, never back.
    const seen = [
      front!(hf(50)),
      sound!(hf(100)),
      footage!("frame=40"),
      front!(hf(100)),
      footage!("progress=end"),
      composite!("frame=1"),
      composite!(`frame=${Math.round(reelFrames((await fixtureEdit()).edit.duration) / 2)}`),
      composite!("progress=end"),
    ];
    expect(seen).toEqual([...seen].sort((a, b) => a! - b!));
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(100);
    expect(new Set(seen).size).toBeGreaterThan(5);
    expect(composite!("speed=3.1x")).toBeNull();
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
    const { edit, transcript, headTrack } = await fixtureEdit();
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
      headTrack,
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

  function runBehind(env: NodeJS.ProcessEnv = {}) {
    const { steps, calls } = recordingSteps();
    const spawnTool: SpawnTool = async (call) => {
      if (isHyperframes(call) && pageOf(call) === "full") {
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
      env,
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

  it("reuses the stored mask, renders the behind page and blends with the mask", async () => {
    const { done, calls } = runBehind();
    await done;
    expect(calls[0]).toMatchObject({ call: "skipped", name: "cutout", summary: "cut-out reused" });
    const [mask] = version.inputs.masks!;
    // The footage and the mask are probed; no page names the mask.
    expect(spawned.filter(isProbe)).toHaveLength(2);
    expect(Object.keys(pages).sort()).toEqual(["behind", "front", "sound"]);
    for (const html of Object.values(pages)) expect(html).not.toContain("masks/");
    expect(pages.behind).toContain('<div id="behind-word"');
    expect(pages.front).not.toContain("behind-word");
    // The blend reads the behind layer's frames and the downloaded mask.
    const composite = spawned.find(isComposite)!;
    expect(composite.args.join(" ")).toContain(join("behind", "frames", "frame_%06d.png"));
    expect(composite.args.join(" ")).toContain("alphamerge");
    expect(maskList!.startsWith("file '")).toBe(true);
    expect(maskList!.endsWith(`${mask!.fingerprint}.mp4'\n`)).toBe(true);
    expect(maskList!.trim().split("\n")).toHaveLength(1);
    // The behind page comes after the sound page, in its lane.
    const order = spawned.filter(isHyperframes).map(pageOf);
    expect(order.indexOf("behind")).toBeGreaterThan(order.indexOf("sound"));
    expect(inserted).toHaveLength(1);
  });

  it("places only the mask in the single call's project", async () => {
    const { done, calls } = runBehind(SINGLE);
    await done;
    expect(calls[0]).toMatchObject({ call: "skipped", name: "cutout", summary: "cut-out reused" });
    const [mask] = version.inputs.masks!;
    const projectHtml = pages.full;
    expect(projectHtml).toContain(`src="masks/${mask!.fingerprint}.mp4"`);
    expect(projectHtml).not.toContain("photos/");
    expect(projectFiles).toEqual(expect.arrayContaining([`masks/${mask!.fingerprint}.mp4`]));
    expect(projectFiles.some((file) => file.startsWith("photos"))).toBe(false);
    expect(inserted).toHaveLength(1);
  });
});

// A lease whose cancel check reads `cancelledNow` (every 50 ms), as runJob's.
function cancellable(cancelledNow: () => boolean) {
  return keepLease({
    renew: async () => true,
    everyMs: 60_000,
    cancelled: async () => cancelledNow(),
    cancelCheckEveryMs: 50,
  });
}

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
    // Stopped within seconds, not after the double's 30: every process of the
    // composite's double (both pages and the footage pass ran at once) is gone,
    // and so is the render's folder with everything they wrote.
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(await childrenOf(root)).toEqual([]);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect(await readdir(join(root, "scratch"))).toEqual([]);
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

// The spans and log records a run leaves: a telemetry that keeps them in memory.
function telemetryWithMemory() {
  const spans = new InMemorySpanExporter();
  const logs = new InMemoryLogRecordExporter();
  const telemetry: Telemetry = createTelemetry(
    {},
    {
      spanProcessors: [new SimpleSpanProcessor({ exporter: spans })],
      logProcessors: [new SimpleLogRecordProcessor({ exporter: logs })],
    },
  );
  return { telemetry, spans, logs };
}

describe("runRender spans", () => {
  type Finished = ReturnType<InMemorySpanExporter["getFinishedSpans"]>;
  const named = (spans: Finished, name: string) => spans.find((span) => span.name === name);
  const childrenOf = (spans: Finished, parent: Finished[number] | undefined) =>
    spans.filter((span) => span.parentSpanContext?.spanId === parent?.spanContext().spanId);

  it("traces the step as its six stages in order, every call of the composite under encode", async () => {
    const { telemetry, spans, logs } = telemetryWithMemory();
    const { steps } = recordingSteps();
    await runRender({
      ctx: stepContext(steps, { job: JOB, telemetry }),
      storage,
      rows,
      exports: exportsStore,
      keyPrefix: PREFIX,
      scratchDir: join(root, "scratch"),
      tools: TOOLS,
      versionId: VERSION_ID,
      ensureInputs: async () => {},
      newId: () => EXPORT_ID,
      spawnTool: fakeSpawn,
      env: {},
    });
    const finished = spans.getFinishedSpans();
    const step = named(finished, "step render");
    expect(childrenOf(finished, step).map((span) => span.name)).toEqual([
      "render.load",
      "render.route",
      "render.build",
      "render.encode",
      "render.upload",
      "render.save",
    ]);
    const route = named(finished, "render.route");
    expect(childrenOf(finished, route).map((span) => span.name)).toEqual(["exec ffprobe"]);
    expect(route?.attributes).toEqual({ "render.path": "composite", "render.mode": "match" });
    const encode = named(finished, "render.encode");
    // Two pages, the sound cut, the footage pass and the blend.
    expect(
      childrenOf(finished, encode)
        .map((span) => span.name)
        .sort(),
    ).toEqual([
      "exec ffmpeg",
      "exec ffmpeg",
      "exec ffmpeg",
      "exec hyperframes",
      "exec hyperframes",
    ]);
    expect(finished.some((span) => span.status.code === SpanStatusCode.ERROR)).toBe(false);
    expect(logs.getFinishedLogRecords()).toEqual([]);

    const { edit, transcript, headTrack } = await fixtureEdit();
    const measurer = await editMeasurer();
    const layers = (["front", "sound"] as const).map((layer) =>
      build(edit, transcript, headTrack, ISSEBYA_PRESET, measurer, { layer }),
    );
    const built = {
      html: layers.map((layer) => layer.html).join(""),
      assets: layers.flatMap((layer) => layer.assets),
    };
    const key = `${PREFIX}exports/${TEST_JOB.reel_id}/${EXPORT_ID}.mp4`;
    expect(step?.attributes).toMatchObject({
      "render.version_id": VERSION_ID,
      "render.duration_seconds": edit.duration,
      "render.mp4_bytes": 2048,
      "render.path": "composite",
      "render.mode": "match",
      "job.cancelled": false,
    });
    expect(named(finished, "render.load")?.attributes).toEqual({
      "render.version_id": VERSION_ID,
      "render.version_number": 2,
      "render.inputs": 1,
    });
    expect(named(finished, "render.build")?.attributes).toEqual({
      "render.page_bytes": Buffer.byteLength(built.html),
      "render.assets": built.assets.length,
      "render.pages": 2,
    });
    expect(encode?.attributes).toEqual({
      "render.duration_seconds": edit.duration,
      "render.path": "composite",
      "render.mode": "match",
    });
    expect(named(finished, "render.upload")?.attributes).toEqual({
      "render.mp4_bytes": 2048,
      "render.key": key,
    });
    expect(named(finished, "render.save")?.attributes).toEqual({ "render.export_id": EXPORT_ID });
    await telemetry.shutdown();
  });

  it("traces the single call with its reason, the HyperFrames call alone under encode", async () => {
    const { telemetry, spans } = telemetryWithMemory();
    await runRender({
      ctx: stepContext(recordingSteps().steps, { job: JOB, telemetry }),
      storage,
      rows,
      exports: exportsStore,
      keyPrefix: PREFIX,
      scratchDir: join(root, "scratch"),
      tools: TOOLS,
      versionId: VERSION_ID,
      ensureInputs: async () => {},
      newId: () => EXPORT_ID,
      spawnTool: fakeSpawn,
      env: SINGLE,
    });
    const finished = spans.getFinishedSpans();
    const step = named(finished, "step render");
    expect(childrenOf(finished, step).map((span) => span.name)).toEqual([
      "render.load",
      "render.route",
      "render.build",
      "render.encode",
      "render.upload",
      "render.save",
    ]);
    const reason = { "render.path": "single", "render.route_reason": "setting" };
    expect(named(finished, "render.route")?.attributes).toEqual(reason);
    expect(childrenOf(finished, named(finished, "render.route"))).toEqual([]);
    expect(step?.attributes).toMatchObject(reason);
    expect(step?.attributes).not.toHaveProperty("render.mode");
    const { edit, transcript, headTrack } = await fixtureEdit();
    const built = build(edit, transcript, headTrack, ISSEBYA_PRESET, await editMeasurer());
    expect(named(finished, "render.build")?.attributes).toEqual({
      "render.page_bytes": Buffer.byteLength(built.html),
      "render.assets": built.assets.length,
    });
    const encode = named(finished, "render.encode");
    expect(encode?.attributes).toEqual({ "render.duration_seconds": edit.duration });
    expect(childrenOf(finished, encode).map((span) => span.name)).toEqual(["exec hyperframes"]);
    await telemetry.shutdown();
  });

  it("logs one ERROR render failed line with the job and the step, and marks the failing stage", async () => {
    const { telemetry, spans, logs } = telemetryWithMemory();
    const key = cacheKey(
      PREFIX,
      inputs.footage.step,
      inputs.footage.fingerprint,
      inputs.footage.file,
    );
    await storage.delete(key);
    const { steps } = recordingSteps();
    await expect(
      runRender({
        ctx: stepContext(steps, { job: JOB, telemetry }),
        storage,
        rows,
        exports: exportsStore,
        keyPrefix: PREFIX,
        scratchDir: join(root, "scratch"),
        tools: TOOLS,
        versionId: VERSION_ID,
        ensureInputs: async () => {},
        newId: () => EXPORT_ID,
        spawnTool: fakeSpawn,
        env: {},
      }),
    ).rejects.toThrow(/input missing/);
    const finished = spans.getFinishedSpans();
    expect(named(finished, "render.load")?.status.code).toBe(SpanStatusCode.ERROR);
    expect(named(finished, "step render")?.status.code).toBe(SpanStatusCode.ERROR);
    expect(named(finished, "render.build")).toBeUndefined();

    const records = logs.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.severityNumber).toBe(SeverityNumber.ERROR);
    expect(record?.body).toMatch(/^render failed: Error: render: input missing: /);
    expect(record?.attributes).toMatchObject({
      "job.id": JOB.id,
      "job.kind": "render",
      "step.name": "render",
      "failure.retrying": false,
    });
    expect(record?.spanContext?.spanId).toBe(named(finished, "step render")?.spanContext().spanId);
    await telemetry.shutdown();
  });

  it("ends the stage and the step clean with job.cancelled when the owner cancels", async () => {
    const { telemetry, spans, logs } = telemetryWithMemory();
    const { steps, calls } = recordingSteps();
    let cancelledNow = false;
    const lease = cancellable(() => cancelledNow);
    const timer = setTimeout(() => {
      cancelledNow = true;
    }, 100);
    // The render never ends on its own: only the cancel stops it (the probe
    // answers, so the cancel lands in the encode).
    const hangs: SpawnTool = (call, signal, log) =>
      isProbe(call)
        ? fakeSpawn(call, signal, log)
        : new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
    try {
      await expect(
        runRender({
          ctx: stepContext(steps, {
            job: JOB,
            telemetry,
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
          spawnTool: hangs,
          env: {},
        }),
      ).rejects.toMatchObject({ name: "JobCancelled" });
    } finally {
      clearTimeout(timer);
      lease.stop();
    }
    const finished = spans.getFinishedSpans();
    const step = named(finished, "step render");
    expect(step?.attributes["job.cancelled"]).toBe(true);
    // A cancelled render still says which way it was going.
    expect(step?.attributes).toMatchObject({ "render.path": "composite", "render.mode": "match" });
    expect(step?.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(named(finished, "render.encode")?.attributes["job.cancelled"]).toBe(true);
    expect(named(finished, "render.encode")?.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(named(finished, "render.upload")).toBeUndefined();
    expect(named(finished, "render.save")).toBeUndefined();
    // A cancel is not a failure: no ERROR log record, no failed row.
    expect(logs.getFinishedLogRecords()).toEqual([]);
    expect(calls.some((call) => call.call === "failed")).toBe(false);
    expect(await storage.list(`${PREFIX}exports/`)).toEqual([]);
    await telemetry.shutdown();
  }, 30_000);
});

describe("renderExport's Chrome temporary folder", () => {
  it("is outside the render's folder and gone after a failed render call", async () => {
    const { edit, transcript, headTrack } = await fixtureEdit();
    const footage = join(root, "footage.mp4");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's own temp folder
    await writeFile(footage, "footage");
    const renderDir = join(root, "scratch", TEST_JOB.id, "render-test");
    let chromeTmp = "";
    const tool: Tool = async (call) => {
      chromeTmp = call.env?.TMPDIR ?? "";
      throw new Error("render failed");
    };
    await expect(
      renderExport({
        tool,
        tools: TOOLS,
        dir: renderDir,
        edit,
        transcript,
        headTrack,
        files: { footage, masks: {} },
      }),
    ).rejects.toThrow("render failed");
    expect(chromeTmp).not.toBe("");
    expect(chromeTmp.startsWith(renderDir)).toBe(false);
    expect(
      join(chromeTmp, "org.chromium.Chromium.XXXXXX", "SingletonSocket").length,
    ).toBeLessThanOrEqual(107);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's own temp folder
    expect(existsSync(chromeTmp)).toBe(false);
  });
});

describe("renderVersion's composite", () => {
  const SETTINGS = { path: "composite", mode: "match" } as const;

  async function compositeOf(tool: Tool, mode: "match" | "clean" = "match") {
    const { edit, transcript, headTrack } = await fixtureEdit();
    const footage = join(root, "footage.mp4");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's own temp folder
    await writeFile(footage, "footage");
    const dir = join(root, "scratch", TEST_JOB.id, "render-test");
    return {
      dir,
      footage,
      done: renderVersion({
        tool,
        tools: TOOLS,
        dir,
        edit,
        transcript,
        headTrack,
        files: { footage, masks: {} },
        settings: { ...SETTINGS, mode },
      }),
    };
  }

  // A Tool over the fake spawner, as the step runner's: the call's own signal
  // stops it.
  const fakeTool: Tool = async (call) => {
    call.signal?.throwIfAborted();
    const run = await fakeSpawn(call, call.signal ?? new AbortController().signal, () => {});
    return run.stdout;
  };

  it("gives every page a Chrome folder and a scratch folder of its own, and removes the Chrome folders", async () => {
    const { dir, done } = await compositeOf(fakeTool);
    await done;
    const hyperframes = spawned.filter(isHyperframes);
    const chromeTmps = hyperframes.map((call) => call.env!.TMPDIR!);
    expect(new Set(chromeTmps).size).toBe(hyperframes.length);
    for (const [index, call] of hyperframes.entries()) {
      const chromeTmp = chromeTmps[index]!;
      expect(chromeTmp.startsWith(dir)).toBe(false);
      expect(
        join(chromeTmp, "org.chromium.Chromium.XXXXXX", "SingletonSocket").length,
      ).toBeLessThanOrEqual(107);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's own temp folder
      expect(existsSync(chromeTmp)).toBe(false);
      const own = join(dir, pageOf(call));
      expect(call.env).toMatchObject({
        HYPERFRAMES_EXTRACT_CACHE_DIR: join(own, "frames-cache"),
        HYPERFRAMES_HISTORY_ROOT: join(own, "hyperframes-history"),
      });
      expect(call.args[2]).toBe(join(own, "project"));
    }
  });

  it("blends the JPEG copy of the footage in match mode and the footage itself in clean mode", async () => {
    const match = await compositeOf(fakeTool);
    const { output } = await match.done;
    expect(output).toBe(join(match.dir, "export.mp4"));
    const jpeg = join(match.dir, "footage.mkv");
    expect(spawned.filter(isFfmpeg).map((call) => call.args.at(-1))).toEqual(
      expect.arrayContaining([jpeg, join(match.dir, "sound.m4a"), output]),
    );
    const blend = spawned.find(isComposite)!;
    expect(blend.args[blend.args.indexOf("-i") + 1]).toBe(jpeg);
    expect(blend.args.at(-1)).toBe(output);

    spawned = [];
    const clean = await compositeOf(fakeTool, "clean");
    expect((await clean.done).route).toEqual({ path: "composite", mode: "clean" });
    expect(spawned.filter(isFfmpeg)).toHaveLength(2);
    const cleanBlend = spawned.find(isComposite)!;
    expect(cleanBlend.args[cleanBlend.args.indexOf("-i") + 1]).toBe(clean.footage);
  });

  it("stops the other lanes when one fails, and throws that failure once all have ended", async () => {
    const stopped: string[] = [];
    const chromeTmps: string[] = [];
    let running = 0;
    const tool: Tool = async (call) => {
      if (isProbe(call)) return PROBED;
      if (isHyperframes(call)) chromeTmps.push(call.env!.TMPDIR!);
      // The front page fails once every lane is running.
      if (isHyperframes(call) && pageOf(call) === "front") {
        while (running < 2) await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error("front page failed");
      }
      // The sound page and the footage pass run until they are stopped.
      running += 1;
      const name = isHyperframes(call) ? pageOf(call) : "footage";
      return new Promise<string>((_resolve, reject) => {
        call.signal!.addEventListener(
          "abort",
          () => {
            stopped.push(name);
            running -= 1;
            reject(call.signal!.reason);
          },
          { once: true },
        );
      });
    };
    const { done } = await compositeOf(tool);
    await expect(done).rejects.toThrow("front page failed");
    expect(stopped.sort()).toEqual(["footage", "sound"]);
    // Nothing was left running, and no Chrome folder is left.
    expect(running).toBe(0);
    expect(chromeTmps).toHaveLength(2);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's own temp folder
    for (const chromeTmp of chromeTmps) expect(existsSync(chromeTmp)).toBe(false);
  });

  it("refuses a composite that wrote no MP4", async () => {
    const tool: Tool = async (call) => {
      if (isComposite(call)) return "";
      return fakeTool(call);
    };
    const { done } = await compositeOf(tool);
    await expect(done).rejects.toThrow("render: the render wrote no MP4");
  });
});
