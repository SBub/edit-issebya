import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Storage, fakeStorage } from "@edit-issebya/storage";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DISABLED_TRACKER } from "./error-tracking.ts";
import { TEST_JOB, recordingSteps } from "./recording-steps.ts";
import { runInProcessStep } from "./step-runner.ts";
import { createTelemetry, endJobSpan, inSpan, startJobSpan } from "./telemetry.ts";
import { keyAttributes, tracedStorage } from "./traced-storage.ts";

const PREFIX = "dev/";
const REEL = "11111111-1111-4111-8111-111111111111";
const VERSION = "22222222-2222-4222-8222-222222222222";
const CACHE_KEY = `${PREFIX}cache/convert/abc123/video.mp4`;
const VERSION_KEY = `${PREFIX}reels/${REEL}/versions/${VERSION}.json`;
const EXPORT_KEY = `${PREFIX}exports/${REEL}/${VERSION}.mp4`;

let root: string;
let raw: Storage;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "traced-storage-"));
  raw = fakeStorage({ root: join(root, "store"), uploadUrlBase: "" });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// A job span, the traced storage under it and the finished spans by name.
function setUp(storage: Storage = raw) {
  const exporter = new InMemorySpanExporter();
  const telemetry = createTelemetry(
    {},
    { spanProcessors: [new SimpleSpanProcessor({ exporter })] },
  );
  const { span: job, context: jobContext } = startJobSpan(telemetry, TEST_JOB);
  const traced = tracedStorage(storage, { telemetry, keyPrefix: PREFIX, fallback: jobContext });
  const named = (name: string) => exporter.getFinishedSpans().filter((s) => s.name === name);
  return { telemetry, job, jobContext, traced, named };
}

describe("keyAttributes", () => {
  it("names the kind from the key's layout, and the step of a pipeline output", () => {
    expect(keyAttributes(PREFIX, CACHE_KEY)).toEqual({
      "r2.kind": "cache",
      "r2.cache_step": "convert",
    });
    expect(keyAttributes(PREFIX, `${PREFIX}reels/${REEL}/source/original.mp4`)).toEqual({
      "r2.kind": "source",
    });
    expect(keyAttributes(PREFIX, VERSION_KEY)).toEqual({ "r2.kind": "version" });
    expect(keyAttributes(PREFIX, EXPORT_KEY)).toEqual({ "r2.kind": "export" });
    expect(keyAttributes(PREFIX, `${PREFIX}library/${REEL}/large.jpg`)).toEqual({
      "r2.kind": "library",
    });
    expect(keyAttributes(PREFIX, `${PREFIX}doctor/probe.txt`)).toEqual({ "r2.kind": "other" });
  });

  it("never carries the key, a reel id or a file name", () => {
    const text = JSON.stringify([
      keyAttributes(PREFIX, CACHE_KEY),
      keyAttributes(PREFIX, VERSION_KEY),
      keyAttributes(PREFIX, EXPORT_KEY),
    ]);
    expect(text).not.toContain(REEL);
    expect(text).not.toContain(VERSION);
    expect(text).not.toContain("video.mp4");
    expect(text).not.toContain("abc123");
  });
});

