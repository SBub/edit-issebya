import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { describe, expect, it } from "vitest";
import type { ToolCall } from "../step-runner.ts";
import { type Telemetry, createTelemetry, runUnderSpan } from "../telemetry.ts";
import { HEAD_TRACK_SETTINGS, frameBytes } from "./head-track.ts";
import {
  HEAD_TRACK_STEP_SETTINGS,
  U2NET_ENTRY,
  headTrack,
  headTrackDecodeArgs,
  headTrackSampleArgs,
  headTrackStep,
  u2netArgs,
} from "./head-track-step.ts";
import { U2NET_SETTINGS, maskEncodeArgs } from "./u2net.ts";

function option(args: string[], name: string): string {
  return args[args.indexOf(name) + 1]!;
}

describe("headTrackSampleArgs", () => {
  it("keeps one frame per sample at 270x480, losslessly, without audio", () => {
    expect(headTrackSampleArgs("/in/source.mp4", "/out/samples.mp4", HEAD_TRACK_SETTINGS)).toEqual([
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-i",
      "/in/source.mp4",
      "-an",
      "-vf",
      "fps=4,scale=270:480",
      "-c:v",
      "libx264",
      "-crf",
      "0",
      "-pix_fmt",
      "yuv444p",
      "/out/samples.mp4",
    ]);
  });
});

describe("headTrackDecodeArgs", () => {
  it("decodes with libvpx-vp9 (alpha kept) to raw RGBA at 4 fps and 270x480", () => {
    const args = headTrackDecodeArgs("/in/mask.webm", "/out/frames.rgba", HEAD_TRACK_SETTINGS);
    expect(args).toEqual([
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-c:v",
      "libvpx-vp9",
      "-i",
      "/in/mask.webm",
      "-an",
      "-vf",
      "fps=4,scale=270:480",
      "-pix_fmt",
      "rgba",
      "-f",
      "rawvideo",
      "/out/frames.rgba",
    ]);
    expect(args.indexOf("libvpx-vp9")).toBeLessThan(args.indexOf("-i"));
  });
});

describe("u2netArgs", () => {
  it("passes the entry its chunk, threads, model and ffmpeg", () => {
    expect(
      u2netArgs(
        { input: "/s/samples.mp4", first: 55, frames: 54, output: "/s/mask-1.rgba", threads: 2 },
        "/models/u2net.onnx",
        { ffmpeg: "/bin/ffmpeg" },
      ),
    ).toEqual([
      U2NET_ENTRY,
      "--input",
      "/s/samples.mp4",
      "--first",
      "55",
      "--frames",
      "54",
      "--output",
      "/s/mask-1.rgba",
      "--threads",
      "2",
      "--model",
      "/models/u2net.onnx",
      "--ffmpeg",
      "/bin/ffmpeg",
    ]);
  });

  it("names the worker's own entry, which exists", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own entry file
    expect(existsSync(U2NET_ENTRY)).toBe(true);
  });
});

const TOOLS = {
  ffmpeg: "ffmpeg",
  ffprobe: "ffprobe",
  hyperframes: ["/node", "/hf.mjs"] as [string, string],
};
const GB = 1024 ** 3;

// Plays each tool: ffprobe counts `count` samples, the entry writes its chunk
// file, ffmpeg writes the file its arguments end with (`count` transparent raw
// frames from the decode).
function fakeTool(count: number, calls: ToolCall[], entry?: (call: ToolCall) => Promise<string>) {
  return async (call: ToolCall): Promise<string> => {
    calls.push(call);
    if (call.file === "ffprobe") return `${count}\n`;
    if (call.file === "/node") {
      if (entry) return entry(call);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      await writeFile(option(call.args, "--output"), "masks");
      return "";
    }
    const out = call.args.at(-1)!;
    const bytes = out.endsWith(".rgba")
      ? new Uint8Array(count * frameBytes(HEAD_TRACK_SETTINGS))
      : "x";
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    await writeFile(out, bytes);
    return "";
  };
}

