import {
  type Attributes,
  type Context,
  ROOT_CONTEXT,
  type Span,
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
import { BatchSpanProcessor, type SpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import type { ClaimedJob } from "./queue.ts";

type Env = Record<string, string | undefined>;

export interface Telemetry {
  tracer: Tracer;
  logger: Logger;
  // True only when both OTLP variables are set and exporters were built.
  exporting: boolean;
  // Flushes and stops both providers; call before the process exits.
  shutdown(): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One reel, one trace: the reel's uuid without dashes, lowercased.
export function traceIdForReel(reelId: string): string {
  if (!UUID.test(reelId)) throw new Error(`not a reel id: ${reelId}`);
  return reelId.replaceAll("-", "").toLowerCase();
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
// OTEL_EXPORTER_OTLP_HEADERS and OTEL_SERVICE_NAME, and exports only when the
// first two are both set; otherwise the providers have no processor at all.
// Tests pass in-memory processors.
export function createTelemetry(
  env: Env = process.env,
  {
    spanProcessors = [],
    logProcessors = [],
  }: { spanProcessors?: SpanProcessor[]; logProcessors?: LogRecordProcessor[] } = {},
): Telemetry {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim().replace(/\/+$/, "") ?? "";
  const rawHeaders = env.OTEL_EXPORTER_OTLP_HEADERS?.trim() ?? "";
  const exporting = endpoint !== "" && rawHeaders !== "";
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

  const tracerProvider = new TracerProvider({ resource, spanProcessors: spans });
  const loggerProvider = new LoggerProvider({ resource, processors: logs });
  return {
    tracer: tracerProvider.getTracer("edit-issebya-worker"),
    logger: loggerProvider.getLogger("edit-issebya-worker"),
    exporting,
    async shutdown() {
      await Promise.all([tracerProvider.shutdown(), loggerProvider.shutdown()]);
    },
  };
}

// The job span, under a remote parent carrying the reel's trace id (span id
// from the reel id's last 16 hex digits, never exported), so every job of the
// reel, at any time, lands in the same trace.
export function startJobSpan(
  telemetry: Telemetry,
  job: ClaimedJob,
): { span: Span; context: Context } {
  const traceId = traceIdForReel(job.reel_id);
  const parent = trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId: traceId.slice(-16),
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
  const span = telemetry.tracer.startSpan(
    `job ${job.kind}`,
    { attributes: { "reel.id": job.reel_id, "job.id": job.id, "job.attempt": job.attempts } },
    parent,
  );
  return { span, context: trace.setSpan(parent, span) };
}

// Ends the job span with its outcome.
export function endJobSpan(span: Span, outcome: string): void {
  span.setAttribute("job.outcome", outcome);
  if (outcome === "failed") span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
}

export type StepStream = "stdout" | "stderr";

// Emits each output line as a log record in the step span's context, so it
// carries the span's trace and span ids.
export function stepLogger(
  telemetry: Telemetry,
  stepContext: Context,
  attributes: Attributes,
): (line: string, stream: StepStream) => void {
  return (line, stream) => {
    telemetry.logger.emit({
      body: line,
      severityNumber: stream === "stderr" ? SeverityNumber.ERROR : SeverityNumber.INFO,
      severityText: stream === "stderr" ? "ERROR" : "INFO",
      context: stepContext,
      attributes: { ...attributes, stream },
    });
  };
}