describe("r2 spans", () => {
  it("puts a step's writes and reads under the step's span, with kind, bytes and outcome", async () => {
    const { telemetry, job, jobContext, traced, named } = setUp();
    const { steps } = recordingSteps();
    const body = new TextEncoder().encode("{}");
    await runInProcessStep(
      {
        steps,
        telemetry,
        errors: DISABLED_TRACKER,
        jobContext,
        job: TEST_JOB,
        signal: new AbortController().signal,
      },
      {
        name: "first_version",
        work: async () => {
          await traced.put(VERSION_KEY, body, { contentType: "application/json" });
          expect(await traced.get(VERSION_KEY)).toEqual(body);
          return { what: "saved", sizeBytes: null };
        },
      },
    );
    endJobSpan(job, "done");

    const step = named("step first_version")[0];
    const [put] = named("r2.put");
    const [get] = named("r2.get");
    expect(put?.parentSpanContext?.spanId).toBe(step?.spanContext().spanId);
    expect(get?.parentSpanContext?.spanId).toBe(step?.spanContext().spanId);
    expect(put?.kind).toBe(SpanKind.CLIENT);
    expect(put?.attributes).toEqual({
      "r2.operation": "put",
      "r2.kind": "version",
      "r2.bytes": 2,
      "r2.outcome": "written",
    });
    expect(get?.attributes).toEqual({
      "r2.operation": "get",
      "r2.kind": "version",
      "r2.bytes": 2,
      "r2.outcome": "ok",
    });
    await telemetry.shutdown();
  });

  it("puts a stage's upload under the stage's span, a file's size as its bytes", async () => {
    const { telemetry, job, jobContext, traced, named } = setUp();
    const file = join(root, "out.mp4");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file in the test's own temp folder
    await writeFile(file, new Uint8Array(1500));
    const copy = join(root, "copy.mp4");
    await inSpan(telemetry, jobContext, "render.upload", {}, async () => {
      expect(await traced.putFileIfAbsent(EXPORT_KEY, file, { contentType: "video/mp4" })).toBe(
        "written",
      );
      expect(await traced.putFileIfAbsent(EXPORT_KEY, file)).toBe("exists");
      expect(await traced.getFile(EXPORT_KEY, copy)).toBe(true);
    });
    endJobSpan(job, "done");

    const stage = named("render.upload")[0];
    const puts = named("r2.put");
    const [get] = named("r2.get");
    expect(puts.map((s) => s.parentSpanContext?.spanId)).toEqual([
      stage?.spanContext().spanId,
      stage?.spanContext().spanId,
    ]);
    expect(puts.map((s) => s.attributes)).toEqual([
      {
        "r2.operation": "putFileIfAbsent",
        "r2.kind": "export",
        "r2.bytes": 1500,
        "r2.outcome": "written",
      },
      {
        "r2.operation": "putFileIfAbsent",
        "r2.kind": "export",
        "r2.bytes": 1500,
        "r2.outcome": "exists",
      },
    ]);
    expect(get?.parentSpanContext?.spanId).toBe(stage?.spanContext().spanId);
    expect(get?.attributes).toEqual({
      "r2.operation": "getFile",
      "r2.kind": "export",
      "r2.bytes": 1500,
      "r2.outcome": "ok",
    });
    await telemetry.shutdown();
  });

  it("puts a call outside any step under the job's span, a missing object as `missing`", async () => {
    const { telemetry, job, traced, named } = setUp();
    expect(await traced.get(CACHE_KEY)).toBeNull();
    expect(await traced.getFile(CACHE_KEY, join(root, "none.mp4"))).toBe(false);
    expect(await traced.putIfAbsent(CACHE_KEY, new Uint8Array(3))).toBe("written");
    endJobSpan(job, "done");

    const gets = named("r2.get");
    expect(gets.map((s) => s.parentSpanContext?.spanId)).toEqual([
      job.spanContext().spanId,
      job.spanContext().spanId,
    ]);
    expect(gets.map((s) => s.attributes)).toEqual([
      {
        "r2.operation": "get",
        "r2.kind": "cache",
        "r2.cache_step": "convert",
        "r2.outcome": "missing",
      },
      {
        "r2.operation": "getFile",
        "r2.kind": "cache",
        "r2.cache_step": "convert",
        "r2.outcome": "missing",
      },
    ]);
    expect(gets.every((s) => s.status.code === SpanStatusCode.UNSET)).toBe(true);
    expect(named("r2.put")[0]?.attributes).toEqual({
      "r2.operation": "putIfAbsent",
      "r2.kind": "cache",
      "r2.cache_step": "convert",
      "r2.bytes": 3,
      "r2.outcome": "written",
    });
    await telemetry.shutdown();
  });

  it("counts the parts of a completed multipart upload", async () => {
    const answers: ("completed" | "missing")[] = ["completed", "missing"];
    const { telemetry, job, traced, named } = setUp({
      ...raw,
      completeMultipartUpload: async () => answers.shift() ?? "missing",
    });
    const options = {
      uploadId: "u1",
      parts: [
        { partNumber: 1, etag: "a" },
        { partNumber: 2, etag: "b" },
        { partNumber: 3, etag: "c" },
      ],
    };
    const key = `${PREFIX}reels/${REEL}/source/original.mp4`;
    expect(await traced.completeMultipartUpload(key, options)).toBe("completed");
    expect(await traced.completeMultipartUpload(key, options)).toBe("missing");
    endJobSpan(job, "done");

    expect(named("r2.put").map((s) => s.attributes)).toEqual([
      {
        "r2.operation": "completeMultipartUpload",
        "r2.kind": "source",
        "r2.multipart_parts": 3,
        "r2.outcome": "written",
      },
      {
        "r2.operation": "completeMultipartUpload",
        "r2.kind": "source",
        "r2.multipart_parts": 3,
        "r2.outcome": "missing",
      },
    ]);
    await telemetry.shutdown();
  });

  it("marks a failed call as an error and rethrows the same error", async () => {
    const failure = new TypeError("fetch failed");
    const { telemetry, job, traced, named } = setUp({
      ...raw,
      put: async () => {
        throw failure;
      },
    });
    await expect(traced.put(VERSION_KEY, new Uint8Array(4))).rejects.toBe(failure);
    endJobSpan(job, "done");

    const [put] = named("r2.put");
    expect(put?.status.code).toBe(SpanStatusCode.ERROR);
    expect(put?.attributes).toEqual({
      "r2.operation": "put",
      "r2.kind": "version",
      "r2.bytes": 4,
      "r2.outcome": "error",
      "error.type": "TypeError",
    });
    expect(put?.events.map((event) => event.name)).toEqual(["exception"]);
    await telemetry.shutdown();
  });

  it("ends a download its signal stopped as `aborted`, not as an error", async () => {
    const stop = new AbortController();
    const { telemetry, job, traced, named } = setUp({
      ...raw,
      getFile: async () => {
        stop.abort();
        throw new Error("aborted");
      },
    });
    await expect(
      traced.getFile(CACHE_KEY, join(root, "x.mp4"), { signal: stop.signal }),
    ).rejects.toThrow("aborted");
    endJobSpan(job, "done");

    const [get] = named("r2.get");
    expect(get?.status.code).toBe(SpanStatusCode.UNSET);
    expect(get?.attributes["r2.outcome"]).toBe("aborted");
    expect(get?.events).toEqual([]);
    await telemetry.shutdown();
  });

  it("makes no span for head, list and delete, and passes their answers through", async () => {
    const { telemetry, job, traced, named } = setUp();
    await raw.put(CACHE_KEY, new Uint8Array(5));
    expect((await traced.head(CACHE_KEY))?.bytes).toBe(5);
    expect(await traced.list(`${PREFIX}cache/`)).toEqual([CACHE_KEY]);
    await traced.delete(CACHE_KEY);
    expect(await raw.head(CACHE_KEY)).toBeNull();
    endJobSpan(job, "done");
    expect(named("r2.get")).toEqual([]);
    expect(named("r2.put")).toEqual([]);
    await telemetry.shutdown();
  });

  it("works with telemetry that exports nothing", async () => {
    const telemetry = createTelemetry({});
    const { context } = startJobSpan(telemetry, TEST_JOB);
    const traced = tracedStorage(raw, { telemetry, keyPrefix: PREFIX, fallback: context });
    await traced.put(VERSION_KEY, new Uint8Array(1));
    expect((await traced.get(VERSION_KEY))?.byteLength).toBe(1);
    await telemetry.shutdown();
  });
});
