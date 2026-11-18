// `yarn workspace @edit-issebya/worker models:fetch`: fetches each published
// model the worker runs (a ModelFile with a `url`) from its pinned URL, once:
// the word aligner's into apps/worker/models/, and the re-listen's Whisper
// `medium` into HyperFrames' model folder (~/.cache/hyperframes/whisper/models). A file already there
// with the pinned size and SHA-256 is kept; anything else is replaced. The
// download is checked against the pin before it takes the model's name.
// Never run at job time; the worker image fetches the same file at build.
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type ModelFile, modelPath, verifyModelFile } from "./model-file.ts";
import { ALIGN_MODEL } from "./pipeline/align-model.ts";
import { RELISTEN_MODEL, relistenModelPath } from "./pipeline/whisper-model.ts";

const PUBLISHED: readonly { model: ModelFile; path: string }[] = [
  { model: ALIGN_MODEL, path: modelPath(ALIGN_MODEL) },
  { model: RELISTEN_MODEL, path: relistenModelPath() },
];

async function fetchModel(model: ModelFile, path: string): Promise<string> {
  try {
    await verifyModelFile(path, model, model.file);
    return `${model.file} already there`;
  } catch {
    // Missing or changed: fetched again below.
  }
  const response = await fetch(model.url!);
  if (!response.ok || !response.body) throw new Error(`${model.url} answered ${response.status}`);
  const part = `${path}.part`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own model folders
  await mkdir(dirname(path), { recursive: true });
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own model folder
    await pipeline(Readable.fromWeb(response.body), createWriteStream(part));
    await verifyModelFile(part, model, model.file);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own model folder
    await rename(part, path);
  } finally {
    await rm(part, { force: true });
  }
  return `${model.file} fetched, ${model.bytes} bytes, ${model.sha256.slice(0, 8)}`;
}

try {
  for (const { model, path } of PUBLISHED) console.log(await fetchModel(model, path));
} catch (error) {
  console.error(`models:fetch: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
