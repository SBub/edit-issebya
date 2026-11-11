// The cut-out's mask tool: the person matte of one span of a footage file,
// made by MODNet (portrait matting, ONNX Runtime on the CPU), run by the
// worker's Node as one tool call of the `cutout` step.
//
//   modnet-entry --input <mp4> --start <s> --end <s> --output <mp4>
//                --crop-top <px> --threads <n> --model <onnx>
//                --ffmpeg <path> --ffprobe <path>
//
// Checks the model against its pinned SHA-256, then streams: ffmpeg decodes
// the span's frames to RGB at the working size, without the rows above the
// crop (`--crop-top`, in the head track's 1920-high pixels; 0 is the whole
// frame), each frame goes through the model, its matte through a 3-frame
// temporal median, and a second ffmpeg scales the mattes back to their rows of
// the footage, fills the rows above them black and writes grayscale H.264
// (white = person). Frame i of the mask is the footage frame at start + i / fps.
// The model runs on `--threads` intra-op threads (the step shares the CPUs
// out between the spans it runs at once; the two ffmpegs keep their own). At most three mattes are held at a time. Written to <output>.part, renamed
// to <output> once finished. One `@hf-progress {"index","total","pct"}` line
// per frame on stdout; any failure exits non-zero with one `modnet: ...` line.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { rename, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { InferenceSession, Tensor } from "onnxruntime-node";
import {
  MATTE_SETTINGS,
  TemporalMedian,
  decodeArgs,
  encodeArgs,
  matteRegion,
  matteToGray,
  modelInput,
  parseFrameRate,
  spanFrames,
} from "./matte.ts";
import { verifyModel } from "./modnet-model.ts";

const run = promisify(execFile);

interface Options {
  input: string;
  start: number;
  end: number;
  output: string;
  cropTop: number;
  threads: number;
  model: string;
  ffmpeg: string;
  ffprobe: string;
}

const NAMES = [
  "--input",
  "--start",
  "--end",
  "--output",
  "--crop-top",
  "--threads",
  "--model",
  "--ffmpeg",
  "--ffprobe",
];

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
  const start = Number(flags.get("--start"));
  const end = Number(flags.get("--end"));
  if (!Number.isFinite(start) || start < 0) throw new Error(`bad --start ${flags.get("--start")}`);
  if (!Number.isFinite(end) || end <= start) throw new Error("--end must be after --start");
  const cropTop = Number(flags.get("--crop-top"));
  if (!Number.isInteger(cropTop) || cropTop < 0) {
    throw new Error(`bad --crop-top ${flags.get("--crop-top")}`);
  }
  const threads = Number(flags.get("--threads"));
  if (!Number.isInteger(threads) || threads < 1) {
    throw new Error(`bad --threads ${flags.get("--threads")}`);
  }
  return {
    input: flags.get("--input")!,
    start,
    end,
    output: flags.get("--output")!,
    cropTop,
    threads,
    model: flags.get("--model")!,
    ffmpeg: flags.get("--ffmpeg")!,
    ffprobe: flags.get("--ffprobe")!,
  };
}

async function probe(
  ffprobe: string,
  input: string,
): Promise<{ width: number; height: number; rate: string; fps: number }> {
  const { stdout } = await run(ffprobe, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,r_frame_rate",
    "-of",
    "json",
    input,
  ]);
  const stream = (
    JSON.parse(stdout) as { streams?: { width?: number; height?: number; r_frame_rate?: string }[] }
  ).streams?.[0];
  const { width = 0, height = 0, r_frame_rate: rate = "" } = stream ?? {};
  if (!stream) throw new Error(`no video track in ${input}`);
  if (!(width > 0 && height > 0)) throw new Error(`bad video size ${width}x${height}`);
  const fps = parseFrameRate(rate);
  if (fps === null) throw new Error(`bad frame rate ${rate}`);
  return { width, height, rate, fps };
}

// A child's stderr, kept for the failure line.
function stderrOf(child: ChildProcess): () => string {
  let text = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    text = (text + chunk.toString("utf8")).slice(-4096);
  });
  return () => text.trim().split("\n").at(-1) ?? "";
}

