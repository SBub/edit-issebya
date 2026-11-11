import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// A model the worker runs itself: a modified file that no official URL
// serves, so it is committed at apps/worker/models/ beside its notice
// (THIRD_PARTY_NOTICES.md) and pinned by name, size and SHA-256. Never
// downloaded.
export interface ModelFile {
  file: string;
  sha256: string;
  bytes: number;
}

// apps/worker/models/<file>, in the repository and in the worker image.
export function modelPath(model: ModelFile): string {
  return fileURLToPath(new URL(`../models/${model.file}`, import.meta.url));
}

// How a missing or changed model comes back: it is a committed file.
export function modelRestore(model: ModelFile): string {
  return `git checkout -- apps/worker/models/${model.file}`;
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own model file
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

// The file at `path` is the pinned model: present, with the pinned size and
// SHA-256. One line naming what is wrong (the model by `name`) and how to fix
// it, otherwise.
export async function verifyModelFile(path: string, model: ModelFile, name: string): Promise<void> {
  const restore = modelRestore(model);
  let bytes: number;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own model file
    ({ size: bytes } = await stat(path));
  } catch {
    throw new Error(`${name} model missing at ${path}, restore it with ${restore}`);
  }
  const sha = await sha256OfFile(path);
  if (bytes !== model.bytes || sha !== model.sha256) {
    throw new Error(
      `${name} model at ${path} has ${bytes} bytes and SHA-256 ${sha.slice(0, 8)}, not ${model.bytes} bytes and ${model.sha256.slice(0, 8)}; restore it with ${restore}`,
    );
  }
}
