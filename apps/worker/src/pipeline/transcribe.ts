import { mkdir, readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeAtomic } from "./atomic.ts";
import type { PipelineStep } from "./definition.ts";
import { ALIGN_SETTINGS } from "./align.ts";
import { alignModelPath } from "./align-model.ts";
import { HYPERFRAMES_VERSION, type ToolPaths, hyperframesEnv } from "./tools.ts";
import { normaliseHyperframes } from "./transcript.ts";

// 1: HyperFrames' whisper times. 2: whisper's words, the aligner's times.
const TRANSCRIBE_VERSION = 2;

// Always the multilingual `small` model told the language: `small.en` and
// `base` drop or merge words on this footage (app_docs/pipeline.md). The
// HyperFrames version is a setting: another version may hear other words.
// `align` is the word aligner's (align.ts): its model and how it hears.
export const TRANSCRIBE_SETTINGS = {
  engine: "whisper",
  model: "small",
  language: "en",
  hyperframes: HYPERFRAMES_VERSION,
  align: ALIGN_SETTINGS,
};

export type TranscribeSettings = typeof TRANSCRIBE_SETTINGS;

const OUTPUT = "transcript.json";
const HEARD = "heard.json";
const ALIGNED = "aligned.json";

// The worker's own aligner entry, run by this Node.
const ALIGN_ENTRY = fileURLToPath(new URL("./align-entry.ts", import.meta.url));

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

// The aligner entry's arguments: the footage, Whisper's words, where the
// aligned transcript goes, its threads, the model and ffmpeg.
export function alignArgs(
  input: { footage: string; words: string; output: string; threads: number },
  model: string,
  tools: Pick<ToolPaths, "ffmpeg">,
): string[] {
  return [
    ALIGN_ENTRY,
    "--input",
    input.footage,
    "--words",
    input.words,
    "--output",
    input.output,
    "--threads",
    String(input.threads),
    "--model",
    model,
    "--ffmpeg",
    tools.ffmpeg,
  ];
}

// Whisper (through HyperFrames) hears the words; the aligner (align-entry.ts)
// times each one in the audio. The transcript keeps Whisper's words and ids
// and takes the aligner's times.
export const transcribe: PipelineStep<TranscribeSettings> = {
  name: "transcribe",
  version: TRANSCRIBE_VERSION,
  settings: TRANSCRIBE_SETTINGS,
  reelStatus: "transcribing",
  outputs: [{ file: OUTPUT, retention: "kept" }],
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
      ignoreStdout: true,
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    const raw = JSON.parse(await readFile(join(work, "transcript.json"), "utf8")) as unknown;
    const heard = normaliseHyperframes(raw);
    await writeAtomic(join(dir, HEARD), `${JSON.stringify(heard, null, 2)}\n`);
    await tool({
      file: node,
      args: alignArgs(
        {
          footage: files["converted.mp4"]!,
          words: join(dir, HEARD),
          output: join(dir, ALIGNED),
          threads: availableParallelism(),
        },
        alignModelPath(),
        tools,
      ),
      // The aligner prints its progress and writes its answer to a file.
      ignoreStdout: true,
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    const aligned = await readFile(join(dir, ALIGNED), "utf8");
    await writeAtomic(join(dir, OUTPUT), aligned);
    const { words } = JSON.parse(aligned) as { words: unknown[] };
    return { what: `transcribed, ${words.length} words` };
  },
};
