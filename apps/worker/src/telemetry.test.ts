import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DISABLED_TRACKER } from "./error-tracking.ts";
import { UNKNOWN_SIZE, createReelSizeHolder } from "./reel-size.ts";
import { TEST_JOB, recordingSteps, stepContext } from "./recording-steps.ts";
import { recordHit, runInProcessStep, runStep } from "./step-runner.ts";
import {
  type Telemetry,
  createTelemetry,
  emitFailureLog,
  endJobSpan,
  inSpan,
  startJobSpan,
  targetAttributes,
  traceIdForJob,
  traceIdForReel,
} from "./telemetry.ts";

const REEL = TEST_JOB.reel_id as string;

async function runJobWithSteps(telemetry: Telemetry, job = TEST_JOB, names = ["one", "two"]) {
  const { steps } = recordingSteps();
  const { span, context: jobContext } = startJobSpan(telemetry, job);
  const signal = new AbortController().signal;
  for (const name of names) {
    await runInProcessStep(
      { steps, telemetry, errors: DISABLED_TRACKER, jobContext, job, signal },
      { name, work: async () => ({ what: `${name} done`, sizeBytes: null }) },
    );
  }
  telemetry.logger.emit({ body: "a line", context: jobContext });
  endJobSpan(span, "done");
}

describe("failure log records", () => {
  it("emits one ERROR record in the failing span's context, scrubbed", async () => {
    const spans = new InMemorySpanExporter();
    const logs = new InMemoryLogRecordExporter();
    const telemetry = createTelemetry(
      {},
      {
        spanProcessors: [new SimpleSpanProcessor({ exporter: spans })],
        logProcessors: [new SimpleLogRecordProcessor({ exporter: logs })],
      },
    );
    const { span, context: jobContext } = startJobSpan(telemetry, TEST_JOB);
    emitFailureLog(telemetry, jobContext, {
      job: TEST_JOB,
      step: "render",
      attempt: 2,
      retrying: false,
      failureKind: "failed",
      message: "render exited with 1\nsecond line",
      reasons: "GET https://example.com/k?sig=1 failed\nboom sb_secret_x",
    });
    endJobSpan(span, "failed");

    const records = logs.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.severityNumber).toBe(SeverityNumber.ERROR);
    expect(record?.severityText).toBe("ERROR");
    expect(record?.body).toBe("render failed: render exited with 1");
    expect(record?.spanContext?.traceId).toBe(traceIdForReel(REEL));
    expect(record?.spanContext?.spanId).toBe(span.spanContext().spanId);
    expect(record?.attributes).toEqual({
      "reel.id": REEL,
      "job.id": TEST_JOB.id,
      "job.kind": TEST_JOB.kind,
      "step.name": "render",
      "step.attempt": 2,
      "failure.kind": "failed",
      "failure.message": "render exited with 1",
      "failure.reasons": "GET https://example.com/k?[redacted] failed\nboom [redacted]",
      "failure.retrying": false,
    });
    await telemetry.shutdown();
  });

  it("emits a job failure outside any step with job.attempt and no step attributes", async () => {
    const logs = new InMemoryLogRecordExporter();
    const telemetry = createTelemetry(
      {},
      { logProcessors: [new SimpleLogRecordProcessor({ exporter: logs })] },
    );
    const { span, context: jobContext } = startJobSpan(telemetry, TEST_JOB);
    emitFailureLog(telemetry, jobContext, {
      job: TEST_JOB,
      attempt: 1,
      retrying: false,
      failureKind: "transient",
      message: "fetch failed",
      reasons: "fetch failed",
    });
    endJobSpan(span, "failed");
    const [record] = logs.getFinishedLogRecords();
    expect(record?.body).toBe("job failed: fetch failed");
    expect(record?.attributes).toMatchObject({ "job.attempt": 1, "failure.kind": "transient" });
    expect(record?.attributes).not.toHaveProperty("step.name");
    await telemetry.shutdown();
  });
});

