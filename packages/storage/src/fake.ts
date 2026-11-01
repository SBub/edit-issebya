import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  copyFile,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  type Storage,
  type UploadedPart,
  assertDownloadName,
  assertPartNumber,
  assertStorageKey,
  assertUploadId,
} from "./storage.ts";

type Env = Record<string, string | undefined>;

// The storage double is on only when the flag is exactly "true".
export function isE2EMockStorage(env: Env = process.env): boolean {
  return env.E2E_MOCK_STORAGE === "true";
}

// The fake's folder: `.e2e-storage` at the repository (or worktree) root, the
// first directory up from cwd holding turbo.json. The studio (run from
// apps/studio) and the worker (run from apps/worker) both land there.
export function e2eStorageRoot(cwd: string = process.cwd()): string {
  let dir = cwd;
  for (;;) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- walks up from cwd looking for one fixed file name
    if (existsSync(join(dir, "turbo.json"))) return join(dir, ".e2e-storage");
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no turbo.json above ${cwd}: cannot place .e2e-storage`);
    dir = parent;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

// A sibling name no key can have (keys are lower-case; a UUID is too, so the
// `.tmp-` infix and the trailing `.tmp` mark it).
function tempPath(path: string): string {
  return `${path}.tmp-${randomUUID()}.tmp`;
}

const TEMP = /\.tmp-[0-9a-f-]{36}\.tmp$/;

// What R2 returns as the ETag of a single PUT: the MD5 hex of the bytes.
function md5Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("md5");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path inside the fake's root
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

// link fails with EEXIST when the target is taken: the existing file stays.
async function linkOnce(temp: string, target: string): Promise<"written" | "exists"> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path inside the fake's root
    await link(temp, target);
    return "written";
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "EEXIST") return "exists";
    throw error;
  }
}

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the fake's own root
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

// Where the fake keeps unfinished multipart uploads. A key starts with
// [a-z0-9], so no object can be stored under it.
const MULTIPART = ".multipart";

function md5Hex(body: Uint8Array): string {
  return createHash("md5").update(body).digest("hex");
}

export interface FakeStorage extends Storage {
  // What the mock route does with a part PUT (R2's UploadPart): stores the
  // part and returns its ETag, the MD5 hex of the bytes, as R2 does.
  putUploadPart(
    key: string,
    options: { uploadId: string; partNumber: number; body: Uint8Array },
  ): Promise<string>;
}

// A Storage backed by a folder, for specs: every key maps to `<root>/<key>`,
// and a key that could leave the root is refused. Signed URLs are same-origin
// paths to the studio's mock route (`uploadUrlBase` + key). A multipart
// upload lives in `<root>/.multipart/<uploadId>/` (`meta.json` with its key,
// one `<n>.part` per part) until it is completed or aborted.
export function fakeStorage({
  root,
  uploadUrlBase,
}: {
  root: string;
  uploadUrlBase: string;
}): FakeStorage {
  const pathOf = (key: string) => join(root, assertStorageKey(key));
  const uploadDir = (uploadId: string) => join(root, MULTIPART, assertUploadId(uploadId));
  const partPath = (uploadId: string, partNumber: number) =>
    join(uploadDir(uploadId), `${assertPartNumber(partNumber)}.part`);

  // The upload's folder when it exists and belongs to this key, else null.
  async function ownUpload(key: string, uploadId: string): Promise<string | null> {
    assertStorageKey(key);
    const dir = uploadDir(uploadId);
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- upload id checked by assertUploadId
      const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as { key?: unknown };
      return meta.key === key ? dir : null;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async function storedParts(dir: string): Promise<UploadedPart[]> {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the fake's own root
    const names = await readdir(dir);
    const parts: UploadedPart[] = [];
    for (const name of names) {
      const match = /^(\d+)\.part$/.exec(name);
      if (!match) continue;
      const path = join(dir, name);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the fake's own root
      const info = await stat(path);
      parts.push({ partNumber: Number(match[1]), etag: await md5Of(path), bytes: info.size });
    }
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  return {
    async createMultipartUpload(key) {
      const uploadId = randomUUID();
      const dir = uploadDir(uploadId);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fresh uuid inside the fake's root
      await mkdir(dir, { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fresh uuid inside the fake's root
      await writeFile(join(dir, "meta.json"), JSON.stringify({ key: assertStorageKey(key) }));
      return { uploadId };
    },

    async signUploadPart(key, { uploadId, partNumber }) {
      const query = new URLSearchParams({
        uploadId: assertUploadId(uploadId),
        partNumber: String(assertPartNumber(partNumber)),
      });
      return `${uploadUrlBase}${assertStorageKey(key)}?${query}`;
    },

    async putUploadPart(key, { uploadId, partNumber, body }) {
      const target = partPath(uploadId, partNumber);
      const dir = await ownUpload(key, uploadId);
      if (!dir) throw new Error("no such upload");
      const temp = tempPath(target);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- upload id and part number checked
      await writeFile(temp, body);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- upload id and part number checked
      await rename(temp, target);
      return md5Hex(body);
    },

    async listUploadParts(key, { uploadId }) {
      const dir = await ownUpload(key, uploadId);
      return dir ? storedParts(dir) : null;
    },

    async completeMultipartUpload(key, { uploadId, parts }) {
      const dir = await ownUpload(key, uploadId);
      if (!dir) return "missing";
      const stored = new Map((await storedParts(dir)).map((part) => [part.partNumber, part]));
      const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      if (sorted.length === 0) throw new Error("no parts to complete");
      for (const [index, part] of sorted.entries()) {
        assertPartNumber(part.partNumber);
        if (index > 0 && sorted[index - 1]!.partNumber === part.partNumber) {
          throw new Error(`part ${part.partNumber} listed twice`);
        }
        const etag = part.etag.replace(/^"(.*)"$/, "$1");
        if (stored.get(part.partNumber)?.etag !== etag) {
          throw new Error(`part ${part.partNumber} does not match its ETag`);
        }
      }
      const target = pathOf(key);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- key checked by assertStorageKey
      await mkdir(dirname(target), { recursive: true });
      const temp = tempPath(target);
      try {
        for (const part of sorted) {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the fake's own root
          await writeFile(temp, await readFile(partPath(uploadId, part.partNumber)), {
            flag: "a",
          });
        }
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- key checked by assertStorageKey
        await rename(temp, target);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
      await rm(dir, { recursive: true, force: true });
      return "completed";
    },

    async abortMultipartUpload(key, { uploadId }) {
      const dir = await ownUpload(key, uploadId);
      if (dir) await rm(dir, { recursive: true, force: true });
    },

    async signDownload(key, options) {
      const url = `${uploadUrlBase}${assertStorageKey(key)}`;
      const name = options?.downloadName;
      if (name === undefined) return url;
      return `${url}?download=${encodeURIComponent(assertDownloadName(name))}`;
    },

    async head(key) {
      try {
        const path = pathOf(key);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- key checked by assertStorageKey
        const info = await stat(path);
        return info.isFile() ? { bytes: info.size, etag: await md5Of(path) } : null;
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },

    async get(key) {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- key checked by assertStorageKey
        return new Uint8Array(await readFile(pathOf(key)));
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },

    async getFile(key, path, options) {
      options?.signal?.throwIfAborted();
      const part = `${path}.part`;
      try {
        await copyFile(pathOf(key), part);
      } catch (error) {
        await rm(part, { force: true });
        if (isMissing(error)) return false;
        throw error;
      }
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- the caller's local path
      await rename(part, path);
      return true;
    },

    // Written under a temporary name and renamed: a reader never sees half a file.
    async put(key, body) {
      const path = pathOf(key);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- key checked by assertStorageKey
      await mkdir(dirname(path), { recursive: true });
      const temp = tempPath(path);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- key checked by assertStorageKey
      await writeFile(temp, body);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- key checked by assertStorageKey
      await rename(temp, path);
    },

    // A finished temporary copy hard-linked to the key's path: link fails with
    // EEXIST when the key is taken, so an existing object is never replaced.
    async putFileIfAbsent(key, path) {
      const target = pathOf(key);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- key checked by assertStorageKey
      await mkdir(dirname(target), { recursive: true });
      const temp = tempPath(target);
      try {
        await copyFile(path, temp);
        return await linkOnce(temp, target);
      } finally {
        await rm(temp, { force: true });
      }
    },

    // The bytes written to a temporary file, then hard-linked like putFileIfAbsent.
    async putIfAbsent(key, body) {
      const target = pathOf(key);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- key checked by assertStorageKey
      await mkdir(dirname(target), { recursive: true });
      const temp = tempPath(target);
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- key checked by assertStorageKey
        await writeFile(temp, body);
        return await linkOnce(temp, target);
      } finally {
        await rm(temp, { force: true });
      }
    },

    async delete(key) {
      await rm(pathOf(key), { force: true });
    },

    async list(prefix) {
      const files = await walk(root);
      return files
        .map((file) => relative(root, file).split(sep).join("/"))
        .filter(
          (key) => key.startsWith(prefix) && !TEMP.test(key) && !key.startsWith(`${MULTIPART}/`),
        )
        .sort();
    },
  };
}
