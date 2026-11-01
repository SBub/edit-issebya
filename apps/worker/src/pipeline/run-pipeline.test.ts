import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Storage, fakeStorage } from "@edit-issebya/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_JOB, recordingSteps, stepContext } from "../recording-steps.ts";
import type { ChildRun, SpawnTool, ToolCall } from "../step-runner.ts";
import { PIPELINE, fingerprintsFor } from "./definition.ts";
import { cacheKey } from "./fingerprint.ts";
import { runPipeline } from "./run-pipeline.ts";
import type { ToolPaths } from "./tools.ts";

const PREFIX = "dev/";
const SOURCE_KEY = `${PREFIX}reels/${TEST_JOB.reel_id}/source/original.mp4`;
const TOOLS: ToolPaths = {
  ffmpeg: "/fake/ffmpeg",
  ffprobe: "/fake/ffprobe",
  hyperframes: ["/fake/node", "/fake/hyperframes.mjs"],
};
// eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
const PROBE = await readFile(new URL("testdata/sdr-cfr.json", import.meta.url), "utf8");
// Two seconds of speech with a 0.2 s gap: what the fake HyperFrames hears.
const WORDS = [
  { text: "This", start: 0.1, end: 0.4 },
  { text: "is", start: 0.4, end: 0.8 },
  { text: "short.", start: 1.0, end: 1.9 },
];
const ENVELOPE_PRINT = Array.from({ length: 200 }, (_, index) => {
  const level = index < 10 || (index >= 80 && index < 100) || index >= 190 ? "-inf" : "-20.0";
  return `frame:${index}\nlavfi.astats.Overall.RMS_level=${level}\n`;
}).join("");

let root: string;
let scratch: string;
let storage: Storage;
let counts: { getFile: number; putFileIfAbsent: number };
let spawned: ToolCall[];

const ok = (stdout = ""): ChildRun => ({
  code: 0,
  exitSignal: null,
  report: "",
  output: stdout,
  stdout,
  groupPeakBytes: null,
});

function option(args: string[], name: string): string {
  return args[args.indexOf(name) + 1]!;
}

// Plays each tool: ffprobe answers fixture JSON, ffmpeg writes the file its
// arguments name (two transparent frames for a raw decode), HyperFrames writes
// its transcript into --dir or its cut-out at -o.
function fakeTools({ failTranscribe = 0 } = {}): SpawnTool {
  let transcribeFailures = failTranscribe;
  return async (call) => {
    spawned.push(call);
    const at = (file: string) => (call.cwd ? resolve(call.cwd, file) : file);
    if (call.file === TOOLS.ffprobe) return ok(PROBE);
    if (call.file === TOOLS.hyperframes[0] && call.args.includes("remove-background")) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      await writeFile(option(call.args, "-o"), "cut-out");
      return ok('{"ok":true}');
    }
    if (call.file === TOOLS.hyperframes[0]) {
      if (transcribeFailures > 0) {
        transcribeFailures -= 1;
        return { ...ok(), code: 1, output: "whisper: model not found\n" };
      }
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      await writeFile(join(option(call.args, "--dir"), "transcript.json"), JSON.stringify(WORDS));
      return ok('{"ok":true}');
    }
    if (call.args.includes("-af")) {
      const filter = option(call.args, "-af");
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      await writeFile(at(/file=([^,]+)$/.exec(filter)![1]!), ENVELOPE_PRINT);
      return ok();
    }
    if (call.args.includes("rawvideo")) {
      const [, width, height] = /scale=(\d+):(\d+)/.exec(option(call.args, "-vf"))!;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      await writeFile(
        at(call.args.at(-1)!),
        new Uint8Array(2 * Number(width) * Number(height) * 4),
      );
      return ok();
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    await writeFile(
      at(call.args.at(-1)!),
      `video from ${call.args.includes("-vf") ? "convert" : "retime"}`,
    );
    return ok();
  };
}

function counting(inner: Storage): Storage {
  return {
    ...inner,
    async getFile(key, path, options) {
      counts.getFile += 1;
      return inner.getFile(key, path, options);
    },
    async putFileIfAbsent(key, path, options) {
      counts.putFileIfAbsent += 1;
      return inner.putFileIfAbsent(key, path, options);
    },
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "run-pipeline-"));
  scratch = join(root, "scratch");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
  await mkdir(scratch);
  const folder = fakeStorage({ root: join(root, "store"), uploadUrlBase: "" });
  await folder.put(SOURCE_KEY, new TextEncoder().encode("phone footage"));
  storage = counting(folder);
  counts = { getFile: 0, putFileIfAbsent: 0 };
  spawned = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function fingerprints() {
  const head = await storage.head(SOURCE_KEY);
  return fingerprintsFor({ etag: head!.etag!, bytes: head!.bytes });
}

async function outputKeys() {
  const fps = await fingerprints();
  return PIPELINE.flatMap((step) =>
    step.outputs.map(({ file }) => cacheKey(PREFIX, step.name, fps[step.name]!, file)),
  );
}