describe("traceIdForReel", () => {
  it("is the reel uuid without dashes, lowercased, and stable", () => {
    expect(traceIdForReel(REEL)).toBe("5f1c9e2a0d3b4a7e8c6f2b9d4e1a7c30");
    expect(traceIdForReel(REEL.toUpperCase())).toBe(traceIdForReel(REEL));
    expect(traceIdForReel("6f1c9e2a-0d3b-4a7e-8c6f-2b9d4e1a7c30")).not.toBe(traceIdForReel(REEL));
  });

  it("refuses anything but a uuid", () => {
    expect(() => traceIdForReel("not-a-uuid")).toThrow("not a reel id");
  });
});

describe("traceIdForJob and targetAttributes", () => {
  const PHOTO = "7a2d0c1e-4b5f-4c3a-9e8d-1f2a3b4c5d6e";

  it("follow the reel for a reel's job and the photo for a photo's job", () => {
    expect(traceIdForJob(TEST_JOB)).toBe(traceIdForReel(REEL));
    expect(traceIdForJob({ reel_id: null, photo_id: PHOTO })).toBe(traceIdForReel(PHOTO));
    expect(targetAttributes(TEST_JOB)).toEqual({ "reel.id": REEL });
    expect(targetAttributes({ reel_id: null, photo_id: PHOTO })).toEqual({ "photo.id": PHOTO });
  });

  it("refuse a job with neither", () => {
    expect(() => traceIdForJob({ reel_id: null, photo_id: null })).toThrow("neither");
  });
});

describe("spans", () => {
  it("gives one trace per reel, one root span per job and one child span per step", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = createTelemetry(
      {},
      { spanProcessors: [new SimpleSpanProcessor({ exporter })] },
    );
    await runJobWithSteps(telemetry);
    await runJobWithSteps(telemetry, { ...TEST_JOB, id: "second-job", attempts: 2 }, ["three"]);
    // Read before shutdown: shutting down clears the in-memory exporters.
    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name)).toEqual([
      "step one",
      "step two",
      "job process",
      "step three",
      "job process",
    ]);
    const traceIds = new Set(spans.map((s) => s.spanContext().traceId));
    expect([...traceIds]).toEqual([traceIdForReel(REEL)]);

    const [one, two, job, three, secondJob] = spans;
    expect(one?.parentSpanContext?.spanId).toBe(job?.spanContext().spanId);
    expect(two?.parentSpanContext?.spanId).toBe(job?.spanContext().spanId);
    expect(three?.parentSpanContext?.spanId).toBe(secondJob?.spanContext().spanId);
    expect(job?.attributes).toMatchObject({
      "reel.id": REEL,
      "job.id": TEST_JOB.id,
      "job.outcome": "done",
    });
    expect(one?.attributes).toMatchObject({
      "step.name": "one",
      "step.wall_ms": expect.any(Number),
    });
    // Each job is a root: no parent span id, so no missing-parent gap in Tempo.
    expect(job?.parentSpanContext).toBeUndefined();
    expect(secondJob?.parentSpanContext).toBeUndefined();
    expect(secondJob?.spanContext().traceId).toBe(traceIdForReel(REEL));
    await telemetry.shutdown();
  });

  it("keeps a span started outside any job out of the reel's trace", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = createTelemetry(
      {},
      { spanProcessors: [new SimpleSpanProcessor({ exporter })] },
    );
    await runJobWithSteps(telemetry);
    telemetry.tracer.startSpan("loose").end();
    const loose = exporter.getFinishedSpans().find((s) => s.name === "loose");
    expect(loose?.spanContext().traceId).not.toBe(traceIdForReel(REEL));
    expect(loose?.parentSpanContext).toBeUndefined();
    await telemetry.shutdown();
  });

  it("keeps a photo's job under its remote parent, in the photo's trace", async () => {
    const PHOTO = "7a2d0c1e-4b5f-4c3a-9e8d-1f2a3b4c5d6e";
    const exporter = new InMemorySpanExporter();
    const telemetry = createTelemetry(
      {},
      { spanProcessors: [new SimpleSpanProcessor({ exporter })] },
    );
    const photoJob = { ...TEST_JOB, reel_id: null, photo_id: PHOTO };
    const { span, context } = startJobSpan(telemetry, photoJob);
    await inSpan(telemetry, context, "decide.test", {}, async () => undefined);
    endJobSpan(span, "done");
    const job = exporter.getFinishedSpans().find((s) => s.name === "job process");
    expect(job?.spanContext().traceId).toBe(traceIdForReel(PHOTO));
    expect(job?.parentSpanContext?.isRemote).toBe(true);
    expect(job?.parentSpanContext?.spanId).toBe(traceIdForReel(PHOTO).slice(-16));
    expect(job?.attributes).toMatchObject({ "photo.id": PHOTO });
    await telemetry.shutdown();
  });
});

