/* eslint-disable no-secrets/no-secrets -- ffmpeg filter and option strings: long and dense, never a secret */
import { join } from "node:path";
import {
  type Edit,
  EXPORT_FPS,
  ISSEBYA_PRESET,
  type Transcript,
  clipFrames,
  maskPath,
  maskSpans,
} from "@edit-issebya/edit";
import type { MediaFacts, RenderMode } from "./render-route.ts";

// The composite export's ffmpeg side (app_docs/export.md): the probe, the sound
// cut, the optional JPEG pass over the footage, and the one pass that blends
// footage, behind layer, person and front layer and encodes. Every argument
// list is a pure function of its inputs.
//
// The blend is the builder's cut-out composite a second time. The page
// (packages/edit's build.ts) does it with CSS: the inverted mask multiplied
// over footage and words, plus the footage times the mask. Here, per pixel:
//   out = (footage with the behind layer over it) x (1 - mask) + footage x mask
// and the front layer over that. A change to one must change the other.

const FPS = EXPORT_FPS;

// HyperFrames writes a PNG sequence as `frame_000001.png`, `frame_000002.png`, ...
const LAYER_FRAMES = "frame_%06d.png";
const LAYER_FIRST_FRAME = 1;

// HyperFrames' sound is AAC at 48 kHz, 1024 samples a packet.
const AAC_RATE = 48_000;
const AAC_PACKET = 1024;

// Seconds between two progress reports of an ffmpeg pass.
const PROGRESS_EVERY_S = 2;

// The single call's own x264 settings (HyperFrames 0.8.222, `--quality
// delivery`, SDR), so the composite's file is encoded the same way.
const X264 = [
  "-c:v",
  "libx264",
  "-preset",
  "fast",
  "-crf",
  "15",
  "-pix_fmt",
  "yuv420p",
  "-bf",
  "0",
  "-threads",
  "8",
  "-x264-params",
  "aq-mode=3:aq-strength=0.8:deblock=1,1:colorprim=bt709:transfer=bt709:colormatrix=bt709",
  "-colorspace",
  "bt709",
  "-color_primaries",
  "bt709",
  "-color_trc",
  "bt709",
  "-color_range",
  "tv",
  "-r",
  String(FPS),
] as const;

interface RawStream {
  codec_type?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  color_range?: string;
  nb_frames?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  disposition?: { attached_pic?: number };
}

// The facts of a file from ffprobe's JSON (`probeArgs` of pipeline/probe.ts).
// An unknown colour range is `tv`, as ffmpeg takes it.
export function parseMediaFacts(json: string): MediaFacts {
  const streams = (JSON.parse(json) as { streams?: RawStream[] }).streams ?? [];
  const video = streams.find(
    (stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1,
  );
  if (!video) throw new Error("render: no video stream");
  return {
    width: video.width ?? 0,
    height: video.height ?? 0,
    rate: video.r_frame_rate ?? "0/0",
    avgRate: video.avg_frame_rate ?? "0/0",
    frames: Number(video.nb_frames ?? Number.NaN),
    range: video.color_range === "pc" ? "pc" : "tv",
    pixFmt: video.pix_fmt ?? "unknown",
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
  };
}

// One cut-out span with its mask's file: the builder's own spans (`maskSpans`)
// and the mask it picks for each, so the composite and the page always agree.
export interface CutoutSpan {
  start: number;
  end: number;
  // The mask's path in a project (`maskPath`), the key of the render's files.
  path: string;
}

export function cutoutSpans(edit: Edit, transcript: Transcript): CutoutSpan[] {
  return maskSpans(edit, transcript, ISSEBYA_PRESET).map((span) => {
    const mask = (edit.inputs.masks ?? []).find(
      (entry) =>
        Math.abs(entry.start - span.start) < 0.0005 && Math.abs(entry.end - span.end) < 0.0005,
    );
    if (!mask) throw new Error(`render: behind item ${span.items[0]} has no cut-out`);
    return { start: span.start, end: span.end, path: maskPath(mask) };
  });
}

// The concat demuxer's list of the masks, in span order. One input for all of
// them: they decode one after the other, so ffmpeg never holds every mask's
// frames in memory waiting for its turn.
export function maskListText(files: readonly string[]): string {
  return files.map((file) => `file '${file.replaceAll("'", "'\\''")}'\n`).join("");
}

// The footage as the single call draws it: HyperFrames' own extraction chain
// (a bt601 full-range JPEG of every frame, quality 95), into one Motion JPEG
// file. `match` mode only.
export function footageJpegArgs({ footage, output }: { footage: string; output: string }) {
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-loglevel",
    "error",
    "-nostats",
    "-progress",
    "pipe:1",
    "-stats_period",
    String(PROGRESS_EVERY_S),
    "-i",
    footage,
    "-an",
    "-vf",
    [
      "setparams=color_primaries=bt709:color_trc=iec61966-2-1",
      "scale=flags=neighbor+accurate_rnd",
      "format=gbrp",
      "scale=out_color_matrix=bt601:out_range=pc:flags=neighbor",
      "format=yuv420p",
    ].join(","),
    "-c:v",
    "mjpeg",
    "-q:v",
    "2",
    output,
  ];
}