function exited(child: ChildProcess): Promise<number | null> {
  return once(child, "close").then(([code]) => code as number | null);
}

async function makeMask(options: Options): Promise<void> {
  await verifyModel(options.model);
  const footage = await probe(options.ffprobe, options.input);
  const region = matteRegion(footage.width, footage.height, options.cropTop);
  const { matte } = region;
  const total = spanFrames(options.start, options.end, footage.fps);
  const session = await InferenceSession.create(options.model, {
    executionProviders: [MATTE_SETTINGS.provider],
    // One frame at a time on this many threads; nothing runs between operators.
    intraOpNumThreads: options.threads,
    interOpNumThreads: 1,
  });
  const [inputName] = session.inputNames;
  const [outputName] = session.outputNames;
  if (!inputName || !outputName) throw new Error("the model has no input or output");

  const part = `${options.output}.part`;
  await rm(part, { force: true });
  const decoder = spawn(
    options.ffmpeg,
    decodeArgs({
      input: options.input,
      start: options.start,
      frames: total,
      fps: footage.fps,
      ...matte,
      region,
    }),
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const encoder = spawn(
    options.ffmpeg,
    encodeArgs({
      output: part,
      rate: footage.rate,
      matte,
      footage,
      region,
    }),
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  const decoderError = stderrOf(decoder);
  const encoderError = stderrOf(encoder);
  const decoded = exited(decoder);
  const encoded = exited(encoder);
  let encoderGone = false;
  void encoded.then(() => {
    encoderGone = true;
  });
  // A write after the encoder died fails here, not as an uncaught error.
  encoder.stdin!.on("error", () => {});

  const write = async (gray: Uint8Array) => {
    if (encoderGone) throw new Error(`mask encoding failed: ${encoderError()}`);
    if (!encoder.stdin!.write(gray)) await once(encoder.stdin!, "drain");
  };

  try {
    const frameBytes = matte.width * matte.height * 3;
    const frame = Buffer.alloc(frameBytes);
    const input = new Float32Array(frameBytes);
    const smoother = new TemporalMedian();
    let filled = 0;
    let index = 0;
    const infer = async () => {
      modelInput(frame, matte.width, matte.height, input);
      const tensor = new Tensor("float32", input, [1, 3, matte.height, matte.width]);
      const result = await session.run({ [inputName]: tensor });
      const gray = matteToGray(result[outputName]!.data as Float32Array);
      const smoothed = smoother.push(gray);
      if (smoothed) await write(smoothed);
      index += 1;
      const pct = Math.floor((100 * index) / total);
      console.log(`@hf-progress ${JSON.stringify({ index, total, pct })}`);
    };
    for await (const chunk of decoder.stdout!) {
      let offset = 0;
      const bytes = chunk as Buffer;
      while (offset < bytes.length) {
        const take = Math.min(frameBytes - filled, bytes.length - offset);
        bytes.copy(frame, filled, offset, offset + take);
        filled += take;
        offset += take;
        if (filled === frameBytes) {
          filled = 0;
          await infer();
        }
      }
    }
    if ((await decoded) !== 0) throw new Error(`decoding failed: ${decoderError()}`);
    if (index === 0) throw new Error(`no frames between ${options.start} and ${options.end}`);
    const last = smoother.flush();
    if (last) await write(last);
    encoder.stdin!.end();
    if ((await encoded) !== 0) throw new Error(`mask encoding failed: ${encoderError()}`);
    await session.release();
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the step's own scratch files
    await rename(part, options.output);
  } catch (error) {
    decoder.kill("SIGKILL");
    encoder.kill("SIGKILL");
    await Promise.all([decoded, encoded]);
    await rm(part, { force: true });
    throw error;
  }
}

try {
  await makeMask(parseOptions(process.argv.slice(2)));
  // No process.exit: exiting with onnxruntime's threads still up aborts the
  // process (`mutex lock failed`); the event loop drains instead.
} catch (error) {
  console.error(`modnet: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
