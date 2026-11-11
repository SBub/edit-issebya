import { stat } from "node:fs/promises";
import type { Storage } from "@edit-issebya/storage";
import { type Attributes, type Context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { type Telemetry, activeSpanContext } from "./telemetry.ts";

// What a key holds, from its layout alone (the layouts of stored-files.ts): a
// pipeline output, the raw footage, a version, an export or a library photo.
// Never the key itself: a reel's id or a file's name does not reach a span.
type KeyKind = "cache" | "source" | "version" | "export" | "library" | "other";

const CACHE_STEP = /^[a-z_]{1,40}$/;

// `r2.kind`, and for a pipeline output `r2.cache_step` (the step that made it).
export function keyAttributes(prefix: string, key: string): Attributes {
  const rest = key.startsWith(prefix) ? key.slice(prefix.length) : key;
  const [first, second, third] = rest.split("/");
  let kind: KeyKind = "other";
  if (first === "cache") kind = "cache";
  else if (first === "exports") kind = "export";
  else if (first === "library") kind = "library";
  else if (first === "reels" && third === "source") kind = "source";
  else if (first === "reels" && third === "versions") kind = "version";
  return {
    "r2.kind": kind,
    ...(kind === "cache" && second && CACHE_STEP.test(second) ? { "r2.cache_step": second } : {}),
  };
}

// A local file's size; null when it cannot be read (the span then has no bytes).
async function fileBytes(path: string): Promise<number | null> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the file the storage call read or wrote
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

// The storage with every object read and write as a span: `r2.get` for `get`
// and `getFile`, `r2.put` for `put`, `putIfAbsent`, `putFileIfAbsent` and
// `completeMultipartUpload`. The span is a child of the step or stage running
// the call (telemetry.ts `activeSpanContext`), or of `fallback` outside any.
// The span's duration is the call's; its attributes:
//
// - `r2.operation`: the storage method.
// - `r2.kind` and `r2.cache_step`: see `keyAttributes`.
// - `r2.bytes`: the bytes read, or the bytes offered for writing.
// - `r2.multipart_parts`: the parts of a completed multipart upload. Every
//   other write is one PUT.
// - `r2.outcome`: `ok` or `missing` for a read; `written`, `exists` (the key
//   was taken, nothing replaced) or `missing` (an unknown multipart upload) for
//   a write; `aborted` when the call's signal stopped it; `error` otherwise,
//   with an error status, `error.type` and an `exception` event.
//
// Spans are observation only: the call's answer and its error pass through
// unchanged, and nothing here can fail a call. `head`, `list`, `delete` and the
// signing methods carry no object bytes and are not spans. The wrapping lives
// in the worker so that packages/storage, shared with the studio, never
// depends on OpenTelemetry.
export function tracedStorage(
  storage: Storage,
  {
    telemetry,
    keyPrefix,
    fallback,
  }: { telemetry: Telemetry; keyPrefix: string; fallback: Context },
): Storage {
  async function traced<T>(
    name: "r2.get" | "r2.put",
    operation: keyof Storage,
    key: string,
    attributes: Attributes,
    call: () => Promise<T>,
    // The outcome and, when only the answer tells, the bytes.
    settle: (answer: T) => Promise<{ outcome: string; bytes?: number | null }>,
    signal?: AbortSignal,
  ): Promise<T> {
    const span = telemetry.tracer.startSpan(
      name,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "r2.operation": operation,
          ...keyAttributes(keyPrefix, key),
          ...attributes,
        },
      },
      activeSpanContext() ?? fallback,
    );
    try {
      const answer = await call();
      const { outcome, bytes } = await settle(answer);
      span.setAttribute("r2.outcome", outcome);
      if (typeof bytes === "number") span.setAttribute("r2.bytes", bytes);
      return answer;
    } catch (error) {
      if (signal?.aborted) {
        span.setAttribute("r2.outcome", "aborted");
      } else {
        span.setAttribute("r2.outcome", "error");
        span.setAttribute("error.type", error instanceof Error ? error.name : "Error");
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      throw error;
    } finally {
      span.end();
    }
  }

  return {
    createMultipartUpload: (key, options) => storage.createMultipartUpload(key, options),
    signUploadPart: (key, options) => storage.signUploadPart(key, options),
    listUploadParts: (key, options) => storage.listUploadParts(key, options),
    abortMultipartUpload: (key, options) => storage.abortMultipartUpload(key, options),
    signDownload: (key, options) => storage.signDownload(key, options),
    head: (key, options) => storage.head(key, options),
    delete: (key) => storage.delete(key),
    list: (prefix) => storage.list(prefix),

    get: (key) =>
      traced(
        "r2.get",
        "get",
        key,
        {},
        () => storage.get(key),
        async (bytes) =>
          bytes ? { outcome: "ok", bytes: bytes.byteLength } : { outcome: "missing" },
      ),
    getFile: (key, path, options) =>
      traced(
        "r2.get",
        "getFile",
        key,
        {},
        () => storage.getFile(key, path, options),
        async (found) =>
          found ? { outcome: "ok", bytes: await fileBytes(path) } : { outcome: "missing" },
        options?.signal,
      ),
    put: (key, body, options) =>
      traced(
        "r2.put",
        "put",
        key,
        { "r2.bytes": body.byteLength },
        () => storage.put(key, body, options),
        async () => ({ outcome: "written" }),
      ),
    putIfAbsent: (key, body, options) =>
      traced(
        "r2.put",
        "putIfAbsent",
        key,
        { "r2.bytes": body.byteLength },
        () => storage.putIfAbsent(key, body, options),
        async (outcome) => ({ outcome }),
      ),
    putFileIfAbsent: async (key, path, options) => {
      const bytes = await fileBytes(path);
      return traced(
        "r2.put",
        "putFileIfAbsent",
        key,
        bytes === null ? {} : { "r2.bytes": bytes },
        () => storage.putFileIfAbsent(key, path, options),
        async (outcome) => ({ outcome }),
      );
    },
    completeMultipartUpload: (key, options) =>
      traced(
        "r2.put",
        "completeMultipartUpload",
        key,
        { "r2.multipart_parts": options.parts.length },
        () => storage.completeMultipartUpload(key, options),
        async (result) => ({ outcome: result === "completed" ? "written" : "missing" }),
      ),
  };
}
