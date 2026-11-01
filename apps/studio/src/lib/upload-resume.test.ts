import { describe, expect, it } from "vitest";
import {
  RESUME_STORAGE_KEY,
  type UploadResume,
  clearResume,
  matchesFile,
  parseResume,
  readResume,
  writeResume,
} from "./upload-resume";

const REEL = "0b9f6c1e-3c1d-4c8e-9a51-2f4d7b6e8a10";
const RECORD: UploadResume = {
  reelId: REEL,
  key: `dev/reels/${REEL}/source/original.mp4`,
  uploadId: "2~abc_DEF-123",
  name: "clip.mp4",
  size: 36_700_160,
  lastModified: 1_761_955_200_000,
};

function memoryStore() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (name: string) => items.get(name) ?? null,
    setItem: (name: string, value: string) => void items.set(name, value),
    removeItem: (name: string) => void items.delete(name),
  };
}

describe("resume record", () => {
  it("round-trips through the store and clears", () => {
    const store = memoryStore();
    expect(readResume(store)).toBeNull();
    writeResume(store, RECORD);
    expect([...store.items.keys()]).toEqual([RESUME_STORAGE_KEY]);
    expect(readResume(store)).toEqual(RECORD);
    clearResume(store);
    expect(readResume(store)).toBeNull();
  });

  it("ignores malformed JSON and fields", () => {
    expect(parseResume(null)).toBeNull();
    expect(parseResume("")).toBeNull();
    expect(parseResume("{")).toBeNull();
    expect(parseResume("null")).toBeNull();
    expect(parseResume("[]")).toBeNull();
    for (const change of [
      { reelId: "not-a-uuid" },
      { key: "../x" },
      { key: "Upper.mp4" },
      { uploadId: "a&b" },
      { uploadId: "" },
      { name: "" },
      { size: -1 },
      { size: 0 },
      { size: 1.5 },
      { lastModified: -1 },
      { lastModified: "1" },
    ]) {
      expect(parseResume(JSON.stringify({ ...RECORD, ...change })), JSON.stringify(change)).toBe(
        null,
      );
    }
  });

  it("matches only the same name, size and last-modified time", () => {
    const file = { name: RECORD.name, size: RECORD.size, lastModified: RECORD.lastModified };
    expect(matchesFile(RECORD, file)).toBe(true);
    expect(matchesFile(RECORD, { ...file, name: "other.mp4" })).toBe(false);
    expect(matchesFile(RECORD, { ...file, size: file.size + 1 })).toBe(false);
    expect(matchesFile(RECORD, { ...file, lastModified: file.lastModified + 1 })).toBe(false);
  });
});
