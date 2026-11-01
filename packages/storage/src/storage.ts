// The storage the studio and the worker share: Cloudflare R2 in production, a
// folder-backed fake under E2E_MOCK_STORAGE=true. Keys are bucket-relative
// paths such as `dev/reels/<id>/source/original.mp4`.
export interface Storage {
  // A URL the browser PUTs the object to, with the given Content-Type.
  signUpload(
    key: string,
    options: { contentType: string; expiresInSeconds: number },
  ): Promise<string>;
  signDownload(key: string, options: { expiresInSeconds: number }): Promise<string>;
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
