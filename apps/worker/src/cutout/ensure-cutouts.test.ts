import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HeadTrack } from "@edit-issebya/edit";
import { type Storage, fakeStorage } from "@edit-issebya/storage";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheKey } from "../pipeline/fingerprint.ts";
import { recordingSteps, stepContext } from "../recording-steps.ts";
import type { SpawnTool } from "../step-runner.ts";
import { classifyKey, recordingStorage } from "../stored-files.ts";
import { type Telemetry, createTelemetry } from "../telemetry.ts";
import { ensureCutouts } from "./ensure-cutouts.ts";
import { MASK_TOOL_VERSION } from "./mask-tool.ts";
import type { PoolLimits } from "./pool.ts";
import { VERSION_ATTRIBUTE } from "./speed.ts";
import { cutoutKey, plannedMasks } from "./spans.ts";
import { BEHIND_HEAD_TRACK, BEHIND_TRANSCRIPT, behindEdit, fakeMaskSpawn } from "./test-support.ts";

const PREFIX = "dev/";
const tools = {
  ffmpeg: "ffmpeg",
  ffprobe: "ffprobe",
  hyperframes: ["node", "hf.mjs"] as [string, string],
};

// Room for every span at once: 8 CPUs and plenty of memory.
const ROOMY: PoolLimits = { cpus: 8, memoryBytes: 64 * 1024 ** 3 };

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
  plannedMasks(behindEdit(), BEHIND_TRANSCRIPT, BEHIND_HEAD_TRACK).map((mask) =>
    cutoutKey(PREFIX, mask.fingerprint),
  );

async function ensure(
  edit = behindEdit(),
  options: {
    recordStored?: (key: string, bytes: number) => Promise<void>;
    headTrack?: HeadTrack | null;
    env?: NodeJS.ProcessEnv;
    limits?: PoolLimits;
    spawn?: ReturnType<typeof fakeMaskSpawn>;
    telemetry?: Telemetry;
  } = {},
) {
  const { steps, calls } = recordingSteps();
  const spawn = options.spawn ?? fakeMaskSpawn();
  const result = await ensureCutouts({
    ctx: stepContext(steps, { telemetry: options.telemetry }),
    storage,
    keyPrefix: PREFIX,
    scratchDir: scratch,
    edit,
    transcript: BEHIND_TRANSCRIPT,
    headTrack: options.headTrack === undefined ? BEHIND_HEAD_TRACK : options.headTrack,
    tools,
    spawnTool: spawn.spawnTool,
    env: options.env ?? { E2E_MOCK_MASK: "true" },
    recordStored: options.recordStored,
    limits: options.limits ?? ROOMY,
  });
  return { result, calls, toolCalls: spawn.calls };
}

const text = async (key: string) => new TextDecoder().decode((await storage.get(key)) ?? undefined);

