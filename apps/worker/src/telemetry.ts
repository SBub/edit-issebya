import { AsyncLocalStorage } from "node:async_hooks";
import {
  type Attributes,
  type Context,
  ROOT_CONTEXT,
  type Span,
  type SpanOptions,
  SpanStatusCode,
  TraceFlags,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { type Logger, SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  type LogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import {
  BatchSpanProcessor,
  type IdGenerator,
  RandomIdGenerator,
  type SpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import type { ClaimedJob } from "./queue.ts";
import { type ReelSizeHolder, reelSizeAttributes } from "./reel-size.ts";
import { scrub } from "./scrub.ts";

type Env = Record<string, string | undefined>;

export interface Telemetry {
  tracer: Tracer;
  logger: Logger;
  // True only when OTEL_EXPORTER_OTLP_ENDPOINT is set and exporters were built.
  exporting: boolean;
  // Starts a span that is a root (no parent span id) in the trace `traceId`.
  startRootSpan(traceId: string, name: string, options: SpanOptions): Span;
  // Flushes and stops both providers; call before the process exits.
  shutdown(): Promise<void>;
}

// The SDK asks its id generator for a trace id only when a span has no valid
// parent, and it asks synchronously inside startSpan. So a trace id pinned for
// the one call is the one that span gets; every other root span (and a pinned
// call that did not need one) gets a random id, as the SDK's default does.
class PinnableIdGenerator implements IdGenerator {
  private readonly random = new RandomIdGenerator();
  private pinned: string | undefined;

  generateTraceId(): string {
    return this.pinned ?? this.random.generateTraceId();
  }

  generateSpanId(): string {
    return this.random.generateSpanId();
  }

  pin<T>(traceId: string, start: () => T): T {
    this.pinned = traceId;
    try {
      return start();
    } finally {
      this.pinned = undefined;
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One reel, one trace: the reel's uuid without dashes, lowercased.
export function traceIdForReel(reelId: string): string {
  if (!UUID.test(reelId)) throw new Error(`not a reel id: ${reelId}`);
  return reelId.replaceAll("-", "").toLowerCase();
}

// A job's trace: its reel's, or its photo's for a `describe_photo` job.
export function traceIdForJob(job: Pick<ClaimedJob, "reel_id" | "photo_id">): string {
  const target = job.reel_id ?? job.photo_id;
  if (!target) throw new Error("job has neither a reel nor a photo");
  return traceIdForReel(target);
}

// `reel.id` or `photo.id`, whichever the job has.
export function targetAttributes(job: Pick<ClaimedJob, "reel_id" | "photo_id">): Attributes {
  return job.reel_id ? { "reel.id": job.reel_id } : { "photo.id": job.photo_id ?? "" };
}

// `k=v,k2=v2`, values URL-decoded (the OTLP exporter spec's header format).
function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const key = pair.slice(0, at).trim();
    if (key) headers[key] = decodeURIComponent(pair.slice(at + 1).trim());
  }
  return headers;
}

// Built per worker process and passed down, never at module load and never
// registered globally. It reads only OTEL_EXPORTER_OTLP_ENDPOINT,
// OTEL_EXPORTER_OTLP_HEADERS and OTEL_SERVICE_NAME. It exports whenever the
// endpoint is set; the headers are optional (a local collector needs none), and
// empty headers send none. Without an endpoint the providers have no processor
// at all. Tests pass in-memory processors.
export function createTelemetry(
  env: Env = process.env,
  {
    spanProcessors = [],
    logProcessors = [],
  }: { spanProcessors?: SpanProcessor[]; logProcessors?: LogRecordProcessor[] } = {},
): Telemetry {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim().replace(/\/+$/, "") ?? "";
  const rawHeaders = env.OTEL_EXPORTER_OTLP_HEADERS?.trim() ?? "";
  const exporting = endpoint !== "";
  const resource = resourceFromAttributes({
    "service.name": env.OTEL_SERVICE_NAME?.trim() || "edit-issebya-worker",
  });

  const spans = [...spanProcessors];
  const logs = [...logProcessors];
  if (exporting) {
    const headers = parseHeaders(rawHeaders);
    spans.push(
      new BatchSpanProcessor({
        exporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers }),
      }),
    );
    logs.push(
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: `${endpoint}/v1/logs`, headers }),
      }),
    );
  }

  const ids = new PinnableIdGenerator();
  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: spans,
    idGenerator: ids,
  });
  const loggerProvider = new LoggerProvider({ resource, processors: logs });
  const tracer = tracerProvider.getTracer("edit-issebya-worker");
  return {
    tracer,
    logger: loggerProvider.getLogger("edit-issebya-worker"),
    exporting,
    startRootSpan(traceId, name, options) {
      // `root` drops any active parent, so no parent span id is written.
      return ids.pin(traceId, () => tracer.startSpan(name, { ...options, root: true }));
    },
    async shutdown() {
      await Promise.all([tracerProvider.shutdown(), loggerProvider.shutdown()]);
    },
  };
}

