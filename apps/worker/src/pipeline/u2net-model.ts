import { type ModelFile, modelPath, verifyModelFile } from "../model-file.ts";

// The head track's person mask model: U-2-Net human segmentation
// (xuebinqin/U-2-Net, Apache 2.0; the `u2net_human_seg` ONNX copy HyperFrames
// uses) converted to opset 13 with its weights and activations statically
// quantised to int8, a modified file that no official URL serves, so it is
// committed at apps/worker/models/ beside its notice (THIRD_PARTY_NOTICES.md)
// and pinned here by name, size and SHA-256. Never downloaded;
// app_docs/pipeline.md says how it was made.
export const U2NET_MODEL: ModelFile = {
  file: "u2net_int8_static13.onnx",
  sha256: "a42be65f30af575480020f4d827eabadf73c8cdfd8f77577d2946780f54dc746",
  bytes: 44_444_038,
};

// apps/worker/models/<file>, in the repository and in the worker image.
export function u2netModelPath(): string {
  return modelPath(U2NET_MODEL);
}

// The model at `path` is the pinned one: present, with the pinned size and
// SHA-256. One line naming what is wrong and how to fix it, otherwise.
export function verifyU2netModel(path: string): Promise<void> {
  return verifyModelFile(path, U2NET_MODEL, "U2Net");
}