describe("log records", () => {
  it(
    "carries each output line with the step span's trace and span ids",
    { timeout: 20_000 },
    async () => {
      const spans = new InMemorySpanExporter();
      const logs = new InMemoryLogRecordExporter();
      const telemetry = createTelemetry(
        {},
        {
          spanProcessors: [new SimpleSpanProcessor({ exporter: spans })],
          logProcessors: [new SimpleLogRecordProcessor({ exporter: logs })],
        },
      );
      const { steps } = recordingSteps();
      const { span, context: jobContext } = startJobSpan(telemetry, TEST_JOB);
      await runStep(
        {
          steps,
          telemetry,
          errors: DISABLED_TRACKER,
          jobContext,
          job: TEST_JOB,
          signal: new AbortController().signal,
        },
        {
          name: "echo",
          file: process.execPath,
          args: ["-e", 'console.log("first"); console.error("second");'],
          describe: "echoed",
        },
      );
      endJobSpan(span, "done");

      const step = spans.getFinishedSpans().find((s) => s.name === "step echo");
      const records = logs.getFinishedLogRecords();
      // Stderr is progress as often as an error: both streams are INFO.
      expect(records.map((r) => [r.body, r.severityText, r.attributes.stream]).sort()).toEqual([
        ["first", "INFO", "stdout"],
        ["second", "INFO", "stderr"],
      ]);
      expect(records.every((r) => r.severityNumber === SeverityNumber.INFO)).toBe(true);
      for (const record of records) {
        expect(record.spanContext?.traceId).toBe(traceIdForReel(REEL));
        expect(record.spanContext?.spanId).toBe(step?.spanContext().spanId);
        expect(record.attributes).toMatchObject({ "reel.id": REEL, "step.name": "echo" });
      }
      expect(trace.getSpan(jobContext)).toBe(span);
      await telemetry.shutdown();
    },
  );
});

describe("export", () => {
  let server: Server;
  let url: string;
  const requests: string[] = [];
  const authorizations: (string | null)[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      authorizations.push(request.headers.authorization ?? null);
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("sends nothing without an endpoint, whatever the headers", async () => {
    for (const env of [
      {},
      { OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer x" },
      { OTEL_EXPORTER_OTLP_ENDPOINT: "", OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer x" },
      { OTEL_EXPORTER_OTLP_ENDPOINT: "  ", OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer x" },
    ]) {
      const telemetry = createTelemetry(env);
      expect(telemetry.exporting).toBe(false);
      await runJobWithSteps(telemetry);
      await telemetry.shutdown();
    }
    expect(requests).toEqual([]);
  });

  it("sends traces and logs to the endpoint alone, with no Authorization header", async () => {
    requests.length = 0;
    authorizations.length = 0;
    const telemetry = createTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: url,
      OTEL_EXPORTER_OTLP_HEADERS: "",
    });
    expect(telemetry.exporting).toBe(true);
    await runJobWithSteps(telemetry);
    await telemetry.shutdown();
    expect(requests.sort()).toEqual(["POST /v1/logs", "POST /v1/traces"]);
    expect(authorizations).toEqual([null, null]);
  });

  it("sends traces and logs when both are set (positive control)", async () => {
    requests.length = 0;
    authorizations.length = 0;
    const telemetry = createTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: `${url}/`,
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20x,X-Extra=a=b",
    });
    expect(telemetry.exporting).toBe(true);
    await runJobWithSteps(telemetry);
    await telemetry.shutdown();
    expect(requests.sort()).toEqual(["POST /v1/logs", "POST /v1/traces"]);
    expect(authorizations).toEqual(["Bearer x", "Bearer x"]);
  });
});

