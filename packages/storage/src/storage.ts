// The storage the studio and the worker share: Cloudflare R2 in production, a
// folder-backed fake under E2E_MOCK_STORAGE=true. Keys are bucket-relative
// paths such as `dev/reels/<id>/source/original.mp4`.
export interface Storage {
  // Starts an S3 multipart upload of the object; the browser then PUTs each
  // part to its own signed URL.
  createMultipartUpload(
    key: string,
    options: { contentType: string },
  ): Promise<{ uploadId: string }>;
  // A URL the browser PUTs one part (1 to MAX_PART_NUMBER) to.
  signUploadPart(
    key: string,
    options: { uploadId: string; partNumber: number; expiresInSeconds: number },
  ): Promise<string>;
  // The parts stored so far, sorted by part number; null when the upload does
  // not exist (never started, completed or aborted).
  listUploadParts(key: string, options: { uploadId: string }): Promise<UploadedPart[] | null>;
  // Assembles the parts into the object. "missing" when the upload id is
  // unknown (already completed or aborted), so the caller can check `head`.
  completeMultipartUpload(
    key: string,
    options: { uploadId: string; parts: { partNumber: number; etag: string }[] },
  ): Promise<"completed" | "missing">;
  // Drops the upload and its parts. No error when it is already gone.
  abortMultipartUpload(key: string, options: { uploadId: string }): Promise<void>;
  // A URL the browser GETs the object from. With `downloadName` the response
  // is an attachment with that file name (the link downloads, never plays);
  // a name outside DOWNLOAD_NAME is refused.
  signDownload(
    key: string,
    options: { expiresInSeconds: number; downloadName?: string },
  ): Promise<string>;
  // null when the object does not exist. The ETag is unquoted (the MD5 hex of
  // the bytes for a single PUT); null only when the store gives none.
  head(
    key: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ bytes: number; etag: string | null } | null>;
  get(key: string): Promise<Uint8Array | null>;
  // Streams the object to `<path>.part`, renamed to `path` once complete, so a
  // half-written download never has the final name. false when it does not exist.
  getFile(key: string, path: string, options?: { signal?: AbortSignal }): Promise<boolean>;
  put(key: string, body: Uint8Array, options?: { contentType?: string }): Promise<void>;
  // Uploads a local file only when no object has the key: an existing object
  // is never replaced.
  putFileIfAbsent(
    key: string,
    path: string,
    options?: { contentType?: string },
  ): Promise<"written" | "exists">;
  // Writes the bytes only when no object has the key: an existing object is
  // never replaced.
  putIfAbsent(
    key: string,
    body: Uint8Array,
    options?: { contentType?: string },
  ): Promise<"written" | "exists">;
  // No error when the object is already gone.
  delete(key: string): Promise<void>;
  // Keys starting with the prefix, sorted.
  list(prefix: string): Promise<string[]>;
}

// One stored part of a multipart upload; the ETag is unquoted.
export interface UploadedPart {
  partNumber: number;
  etag: string;
  bytes: number;
}

// S3's (and R2's) part number range.
export const MAX_PART_NUMBER = 10000;

const UPLOAD_ID = /^[A-Za-z0-9._~-]{1,1024}$/;

// Wide enough for R2's opaque upload ids; no slash, no query character, so an
// id is safe in a path and a query string.
export function isUploadId(value: unknown): value is string {
  return typeof value === "string" && UPLOAD_ID.test(value);
}

export function assertUploadId(value: string): string {
  if (!isUploadId(value)) throw new Error("invalid upload id");
  return value;
}

export function isPartNumber(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_PART_NUMBER;
}

export function assertPartNumber(value: number): number {
  if (!isPartNumber(value)) throw new Error(`invalid part number: ${String(value)}`);
  return value;
}

const KEY = /^[a-z0-9][a-z0-9/._-]{0,511}$/;

// A key is never a path out of the fake's root: lower-case, no leading slash,
// no empty segment and no `..` segment.
export function isStorageKey(key: string): boolean {
  if (!KEY.test(key)) return false;
  if (key.includes("//")) return false;
  return !key.split("/").some((segment) => segment === ".." || segment === ".");
}

export function assertStorageKey(key: string): string {
  if (!isStorageKey(key)) throw new Error(`invalid storage key: ${JSON.stringify(key)}`);
  return key;
}

const DOWNLOAD_NAME = /^[A-Za-z0-9._-]{1,128}$/;

// A download file name that cannot break a Content-Disposition header.
export function isDownloadName(name: string): boolean {
  return DOWNLOAD_NAME.test(name);
}

export function assertDownloadName(name: string): string {
  if (!isDownloadName(name)) throw new Error(`invalid download name: ${JSON.stringify(name)}`);
  return name;
}

const SEGMENT = /^[a-z0-9_-]+$/;

type Env = Record<string, string | undefined>;

// R2_KEY_PREFIX, trimmed: empty, or lower-case segments each ending with "/";
// null when malformed.
export function keyPrefix(env: Env = process.env): string | null {
  const prefix = (env.R2_KEY_PREFIX ?? "").trim();
  if (prefix === "") return prefix;
  if (!prefix.endsWith("/")) return null;
  return prefix
    .slice(0, -1)
    .split("/")
    .every((segment) => SEGMENT.test(segment))
    ? prefix
    : null;
}
