import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineStep } from "./definition.ts";

// 2: the footage copy only (no cut-out copy since the cut-out left the pipeline).
const PREVIEW_VERSION = 2;

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
};

export type PreviewSettings = typeof PREVIEW_SETTINGS;

// The kept output; the worker records it on the reel for the studio.
export const FOOTAGE_PREVIEW_FILE = "footage-preview.mp4";
const FOOTAGE = FOOTAGE_PREVIEW_FILE;
const FOOTAGE_PARTIAL = "footage-preview.part.mp4";

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

export const previewCopies: PipelineStep<PreviewSettings> = {
  name: "preview_copies",
  version: PREVIEW_VERSION,
  settings: PREVIEW_SETTINGS,
  reelStatus: "making_previews",
  outputs: [{ file: FOOTAGE, retention: "kept" }],
  reusedWhat: "preview copies made",
  inputs: (_source, fingerprints) => [
    {
      ref: { step: "retime", fingerprint: fingerprints.retime!, file: "source.mp4" },
      as: "source.mp4",
    },
  ],
  async run({ tool, tools, dir, files, settings }) {
    const footage = join(dir, FOOTAGE_PARTIAL);
    await tool({
      file: tools.ffmpeg,
      args: footagePreviewArgs(files["source.mp4"]!, footage, settings),
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    await rename(footage, join(dir, FOOTAGE));
    return { what: "preview copies made" };
  },
};
