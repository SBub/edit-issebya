import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PART_NUMBER_MAX, assertStorageKey, isPartNumber } from "./storage.ts";

// The fake's upload ids: 32 lower-case hex characters, so an id is never a path.
const FAKE_UPLOAD_ID = /^[a-f0-9]{32}$/;
const PART_FILE = /^part-(\d{5})$/;

export interface FakePart {
  partNumber: number;
  etag: string;
  size: number;
}

// The errors S3 answers with, by name, so the mock route can map them.
export class MultipartError extends Error {
  constructor(name: "NoSuchUpload" | "InvalidPart", message: string) {
    super(message);
    this.name = name;
  }
}

function noSuchUpload(): MultipartError {
  return new MultipartError("NoSuchUpload", "no such upload for this key");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

// S3 quotes ETags; a client may send them back with or without the quotes.
function bareEtag(etag: string): string {
  return etag.replace(/^"/, "").replace(/"$/, "");
}

function etagOf(bytes: Uint8Array): string {
  return `"${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}"`;
}

function partFile(partNumber: number): string {
  return `part-${String(partNumber).padStart(5, "0")}`;
}

/**
 * The folder fake's multipart uploads, kept on disk so the studio's mock route
 * (one request per part) and the tests share them: `<root>/.multipart/<uploadId>/`
 * holds `upload.json` (the key the id is bound to) and one `part-NNNNN` file per
 * part. A leading dot is never a valid storage key, so this folder never collides
 * with an object. Like R2, an upload id works only with the key it was created
 * for, and a completed or aborted id is gone.
 */
export function fakeMultipart({ root }: { root: string }) {
  const folder = (uploadId: string) => {
    if (!FAKE_UPLOAD_ID.test(uploadId)) throw noSuchUpload();
    return join(root, ".multipart", uploadId);
  };

  // The upload's folder once its id and key binding are checked.
  async function openUpload(key: string, uploadId: string): Promise<string> {
    assertStorageKey(key);
    const dir = folder(uploadId);
    let record: unknown;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- id checked against a hex pattern
      record = JSON.parse(await readFile(join(dir, "upload.json"), "utf8"));
    } catch (error) {
      if (isMissing(error)) throw noSuchUpload();
      throw error;
    }
    if ((record as { key?: unknown } | null)?.key !== key) throw noSuchUpload();
    return dir;
  }

  async function listParts(key: string, uploadId: string): Promise<FakePart[]> {
    const dir = await openUpload(key, uploadId);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- id checked against a hex pattern
    const names = await readdir(dir);
    const parts: FakePart[] = [];
    for (const name of names) {
      const match = PART_FILE.exec(name);
      if (!match) continue;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- id checked, name matched PART_FILE
      const bytes = new Uint8Array(await readFile(join(dir, name)));
      parts.push({ partNumber: Number(match[1]), etag: etagOf(bytes), size: bytes.byteLength });
    }
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  return {
    async create(key: string): Promise<string> {
      assertStorageKey(key);
      const uploadId = randomBytes(16).toString("hex");
      const dir = folder(uploadId);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- id is fresh hex
      await mkdir(dir, { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- id is fresh hex
      await writeFile(join(dir, "upload.json"), JSON.stringify({ key }));
      return uploadId;
    },

    // Writes (or replaces) one part and answers its quoted ETag.
    async putPart(
      key: string,
      uploadId: string,
      partNumber: number,
      bytes: Uint8Array,
    ): Promise<string> {
      if (!isPartNumber(partNumber)) {
        throw new MultipartError("InvalidPart", `part number must be 1 to ${PART_NUMBER_MAX}`);
      }
      const dir = await openUpload(key, uploadId);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- id checked, fixed part name
      await writeFile(join(dir, partFile(partNumber)), bytes);
      return etagOf(bytes);
    },

    listParts,

    // Assembles the listed parts, in order, into `<root>/<key>` and forgets the
    // upload. Every part must exist with the given ETag, in ascending order.
    async complete(
      key: string,
      uploadId: string,
      parts: { partNumber: number; etag: string }[],
    ): Promise<string> {
      const dir = await openUpload(key, uploadId);
      if (parts.length === 0) throw new MultipartError("InvalidPart", "no parts");
      const held = new Map((await listParts(key, uploadId)).map((part) => [part.partNumber, part]));
      let previous = 0;
      for (const part of parts) {
        if (part.partNumber <= previous) {
          throw new MultipartError("InvalidPart", "parts are not in ascending order");
        }
        previous = part.partNumber;
        const stored = held.get(part.partNumber);
        if (!stored || bareEtag(stored.etag) !== bareEtag(part.etag)) {
          throw new MultipartError("InvalidPart", `part ${part.partNumber} does not match`);
        }
      }

      const target = join(root, key);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- key checked by assertStorageKey
      await mkdir(dirname(target), { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- key checked by assertStorageKey
      await writeFile(target, new Uint8Array());
      const whole = createHash("sha256");
      for (const part of parts) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- id checked, fixed part name
        const bytes = await readFile(join(dir, partFile(part.partNumber)));
        whole.update(bytes);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- key checked by assertStorageKey
        await appendFile(target, bytes);
      }
      await rm(dir, { recursive: true, force: true });
      return `"${whole.digest("hex").slice(0, 32)}-${parts.length}"`;
    },

    // No error when the upload is already gone. As on R2, an id bound to
    // another key is "no such upload" and is left alone.
    async abort(key: string, uploadId: string): Promise<void> {
      let dir: string;
      try {
        dir = await openUpload(key, uploadId);
      } catch (error) {
        if (error instanceof MultipartError) return;
        throw error;
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}
