import { mkdir, readFile, rm } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeAtomic } from "./atomic.ts";
import type { PipelineStep } from "./definition.ts";
import { ALIGN_SETTINGS } from "./align.ts";
import { alignModelPath } from "./align-model.ts";
import { envelopeArgs, parseEnvelope } from "./envelope.ts";
import {
  RELISTEN_SETTINGS,
  type Replacement,
  applyReplacements,
  heardTexts,
  mergeHeard,
  relistenSpots,
  relistenSummary,
  relistenWindow,
  windowArgs,
} from "./relisten.ts";
import { HYPERFRAMES_VERSION, type ToolPaths, hyperframesEnv } from "./tools.ts";
import {
  type Transcript,
  normaliseHyperframes,
  numberWords,
  parseTranscript,
} from "./transcript.ts";
import { relistenModelPath, verifyRelistenModel } from "./whisper-model.ts";

// 1: HyperFrames' whisper times. 2: whisper's words, the aligner's times.
// 3: the spots where a word may be missing heard again by a larger model.
const TRANSCRIBE_VERSION = 3;

// Always the multilingual `small` model told the language: `small.en` and
// `base` drop or merge words on this footage (app_docs/pipeline.md). The
// HyperFrames version is a setting: another version may hear other words.
// `align` is the word aligner's (align.ts): its model and how it hears.
// `relisten` is the second hearing's (relisten.ts): its model and thresholds.
export const TRANSCRIBE_SETTINGS = {
  engine: "whisper",
  model: "small",
  language: "en",
  hyperframes: HYPERFRAMES_VERSION,
  align: ALIGN_SETTINGS,
  relisten: RELISTEN_SETTINGS,
};

export type TranscribeSettings = typeof TRANSCRIBE_SETTINGS;

const OUTPUT = "transcript.json";
const HEARD = "heard.json";
const ALIGNED = "aligned.json";
const EMISSIONS = "emissions.f32";
const ENVELOPE_PRINT = "envelope.txt";
const MERGED = "merged.json";

// The worker's own aligner entry, run by this Node.
const ALIGN_ENTRY = fileURLToPath(new URL("./align-entry.ts", import.meta.url));

// HyperFrames' arguments (after its entry file): it writes
// `<dir>/transcript.json`.
export function transcribeArgs(
  input: string,
  dir: string,
  settings: Pick<TranscribeSettings, "engine" | "language"> & { model: string },
): string[] {
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
// aligned transcript goes, its threads, the model, ffmpeg and the file its
// letter probabilities are kept in (read back by a second alignment).
export function alignArgs(
  input: { footage: string; words: string; output: string; threads: number; emissions: string },
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
    "--emissions",
    input.emissions,
  ];
}

// Whisper `small` (through HyperFrames) hears the words; the aligner
// (align-entry.ts) times each one in the audio. Then the re-listen
// (relisten.ts): where the audio and those times say a word may be missing,
// Whisper `medium` hears a short window again, and its words replace the old
// ones only between two words both models agree on. When that changed the
// words, the aligner times the new list (from its saved letter probabilities,
// the model does not run twice). Ids are given last, by position, to the
// list the step writes.
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
    const footage = files["converted.mp4"]!;
    const [node, entry] = tools.hyperframes;
    // HyperFrames always writes `<folder>/transcript.json`, which is not the
    // step's output: each hearing gets a folder of its own.
    const hear = async (input: string, folder: string, model: string): Promise<unknown> => {
      const work = join(dir, folder);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
      await mkdir(work, { recursive: true });
      await tool({
        file: node,
        args: [entry, ...transcribeArgs(input, work, { ...settings, model })],
        env: hyperframesEnv(),
        ignoreStdout: true,
      });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
      return JSON.parse(await readFile(join(work, "transcript.json"), "utf8")) as unknown;
    };
    const align = async (words: Transcript, name: string, output: string): Promise<Transcript> => {
      await writeAtomic(join(dir, name), `${JSON.stringify(words, null, 2)}\n`);
      await tool({
        file: node,
        args: alignArgs(
          {
            footage,
            words: join(dir, name),
            output: join(dir, output),
            threads: availableParallelism(),
            emissions: join(dir, EMISSIONS),
          },
          alignModelPath(),
          tools,
        ),
        // The aligner prints its progress and writes its answer to a file.
        ignoreStdout: true,
      });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
      return parseTranscript(await readFile(join(dir, output), "utf8"));
    };

    // A file left by an earlier try must not stand in for this clip's audio.
    await rm(join(dir, EMISSIONS), { force: true });
    const heard = normaliseHyperframes(await hear(footage, "hyperframes", settings.model));
    const aligned = await align(heard, HEARD, ALIGNED);

    await tool({
      file: tools.ffmpeg,
      args: envelopeArgs(footage, ENVELOPE_PRINT),
      cwd: dir,
      ignoreStdout: true,
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    const envelope = parseEnvelope(await readFile(join(dir, ENVELOPE_PRINT), "utf8"));
    const relisten = settings.relisten;
    const spots = relistenSpots({ words: aligned.words, envelope, settings: relisten });
    const replacements: Replacement[] = [];
    if (spots.length > 0) await verifyRelistenModel(relistenModelPath());
    for (const [index, spot] of spots.entries()) {
      const window = relistenWindow(
        spot,
        aligned.words,
        envelope.length * relisten.envelopeFrameSeconds,
        relisten,
      );
      const audio = join(dir, `relisten-${index}.wav`);
      await tool({
        file: tools.ffmpeg,
        args: windowArgs(footage, window, audio),
        ignoreStdout: true,
      });
      const again = heardTexts(await hear(audio, `relisten-${index}`, relisten.model));
      const replacement = mergeHeard({ words: aligned.words, window, spot, heard: again });
      if (replacement) replacements.push(replacement);
    }

    const changed = replacements.length > 0;
    const words = changed
      ? (
          await align(
            { words: numberWords(applyReplacements(aligned.words, replacements)) },
            MERGED,
            "realigned.json",
          )
        ).words
      : aligned.words;
    const transcript: Transcript = { words: numberWords(words) };
    await writeAtomic(join(dir, OUTPUT), `${JSON.stringify(transcript, null, 2)}\n`);
    const again = relistenSummary(spots.length, aligned.words.length, words.length, changed);
    return { what: `transcribed, ${words.length} words${again}` };
  },
};
