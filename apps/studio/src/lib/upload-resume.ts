// The resume record: what survives a reload of an interrupted upload, kept in
// localStorage. Never the file's bytes (a browser cannot read a picked file
// after a reload unless the user picks it again); the user picks the same
// file and the uploader sends only the parts storage does not hold yet.

export const RESUME_KEY = "studio_upload_resume";

export interface ResumeRecord {
  reelId: string;
  key: string;
  uploadId: string;
  name: string;
  size: number;
  lastModified: number;
}

// The part of Web Storage this needs, so tests pass a plain object.
export interface ResumeStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UPLOAD_ID = /^[A-Za-z0-9._~-]{1,1024}$/;

function isRecord(value: unknown): value is ResumeRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.reelId === "string" &&
    UUID.test(record.reelId) &&
    typeof record.key === "string" &&
    record.key.length > 0 &&
    typeof record.uploadId === "string" &&
    UPLOAD_ID.test(record.uploadId) &&
    typeof record.name === "string" &&
    record.name.length > 0 &&
    Number.isInteger(record.size) &&
    (record.size as number) > 0 &&
    Number.isFinite(record.lastModified)
  );
}

// A stored record's text as a record, or null when it is malformed.
export function parseResume(raw: string): ResumeRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const { reelId, key, uploadId, name, size, lastModified } = parsed;
    return { reelId, key, uploadId, name, size, lastModified };
  } catch {
    return null;
  }
}

// The stored record; a malformed one reads as null and is cleared.
export function readResume(store: ResumeStore): ResumeRecord | null {
  let raw: string | null;
  try {
    raw = store.getItem(RESUME_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const record = parseResume(raw);
  if (!record) clearResume(store);
  return record;
}

export function writeResume(store: ResumeStore, record: ResumeRecord): void {
  try {
    store.setItem(RESUME_KEY, JSON.stringify(record));
  } catch {
    // Storage full or blocked: the upload goes on, only without resume.
  }
}

export function clearResume(store: ResumeStore): void {
  try {
    store.removeItem(RESUME_KEY);
  } catch {
    // Nothing to clear.
  }
}

// The picked file is the interrupted one: same name, size and modified time.
export function matchesResume(
  record: ResumeRecord,
  file: { name: string; size: number; lastModified: number },
): boolean {
  return (
    record.name === file.name &&
    record.size === file.size &&
    record.lastModified === file.lastModified
  );
}