// `job.queue_wait_ms`: from the job's creation to this claim (`started_at` is
// set by claim_job, on every claim). Left out when either time is not known.
function queueWaitAttributes(job: Pick<ClaimedJob, "created_at" | "started_at">): Attributes {
  if (!job.created_at || !job.started_at) return {};
  const waited = Date.parse(job.started_at) - Date.parse(job.created_at);
  return Number.isFinite(waited) && waited >= 0 ? { "job.queue_wait_ms": waited } : {};
}

// The job span. A reel's job is a root span in the reel's trace (trace id = the
// reel id without dashes), so every job of the reel, at any time, lands in the
// same trace as a top-level block with no parent span id. With the reel's size,
// the span carries its `reel.*` attributes from the start.
//
// A photo's job keeps its earlier shape: it runs under a remote parent with the
// photo's trace id (span id from the photo id's last 16 hex digits, never
// exported), whose span id no span carries, so Grafana shows it as missing parent.
export function startJobSpan(
  telemetry: Telemetry,
  job: ClaimedJob,
  size?: ReelSizeHolder,
): { span: Span; context: Context } {
  const traceId = traceIdForJob(job);
  const options: SpanOptions = {
    attributes: {
      ...targetAttributes(job),
      "job.id": job.id,
      "job.attempt": job.attempts,
      ...queueWaitAttributes(job),
      ...(size ? reelSizeAttributes(size.current()) : {}),
    },
  };
  if (job.reel_id) {
    const span = telemetry.startRootSpan(traceId, `job ${job.kind}`, options);
    return { span, context: trace.setSpan(ROOT_CONTEXT, span) };
  }
  const parent = trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId: traceId.slice(-16),
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
  const span = telemetry.tracer.startSpan(`job ${job.kind}`, options, parent);
  return { span, context: trace.setSpan(parent, span) };
}

// Ends the job span with its outcome, and the reel's size as the job ended
// knowing it (values learned during the job included).
export function endJobSpan(span: Span, outcome: string, size?: ReelSizeHolder): void {
  span.setAttribute("job.outcome", outcome);
  if (size) span.setAttributes(reelSizeAttributes(size.current()));
  // A wait is not an error: the job is taken again later.
  if (outcome === "failed" || outcome === "refused") span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
}

// The span the running work belongs to (its Context), for code that is handed
// no Context: the storage wrapper (traced-storage.ts) reads it to put a read or
// a write under the step or the stage that made it. It is not OpenTelemetry's
// global context manager (none is registered); only `runUnderSpan` sets it.
const activeSpan = new AsyncLocalStorage<Context>();

// Runs `work` with `context` as the active span's Context, for everything it
// awaits.
export function runUnderSpan<T>(context: Context, work: () => T): T {
  return activeSpan.run(context, work);
}

