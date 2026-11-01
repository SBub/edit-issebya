import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "./atomic.ts";
import type { PipelineStep } from "./definition.ts";
import { HYPERFRAMES_VERSION, hyperframesEnv } from "./tools.ts";
import { normaliseHyperframes } from "./transcript.ts";

const TRANSCRIBE_VERSION = 1;

// Always the multilingual `small` model told the language: `small.en` and
// `base` drop or merge words on this footage (app_docs/pipeline.md). The
// HyperFrames version is a setting: another version may hear other words.
export const TRANSCRIBE_SETTINGS = {
  engine: "whisper",
  model: "small",
  language: "en",
  hyperframes: HYPERFRAMES_VERSION,
};

export type TranscribeSettings = typeof TRANSCRIBE_SETTINGS;

const OUTPUT = "transcript.json";

// HyperFrames' arguments (after its entry file): it writes
// `<dir>/transcript.json`.
export function transcribeArgs(input: string, dir: string, settings: TranscribeSettings): string[] {
  return [
    "transcribe",
    input,
    "--engine",
    settings.engine,
    "--model",
    settings.model,
    "--language",
    settings.language,
    "--json",
    "--dir",
    dir,
  ];
}

export const transcribe: PipelineStep<TranscribeSettings> = {
  name: "transcribe",
  version: TRANSCRIBE_VERSION,
  settings: TRANSCRIBE_SETTINGS,
  reelStatus: "transcribing",
  outputs: [OUTPUT],
  reusedWhat: "transcribed",
  inputs: (_source, fingerprints) => [
    {
      ref: { step: "convert", fingerprint: fingerprints.convert!, file: "converted.mp4" },
      as: "converted.mp4",
    },
  ],
  async run({ tool, tools, dir, files, settings }) {
    // Its own folder: HyperFrames' transcript.json is not the step's output.
    const work = join(dir, "hyperframes");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    await mkdir(work, { recursive: true });
    const [node, entry] = tools.hyperframes;
    await tool({
      file: node,
      args: [entry, ...transcribeArgs(files["converted.mp4"]!, work, settings)],
      env: hyperframesEnv(),
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    const raw = JSON.parse(await readFile(join(work, "transcript.json"), "utf8")) as unknown;
    const transcript = normaliseHyperframes(raw);
    await writeAtomic(join(dir, OUTPUT), `${JSON.stringify(transcript, null, 2)}\n`);
    return { what: `transcribed, ${transcript.words.length} words` };
  },
};
