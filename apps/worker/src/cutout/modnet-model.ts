import { type ModelFile, modelPath, modelRestore, verifyModelFile } from "../model-file.ts";
import { MATTE_SETTINGS } from "./matte.ts";

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
export const MODEL_RESTORE = modelRestore(MODNET_MODEL);

// apps/worker/models/<file>, in the repository and in the worker image.
export function modnetModelPath(): string {
  return modelPath(MODNET_MODEL);
}

// The model at `path` is the pinned one: present, with the pinned size and
// SHA-256. One line naming what is wrong and how to fix it, otherwise.
export function verifyModel(path: string): Promise<void> {
  return verifyModelFile(path, MODNET_MODEL, "MODNet");
}