// The Context of the step or stage that is running, if any.
export function activeSpanContext(): Context | undefined {
  return activeSpan.getStore();
}

// Runs `work` in a span of its own, a child of `parent` (a Context carrying
// the span it belongs to). `work` gets the span, to set attributes on it, and
// its Context, the parent of any span it starts. A thrown error marks the span
// as failed and is rethrown unchanged; the span always ends. Spans are
// observation only: the work runs, and fails, as it would without them.
// `cancelled()`, asked when the work throws, says the error is the owner's
// cancel: the span then ends clean with `job.cancelled` true, not as an error.
export async function inSpan<T>(
  telemetry: Telemetry,
  parent: Context,
  name: string,
  attributes: Attributes,
  work: (span: Span, context: Context) => Promise<T>,
  { cancelled }: { cancelled?: () => boolean } = {},
): Promise<T> {
  const span = telemetry.tracer.startSpan(name, { attributes }, parent);
  const context = trace.setSpan(parent, span);
  try {
    return await runUnderSpan(context, () => work(span, context));
  } catch (error) {
    if (cancelled?.()) {
      span.setAttribute("job.cancelled", true);
    } else {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    throw error;
  } finally {
    span.end();
  }
}

export type StepStream = "stdout" | "stderr";

// Emits each output line as an INFO log record in the step span's context, so
// it carries the span's trace and span ids. The stream is an attribute only:
// a tool's stderr is its progress as often as its errors, so no line is an
// ERROR for going to stderr (a failure is one emitFailureLog record).
export function stepLogger(
  telemetry: Telemetry,
  stepContext: Context,
  attributes: Attributes,
): (line: string, stream: StepStream) => void {
  return (line, stream) => {
    telemetry.logger.emit({
      body: line,
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      context: stepContext,
      attributes: { ...attributes, stream },
    });
  };
}

// A job's failure, or one step's failed attempt: one ERROR log record and a
// `failure` event on the failing span (see emitFailureLog).
export interface FailureLogInput {
  job: ClaimedJob;
  // The failed step's name; absent for a failure outside any step.
  step?: string;
  // The step's attempt, or the job's attempts for a failure outside a step.
  attempt: number;
  // True when the step runs once more after this failure.
  retrying: boolean;
  failureKind: string;
  // The error's reason, its first line is the message.
  message: string;
  // The reasons lines the failed row keeps (the tail), the full text.
  reasons: string;
}

const MESSAGE_CHARS = 500;

// The failure's attributes, scrubbed (app_docs/error-tracking.md): the reasons
// as they are, the message as one line.
export function failureAttributes(
  input: Pick<FailureLogInput, "failureKind" | "message" | "reasons">,
) {
  const firstLine = input.message.split("\n").find((line) => line.trim() !== "") ?? "";
  return {
    "failure.kind": input.failureKind,
    "failure.message": scrub(firstLine.trim()).slice(0, MESSAGE_CHARS),
    "failure.reasons": scrub(input.reasons),
  };
}

// Emits the failure as exactly one ERROR log record in `context` (the step's
// span or the job's), so Grafana links it to the trace. Job, reel or photo,
// step and attempt are attributes; the reasons are the full tail.
export function emitFailureLog(
  telemetry: Telemetry,
  context: Context,
  input: FailureLogInput,
): void {
  const { job, step, attempt, retrying } = input;
  const attributes = failureAttributes(input);
  const message = attributes["failure.message"];
  telemetry.logger.emit({
    body: step ? `${step} failed: ${message}` : `job failed: ${message}`,
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
    context,
    attributes: {
      ...targetAttributes(job),
      "job.id": job.id,
      "job.kind": job.kind,
      ...(step ? { "step.name": step, "step.attempt": attempt } : { "job.attempt": attempt }),
      ...attributes,
      "failure.retrying": retrying,
    },
  });
}
