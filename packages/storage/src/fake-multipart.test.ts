import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeMultipart } from "./fake-multipart.ts";

const KEY = "dev/reels/r1/source/original.mp4";
let root: string;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fake-multipart-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("fakeMultipart", () => {
  it("assembles four parts into the exact bytes and forgets the upload", async () => {
    const multipart = fakeMultipart({ root });
    const uploadId = await multipart.create(KEY);
    expect(uploadId).toMatch(/^[a-f0-9]{32}$/);
    const chunks = [randomBytes(1000), randomBytes(1000), randomBytes(1000), randomBytes(17)];
    const parts: { partNumber: number; etag: string }[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const etag = await multipart.putPart(KEY, uploadId, index + 1, chunk);
      expect(etag).toMatch(/^"[a-f0-9]{32}"$/);
      parts.push({ partNumber: index + 1, etag });
    }
    // A client may send the ETags back without their quotes.
    const bare = parts.map((part, index) =>
      index === 1 ? { ...part, etag: part.etag.replaceAll('"', "") } : part,
    );
    await multipart.complete(KEY, uploadId, bare);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp dir
    const assembled = new Uint8Array(await readFile(join(root, KEY)));
    expect(sha256(assembled)).toBe(sha256(Buffer.concat(chunks)));
    await expect(multipart.complete(KEY, uploadId, parts)).rejects.toThrow(/no such upload/);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp dir
    expect(await readdir(join(root, ".multipart"))).toEqual([]);
  });

  it("lists the parts it holds, by part number", async () => {
    const multipart = fakeMultipart({ root });
    const uploadId = await multipart.create(KEY);
    await multipart.putPart(KEY, uploadId, 2, new Uint8Array([1, 2]));
    const first = await multipart.putPart(KEY, uploadId, 1, new Uint8Array([3]));
    const parts = await multipart.listParts(KEY, uploadId);
    expect(parts.map(({ partNumber, size }) => ({ partNumber, size }))).toEqual([
      { partNumber: 1, size: 1 },
      { partNumber: 2, size: 2 },
    ]);
    expect(parts[0]?.etag).toBe(first);
  });

  it("binds an upload id to its key and refuses bad or unknown ids", async () => {
    const multipart = fakeMultipart({ root });
    const uploadId = await multipart.create(KEY);
    const bytes = new Uint8Array([1]);
    await expect(
      multipart.putPart("dev/reels/r2/source/original.mp4", uploadId, 1, bytes),
    ).rejects.toThrow(/no such upload/);
    for (const id of ["../x", uploadId.toUpperCase(), uploadId.slice(1), "b".repeat(32)]) {
      await expect(multipart.putPart(KEY, id, 1, bytes)).rejects.toThrow(/no such upload/);
      await expect(multipart.listParts(KEY, id)).rejects.toThrow(/no such upload/);
    }
    await expect(multipart.putPart(KEY, uploadId, 0, bytes)).rejects.toThrow(/part number/);
    await expect(multipart.putPart(KEY, uploadId, 10001, bytes)).rejects.toThrow(/part number/);
    await expect(multipart.create("../x")).rejects.toThrow(/invalid storage key/);
  });

  it("refuses a wrong ETag, a missing part and parts out of order", async () => {
    const multipart = fakeMultipart({ root });
    const uploadId = await multipart.create(KEY);
    const one = await multipart.putPart(KEY, uploadId, 1, new Uint8Array([1]));
    const two = await multipart.putPart(KEY, uploadId, 2, new Uint8Array([2]));
    await expect(
      multipart.complete(KEY, uploadId, [{ partNumber: 1, etag: '"0"' }]),
    ).rejects.toThrow(/does not match/);
    await expect(multipart.complete(KEY, uploadId, [{ partNumber: 3, etag: one }])).rejects.toThrow(
      /does not match/,
    );
    await expect(
      multipart.complete(KEY, uploadId, [
        { partNumber: 2, etag: two },
        { partNumber: 1, etag: one },
      ]),
    ).rejects.toThrow(/ascending/);
    expect(await multipart.listParts(KEY, uploadId)).toHaveLength(2);
  });

  it("aborts repeatably and leaves another key's upload alone", async () => {
    const multipart = fakeMultipart({ root });
    const uploadId = await multipart.create(KEY);
    await multipart.putPart(KEY, uploadId, 1, new Uint8Array([1]));
    await multipart.abort("dev/reels/r2/source/original.mp4", uploadId);
    expect(await multipart.listParts(KEY, uploadId)).toHaveLength(1);
    await multipart.abort(KEY, uploadId);
    await multipart.abort(KEY, uploadId);
    await multipart.abort(KEY, "../x");
    await expect(multipart.listParts(KEY, uploadId)).rejects.toThrow(/no such upload/);
  });
});
