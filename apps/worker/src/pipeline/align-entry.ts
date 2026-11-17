// The transcribe step's word aligner: where each of Whisper's words starts and
// ends in the audio, by the CTC model (wav2vec2, ONNX Runtime on the CPU), run
// by the worker's Node as one tool call of the `transcribe` step.
//
//   align-entry --input <media> --words <transcript.json> --output <json>
//               --threads <n> --model <onnx> --ffmpeg <path>
//
// Checks the model against its pinned SHA-256; ffmpeg decodes the audio to
// 16 kHz mono; the model hears it in chunks (align.ts, chunksOf), and the
// forced alignment places the words (alignedTranscript). Written to
// <output>.part, renamed to <output> once finished. One `@hf-progress
// {"index","total","pct"}` line per chunk on stdout; any failure exits
// non-zero with one `align: ...` line.
import { spawn } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { InferenceSession, Tensor } from "onnxruntime-node";
import { exited, stderrOf } from "../child-output.ts";
import { verifyAlignModel } from "./align-model.ts";
import {
  ALIGN_SETTINGS,
  VOCABULARY_SIZE,
  alignDecodeArgs,
  alignedTranscript,
  chunksOf,
  forcedAlign,
  logSoftmax,
  normaliseSamples,
  transcriptTokens,
} from "./align.ts";
import { parseTranscript } from "./transcript.ts";

interface Options {
  input: string;
  words: string;
  output: string;
  threads: number;
  model: string;
  ffmpeg: string;
}

const NAMES = ["--input", "--words", "--output", "--threads", "--model", "--ffmpeg"];

function parseOptions(argv: string[]): Options {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]!;
    const value = argv[i + 1];
    if (!NAMES.includes(name)) throw new Error(`unknown argument ${name}`);
    if (value === undefined) throw new Error(`missing value for ${name}`);
    flags.set(name, value);
  }
  for (const name of NAMES) if (!flags.has(name)) throw new Error(`missing ${name}`);
  const threads = Number(flags.get("--threads"));
  if (!Number.isInteger(threads) || threads < 1) {
    throw new Error(`bad --threads ${flags.get("--threads")}`);
  }
  return {
    input: flags.get("--input")!,
    words: flags.get("--words")!,
    output: flags.get("--output")!,
    threads,
    model: flags.get("--model")!,
    ffmpeg: flags.get("--ffmpeg")!,
  };
}

async function decode(options: Options): Promise<Float32Array> {
  const decoder = spawn(options.ffmpeg, alignDecodeArgs(options.input), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const error = stderrOf(decoder);
  const done = exited(decoder);
  const parts: Buffer[] = [];
  for await (const chunk of decoder.stdout) parts.push(chunk as Buffer);
  if ((await done) !== 0) throw new Error(`decoding failed: ${error()}`);
  const bytes = Buffer.concat(parts);
  const samples = new Float32Array(bytes.length >> 2);
  for (let i = 0; i < samples.length; i += 1) samples[i] = bytes.readFloatLE(i * 4);
  return samples;
}

async function align(options: Options): Promise<void> {
  await verifyAlignModel(options.model);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the step's own scratch file
  const words = parseTranscript(await readFile(options.words, "utf8")).words;
  const samples = await decode(options);
  const settings = ALIGN_SETTINGS;
  const chunks = chunksOf(samples.length, settings);
  const frames = chunks.reduce((sum, chunk) => sum + chunk.count, 0);
  const emissions = new Float32Array(frames * VOCABULARY_SIZE);

  const session = await InferenceSession.create(options.model, {
    executionProviders: [settings.provider],
    intraOpNumThreads: options.threads,
    interOpNumThreads: 1,
    graphOptimizationLevel: "all",
  });
  const [inputName] = session.inputNames;
  const [outputName] = session.outputNames;
  if (!inputName || !outputName) throw new Error("the model has no input or output");
  for (const [index, chunk] of chunks.entries()) {
    const input = normaliseSamples(samples.subarray(chunk.from, chunk.to));
    const result = await session.run({
      [inputName]: new Tensor("float32", input, [1, input.length]),
    });
    const logits = result[outputName]!;
    const [, made, size] = logits.dims as [number, number, number];
    if (size !== VOCABULARY_SIZE)
      throw new Error(`the model gives ${size} labels, not ${VOCABULARY_SIZE}`);
    const data = logits.data as Float32Array;
    // The clip's last frames may be a frame short of a whole step: the last
    // frame the model made stands for them.
    for (let k = 0; k < chunk.count; k += 1) {
      const from = Math.min(chunk.skip + k, made - 1) * size;
      emissions.set(data.subarray(from, from + size), (chunk.first + k) * size);
    }
    const pct = Math.floor((100 * (index + 1)) / chunks.length);
    console.log(`@hf-progress ${JSON.stringify({ index: index + 1, total: chunks.length, pct })}`);
  }
  await session.release();

  logSoftmax(emissions, frames, VOCABULARY_SIZE);
  const { tokens, owned } = transcriptTokens(words);
  const spans = forcedAlign(emissions, frames, VOCABULARY_SIZE, tokens);
  const aligned = alignedTranscript(
    words,
    owned,
    spans,
    settings.samplesPerFrame / settings.sampleRate,
    samples.length / settings.sampleRate,
  );
  const part = `${options.output}.part`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the step's own scratch file
  await writeFile(part, `${JSON.stringify({ words: aligned }, null, 2)}\n`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the step's own scratch files
  await rename(part, options.output);
}

try {
  const options = parseOptions(process.argv.slice(2));
  try {
    await align(options);
  } catch (error) {
    await rm(`${options.output}.part`, { force: true });
    throw error;
  }
  // No process.exit: exiting with onnxruntime's threads still up aborts the
  // process (`mutex lock failed`); the event loop drains instead.
} catch (error) {
  console.error(`align: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
