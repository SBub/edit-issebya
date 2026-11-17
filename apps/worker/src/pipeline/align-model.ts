import { type ModelFile, modelPath, verifyModelFile } from "../model-file.ts";

// The word aligner's model: wav2vec2-base-960h (facebook/wav2vec2-base-960h,
// Apache 2.0), an English CTC speech model that spells letters, in the ONNX
// export with float32 weights published by Xenova/wav2vec2-base-960h, at a
// pinned revision, unchanged. Too large to commit (378 MB), so it is fetched
// from that URL by `models:fetch` (fetch-models.ts) and by the worker image's
// build, and pinned here by name, size and SHA-256. Float32 because the smaller
// exports are out: the float16 one (189 MB) crashes onnxruntime-node on Linux
// arm64 (the worker container on the owner's Mac) as soon as a session is
// created, and the int8 one (95 MB) placed whole words up to 5 s off on the
// owner's footage (app_docs/pipeline.md).
export const ALIGN_MODEL_REVISION = "a19f851b3d42865797e410752b4c570c871e4825";

export const ALIGN_MODEL: ModelFile = {
  file: "wav2vec2-base-960h.onnx",
  sha256: "e46614273f03ff4b87923a965e417fa72004825522cb007c9c25633b8475490d",
  bytes: 377_887_594,
  url: `https://huggingface.co/Xenova/wav2vec2-base-960h/resolve/${ALIGN_MODEL_REVISION}/onnx/model.onnx`,
};

// apps/worker/models/<file>, in the repository folder and in the worker image.
export function alignModelPath(): string {
  return modelPath(ALIGN_MODEL);
}

// The model at `path` is the pinned one: present, with the pinned size and
// SHA-256. One line naming what is wrong and how to fix it, otherwise.
export function verifyAlignModel(path: string): Promise<void> {
  return verifyModelFile(path, ALIGN_MODEL, "wav2vec2");
}