// How many AAC packets the single call's export holds for a reel of `frames`
// frames: HyperFrames pads its mix to `frames / fps` seconds and keeps
// `ceil(samples / 1024) + 1` packets.
export function soundPackets(frames: number): number {
  return Math.ceil(Math.round((frames / FPS) * AAC_RATE) / AAC_PACKET) + 1;
}

// The sound page's AAC cut to the single call's exact packets, by stream copy.
// The page is rendered at 1 fps, so HyperFrames pads its mix to a whole second:
// longer than the reel, but its first packets are the same bytes. Keep
// `soundPackets` of them and shorten the last with HyperFrames' own `setts`
// expression. Never cut by time (`-t`): that drops packets by timestamp and
// cannot shorten the last one.
export function soundCutArgs({
  input,
  output,
  frames,
}: {
  input: string;
  output: string;
  frames: number;
}): string[] {
  const target = frames / FPS;
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-loglevel",
    "error",
    "-i",
    input,
    "-map",
    "0:a:0",
    "-c",
    "copy",
    "-frames:a",
    String(soundPackets(frames)),
    "-bsf:a",
    `setts=duration='if(gte((PTS+DURATION)*TB,${target}),round(${target}/TB-PTS),DURATION)'`,
    output,
  ];
}

export interface CompositeInput {
  mode: RenderMode;
  // The reel's length in seconds and in frames (`reelFrames`).
  duration: number;
  frames: number;
  // The export's frame size.
  width: number;
  height: number;
  // The footage: the file itself (`clean`), or its Motion JPEG copy (`match`,
  // `footageJpegArgs`); the facts are the footage file's own either way.
  footage: string;
  footageFacts: MediaFacts;
  // The cut-out spans in order, each with its mask's facts; with any, the
  // behind layer's frames and the masks' concat list are given too.
  spans: readonly { start: number; end: number; facts: MediaFacts }[];
  maskList?: string;
  behindFrames?: string;
  // The front layer's PNG folder and the cut sound.
  frontFrames: string;
  sound: string;
  output: string;
}

const between = (first: number, last: number, n = "n") => `between(${n},${first},${last})`;

// A layer's PNG frames to the blend's format: bt709 limited range, with alpha.
const LAYER_CHAIN =
  "scale=out_color_matrix=bt709:out_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,format=yuva420p,setsar=1";

