import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Storage, fakeStorage } from "@edit-issebya/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryStoredFiles } from "./memory-stored-files.ts";
import { TEST_JOB } from "./recording-steps.ts";
import { recordedStorage } from "./stored-files.ts";

const PREFIX = `dev/reels/${TEST_JOB.reel_id}/`;
const bytes = (n: number) => new Uint8Array(n).fill(7);

let root: string;
let storage: Storage;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "stored-files-"));
  storage = fakeStorage({ root, uploadUrlBase: "" });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("recordedStorage", () => {
  it("records every put with its size, kind, step, reel and owner", async () => {
    const { store, rows } = memoryStoredFiles();
    const files = recordedStorage(storage, store, TEST_JOB);
    await files.put(`${PREFIX}cache/converted.mp4`, bytes(30), {
      kind: "rebuildable",
      step: "convert",
    });
    await files.put(`${PREFIX}preview/preview.mp4`, bytes(20), { kind: "kept", step: "preview" });
    await files.put(`${PREFIX}versions/v1.json`, bytes(10), { kind: "version", step: "decide" });

    // Every object in the folder has exactly one live row.
    expect(await storage.list(PREFIX)).toEqual(rows.map((r) => r.r2_key).sort());
    expect(
      rows.map(({ r2_key, bytes, kind, step, reel_id, owner_id, deleted_at }) => ({
        r2_key,
        bytes,
        kind,
        step,
        reel_id,
        owner_id,
        deleted_at,
      })),
    ).toEqual([
      {
        r2_key: `${PREFIX}cache/converted.mp4`,
        bytes: 30,
        kind: "rebuildable",
        step: "convert",
        reel_id: TEST_JOB.reel_id,
        owner_id: TEST_JOB.owner_id,
        deleted_at: null,
      },
      {
        r2_key: `${PREFIX}preview/preview.mp4`,
        bytes: 20,
        kind: "kept",
        step: "preview",
        reel_id: TEST_JOB.reel_id,
        owner_id: TEST_JOB.owner_id,
        deleted_at: null,
      },
      {
        r2_key: `${PREFIX}versions/v1.json`,
        bytes: 10,
        kind: "version",
        step: "decide",
        reel_id: TEST_JOB.reel_id,
        owner_id: TEST_JOB.owner_id,
        deleted_at: null,
      },
    ]);
  });

  it("keeps one live row per key when the same key is written again", async () => {
    const { store, rows } = memoryStoredFiles();
    const files = recordedStorage(storage, store, TEST_JOB);
    const key = `${PREFIX}cache/converted.mp4`;
    await files.put(key, bytes(30), { kind: "rebuildable", step: "convert" });
    await files.put(key, bytes(45), { kind: "rebuildable", step: "convert" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ r2_key: key, bytes: 45, deleted_at: null });
  });

  it("records nothing when the write fails", async () => {
    const { store, rows } = memoryStoredFiles();
    const failing = {
      ...storage,
      put: async () => {
        throw new Error("r2 down");
      },
    } as Storage;
    const files = recordedStorage(failing, store, TEST_JOB);
    await expect(
      files.put(`${PREFIX}cache/x.mp4`, bytes(1), { kind: "rebuildable", step: "convert" }),
    ).rejects.toThrow("r2 down");
    expect(rows).toEqual([]);
  });

  it("refuses source files, which only finish_upload records", async () => {
    const { store, rows } = memoryStoredFiles();
    const files = recordedStorage(storage, store, TEST_JOB);
    await expect(
      // @ts-expect-error source is not a kind the worker may write
      files.put(`${PREFIX}source/original.mp4`, bytes(1), { kind: "source", step: "upload" }),
    ).rejects.toThrow("finish_upload");
    expect(rows).toEqual([]);
    expect(await storage.list(PREFIX)).toEqual([]);
  });
});

describe("worker write paths", () => {
  it("write to storage only through recordedStorage", async () => {
    const dir = new URL(".", import.meta.url).pathname;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own source folder
    const sources = (await readdir(dir, { recursive: true })).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
    );
    expect(sources.length).toBeGreaterThan(10);
    const writers: string[] = [];
    for (const file of sources) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own source files
      const text = await readFile(join(dir, file), "utf8");
      if (/\.put\(|signUpload\(/.test(text)) writers.push(file);
    }
    expect(writers).toEqual(["stored-files.ts"]);
  });
});
