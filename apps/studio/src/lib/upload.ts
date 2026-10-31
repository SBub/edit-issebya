// R2's single-PUT limit; a resumable upload for larger files is a later slice.
export const MAX_UPLOAD_BYTES = 5 * 1024 ** 3;

const EXTENSIONS = new Set(["mp4", "mov", "m4v", "webm"]);
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
