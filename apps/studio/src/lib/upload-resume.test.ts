import { describe, expect, it } from "vitest";
import {
  RESUME_KEY,
  type ResumeRecord,
  clearResume,
  clearResumeFor,
  matchesResume,
  readResume,
  resumeIsGone,
  writeResume,
} from "./upload-resume";

function memory(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

const REEL = "0b9f6c1e-3c1d-4c8e-9a51-2f4d7b6e8a10";
const RECORD: ResumeRecord = {
  reelId: REEL,
  key: `dev/reels/${REEL}/source/original.mp4`,
  uploadId: "c0ffee-1",
  name: "clip.mp4",
  size: 36700160,
  lastModified: 1767225600000,
};

describe("the resume record", () => {
  it("round-trips, and clears", () => {
    const store = memory();
    expect(readResume(store)).toBeNull();
    writeResume(store, RECORD);
    expect(readResume(store)).toEqual(RECORD);
    clearResume(store);
    expect(readResume(store)).toBeNull();
  });

  it("reads a malformed record as null and clears it", () => {
    for (const raw of [
      "not json",
      "null",
      JSON.stringify({ ...RECORD, reelId: "x" }),
      JSON.stringify({ ...RECORD, uploadId: "a/b" }),
      JSON.stringify({ ...RECORD, size: 0 }),
      JSON.stringify({ ...RECORD, name: "" }),
    ]) {
      const store = memory({ [RESUME_KEY]: raw });
      expect(readResume(store)).toBeNull();
      expect(store.items.has(RESUME_KEY)).toBe(false);
    }
  });

  it("drops unknown fields", () => {
    const store = memory({ [RESUME_KEY]: JSON.stringify({ ...RECORD, extra: 1 }) });
    expect(readResume(store)).toEqual(RECORD);
  });

  it("survives a store that throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readResume(throwing)).toBeNull();
    expect(() => writeResume(throwing, RECORD)).not.toThrow();
    expect(() => clearResume(throwing)).not.toThrow();
  });

  it("matches the same file only", () => {
    const file = { name: "clip.mp4", size: 36700160, lastModified: 1767225600000 };
    expect(matchesResume(RECORD, file)).toBe(true);
    expect(matchesResume(RECORD, { ...file, name: "other.mp4" })).toBe(false);
    expect(matchesResume(RECORD, { ...file, size: 1 })).toBe(false);
    expect(matchesResume(RECORD, { ...file, lastModified: 1 })).toBe(false);
  });
});

describe("clearing the record for a deleted reel", () => {
  it("clears the record that names the reel", () => {
    const store = memory({ [RESUME_KEY]: JSON.stringify(RECORD) });
    clearResumeFor(store, REEL);
    expect(store.items.has(RESUME_KEY)).toBe(false);
  });

  it("keeps the record of another reel", () => {
    const store = memory({ [RESUME_KEY]: JSON.stringify(RECORD) });
    clearResumeFor(store, "11111111-2222-4333-8444-555555555555");
    expect(readResume(store)).toEqual(RECORD);
  });

  it("does nothing without a record, and survives a store that throws", () => {
    expect(() => clearResumeFor(memory(), REEL)).not.toThrow();
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => clearResumeFor(throwing, REEL)).not.toThrow();
  });
});

describe("a resume answered as a gone reel", () => {
  it("is the 404 not-found answer of the upload routes", () => {
    expect(resumeIsGone({ status: 404, error: "not-found" })).toBe(true);
  });

  it("is not any other failure", () => {
    expect(resumeIsGone(null)).toBe(false);
    expect(resumeIsGone({ status: 404, error: null })).toBe(false);
    expect(resumeIsGone({ status: 500, error: "not-found" })).toBe(false);
    expect(resumeIsGone({ status: 401, error: "signed-out" })).toBe(false);
  });
});
