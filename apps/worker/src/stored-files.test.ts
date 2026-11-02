import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeStorage, type Storage, fakeStorage } from "@edit-issebya/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  STORAGE_METHODS,
  type StoredFileRecords,
  type StoredFileRow,
  classifyKey,
  recordingStorage,
} from "./stored-files.ts";

const PREFIX = "dev/";
const REEL = "5f1c9e2a-0d3b-4a7e-8c6f-2b9d4e1a7c30";
const OTHER = "0b6f2a52-7d0e-4c55-9d4a-3c1f0e8a1b01";
const FP = "a".repeat(64);

let root: string;
let raw: FakeStorage;
let rows: StoredFileRow[];
let wrapped: Storage;

function memoryRecords(): StoredFileRecords {
  return {
    async record(row) {
      rows.push(row);
    },
    async slimRebuildable() {
      return [];
    },
    async expireExports() {
      return [];
    },
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "stored-files-"));
  raw = fakeStorage({ root: join(root, "store"), uploadUrlBase: "" });
  rows = [];
  wrapped = recordingStorage(raw, { records: memoryRecords(), reelId: REEL, keyPrefix: PREFIX });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("classifyKey", () => {
  it("tells every stored layout apart", () => {
    expect(classifyKey(PREFIX, `${PREFIX}cache/convert/${FP}/converted.mp4`)).toEqual({
      kind: "rebuildable",
      step: "convert",
    });
    expect(classifyKey(PREFIX, `${PREFIX}cache/retime/${FP}/source.mp4`)).toEqual({
      kind: "rebuildable",
      step: "retime",
    });
    expect(classifyKey(PREFIX, `${PREFIX}cache/retime/${FP}/transcript.json`)).toEqual({
      kind: "kept",
      step: "retime",
    });
    expect(classifyKey(PREFIX, `${PREFIX}cache/remove_background/${FP}/subject.webm`)).toEqual({
      kind: "rebuildable",
      step: "remove_background",
    });
    expect(classifyKey(PREFIX, `${PREFIX}cache/head_track/${FP}/head-track.json`)).toEqual({
      kind: "kept",
      step: "head_track",
    });
    expect(classifyKey(PREFIX, `${PREFIX}reels/${REEL}/versions/${OTHER}.json`)).toEqual({
      kind: "version",
      step: "version",
    });
    expect(classifyKey(PREFIX, `${PREFIX}exports/${REEL}/${OTHER}.mp4`)).toEqual({
      kind: "export",
      step: "render",
    });
    expect(classifyKey(PREFIX, `${PREFIX}reels/${REEL}/source/original.mov`)).toEqual({
      kind: "source",
      step: "upload",
    });
    expect(classifyKey("", `cache/transcribe/${FP}/transcript.json`)).toEqual({
      kind: "kept",
      step: "transcribe",
    });
  });

  it("throws on any other key", () => {
    for (const key of [
      `${PREFIX}cache/convert/${FP}/other.mp4`,
      `${PREFIX}cache/unknown/${FP}/converted.mp4`,
      `prod/cache/convert/${FP}/converted.mp4`,
      `${PREFIX}reels/${REEL}/notes.txt`,
      `${PREFIX}exports/${REEL}/x.mp4`,
    ]) {
      expect(() => classifyKey(PREFIX, key)).toThrow(/unknown key layout/);
    }
  });
});