function run(
  steps: ReturnType<typeof recordingSteps>["steps"],
  options: { spawnTool?: SpawnTool; pipeline?: typeof PIPELINE; signal?: AbortSignal } = {},
) {
  return runPipeline({
    ctx: stepContext(steps, options.signal ? { signal: options.signal } : {}),
    storage,
    keyPrefix: PREFIX,
    scratchDir: scratch,
    tools: TOOLS,
    spawnTool: options.spawnTool ?? fakeTools(),
    pipeline: options.pipeline,
  });
}

function shape(calls: ReturnType<typeof recordingSteps>["calls"]) {
  return calls.map((call) => {
    if (call.call === "reelStatus") return `status ${call.status}`;
    if (call.call === "start" || call.call === "skipped") return `${call.call} ${call.name}`;
    return call.call;
  });
}

describe("runPipeline", () => {
  it("runs every step on a first run and stores every output under its key", async () => {
    const { steps, calls } = recordingSteps(SOURCE_KEY);
    await run(steps);
    expect(shape(calls)).toEqual([
      "status converting",
      "start convert",
      "done",
      "status transcribing",
      "start transcribe",
      "done",
      "status retiming",
      "start retime",
      "done",
      "status removing_background",
      "start remove_background",
      "done",
      "status tracking_head",
      "start head_track",
      "done",
      "status making_previews",
      "start preview_copies",
      "done",
    ]);
    expect(await storage.list(`${PREFIX}cache/`)).toEqual([...(await outputKeys())].sort());
    const transcript = JSON.parse(
      new TextDecoder().decode((await storage.get((await outputKeys())[1]!))!),
    );
    expect(transcript.words.map((word: { id: string }) => word.id)).toEqual([
      "w0001",
      "w0002",
      "w0003",
    ]);
    // The source is downloaded once; later steps use the job's own outputs.
    expect(counts.getFile).toBe(1);
    const done = calls.filter((call) => call.call === "done");
    expect(done.map((call) => call.call === "done" && call.summary.split(",")[0])).toEqual([
      "footage converted",
      "transcribed",
      "retimed to 1.9 seconds",
      "background removed",
      "head tracked",
      "preview copies made",
    ]);
    const fps = await fingerprints();
    const track = JSON.parse(
      new TextDecoder().decode(
        (await storage.get(cacheKey(PREFIX, "head_track", fps.head_track!, "head-track.json")))!,
      ),
    );
    // Two transparent frames: no head in either.
    expect(track).toEqual([null, null]);
    const headTracked = done[4]!;
    expect(headTracked.call === "done" && headTracked.summary).toMatch(
      /^head tracked, 2 samples, 2 without a head, /,
    );
  });

  it("reuses every output on a second run: no process, download or upload", async () => {
    await run(recordingSteps(SOURCE_KEY).steps);
    spawned = [];
    counts = { getFile: 0, putFileIfAbsent: 0 };
    const { steps, calls } = recordingSteps(SOURCE_KEY);
    await run(steps);
    expect(shape(calls)).toEqual([
      "status converting",
      "skipped convert",
      "status transcribing",
      "skipped transcribe",
      "status retiming",
      "skipped retime",
      "status removing_background",
      "skipped remove_background",
      "status tracking_head",
      "skipped head_track",
      "status making_previews",
      "skipped preview_copies",
    ]);
    expect(
      calls
        .filter((call) => call.call === "skipped")
        .map((call) => call.call === "skipped" && call.summary),
    ).toEqual([
      "footage converted, reused",
      "transcribed, reused",
      "retimed, reused",
      "background removed, reused",
      "head tracked, reused",
      "preview copies made, reused",
    ]);
    expect(spawned).toEqual([]);
    expect(counts).toEqual({ getFile: 0, putFileIfAbsent: 0 });
  });

  it("re-runs only the step that lost an output, keeping its stored ones", async () => {
    await run(recordingSteps(SOURCE_KEY).steps);
    const keys = await outputKeys();
    const retimeKeys = keys.filter((key) => key.includes("/cache/retime/"));
    const lost = retimeKeys.find((key) => key.endsWith("retime.json"))!;
    const kept = retimeKeys.filter((key) => key !== lost);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    const before = await Promise.all(kept.map((key) => stat(join(root, "store", key))));
    await storage.delete(lost);
    counts = { getFile: 0, putFileIfAbsent: 0 };

    const { steps, calls } = recordingSteps(SOURCE_KEY);
    await run(steps);
    expect(shape(calls)).toEqual([
      "status converting",
      "skipped convert",
      "status transcribing",
      "skipped transcribe",
      "status retiming",
      "start retime",
      "done",
      "status removing_background",
      "skipped remove_background",
      "status tracking_head",
      "skipped head_track",
      "status making_previews",
      "skipped preview_copies",
    ]);
    expect(await storage.head(lost)).not.toBeNull();
    // Its two inputs downloaded; only the lost output uploaded.
    expect(counts).toEqual({ getFile: 2, putFileIfAbsent: 1 });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    const after = await Promise.all(kept.map((key) => stat(join(root, "store", key))));
    after.forEach((info, index) => {
      expect(info.mtimeMs).toBe(before[index]!.mtimeMs);
      expect(info.size).toBe(before[index]!.size);
    });
  });

  it("re-runs convert alone when its output is lost: later fingerprints are unchanged", async () => {
    await run(recordingSteps(SOURCE_KEY).steps);
    const keys = await outputKeys();
    await storage.delete(keys.find((key) => key.endsWith("converted.mp4"))!);
    const { steps, calls } = recordingSteps(SOURCE_KEY);
    await run(steps);
    expect(shape(calls)).toEqual([
      "status converting",
      "start convert",
      "done",
      "status transcribing",
      "skipped transcribe",
      "status retiming",
      "skipped retime",
      "status removing_background",
      "skipped remove_background",
      "status tracking_head",
      "skipped head_track",
      "status making_previews",
      "skipped preview_copies",
    ]);
  });

  it("re-runs a step and every later one after its version changes", async () => {
    await run(recordingSteps(SOURCE_KEY).steps);
    const bumped = PIPELINE.map((step) =>
      step.name === "transcribe" ? { ...step, version: step.version + 1 } : step,
    );
    const { steps, calls } = recordingSteps(SOURCE_KEY);
    await run(steps, { pipeline: bumped });
    expect(shape(calls)).toEqual([
      "status converting",
      "skipped convert",
      "status transcribing",
      "start transcribe",
      "done",
      "status retiming",
      "start retime",
      "done",
      "status removing_background",
      "start remove_background",
      "done",
      "status tracking_head",
      "start head_track",
      "done",
      "status making_previews",
      "start preview_copies",
      "done",
    ]);
  });

  it("resumes a failed job at the step that failed", async () => {
    const first = recordingSteps(SOURCE_KEY);
    await expect(run(first.steps, { spawnTool: fakeTools({ failTranscribe: 1 }) })).rejects.toThrow(
      /transcribe exited with 1\nwhisper: model not found/,
    );
    expect(shape(first.calls)).toEqual([
      "status converting",
      "start convert",
      "done",
      "status transcribing",
      "start transcribe",
      "failed",
    ]);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect(await readdir(scratch)).toEqual([]);

    const retry = recordingSteps(SOURCE_KEY);
    await run(retry.steps);
    expect(shape(retry.calls)).toEqual([
      "status converting",
      "skipped convert",
      "status transcribing",
      "start transcribe",
      "done",
      "status retiming",
      "start retime",
      "done",
      "status removing_background",
      "start remove_background",
      "done",
      "status tracking_head",
      "start head_track",
      "done",
      "status making_previews",
      "start preview_copies",
      "done",
    ]);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect(await readdir(scratch)).toEqual([]);
  });

  it("removes the job's scratch folder after success", async () => {
    await run(recordingSteps(SOURCE_KEY).steps);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect(await readdir(scratch)).toEqual([]);
  });

  it("fails the job when the source is missing or has no ETag", async () => {
    await storage.delete(SOURCE_KEY);
    await expect(run(recordingSteps(SOURCE_KEY).steps)).rejects.toThrow("source object missing");

    const inner = storage;
    storage = { ...inner, head: async () => ({ bytes: 10, etag: null }) };
    const { steps, calls } = recordingSteps(SOURCE_KEY);
    await expect(run(steps)).rejects.toThrow("source object has no ETag");
    expect(calls).toEqual([]);
  });

  it("fails the step naming a cached input that is gone", async () => {
    await run(recordingSteps(SOURCE_KEY).steps);
    const keys = await outputKeys();
    const converted = keys.find((key) => key.endsWith("converted.mp4"))!;
    await storage.delete(converted);
    // transcribe must run (version bumped) but convert is a hit whose output is gone.
    const bumped = PIPELINE.map((step) =>
      step.name === "transcribe" ? { ...step, version: step.version + 1 } : step,
    );
    const withoutConvert = [{ ...PIPELINE[0]!, outputs: [] }, ...bumped.slice(1)];
    const { steps, calls } = recordingSteps(SOURCE_KEY);
    await expect(run(steps, { pipeline: withoutConvert })).rejects.toThrow(
      `transcribe: input missing: ${converted}`,
    );
    expect(calls.at(-1)).toMatchObject({ call: "failed" });
  });

  it("writes nothing more after a lost lease and still cleans up", async () => {
    const controller = new AbortController();
    const tools = fakeTools();
    const { steps, calls } = recordingSteps(SOURCE_KEY);
    await expect(
      run(steps, {
        signal: controller.signal,
        spawnTool: async (call, signal, log) => {
          const result = await tools(call, signal, log);
          if (call.args.includes("-vf")) controller.abort(new Error("lease lost"));
          return result;
        },
      }),
    ).rejects.toThrow("lease lost");
    expect(shape(calls)).toEqual(["status converting", "start convert"]);
    expect(await storage.list(`${PREFIX}cache/`)).toEqual([]);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    expect(await readdir(scratch)).toEqual([]);
  });
});