describe("ensureCutouts", () => {
  it("makes every missing mask in one cutout step and names them in the inputs", async () => {
    const { result, calls, toolCalls } = await ensure();
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]!.args).toContain("5.100");
    expect(result.inputs.masks).toEqual(
      plannedMasks(behindEdit(), BEHIND_TRANSCRIPT, BEHIND_HEAD_TRACK),
    );
    for (const key of keys()) expect(await storage.head(key)).not.toBeNull();
    const done = calls.filter((call) => call.call === "done");
    expect(calls.filter((call) => call.call === "start").map((call) => call.name)).toEqual([
      "cutout",
    ]);
    expect(done[0]!.summary).toMatch(/^2 cut-outs made, 0 reused, 5\.6 s masked/);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's temp folder
    expect(await readdir(scratch)).toEqual([]);
  });

  it("gives the real tool each span's crop above the head, read from the head track", async () => {
    const { toolCalls, result } = await ensure(behindEdit(), { env: {} });
    const cropOf = (index: number) => {
      const args = toolCalls[index]!.args;
      return args[args.indexOf("--crop-top") + 1];
    };
    expect([cropOf(0), cropOf(1)]).toEqual(["266", "350"]);
    for (const key of keys()) expect(await storage.head(key)).not.toBeNull();

    // Without a head track nothing is cropped, and the masks are other masks.
    const whole = await ensure(behindEdit(), { env: {}, headTrack: null });
    expect(whole.toolCalls.map((call) => call.args[call.args.indexOf("--crop-top") + 1])).toEqual([
      "0",
      "0",
    ]);
    const cropped = result.inputs.masks!.map((mask) => mask.fingerprint);
    for (const mask of whole.result.inputs.masks!) expect(cropped).not.toContain(mask.fingerprint);
  });

  // A spawn double that holds every call open until released, and counts how
  // many are open at once.
  function heldSpawn() {
    const inner = fakeMaskSpawn();
    let open = 0;
    let most = 0;
    const release: (() => void)[] = [];
    const spawnTool: SpawnTool = async (call, signal, log) => {
      open += 1;
      most = Math.max(most, open);
      await new Promise<void>((resolve) => release.push(resolve));
      open -= 1;
      return inner.spawnTool(call, signal, log);
    };
    // Lets every held call go, one at a time, until `running` has ended.
    const releaseUntil = async (running: Promise<unknown>) => {
      let ended = false;
      void running.then(
        () => (ended = true),
        () => (ended = true),
      );
      while (!ended) {
        release.shift()?.();
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    };
    return { spawn: { spawnTool, calls: inner.calls }, releaseUntil, most: () => most };
  }

  it("runs the spans' tool calls at the same time, the CPUs shared out as threads", async () => {
    const held = heldSpawn();
    const running = ensure(behindEdit(), { env: {}, spawn: held.spawn });
    await held.releaseUntil(running);
    const { toolCalls, calls } = await running;
    expect(held.most()).toBe(2);
    // Two spans of about the same length on 8 CPUs: 4 threads each.
    expect(toolCalls.map((call) => call.args[call.args.indexOf("--threads") + 1])).toEqual([
      "4",
      "4",
    ]);
    expect(calls.filter((call) => call.call === "start")).toHaveLength(1);
    expect(calls.find((call) => call.call === "done")).toMatchObject({
      summary: expect.stringMatching(/^2 cut-outs made, 0 reused, 5\.6 s masked/),
    });
    for (const key of keys()) expect(await storage.head(key)).not.toBeNull();
  });

  it("runs one span at a time when memory allows no more, on all the CPUs", async () => {
    const held = heldSpawn();
    const running = ensure(behindEdit(), {
      env: {},
      spawn: held.spawn,
      limits: { cpus: 8, memoryBytes: 2 * 1024 ** 3 },
    });
    await held.releaseUntil(running);
    const { toolCalls } = await running;
    expect(held.most()).toBe(1);
    expect(toolCalls.map((call) => call.args[call.args.indexOf("--threads") + 1])).toEqual([
      "8",
      "8",
    ]);
    expect(toolCalls).toHaveLength(2);
  });

  it("fails the step when a span fails, and uploads no mask for it", async () => {
    const inner = fakeMaskSpawn();
    const spawnTool: SpawnTool = async (call, signal, log) => {
      if (call.args.includes("19.967")) {
        return {
          code: 1,
          exitSignal: null,
          report: "",
          output: "modnet: decoding failed\n",
          stdout: "",
          groupPeakBytes: null,
        };
      }
      return inner.spawnTool(call, signal, log);
    };
    await expect(
      ensure(behindEdit(), { env: {}, spawn: { spawnTool, calls: inner.calls } }),
    ).rejects.toThrow(/cutout exited with 1/);
    const [first, second] = keys();
    // The span that ended well is stored, for the next run to reuse; the other is not.
    expect(await storage.head(first!)).not.toBeNull();
    expect(await storage.head(second!)).toBeNull();
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
    edit.inputs.masks = plannedMasks(behindEdit(), BEHIND_TRANSCRIPT, BEHIND_HEAD_TRACK);
    const { result, calls, toolCalls } = await ensure(edit);
    expect(calls).toEqual([]);
    expect(toolCalls).toEqual([]);
    expect(result.inputs).not.toHaveProperty("masks");
  });

  it("writes no row and names no masks for VISUALs alone, which sit over the footage", async () => {
    const edit = behindEdit();
    edit.tracks.behind = edit.tracks.behind!.flatMap((item) =>
      item.kind === "visual" ? [item] : [],
    );
    const { result, calls, toolCalls } = await ensure(edit);
    expect(calls).toEqual([]);
    expect(toolCalls).toEqual([]);
    expect(result.inputs).not.toHaveProperty("masks");
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
    // The spans end in any order: each mask is recorded as its call ends.
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining(keys().map((key) => ({ key, kind: "rebuildable", step: "cutout" }))),
    );
    expect(classifyKey(PREFIX, keys()[0]!)).toEqual({ kind: "rebuildable", step: "cutout" });
  });
});

