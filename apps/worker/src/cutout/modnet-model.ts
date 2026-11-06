import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MATTE_SETTINGS } from "./matte.ts";

type Env = Record<string, string | undefined>;

export interface ModelFile {
  file: string;
  url: string;
  sha256: string;
  bytes: number;
}

// The official MODNet portrait matting model in ONNX (ZHKKKe/MODNet,
// onnx/README.md: "the ONNX version of the official Image Matting Model"),
// Apache 2.0 like the project's code. Never committed and never fetched at job
// time: `models:install` downloads it once and checks it against this hash.
export const MODNET_MODEL: ModelFile = {
  file: `${MATTE_SETTINGS.model}.onnx`,
  // eslint-disable-next-line no-secrets/no-secrets -- a public Google Drive file id, not a key
  url: "https://drive.usercontent.google.com/download?id=1cgycTQlYXpTh26gB9FTnthE7AvruV8hd&export=download&confirm=t",
  sha256: MATTE_SETTINGS.modelSha256,
  bytes: 25_888_640,
};

export const MODELS_INSTALL = "yarn workspace @edit-issebya/worker models:install";

// WORKER_MODELS_DIR, else ~/.edit-issebya-worker/models.
export function modelsDirOf(env: Env = process.env): string {
  return env.WORKER_MODELS_DIR?.trim() || join(homedir(), ".edit-issebya-worker", "models");
}

export function modnetModelPath(env: Env = process.env): string {
  return join(modelsDirOf(env), MODNET_MODEL.file);
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own model file
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

// The model at `path` is the pinned one: present, with the pinned SHA-256.
// One line naming what is wrong and how to fix it, otherwise.
export async function verifyModel(path: string): Promise<void> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own model file
    await stat(path);
  } catch {
    throw new Error(`MODNet model not installed at ${path}, run ${MODELS_INSTALL}`);
  }
  const sha = await sha256OfFile(path);
  if (sha !== MODNET_MODEL.sha256) {
    throw new Error(
      `MODNet model at ${path} has SHA-256 ${sha.slice(0, 8)}, not ${MODNET_MODEL.sha256.slice(0, 8)}; run ${MODELS_INSTALL}`,
    );
  }
}

export type Fetch = (url: string) => Promise<Response>;

// Downloads the model into `path` unless the pinned one is already there:
// streamed into `<path>.part` while hashed, kept only when the size and the
// SHA-256 match, then renamed. Returns what it did.
export async function installModel(
  path: string,
  { fetch: get = fetch, model = MODNET_MODEL }: { fetch?: Fetch; model?: ModelFile } = {},
): Promise<"installed" | "present"> {
  try {
    if ((await sha256OfFile(path)) === model.sha256) return "present";
  } catch {
    // Not there yet.
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own models folder
  await mkdir(dirname(path), { recursive: true });
  const part = `${path}.part`;
  const response = await get(model.url);
  if (!response.ok || !response.body) {
    throw new Error(`model download failed: HTTP ${response.status} from ${model.url}`);
  }
  const hash = createHash("sha256");
  let bytes = 0;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own models folder
  const file = await open(part, "w");
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      bytes += chunk.byteLength;
      await file.write(chunk);
    }
  } finally {
    await file.close();
  }
  const sha = hash.digest("hex");
  if (bytes !== model.bytes || sha !== model.sha256) {
    await rm(part, { force: true });
    throw new Error(
      `model download refused: ${bytes} bytes with SHA-256 ${sha}, expected ${model.bytes} bytes with ${model.sha256}`,
    );
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own models folder
  await rename(part, path);
  return "installed";
}
