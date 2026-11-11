// The head track's mask tool: the person mask of one chunk of the step's
// sample clip, made by U2Net (the int8 model, ONNX Runtime on the CPU), run by
// the worker's Node as one tool call of the `head_track` step.
//
//   u2net-entry --input <samples.mp4> --first <sample> --frames <count>
//               --output <rgba> --threads <n> --model <onnx> --ffmpeg <path>
//
// Checks the model against its pinned SHA-256, then streams: ffmpeg decodes
// the chunk's samples to RGB, each frame goes through the model on its own
// (u2net.ts: nothing is carried from one frame to the next, so the masks do
// not depend on how the samples are split), and its mask is written as the
// alpha of one raw RGBA frame. Exactly `--frames` frames, or it fails. The
// model runs on `--threads` intra-op threads. Written to <output>.part,
// renamed to <output> once finished. One `@hf-progress {"index","total","pct"}`
// line per frame on stdout; any failure exits non-zero with one `u2net: ...`
// line.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { InferenceSession, Tensor } from "onnxruntime-node";
import sharp from "sharp";
import { exited, stderrOf } from "../child-output.ts";
import { HEAD_TRACK_SETTINGS, frameBytes } from "./head-track.ts";
import { verifyU2netModel } from "./u2net-model.ts";
import { U2NET_SETTINGS, alphaToRgba, u2netDecodeArgs, u2netInput, u2netMask } from "./u2net.ts";

interface Options {
  input: string;
  first: number;
  frames: number;
  output: string;
  threads: number;
  model: string;
  ffmpeg: string;
}

const NAMES = ["--input", "--first", "--frames", "--output", "--threads", "--model", "--ffmpeg"];

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
  const whole = (name: string, least: number) => {
    const value = Number(flags.get(name));
    if (!Number.isInteger(value) || value < least) {
      throw new Error(`bad ${name} ${flags.get(name)}`);
    }
    return value;
  };
  return {
    input: flags.get("--input")!,
    first: whole("--first", 0),
    frames: whole("--frames", 1),
    output: flags.get("--output")!,
    threads: whole("--threads", 1),
    model: flags.get("--model")!,
    ffmpeg: flags.get("--ffmpeg")!,
  };
}

async function makeMask(options: Options): Promise<void> {
  await verifyU2netModel(options.model);
  const settings = HEAD_TRACK_SETTINGS;
  const { analysisWidth: width, analysisHeight: height } = settings;
  const { size, resize: kernel } = U2NET_SETTINGS;
  const session = await InferenceSession.create(options.model, {
    executionProviders: [U2NET_SETTINGS.provider],
    // One frame at a time on this many threads; nothing runs between operators.
    intraOpNumThreads: options.threads,
    interOpNumThreads: 1,
    graphOptimizationLevel: "all",
  });
  const [inputName] = session.inputNames;
  const [outputName] = session.outputNames;
  if (!inputName || !outputName) throw new Error("the model has no input or output");

  const part = `${options.output}.part`;
  await rm(part, { force: true });
  const decoder = spawn(options.ffmpeg, u2netDecodeArgs(options, settings), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const decoderError = stderrOf(decoder);
  const decoded = exited(decoder);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the step's own scratch file
  const file = createWriteStream(part);
  // A failed write is kept for the next frame, not thrown as an uncaught error.
  const writing: { error?: Error } = {};
  file.on("error", (error) => {
    writing.error = error;
  });
  const closed = new Promise<void>((resolve) => file.on("close", () => resolve()));

  try {
    const rgbBytes = width * height * 3;
    const frame = Buffer.alloc(rgbBytes);
    const input = new Float32Array(3 * size * size);
    const mask = Buffer.alloc(size * size);
    let filled = 0;
    let index = 0;
    const infer = async () => {
      if (index >= options.frames) throw new Error(`more than ${options.frames} frames decoded`);
      const resized = await sharp(frame, { raw: { width, height, channels: 3 } })
        .resize(size, size, { kernel, fit: "fill" })
        .raw()
        .toBuffer();
      u2netInput(resized, input);
      const tensor = new Tensor("float32", input, [1, 3, size, size]);
      const result = await session.run({ [inputName]: tensor });
      u2netMask(result[outputName]!.data as Float32Array, mask);
      const alpha = await sharp(mask, { raw: { width: size, height: size, channels: 1 } })
        .resize(width, height, { kernel, fit: "fill" })
        .toColourspace("b-w")
        .raw()
        .toBuffer();
      // A fresh frame each time: the stream keeps the buffer until it is written.
      const rgba = Buffer.alloc(frameBytes(settings));
      alphaToRgba(alpha, rgba);
      if (writing.error) throw writing.error;
      if (!file.write(rgba)) await once(file, "drain");
      index += 1;
      const pct = Math.floor((100 * index) / options.frames);
      console.log(`@hf-progress ${JSON.stringify({ index, total: options.frames, pct })}`);
    };
    for await (const chunk of decoder.stdout) {
      let offset = 0;
      const bytes = chunk as Buffer;
      while (offset < bytes.length) {
        const take = Math.min(rgbBytes - filled, bytes.length - offset);
        bytes.copy(frame, filled, offset, offset + take);
        filled += take;
        offset += take;
        if (filled === rgbBytes) {
          filled = 0;
          await infer();
        }
      }
    }
    if ((await decoded) !== 0) throw new Error(`decoding failed: ${decoderError()}`);
    if (index !== options.frames || filled !== 0) {
      throw new Error(
        `${index} frames decoded from sample ${options.first}, expected ${options.frames}`,
      );
    }
    file.end();
    await closed;
    if (writing.error) throw writing.error;
    await session.release();
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the step's own scratch files
    await rename(part, options.output);
  } catch (error) {
    decoder.kill("SIGKILL");
    file.destroy();
    await Promise.all([decoded, closed]);
    await rm(part, { force: true });
    throw error;
  }
}

try {
  await makeMask(parseOptions(process.argv.slice(2)));
  // No process.exit: exiting with onnxruntime's threads still up aborts the
  // process (`mutex lock failed`); the event loop drains instead.
} catch (error) {
  console.error(`u2net: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