describe("recordingStorage", () => {
  const keys = {
    put: `${PREFIX}reels/${REEL}/versions/${OTHER}.json`,
    putIfAbsent: `${PREFIX}cache/transcribe/${FP}/transcript.json`,
    putFileIfAbsent: `${PREFIX}cache/convert/${FP}/converted.mp4`,
    completeMultipartUpload: `${PREFIX}reels/${REEL}/source/original.mp4`,
  };

  // Every method STORAGE_METHODS marks `write`, called through the wrapper.
  const writes: Record<string, () => Promise<unknown>> = {
    put: () => wrapped.put(keys.put, new Uint8Array(3)),
    putIfAbsent: () => wrapped.putIfAbsent(keys.putIfAbsent, new Uint8Array(5)),
    async putFileIfAbsent() {
      const path = join(root, "file.mp4");
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      await writeFile(path, new Uint8Array(7));
      return wrapped.putFileIfAbsent(keys.putFileIfAbsent, path);
    },
    async completeMultipartUpload() {
      const key = keys.completeMultipartUpload;
      const { uploadId } = await raw.createMultipartUpload(key, { contentType: "video/mp4" });
      const etag = await raw.putUploadPart(key, {
        uploadId,
        partNumber: 1,
        body: new Uint8Array(11),
      });
      return wrapped.completeMultipartUpload(key, { uploadId, parts: [{ partNumber: 1, etag }] });
    },
  };
  const expected: Record<string, StoredFileRow> = {
    put: { reelId: REEL, key: keys.put, kind: "version", step: "version", bytes: 3 },
    putIfAbsent: {
      reelId: REEL,
      key: keys.putIfAbsent,
      kind: "kept",
      step: "transcribe",
      bytes: 5,
    },
    putFileIfAbsent: {
      reelId: REEL,
      key: keys.putFileIfAbsent,
      kind: "rebuildable",
      step: "convert",
      bytes: 7,
    },
    completeMultipartUpload: {
      reelId: REEL,
      key: keys.completeMultipartUpload,
      kind: "source",
      step: "upload",
      bytes: 11,
    },
  };

  it("classifies exactly the four known write methods as writes", () => {
    const writeMethods = Object.entries(STORAGE_METHODS)
      .filter(([, kind]) => kind === "write")
      .map(([name]) => name)
      .sort();
    expect(writeMethods).toEqual(Object.keys(writes).sort());
    expect(STORAGE_METHODS.delete).toBe("refused");
  });

  it("records every write once, with its key, kind, step and size", async () => {
    for (const name of Object.keys(writes)) {
      rows = [];
      await writes[name]!();
      expect(rows, name).toEqual([expected[name]]);
    }
  });

  it("records a put-if-absent that found the object, with the stored size", async () => {
    await raw.putIfAbsent(keys.putIfAbsent, new Uint8Array(9));
    await raw.putIfAbsent(keys.putFileIfAbsent, new Uint8Array(13));
    expect(await wrapped.putIfAbsent(keys.putIfAbsent, new Uint8Array(5))).toBe("exists");
    const path = join(root, "other.mp4");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    await writeFile(path, new Uint8Array(7));
    expect(await wrapped.putFileIfAbsent(keys.putFileIfAbsent, path)).toBe("exists");
    expect(rows).toEqual([
      { ...expected.putIfAbsent, bytes: 9 },
      { ...expected.putFileIfAbsent, bytes: 13 },
    ]);
  });

  it("records nothing for a multipart upload that is missing", async () => {
    const result = await wrapped.completeMultipartUpload(keys.completeMultipartUpload, {
      uploadId: "gone",
      parts: [{ partNumber: 1, etag: "x" }],
    });
    expect(result).toBe("missing");
    expect(rows).toEqual([]);
  });

  it("refuses a key of unknown layout before writing anything", async () => {
    const key = `${PREFIX}reels/${REEL}/notes.txt`;
    await expect(wrapped.put(key, new Uint8Array(1))).rejects.toThrow(/unknown key layout/);
    await expect(wrapped.putIfAbsent(key, new Uint8Array(1))).rejects.toThrow(/unknown key layout/);
    expect(await raw.head(key)).toBeNull();
    expect(rows).toEqual([]);
  });

  it("refuses delete and leaves the object", async () => {
    await raw.put(keys.put, new Uint8Array(3));
    await expect(wrapped.delete(keys.put)).rejects.toThrow(/jobs never delete stored objects/);
    expect(await raw.head(keys.put)).not.toBeNull();
  });

  it("passes reads through and records nothing for them", async () => {
    await raw.put(keys.put, new Uint8Array([1, 2]));
    expect(await wrapped.get(keys.put)).toEqual(new Uint8Array([1, 2]));
    expect((await wrapped.head(keys.put))?.bytes).toBe(2);
    expect(await wrapped.list(PREFIX)).toEqual([keys.put]);
    expect(rows).toEqual([]);
  });

  it("fails the write when recording fails", async () => {
    const failing = recordingStorage(raw, {
      records: {
        ...memoryRecords(),
        async record() {
          throw new Error("database down");
        },
      },
      reelId: REEL,
      keyPrefix: PREFIX,
    });
    await expect(failing.put(keys.put, new Uint8Array(1))).rejects.toThrow(/database down/);
  });
});
