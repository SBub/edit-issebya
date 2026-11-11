import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MATTE_SETTINGS } from "./matte.ts";

export interface ModelFile {
  file: string;
  sha256: string;
  bytes: number;
}

// The cut-out's model: MODNet portrait matting (ZHKKKe/MODNet, Apache 2.0)
// with its weights and activations quantised to int8, a modified file that no
// official URL serves, so it is committed at apps/worker/models/ beside its
// notice (THIRD_PARTY_NOTICES.md) and pinned here by name, size and SHA-256.
// Never downloaded; app_docs/pipeline.md says how it was made.
export const MODNET_MODEL: ModelFile = {
  file: `${MATTE_SETTINGS.model}.onnx`,
  sha256: MATTE_SETTINGS.modelSha256,
  bytes: 6_912_985,
};

// How a missing or changed model comes back: it is a committed file.
export const MODEL_RESTORE = `git checkout -- apps/worker/models/${MODNET_MODEL.file}`;

// apps/worker/models/<file>, in the repository and in the worker image.
export function modnetModelPath(): string {
  return fileURLToPath(new URL(`../../models/${MODNET_MODEL.file}`, import.meta.url));
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own model file
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

// The model at `path` is the pinned one: present, with the pinned size and
// SHA-256. One line naming what is wrong and how to fix it, otherwise.
export async function verifyModel(path: string): Promise<void> {
  let bytes: number;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own model file
    ({ size: bytes } = await stat(path));
  } catch {
    throw new Error(`MODNet model missing at ${path}, restore it with ${MODEL_RESTORE}`);
  }
  const sha = await sha256OfFile(path);
  if (bytes !== MODNET_MODEL.bytes || sha !== MODNET_MODEL.sha256) {
    throw new Error(
      `MODNet model at ${path} has ${bytes} bytes and SHA-256 ${sha.slice(0, 8)}, not ${MODNET_MODEL.bytes} bytes and ${MODNET_MODEL.sha256.slice(0, 8)}; restore it with ${MODEL_RESTORE}`,
    );
  }
}