describe("reel size attributes", () => {
  it("puts reel.* on the job span, every step span and a cache hit's span", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = createTelemetry(
      {},
      { spanProcessors: [new SimpleSpanProcessor({ exporter })] },
    );
    const size = createReelSizeHolder({ ...UNKNOWN_SIZE, sourceBytes: 1000, sourceSeconds: 50 });
    const { span, context: jobContext } = startJobSpan(telemetry, TEST_JOB, size);
    const { steps } = recordingSteps();
    const ctx = { ...stepContext(steps, { telemetry, size }), jobContext };
    await runInProcessStep(ctx, {
      name: "retime",
      work: async () => {
        // Learned mid-step: on this step's span when it ends, and every later one.
        size.update({ footageSeconds: 41, wordCount: 120 });
        return { what: "retimed", sizeBytes: null };
      },
    });
    await recordHit(ctx, { name: "head_track", summary: "reused", wallMs: 1 });
    endJobSpan(span, "done", size);
    const spans = exporter.getFinishedSpans();
    const byName = Object.fromEntries(spans.map((s) => [s.name, s.attributes]));
    const learned = {
      "reel.source_bytes": 1000,
      "reel.source_seconds": 50,
      "reel.footage_seconds": 41,
      "reel.word_count": 120,
    };
    expect(byName["step retime"]).toMatchObject(learned);
    expect(byName["step head_track"]).toMatchObject(learned);
    expect(byName["job process"]).toMatchObject(learned);
    await telemetry.shutdown();
  });

  it("puts none on a span without a size (a photo job)", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = createTelemetry(
      {},
      { spanProcessors: [new SimpleSpanProcessor({ exporter })] },
    );
    const { span } = startJobSpan(telemetry, TEST_JOB);
    endJobSpan(span, "done");
    const keys = Object.keys(exporter.getFinishedSpans()[0]!.attributes);
    expect(keys.filter((key) => key.startsWith("reel.") && key !== "reel.id")).toEqual([]);
    await telemetry.shutdown();
  });
});

describe("job.queue_wait_ms", () => {
  function jobSpanAttributes(times: { created_at?: string; started_at?: string | null }) {
    const exporter = new InMemorySpanExporter();
    const telemetry = createTelemetry(
      {},
      { spanProcessors: [new SimpleSpanProcessor({ exporter })] },
    );
    const { span } = startJobSpan(telemetry, { ...TEST_JOB, ...times });
    endJobSpan(span, "done");
    return exporter.getFinishedSpans()[0]?.attributes ?? {};
  }

  it("is the time from the job's creation to its claim", () => {
    expect(
      jobSpanAttributes({
        created_at: "2026-11-10T10:00:00.000Z",
        started_at: "2026-11-10T10:00:02.500Z",
      })["job.queue_wait_ms"],
    ).toBe(2500);
  });

  it("is left out when a time is missing or the two are out of order", () => {
    expect(jobSpanAttributes({})).not.toHaveProperty("job.queue_wait_ms");
    expect(
      jobSpanAttributes({ created_at: "2026-11-10T10:00:00.000Z", started_at: null }),
    ).not.toHaveProperty("job.queue_wait_ms");
    expect(
      jobSpanAttributes({
        created_at: "2026-11-10T10:00:05.000Z",
        started_at: "2026-11-10T10:00:00.000Z",
      }),
    ).not.toHaveProperty("job.queue_wait_ms");
  });
});

