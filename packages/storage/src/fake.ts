import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fakeMultipart } from "./fake-multipart.ts";
import { type Storage, assertStorageKey, assertUploadId, isPartNumber } from "./storage.ts";

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
    // `.multipart` holds the fake's unfinished uploads, never an object.
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

// A Storage backed by a folder, for specs: every key maps to `<root>/<key>`,
// and a key that could leave the root is refused. Signed URLs are same-origin
// paths to the studio's mock route (`uploadUrlBase` + key), with S3's query
// strings for the multipart requests.
export function fakeStorage({
  root,
  uploadUrlBase,
}: {
  root: string;
  uploadUrlBase: string;
}): Storage {
  const pathOf = (key: string) => join(root, assertStorageKey(key));
  const urlOf = (key: string) => `${uploadUrlBase}${assertStorageKey(key)}`;

  return {
    async signCreateMultipart(key, { contentType }) {
      return { url: `${urlOf(key)}?uploads`, headers: { "Content-Type": contentType } };
    },

    async signUploadPart(key, { uploadId, partNumber }) {
      if (!isPartNumber(partNumber)) throw new Error("invalid part number");
      return `${urlOf(key)}?partNumber=${partNumber}&uploadId=${encodeURIComponent(assertUploadId(uploadId))}`;
    },

    // List (GET) and complete (POST) share the URL, as on S3.
    async signListParts(key, { uploadId }) {
      return `${urlOf(key)}?uploadId=${encodeURIComponent(assertUploadId(uploadId))}`;
    },

    async signCompleteMultipart(key, { uploadId }) {
      return `${urlOf(key)}?uploadId=${encodeURIComponent(assertUploadId(uploadId))}`;
    },

    abortMultipart(key, uploadId) {
      return fakeMultipart({ root }).abort(key, uploadId);
    },

    async signDownload(key) {
      return urlOf(key);
    },

    async head(key) {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- key checked by assertStorageKey
        const info = await stat(pathOf(key));
        return info.isFile() ? { bytes: info.size } : null;
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

    async put(key, body) {
      const path = pathOf(key);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- key checked by assertStorageKey
      await mkdir(dirname(path), { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- key checked by assertStorageKey
      await writeFile(path, body);
    },

    async delete(key) {
      await rm(pathOf(key), { force: true });
    },

    async list(prefix) {
      const files = await walk(root);
      return files
        .map((file) => relative(root, file).split(sep).join("/"))
        .filter((key) => key.startsWith(prefix))
        .sort();
    },
  };
}