describe("headTrack", () => {
  it("is the head_track step, reading the retimed footage and keeping its JSON", () => {
    expect(headTrack.name).toBe("head_track");
    expect(headTrack.version).toBe(3);
    expect(headTrack.settings).toEqual({ ...HEAD_TRACK_SETTINGS, mask: U2NET_SETTINGS });
    expect(headTrack.settings.mask.modelSha256).toBe(
      "a42be65f30af575480020f4d827eabadf73c8cdfd8f77577d2946780f54dc746",
    );
    expect(headTrack.outputs).toEqual([{ file: "head-track.json", retention: "kept" }]);
    expect(
      headTrack.inputs({ etag: "e", bytes: 1 }, { retime: "fp" }).map((input) => input.ref),
    ).toEqual([{ step: "retime", fingerprint: "fp", file: "source.mp4" }]);
  });

  it("samples, counts, masks in chunks at once, joins and decodes, then deletes every scratch file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "head-track-step-"));
    try {
      const calls: ToolCall[] = [];
      const step = headTrackStep({
        limits: () => ({ cpus: 8, memoryBytes: 8 * GB }),
        model: "/models/u2net.onnx",
        node: "/node",
      });
      const { what } = await step.run({
        tool: fakeTool(10, calls),
        tools: TOOLS,
        dir,
        files: { "source.mp4": "/in/source.mp4" },
        settings: HEAD_TRACK_STEP_SETTINGS,
        signal: new AbortController().signal,
      });

      const samples = join(dir, "samples.mp4");
      const mask = join(dir, "mask.part.webm");
      const parts = [0, 1, 2, 3].map((index) => join(dir, `mask-${index}.rgba`));
      expect(calls).toHaveLength(8);
      expect(calls[0]).toMatchObject({
        file: "ffmpeg",
        args: headTrackSampleArgs("/in/source.mp4", samples, HEAD_TRACK_SETTINGS),
      });
      expect(calls[1]).toMatchObject({ file: "ffprobe" });
      expect(calls[1]!.args.at(-1)).toBe(samples);
      // 10 samples on 8 CPUs: chunks of 3, 3, 3 and 1, two threads each.
      const chunks = [
        [0, 3],
        [3, 3],
        [6, 3],
        [9, 1],
      ];
      for (const [index, [first, frames]] of chunks.entries()) {
        const call = calls[2 + index]!;
        expect(call.file).toBe("/node");
        expect(call.args).toEqual(
          u2netArgs(
            { input: samples, first: first!, frames: frames!, output: parts[index]!, threads: 2 },
            "/models/u2net.onnx",
            TOOLS,
          ),
        );
        expect(call.sampleGroupMemory).toBe(true);
      }
      expect(calls[6]).toMatchObject({
        file: "ffmpeg",
        args: maskEncodeArgs(parts, mask, HEAD_TRACK_SETTINGS, U2NET_SETTINGS),
      });
      expect(calls[7]).toMatchObject({
        file: "ffmpeg",
        args: headTrackDecodeArgs(mask, join(dir, "frames.rgba"), HEAD_TRACK_SETTINGS),
      });

      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      expect(await readdir(dir)).toEqual(["head-track.json"]);
      expect(
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
        JSON.parse(await readFile(join(dir, "head-track.json"), "utf8")),
      ).toEqual(Array.from({ length: 10 }, () => null));
      expect(what).toMatch(/head/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("gives the step's progress from every chunk, weighted by its samples", async () => {
    const dir = await mkdtemp(join(tmpdir(), "head-track-step-"));
    try {
      const calls: ToolCall[] = [];
      const step = headTrackStep({
        limits: () => ({ cpus: 8, memoryBytes: 8 * GB }),
        node: "/node",
      });
      await step.run({
        tool: fakeTool(10, calls),
        tools: TOOLS,
        dir,
        files: { "source.mp4": "/in/source.mp4" },
        settings: HEAD_TRACK_STEP_SETTINGS,
        signal: new AbortController().signal,
      });
      const [a, b, c, d] = calls.slice(2, 6).map((call) => call.progress!);
      const line = (pct: number) => `@hf-progress {"index":1,"total":1,"pct":${pct}}`;
      expect(a!("not progress")).toBeNull();
      // Three of the ten samples are done, then one more, then all.
      expect(a!(line(100))).toBe(30);
      expect(d!(line(100))).toBe(40);
      expect(b!(line(50))).toBe(55);
      expect(b!(line(100))).toBe(70);
      expect(c!(line(100))).toBe(100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("masks in one chunk on one CPU, on one thread", async () => {
    const dir = await mkdtemp(join(tmpdir(), "head-track-step-"));
    try {
      const calls: ToolCall[] = [];
      const step = headTrackStep({
        limits: () => ({ cpus: 1, memoryBytes: 8 * GB }),
        node: "/node",
      });
      await step.run({
        tool: fakeTool(10, calls),
        tools: TOOLS,
        dir,
        files: { "source.mp4": "/in/source.mp4" },
        settings: HEAD_TRACK_STEP_SETTINGS,
        signal: new AbortController().signal,
      });
      const entries = calls.filter((call) => call.file === "/node");
      expect(entries).toHaveLength(1);
      expect(option(entries[0]!.args, "--first")).toBe("0");
      expect(option(entries[0]!.args, "--frames")).toBe("10");
      expect(option(entries[0]!.args, "--threads")).toBe("1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails when a chunk fails, leaving no scratch file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "head-track-step-"));
    try {
      const step = headTrackStep({
        limits: () => ({ cpus: 8, memoryBytes: 8 * GB }),
        node: "/node",
      });
      await expect(
        step.run({
          tool: fakeTool(10, [], async (call) => {
            // A killed entry leaves its `.part`.
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
            await writeFile(`${option(call.args, "--output")}.part`, "half");
            if (option(call.args, "--first") === "3") throw new Error("u2net: decoding failed");
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
            await writeFile(option(call.args, "--output"), "masks");
            return "";
          }),
          tools: TOOLS,
          dir,
          files: { "source.mp4": "/in/source.mp4" },
          settings: HEAD_TRACK_STEP_SETTINGS,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/u2net: decoding failed/);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails on a sample clip without frames", async () => {
    const dir = await mkdtemp(join(tmpdir(), "head-track-step-"));
    try {
      await expect(
        headTrackStep({ node: "/node" }).run({
          tool: fakeTool(0, []),
          tools: TOOLS,
          dir,
          files: { "source.mp4": "/in/source.mp4" },
          settings: HEAD_TRACK_STEP_SETTINGS,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/head_track: the sample clip has no frames/);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("head track speed", () => {
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

  // The step's run, under a step span of the telemetry, as the pipeline runs it.
  async function runTracked(
    telemetry: Telemetry,
    dir: string,
    tool: (call: ToolCall) => Promise<string>,
  ) {
    const span = telemetry.tracer.startSpan("step head_track");
    try {
      return await runUnderSpan(trace.setSpan(ROOT_CONTEXT, span), () =>
        headTrackStep({
          limits: () => ({ cpus: 8, memoryBytes: 8 * GB }),
          node: "/node",
        }).run({
          tool,
          tools: TOOLS,
          dir,
          files: { "source.mp4": "/in/source.mp4" },
          settings: HEAD_TRACK_STEP_SETTINGS,
          signal: new AbortController().signal,
          telemetry,
        }),
      );
    } finally {
      span.end();
    }
  }

  const version = { head_track_version: String(headTrack.version) };

  it("records the footage tracked and the step's wall time, by the version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "head-track-speed-"));
    const { telemetry, read } = metered();
    try {
      await runTracked(telemetry, dir, fakeTool(10, []));
      const metrics = await read();
      // Ten samples a quarter second apart: 2.5 s of footage.
      expect(metrics["head_track.video"]).toEqual([
        { value: expect.closeTo(2.5, 5), attributes: version },
      ]);
      expect(metrics["head_track.work"]).toEqual([
        { value: expect.any(Number), attributes: version },
      ]);
      expect(metrics["head_track.work"]![0]!.value as number).toBeGreaterThan(0);
    } finally {
      await telemetry.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("puts the footage tracked in milliseconds on the step span", async () => {
    const dir = await mkdtemp(join(tmpdir(), "head-track-speed-"));
    const { telemetry, spans } = metered();
    try {
      await runTracked(telemetry, dir, fakeTool(10, []));
      const step = spans.getFinishedSpans().find((span) => span.name === "step head_track");
      expect(step?.attributes["head_track.video_ms"]).toBe(2500);
    } finally {
      await telemetry.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("adds nothing when the step fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "head-track-speed-"));
    const { telemetry, read } = metered();
    try {
      await expect(
        runTracked(
          telemetry,
          dir,
          fakeTool(10, [], async (call) => {
            if (option(call.args, "--first") === "3") throw new Error("u2net: decoding failed");
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
            await writeFile(option(call.args, "--output"), "masks");
            return "";
          }),
        ),
      ).rejects.toThrow(/u2net: decoding failed/);
      const metrics = await read();
      expect(metrics["head_track.video"]?.map((point) => point.value)).toEqual([0]);
      expect(metrics["head_track.work"]?.map((point) => point.value)).toEqual([0]);
    } finally {
      await telemetry.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