describe("inSpan", () => {
  it("runs the work in a child span of the parent, with its attributes and context", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = createTelemetry(
      {},
      { spanProcessors: [new SimpleSpanProcessor({ exporter })] },
    );
    const { span: job, context: jobContext } = startJobSpan(telemetry, TEST_JOB);
    const value = await inSpan(
      telemetry,
      jobContext,
      "decide.test",
      { "decide.attempt": 1 },
      async (span, context) => {
        span.setAttribute("decide.outcome", "ok");
        // A span started under the work's context is its child.
        const inner = telemetry.tracer.startSpan("inner", {}, context);
        inner.end();
        return "done";
      },
    );
    endJobSpan(job, "done");
    expect(value).toBe("done");
    const spans = exporter.getFinishedSpans();
    const child = spans.find((s) => s.name === "decide.test");
    const inner = spans.find((s) => s.name === "inner");
    expect(child?.parentSpanContext?.spanId).toBe(job.spanContext().spanId);
    expect(child?.attributes).toMatchObject({ "decide.attempt": 1, "decide.outcome": "ok" });
    expect(inner?.parentSpanContext?.spanId).toBe(child?.spanContext().spanId);
    await telemetry.shutdown();
  });

  it("marks the span failed, records the error, rethrows it unchanged and always ends the span", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = createTelemetry(
      {},
      { spanProcessors: [new SimpleSpanProcessor({ exporter })] },
    );
    const { context: jobContext } = startJobSpan(telemetry, TEST_JOB);
    const thrown = new Error("the call broke");
    const error = await inSpan(telemetry, jobContext, "decide.test", {}, async () => {
      throw thrown;
    }).catch((caught: unknown) => caught);
    expect(error).toBe(thrown);
    const span = exporter.getFinishedSpans().find((s) => s.name === "decide.test");
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events.map((event) => event.name)).toEqual(["exception"]);
    await telemetry.shutdown();
  });

  it("works with telemetry that exports nothing", async () => {
    const telemetry = createTelemetry({});
    const { context } = startJobSpan(telemetry, TEST_JOB);
    await expect(inSpan(telemetry, context, "decide.test", {}, async () => 7)).resolves.toBe(7);
    await telemetry.shutdown();
  });

  it("ends a cancelled work clean with job.cancelled, not as an error", async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = createTelemetry(
      {},
      { spanProcessors: [new SimpleSpanProcessor({ exporter })] },
    );
    const { context: jobContext } = startJobSpan(telemetry, TEST_JOB);
    let cancelled = true;
    const thrown = new Error("job cancelled");
    const error = await inSpan(
      telemetry,
      jobContext,
      "render.encode",
      {},
      async () => {
        throw thrown;
      },
      { cancelled: () => cancelled },
    ).catch((caught: unknown) => caught);
    expect(error).toBe(thrown);
    const span = exporter.getFinishedSpans().find((s) => s.name === "render.encode");
    expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(span?.events).toEqual([]);
    expect(span?.attributes).toEqual({ "job.cancelled": true });
    // Not cancelled: the same error is a failure again.
    cancelled = false;
    await inSpan(
      telemetry,
      jobContext,
      "render.encode",
      {},
      async () => {
        throw thrown;
      },
      { cancelled: () => cancelled },
    ).catch(() => {});
    const failed = exporter.getFinishedSpans().filter((s) => s.name === "render.encode")[1];
    expect(failed?.status.code).toBe(SpanStatusCode.ERROR);
    await telemetry.shutdown();
  });
});
