import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineStep } from "./definition.ts";

const PREVIEW_VERSION = 1;

// Small copies for the studio's live preview (D5), built for Chrome: about
// 2.7 Mbit/s together, so about 17 to 18 MB for a 50 s reel. Same frame
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
  subject: {
    videoCodec: "libvpx-vp9",
    videoBitrate: "1400k",
    pixelFormat: "yuva420p",
    deadline: "good",
    cpuUsed: 4,
  },
};

export type PreviewSettings = typeof PREVIEW_SETTINGS;

// The kept outputs; the worker records them on the reel for the studio.
export const FOOTAGE_PREVIEW_FILE = "footage-preview.mp4";
export const SUBJECT_PREVIEW_FILE = "subject-preview.webm";
const FOOTAGE = FOOTAGE_PREVIEW_FILE;
const SUBJECT = SUBJECT_PREVIEW_FILE;
const FOOTAGE_PARTIAL = "footage-preview.part.mp4";
const SUBJECT_PARTIAL = "subject-preview.part.webm";

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

// The cut-out as a small VP9 WebM, alpha kept: the `libvpx-vp9` decoder before
// `-i` reads the alpha in, and VP9 alpha needs `-auto-alt-ref 0`.
export function subjectPreviewArgs(
  input: string,
  output: string,
  settings: PreviewSettings,
): string[] {
  const s = settings.subject;
  return [
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-c:v",
    "libvpx-vp9",
    "-i",
    input,
    "-an",
    "-vf",
    `scale=${settings.width}:${settings.height},format=${s.pixelFormat}`,
    "-fps_mode",
    "passthrough",
    "-c:v",
    s.videoCodec,
    "-pix_fmt",
    s.pixelFormat,
    "-b:v",
    s.videoBitrate,
    "-deadline",
    s.deadline,
    "-cpu-used",
    String(s.cpuUsed),
    "-row-mt",
    "1",
    "-auto-alt-ref",
    "0",
    "-g",
    gop(settings),
    "-metadata:s:v:0",
    "alpha_mode=1",
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
    { file: SUBJECT, retention: "kept" },
  ],
  reusedWhat: "preview copies made",
  inputs: (_source, fingerprints) => [
    {
      ref: { step: "retime", fingerprint: fingerprints.retime!, file: "source.mp4" },
      as: "source.mp4",
    },
    {
      ref: {
        step: "remove_background",
        fingerprint: fingerprints.remove_background!,
        file: "subject.webm",
      },
      as: "subject.webm",
    },
  ],
  async run({ tool, tools, dir, files, settings }) {
    const footage = join(dir, FOOTAGE_PARTIAL);
    await tool({
      file: tools.ffmpeg,
      args: footagePreviewArgs(files["source.mp4"]!, footage, settings),
    });
    const subject = join(dir, SUBJECT_PARTIAL);
    await tool({
      file: tools.ffmpeg,
      args: subjectPreviewArgs(files["subject.webm"]!, subject, settings),
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    await rename(footage, join(dir, FOOTAGE));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    await rename(subject, join(dir, SUBJECT));
    return { what: "preview copies made" };
  },
};
