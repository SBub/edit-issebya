import { isStorageKey, isUploadId } from "@edit-issebya/storage";
import { isReelId } from "./reels";

/**
 * What survives a reload of an unfinished upload: the reel, its key, the
 * multipart upload id and enough of the file (name, size, last-modified) to
 * recognise it when the owner picks it again. One localStorage entry of
 * functional state only: removed on finish, cancel or discard, never sent
 * anywhere. A browser never lets a page re-read the file itself.
 */
export interface UploadResume {
  reelId: string;
  key: string;
  uploadId: string;
  name: string;
  size: number;
  lastModified: number;
}

export const RESUME_STORAGE_KEY = "studio-upload-resume";

type KeyValueStore = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// The record when the text is a well-formed one, else null.
export function parseResume(text: string | null): UploadResume | null {
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { reelId, key, uploadId, name, size, lastModified } = value as Record<string, unknown>;
  if (typeof reelId !== "string" || !isReelId(reelId)) return null;
  if (typeof key !== "string" || !isStorageKey(key)) return null;
  if (!isUploadId(uploadId)) return null;
  if (typeof name !== "string" || name.length < 1) return null;
  if (!isCount(size) || size < 1 || !isCount(lastModified)) return null;
  return { reelId, key, uploadId, name, size, lastModified };
}

export function readResume(store: KeyValueStore): UploadResume | null {
  return parseResume(store.getItem(RESUME_STORAGE_KEY));
}

export function writeResume(store: KeyValueStore, record: UploadResume): void {
  store.setItem(RESUME_STORAGE_KEY, JSON.stringify(record));
}

export function clearResume(store: KeyValueStore): void {
  store.removeItem(RESUME_STORAGE_KEY);
}

// Whether the picked file is the one the record was written for.
export function matchesFile(
  record: UploadResume,
  file: { name: string; size: number; lastModified: number },
): boolean {
  return (
    record.name === file.name &&
    record.size === file.size &&
    record.lastModified === file.lastModified
  );
}