// The cut-out span's counts: masks made by this call and stored ones reused.
describe("ensureCutouts span counts", () => {
  it("puts the made and reused counts on the cut-out span when some are stored", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = createTelemetry(
      {},
      { spanProcessors: [new SimpleSpanProcessor({ exporter })] },
    );
    const [first] = keys();
    await storage.put(first!, new TextEncoder().encode("stored"));
    await ensureCutouts({
      ctx: stepContext(recordingSteps().steps, { telemetry }),
      storage,
      keyPrefix: PREFIX,
      scratchDir: scratch,
      edit: behindEdit(),
      transcript: BEHIND_TRANSCRIPT,
      headTrack: BEHIND_HEAD_TRACK,
      tools,
      spawnTool: fakeMaskSpawn().spawnTool,
      env: { E2E_MOCK_MASK: "true" },
    });
    const span = exporter.getFinishedSpans().find((s) => s.name === "step cutout");
    expect(span?.attributes).toMatchObject({
      "cutout.made": 1,
      "cutout.reused": 1,
      "cutout.parallel": 1,
    });
    await telemetry.shutdown();
  });

  it("puts reused on the cut-out span of a cache hit", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = createTelemetry(
      {},
      { spanProcessors: [new SimpleSpanProcessor({ exporter })] },
    );
    for (const key of keys()) await storage.put(key, new TextEncoder().encode("stored"));
    await ensureCutouts({
      ctx: stepContext(recordingSteps().steps, { telemetry }),
      storage,
      keyPrefix: PREFIX,
      scratchDir: scratch,
      edit: behindEdit(),
      transcript: BEHIND_TRANSCRIPT,
      headTrack: BEHIND_HEAD_TRACK,
      tools,
      spawnTool: fakeMaskSpawn().spawnTool,
      env: { E2E_MOCK_MASK: "true" },
    });
    const span = exporter.getFinishedSpans().find((s) => s.name === "step cutout");
    expect(span?.attributes).toMatchObject({ "cutout.made": 0, "cutout.reused": 2 });
    await telemetry.shutdown();
  });
});

describe("cut-out speed", () => {
  // A telemetry whose metrics are kept in memory: each read flushes first.
  function metered() {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    const spans = new InMemorySpanExporter();
    const telemetry = createTelemetry(
      {},
      {
        metricReaders: [reader],
        spanProcessors: [new SimpleSpanProcessor({ exporter: spans })],
      },
    );
    // The metrics by name, as the last export read them.
    const read = async () => {
      await telemetry.flushMetrics();
      const last = exporter.getMetrics().at(-1);
      const metrics = last?.scopeMetrics.flatMap((scope) => scope.metrics) ?? [];
      return Object.fromEntries(
        metrics.map((metric) => [
          metric.descriptor.name,
          metric.dataPoints.map((point) => ({ value: point.value, attributes: point.attributes })),
        ]),
      );
    };
    return { telemetry, spans, read };
  }

  const version = { [VERSION_ATTRIBUTE]: String(MASK_TOOL_VERSION) };

  it("records the footage cut out and the step's wall time, by the tool's version", async () => {
    const { telemetry, read } = metered();
    await ensure(behindEdit(), { env: {}, telemetry });
    const metrics = await read();
    // The two spans are 2.867 s and 2.766 s long.
    expect(metrics["cutout.video"]).toEqual([
      { value: expect.closeTo(5.633, 2), attributes: version },
    ]);
    expect(metrics["cutout.work"]).toEqual([{ value: expect.any(Number), attributes: version }]);
    expect(metrics["cutout.work"]![0]!.value as number).toBeGreaterThan(0);
    await telemetry.shutdown();
  });

  it("counts only the masks it made, and the footage they cover", async () => {
    const { telemetry, read } = metered();
    const [first] = keys();
    await storage.put(first!, new TextEncoder().encode("stored"));
    await ensure(behindEdit(), { env: {}, telemetry });
    const metrics = await read();
    // Only the second span, 2.766 s long, was made.
    expect(metrics["cutout.video"]).toEqual([
      { value: expect.closeTo(2.766, 2), attributes: version },
    ]);
    await telemetry.shutdown();
  });

  it("puts the footage cut out in milliseconds on the step span", async () => {
    const { telemetry, spans } = metered();
    await ensure(behindEdit(), { env: {}, telemetry });
    const step = spans.getFinishedSpans().find((span) => span.name === "step cutout");
    expect(step?.attributes["cutout.video_ms"]).toBe(5633);
    await telemetry.shutdown();
  });

  it("records nothing when every mask was reused", async () => {
    const { telemetry, read } = metered();
    for (const key of keys()) await storage.put(key, new TextEncoder().encode("stored"));
    await ensure(behindEdit(), { env: {}, telemetry });
    expect(await read()).toEqual({});
    await telemetry.shutdown();
  });

  it("adds nothing when the step fails", async () => {
    const { telemetry, read } = metered();
    const inner = fakeMaskSpawn();
    const spawnTool: SpawnTool = async (call, signal, log) => {
      if (call.args.includes("19.967")) {
        return {
          code: 1,
          exitSignal: null,
          report: "",
          output: "modnet: decoding failed\n",
          stdout: "",
          groupPeakBytes: null,
        };
      }
      return inner.spawnTool(call, signal, log);
    };
    await expect(
      ensure(behindEdit(), { env: {}, telemetry, spawn: { spawnTool, calls: inner.calls } }),
    ).rejects.toThrow(/cutout exited with 1/);
    const metrics = await read();
    expect(metrics["cutout.video"]?.map((point) => point.value)).toEqual([0]);
    expect(metrics["cutout.work"]?.map((point) => point.value)).toEqual([0]);
    await telemetry.shutdown();
  });
});
