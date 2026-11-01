// The storage the studio and the worker share: Cloudflare R2 in production, a
// folder-backed fake under E2E_MOCK_STORAGE=true. Keys are bucket-relative
// paths such as `dev/reels/<id>/source/original.mp4`.
export interface Storage {
  // A URL the browser POSTs to start a multipart upload, and the headers it must send.
  signCreateMultipart(
    key: string,
    options: { contentType: string; expiresInSeconds: number },
  ): Promise<{ url: string; headers: Record<string, string> }>;
  // A URL the browser PUTs one part to.
  signUploadPart(
    key: string,
    options: { uploadId: string; partNumber: number; expiresInSeconds: number },
  ): Promise<string>;
  // A URL the browser GETs the parts storage already holds from.
  signListParts(
    key: string,
    options: { uploadId: string; expiresInSeconds: number },
  ): Promise<string>;
  // A URL the browser POSTs the parts list to, assembling the object.
  signCompleteMultipart(
    key: string,
    options: { uploadId: string; expiresInSeconds: number },
  ): Promise<string>;
  // Sent by the server; no error when the upload is already gone.
  abortMultipart(key: string, uploadId: string): Promise<void>;
  signDownload(key: string, options: { expiresInSeconds: number }): Promise<string>;
  // null when the object does not exist.
  head(key: string, options?: { signal?: AbortSignal }): Promise<{ bytes: number } | null>;
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, body: Uint8Array, options?: { contentType?: string }): Promise<void>;
  // No error when the object is already gone.
  delete(key: string): Promise<void>;
  // Keys starting with the prefix, sorted.
  list(prefix: string): Promise<string[]>;
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

// S3's (and R2's) highest part number.
export const PART_NUMBER_MAX = 10000;

const UPLOAD_ID = /^[A-Za-z0-9._~+/=-]{1,1024}$/;

// An upload id as S3 and R2 hand it out; never anything that could change a query string.
export function isUploadId(value: unknown): value is string {
  return typeof value === "string" && UPLOAD_ID.test(value);
}

export function assertUploadId(value: string): string {
  if (!isUploadId(value)) throw new Error("invalid upload id");
  return value;
}

export function isPartNumber(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= PART_NUMBER_MAX;
}
