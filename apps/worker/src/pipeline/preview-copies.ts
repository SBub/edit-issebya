import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineStep } from "./definition.ts";

// 2: the footage copy only (no cut-out copy since the cut-out left the pipeline).
// 3: also a thumbnail and a frames sprite.
const PREVIEW_VERSION = 3;

// The studio's frames sprite: one row of small frames, one every two
// seconds (32 cover 64 s; a longer reel's later frames are simply absent).
export const FOOTAGE_FRAMES = { everySeconds: 2, columns: 32, width: 90, height: 160 };

// A small copy of the footage for the studio's live preview (D5), built for
// Chrome: about 1.3 Mbit/s, so about 8 MB for a 50 s reel. Same frame
// timing as the source, a keyframe every second for seeking.
export const PREVIEW_SETTINGS = {
  width: 540,
  height: 960,
  keyframeSeconds: 1,
  fps: 30,
  footage: {
    videoCodec: "libx264",
    preset: "medium",
    videoBitrate: "1200k",
    maxrate: "1500k",
    bufsize: "3000k",
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioBitrate: "128k",
    faststart: true,
  },
  // The reels grid's tile: one representative frame.
  thumbnail: { width: 270, height: 480, quality: 4 },
  // The tracks timeline's footage strip.
  frames: { ...FOOTAGE_FRAMES, quality: 5 },
};

export type PreviewSettings = typeof PREVIEW_SETTINGS;

// The kept output; the worker records it on the reel for the studio.
export const FOOTAGE_PREVIEW_FILE = "footage-preview.mp4";
const FOOTAGE = FOOTAGE_PREVIEW_FILE;
const FOOTAGE_PARTIAL = "footage-preview.part.mp4";
// The two kept images, from the same retimed footage, so frame times equal
// preview times.
export const THUMBNAIL_FILE = "thumbnail.jpg";
export const FRAMES_FILE = "frames.jpg";
const THUMBNAIL_PARTIAL = "thumbnail.part.jpg";
const FRAMES_PARTIAL = "frames.part.jpg";

function gop(settings: PreviewSettings): string {
  return String(settings.fps * settings.keyframeSeconds);
}

// The retimed footage as a small H.264 MP4.
export function footagePreviewArgs(
  input: string,
  output: string,
  settings: PreviewSettings,
): string[] {
  const s = settings.footage;
  return [
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-i",
    input,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    `scale=${settings.width}:${settings.height}`,
    "-fps_mode",
    "passthrough",
    "-c:v",
    s.videoCodec,
    "-preset",
    s.preset,
    "-b:v",
    s.videoBitrate,
    "-maxrate",
    s.maxrate,
    "-bufsize",
    s.bufsize,
    "-pix_fmt",
    s.pixelFormat,
    "-g",
    gop(settings),
    "-keyint_min",
    gop(settings),
    "-sc_threshold",
    "0",
    "-c:a",
    s.audioCodec,
    "-b:a",
    s.audioBitrate,
    ...(s.faststart ? ["-movflags", "+faststart"] : []),
    output,
  ];
}

// One JPEG: the most representative of the first 30 frames, at tile size.
export function thumbnailArgs(input: string, output: string, settings: PreviewSettings): string[] {
  const t = settings.thumbnail;
  return [
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-i",
    input,
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    `thumbnail=30,scale=${t.width}:${t.height}`,
    "-frames:v",
    "1",
    "-q:v",
    String(t.quality),
    output,
  ];
}

// One JPEG: a single row of small frames, one every `everySeconds`.
export function framesArgs(input: string, output: string, settings: PreviewSettings): string[] {
  const f = settings.frames;
  return [
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-i",
    input,
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    `fps=1/${f.everySeconds},scale=${f.width}:${f.height},tile=${f.columns}x1`,
    "-frames:v",
    "1",
    "-q:v",
    String(f.quality),
    output,
  ];
}

export const previewCopies: PipelineStep<PreviewSettings> = {
  name: "preview_copies",
  version: PREVIEW_VERSION,
  settings: PREVIEW_SETTINGS,
  reelStatus: "making_previews",
  outputs: [
    { file: FOOTAGE, retention: "kept" },
    { file: THUMBNAIL_FILE, retention: "kept" },
    { file: FRAMES_FILE, retention: "kept" },
  ],
  reusedWhat: "preview copies made",
  inputs: (_source, fingerprints) => [
    {
      ref: { step: "retime", fingerprint: fingerprints.retime!, file: "source.mp4" },
      as: "source.mp4",
    },
  ],
  async run({ tool, tools, dir, files, settings }) {
    const source = files["source.mp4"]!;
    const made: [string, string, typeof footagePreviewArgs][] = [
      [FOOTAGE_PARTIAL, FOOTAGE, footagePreviewArgs],
      [THUMBNAIL_PARTIAL, THUMBNAIL_FILE, thumbnailArgs],
      [FRAMES_PARTIAL, FRAMES_FILE, framesArgs],
    ];
    for (const [partial, file, args] of made) {
      const path = join(dir, partial);
      await tool({ file: tools.ffmpeg, args: args(source, path, settings) });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
      await rename(path, join(dir, file));
    }
    return { what: "preview copies made" };
  },
};