// The composite's filter graph, one chain per entry, and the input each chain
// reads by number.
export function compositeGraph(input: CompositeInput): { inputs: string[][]; graph: string[] } {
  const { mode, duration, frames, width, height, footageFacts: src, spans } = input;
  const hasCutout = spans.length > 0;
  if (hasCutout && (!input.maskList || !input.behindFrames)) {
    throw new Error("render: cut-out spans need the behind layer and the masks");
  }
  const inputs: string[][] = [];
  const add = (...args: string[]) => inputs.push(args) - 1;
  const layer = (dir: string) =>
    add(
      "-framerate",
      String(FPS),
      "-start_number",
      String(LAYER_FIRST_FRAME),
      "-i",
      join(dir, LAYER_FRAMES),
    );
  const iFootage = add("-i", input.footage);
  const iBehind = hasCutout ? layer(input.behindFrames!) : -1;
  const iFront = layer(input.frontFrames);
  const iMask = hasCutout ? add("-f", "concat", "-safe", "0", "-i", input.maskList!) : -1;
  add("-i", input.sound);

  // The frames HyperFrames shows (packages/edit's span-frames.ts). The footage
  // clip starts at 0, so its frame n is output frame n. It shows only the
  // frames it extracts and holds the last one; inside a cut-out span the
  // span's own footage copy does the same, so the frame a span never extracts
  // is dropped and the frame before it fills its place (the `fps` filter
  // repeats it).
  const main = clipFrames({ start: 0, end: duration }, frames);
  const cuts = spans.map((span) => clipFrames(span, frames));
  const kept = Math.min(main.extracted, src.frames);
  const held = cuts.flatMap((cut) => cut.held).filter((frame) => frame < kept);
  const select =
    `lt(n,${kept})` +
    (held.length > 0 ? `*not(${held.map((frame) => `eq(n,${frame})`).join("+")})` : "");
  const needScale = src.width !== width || src.height !== height;
  const size = needScale ? [`${width}:${height}`] : [];
  const footage = [`select='${select}'`, `fps=${FPS}`];
  if (mode === "match") {
    // The Motion JPEG copy is bt601 full range. The single call goes JPEG to
    // RGB (the browser) to bt709: the same two steps.
    footage.push(
      "scale=in_color_matrix=bt601:in_range=pc:flags=neighbor+accurate_rnd",
      "format=gbrp",
      `scale=${[...size, "out_color_matrix=bt709", "out_range=tv", `flags=${needScale ? "bicubic" : "neighbor"}`].join(":")}`,
    );
  } else if (needScale || src.range !== "tv") {
    footage.push(
      `scale=${[...size, `in_range=${src.range}`, "out_range=tv", "flags=bicubic"].join(":")}`,
    );
  }
  footage.push(
    "format=yuv420p",
    `tpad=stop_mode=clone:stop=${frames}`,
    `trim=end_frame=${frames}`,
    "setsar=1",
  );
  const graph = [`[${iFootage}:v]${footage.join(",")}${hasCutout ? ",split=2[Fa][Fb]" : "[Fa]"}`];

  let base = "Fa";
  if (hasCutout) {
    const inSpans = cuts.map((cut) => between(cut.first, cut.last)).join("+");
    graph.push(`[${iBehind}:v]${LAYER_CHAIN}[Bv]`);
    graph.push(`[Fa][Bv]overlay=format=yuv420:eof_action=pass:enable='${inSpans}'[G]`);
    // One mask track from the one mask input. Mask k's frame j goes to output
    // frame `first of span k` + j. Frames past what HyperFrames extracts, or
    // past the span, are dropped, and the `fps` filter repeats the last kept
    // frame over the hole: the hold HyperFrames does. Outside the spans the
    // track is never used.
    const first = spans[0]!.facts;
    const drops: string[] = [];
    const moves: string[] = [];
    let read = 0;
    let keptSoFar = 0;
    for (const [index, cut] of cuts.entries()) {
      const count = spans[index]!.facts.frames;
      const usable = Math.min(count, cut.count, cut.extracted);
      if (usable < count) drops.push(between(read + usable, read + count - 1));
      moves.push(`${between(keptSoFar, keptSoFar + usable - 1, "N")}*${cut.first - keptSoFar}`);
      read += count;
      keptSoFar += usable;
    }
    const maskSize = first.width !== width || first.height !== height ? [`${width}:${height}`] : [];
    const mask = [
      ...(drops.length > 0 ? [`select='not(${drops.join("+")})'`] : []),
      `setpts='(N+${moves.join("+")})/(${FPS}*TB)'`,
      `scale=${[...maskSize, `in_range=${first.range}`, "out_range=pc", "flags=bicubic"].join(":")}`,
      "format=gray",
      `fps=${FPS}:start_time=0`,
      `tpad=stop_mode=clone:stop=${frames}`,
      `trim=end_frame=${frames}`,
      "setsar=1",
    ];
    graph.push(`[${iMask}:v]${mask.join(",")}[M]`);
    // The person: the footage with the mask as its alpha, over footage and words.
    graph.push("[Fb][M]alphamerge[FM]");
    graph.push(`[G][FM]overlay=format=yuv420:eof_action=pass:enable='${inSpans}'[C]`);
    base = "C";
  }
  graph.push(`[${iFront}:v]${LAYER_CHAIN}[Fv]`);
  graph.push(`[${base}][Fv]overlay=format=yuv420:eof_action=pass[D]`);
  graph.push("[D]format=yuv420p[V]");
  return { inputs, graph };
}

// `ffmpeg`'s arguments for the composite, exactly: every input decoded once,
// the blend, the single call's x264 settings, the cut sound copied in.
export function compositeArgs(input: CompositeInput): string[] {
  const { inputs, graph } = compositeGraph(input);
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-loglevel",
    "error",
    "-nostats",
    "-progress",
    "pipe:1",
    "-stats_period",
    String(PROGRESS_EVERY_S),
    ...inputs.flat(),
    "-filter_complex",
    graph.join(";"),
    "-map",
    "[V]",
    "-map",
    `${inputs.length - 1}:a:0`,
    "-frames:v",
    String(input.frames),
    ...X264,
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    input.output,
  ];
}
