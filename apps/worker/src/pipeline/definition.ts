import type { PipelineReelStatus } from "../step-store.ts";
import type { Tool } from "../step-runner.ts";
import { convert } from "./convert.ts";
import { type FileRef, fingerprint } from "./fingerprint.ts";
import { headTrack } from "./head-track-step.ts";
import { previewCopies } from "./preview-copies.ts";
import { removeBackground } from "./remove-background.ts";
import { retime } from "./retime.ts";
import type { ToolPaths } from "./tools.ts";
import { transcribe } from "./transcribe.ts";

export type SourceRef = { etag: string; bytes: number };

// A file a step reads, and the name its `run` finds it under in `files`.
export interface StepInput {
  ref: FileRef;
  as: string;
}

export interface StepRunArgs<S> {
  tool: Tool;
  tools: ToolPaths;
  // The step's own folder: its outputs are written here under their names.
  dir: string;
  // Local paths of exactly the declared inputs, by their `as` names.
  files: Record<string, string>;
  settings: S;
  signal: AbortSignal;
}

// `kept`: cannot be regenerated cheaply, so it stays. `rebuildable`: heavy,
// and may be deleted by the cleanup (slice 14), since its step re-runs from
// the fingerprint whenever a later job needs it.
export type OutputRetention = "kept" | "rebuildable";

export interface StepOutput {
  file: string;
  retention: OutputRetention;
}

// One fixed step: everything its outputs depend on (inputs, settings,
// version) is declared, and its fingerprint is made of nothing else.
export interface PipelineStep<S extends object = object> {
  name: string;
  // Bumped by hand whenever the step's behaviour changes.
  version: number;
  settings: S;
  reelStatus: PipelineReelStatus;
  outputs: readonly StepOutput[];
  // The summary of a cache hit: `<reusedWhat>, reused`.
  reusedWhat: string;
  inputs(source: SourceRef, fingerprints: Record<string, string>): StepInput[];
  run(args: StepRunArgs<S>): Promise<{ what: string }>;
}

export const PIPELINE: readonly PipelineStep[] = [
  convert,
  transcribe,
  retime,
  removeBackground,
  headTrack,
  previewCopies,
];

// The names of a step's outputs, in order.
export function outputFiles(step: PipelineStep): string[] {
  return step.outputs.map((output) => output.file);
}

// The retention tag of one step's output; null when no step declares it.
export function retentionOf(
  step: string,
  file: string,
  pipeline: readonly PipelineStep[] = PIPELINE,
): OutputRetention | null {
  const output = pipeline
    .find((candidate) => candidate.name === step)
    ?.outputs.find((candidate) => candidate.file === file);
  return output?.retention ?? null;
}

// Every step's fingerprint, in order, from the source and the definition
// alone: no file is read, so a hit is decided before any download.
export function fingerprintsFor(
  source: SourceRef,
  pipeline: readonly PipelineStep[] = PIPELINE,
): Record<string, string> {
  const fingerprints: Record<string, string> = {};
  for (const step of pipeline) {
    fingerprints[step.name] = fingerprint({
      inputs: step.inputs(source, fingerprints).map((input) => input.ref),
      settings: step.settings,
      version: step.version,
    });
  }
  return fingerprints;
}
