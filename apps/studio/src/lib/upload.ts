import { isPartNumber, isStorageKey, isUploadId } from "@edit-issebya/storage";

// The studio's own limit (1 GiB): the browser refuses a larger file before
// anything is created. R2's multipart limit is far above it.
export const MAX_UPLOAD_BYTES = 1024 ** 3;

// Every part but the last is exactly this size: S3 and R2 need at least 5 MiB
// per part, and R2 needs equal part sizes.
export const PART_BYTES = 10 * 1024 ** 2;

const CONTENT_TYPES = new Map([
  ["mp4", "video/mp4"],
  ["mov", "video/quicktime"],
  ["m4v", "video/x-m4v"],
  ["webm", "video/webm"],
]);
const EXTENSIONS = new Set(CONTENT_TYPES.keys());
const MAX_NAME_LENGTH = 200;

// The file's lower-cased extension when the studio accepts it, else null.
export function sourceExtension(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return EXTENSIONS.has(ext) ? ext : null;
}

// Where the source lands in the bucket. The reels insert policy accepts only a
// key ending with this reel's own `reels/<id>/source/original.<ext>`.
export function sourceKey(prefix: string, reelId: string, ext: string): string {
  return `${prefix}reels/${reelId}/source/original.${ext}`;
}

// The Content-Type the stored object gets, from the key's own extension, so
// the server signs it without trusting the browser.
export function contentTypeOf(key: string): string {
  const ext = sourceExtension(key);
  return (ext && CONTENT_TYPES.get(ext)) ?? "application/octet-stream";
}

export interface UploadRequest {
  name: string;
  bytes: number;
  type: string;
  ext: string;
}

export type ParsedUpload = { ok: true; value: UploadRequest } | { ok: false; reason: string };

export function parseUploadRequest(input: {
  name?: unknown;
  bytes?: unknown;
  type?: unknown;
}): ParsedUpload {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 1 || name.length > MAX_NAME_LENGTH) return { ok: false, reason: "name" };
  const { bytes } = input;
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 1) {
    return { ok: false, reason: "empty" };
  }
  if (bytes > MAX_UPLOAD_BYTES) return { ok: false, reason: "too-large" };
  const type = typeof input.type === "string" ? input.type.trim() : "";
  if (type !== "" && !type.startsWith("video/")) return { ok: false, reason: "type" };
  const ext = sourceExtension(name);
  if (!ext) return { ok: false, reason: "extension" };
  return { ok: true, value: { name, bytes, type, ext } };
}

export type SignRequest =
  | { kind: "create"; key: string }
  | { kind: "part"; key: string; uploadId: string; partNumber: number }
  | { kind: "list"; key: string; uploadId: string }
  | { kind: "complete"; key: string; uploadId: string };

/**
 * One S3 request the browser's uploader asks the studio to sign. Only the four
 * multipart requests pass: a single PutObject (PUT without an upload id) and
 * every DELETE are refused, abort runs on the server. The client's `expiresIn`
 * is ignored.
 */
export function parseSignRequest(input: unknown): { ok: true; value: SignRequest } | { ok: false } {
  if (typeof input !== "object" || input === null) return { ok: false };
  const { method, key, uploadId, partNumber } = input as Record<string, unknown>;
  if (typeof key !== "string" || !isStorageKey(key)) return { ok: false };
  if (uploadId === undefined) {
    return method === "POST" ? { ok: true, value: { kind: "create", key } } : { ok: false };
  }
  if (!isUploadId(uploadId)) return { ok: false };
  if (method === "PUT") {
    return isPartNumber(partNumber)
      ? { ok: true, value: { kind: "part", key, uploadId, partNumber } }
      : { ok: false };
  }
  if (partNumber !== undefined) return { ok: false };
  if (method === "GET") return { ok: true, value: { kind: "list", key, uploadId } };
  if (method === "POST") return { ok: true, value: { kind: "complete", key, uploadId } };
  return { ok: false };
}

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

// How long to wait before retry `attempt` (0-based) of a failed upload; null
// once the retries are spent.
export function retryDelayMs(attempt: number): number | null {
  return RETRY_DELAYS_MS[attempt] ?? null;
}
