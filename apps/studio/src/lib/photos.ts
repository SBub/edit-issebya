// The owner's photo library: what the browser may upload, where it lands in
// the bucket, and what the client is given about each photo (never a key).

// A product bound: well above a phone's largest HEIC or JPEG.
export const MAX_PHOTO_BYTES = 25 * 1024 * 1024;

// The accepted types and the extension each is stored under.
export const PHOTO_TYPES: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/webp": "webp",
};

// What the file picker offers: the types, and HEIC/HEIF by extension for the
// browsers that report no type for them.
export const PHOTO_ACCEPT = `${Object.keys(PHOTO_TYPES).join(",")},.heic,.heif`;

// Browsers other than Safari often give a HEIC or HEIF file an empty type.
const TYPE_OF_EXTENSION: Readonly<Record<string, string>> = {
  heic: "image/heic",
  heif: "image/heif",
};

const MAX_NAME_LENGTH = 255;

export const PHOTO_STATUSES = ["uploading", "describing", "ready", "failed"] as const;
export type PhotoStatus = (typeof PHOTO_STATUSES)[number];

// Server only: the keys stay on the server, which signs them.
export const PHOTO_COLUMNS =
  "id, status, file_name, content_type, r2_key, upload_id, bytes, width, height, description, tags, thumbnail_key, large_key, created_at";

export interface PhotoRow {
  id: string;
  status: PhotoStatus;
  file_name: string;
  content_type: string;
  r2_key: string;
  upload_id: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  description: string | null;
  tags: string[] | null;
  thumbnail_key: string | null;
  large_key: string | null;
  created_at: string;
}

// One tile and its dialog, as the client gets it: short-lived signed URLs,
// never a storage key.
export interface LibraryItem {
  id: string;
  fileName: string;
  status: PhotoStatus;
  bytes: number | null;
  width: number | null;
  height: number | null;
  description: string | null;
  tags: string[];
  thumbnailUrl: string | null;
  largeUrl: string | null;
}

export interface PhotoUpload {
  name: string;
  size: number;
  contentType: string;
  ext: string;
}

export type ParsedPhotoUpload =
  { ok: true; value: PhotoUpload } | { ok: false; reason: "name" | "empty" | "too-large" | "type" };

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

// The browser's own description of the picked file; its size is checked
// again from storage once the upload is complete.
export function parsePhotoUpload(input: {
  name?: unknown;
  size?: unknown;
  type?: unknown;
}): ParsedPhotoUpload {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 1 || name.length > MAX_NAME_LENGTH) return { ok: false, reason: "name" };
  const { size } = input;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 1) {
    return { ok: false, reason: "empty" };
  }
  if (size > MAX_PHOTO_BYTES) return { ok: false, reason: "too-large" };
  const given = typeof input.type === "string" ? input.type.trim().toLowerCase() : "";
  const contentType = given === "" ? TYPE_OF_EXTENSION[extensionOf(name)] : given;
  const ext = contentType ? PHOTO_TYPES[contentType] : undefined;
  if (!contentType || !ext) return { ok: false, reason: "type" };
  return { ok: true, value: { name, size, contentType, ext } };
}

// Where the original lands. The photos insert policy accepts only a key
// ending with this photo's own `library/<id>/original.<ext>`.
export function photoKey(prefix: string, photoId: string, ext: string): string {
  return `${prefix}library/${photoId}/original.${ext}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isPhotoId(id: unknown): id is string {
  return typeof id === "string" && UUID.test(id);
}

// `1200 x 900`, or null while the worker has not measured it.
export function formatDimensions(width: number | null, height: number | null): string | null {
  return width && height ? `${width} x ${height}` : null;
}

// A library tile shows only the thumbnail: no badge for a ready photo, and
// every other status (`uploading`, `describing`, `failed`) on the tile, so a
// broken photo never looks like a good one.
export function photoBadge(status: PhotoStatus): string | undefined {
  return status === "ready" ? undefined : status;
}

// The tile's accessible name: the file name, which the tile no longer shows,
// and the status while the photo is not ready.
export function photoTileLabel(item: Pick<LibraryItem, "fileName" | "status">): string {
  const badge = photoBadge(item.status);
  return badge ? `${item.fileName}, ${badge}` : item.fileName;
}

// The muted line under the library's heading: what the library is for, worded
// for an empty library until the first photo (any status) is in it.
export const LIBRARY_INTRO_EMPTY =
  "Add photos of your work, places or products. When you talk about them, they can appear behind you in your reels";
export const LIBRARY_INTRO =
  "Photos you add here can appear in your reels, placed behind you when they fit what you're saying";

export function libraryIntro(photoCount: number): string {
  return photoCount > 0 ? LIBRARY_INTRO : LIBRARY_INTRO_EMPTY;
}
