import { homedir } from "node:os";
import { join } from "node:path";
import { type ModelFile, verifyModelFile } from "../model-file.ts";

// The Whisper model transcribe's re-listen hears a window with: `medium`
// (ggml-medium.bin of ggerganov/whisper.cpp, MIT), the file HyperFrames'
// `--model medium` names, at the revision, size and SHA-256 HyperFrames pins
// (0.8.222, its PINNED_MODELS). Run through HyperFrames like `small`, so it
// lives where HyperFrames looks for its models, not in apps/worker/models.
// Fetched there by `models:fetch` (fetch-models.ts) and by the worker image's
// build, never at job time: without the check here HyperFrames would download
// 1.5 GB in the middle of a job.
export const WHISPER_MODEL_REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1";

export const RELISTEN_MODEL: ModelFile = {
  file: "ggml-medium.bin",
  sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
  bytes: 1_533_763_059,
  url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODEL_REVISION}/ggml-medium.bin`,
};

// HyperFrames' model folder: ~/.cache/hyperframes/whisper/models.
export function relistenModelPath(home: string = homedir()): string {
  return join(home, ".cache", "hyperframes", "whisper", "models", RELISTEN_MODEL.file);
}

// The model at `path` is the pinned one: present, with the pinned size and
// SHA-256. One line naming what is wrong and how to fix it, otherwise.
export function verifyRelistenModel(path: string): Promise<void> {
  return verifyModelFile(path, RELISTEN_MODEL, "whisper medium");
}
