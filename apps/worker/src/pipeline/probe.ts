// What the fixed steps need to know about a media file, from one ffprobe call.
export interface Probe {
  video: {
    codec: string;
    width: number;
    height: number;
    rFrameRate: string;
    avgFrameRate: string;
    colorTransfer: string | null;
    colorPrimaries: string | null;
    colorSpace: string | null;
    // Degrees the player turns the picture (0, 90, 180 or 270): a phone's
    // portrait clip is often stored landscape with 90 or 270.
    rotation: number;
  };
  audio: { codec: string; sampleRate: number } | null;
  durationSeconds: number;
  // The container, as ffprobe names it (`mov,mp4,m4a,3gp,3g2,mj2`, `image2`).
  formatName: string | null;
}

export function probeArgs(path: string): string[] {
  return ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", path];
}

interface RawStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  color_transfer?: string;
  color_primaries?: string;
  color_space?: string;
  sample_rate?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
  disposition?: { attached_pic?: number };
}

// 0, 90, 180 or 270: the Display Matrix side data wins over the older `rotate`
// tag; anything unreadable is 0.
function rotationOf(stream: RawStream): number {
  const fromSideData = stream.side_data_list?.find(
    (data) => typeof data.rotation === "number",
  )?.rotation;
  const raw = fromSideData ?? Number(stream.tags?.rotate ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return (((Math.round(raw / 90) * 90) % 360) + 360) % 360;
}

// The first video and audio streams of ffprobe's JSON. A file without video or
// without a duration is refused. An attached picture (an audio file's cover
// art) is not video.
export function parseProbe(json: string): Probe {
  const raw = JSON.parse(json) as {
    streams?: RawStream[];
    format?: { duration?: string; format_name?: string };
  };
  const streams = raw.streams ?? [];
  const video = streams.find(
    (stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1,
  );
  if (!video) throw new Error("probe: no video stream");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const durationSeconds = Number(raw.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`probe: no duration (${raw.format?.duration})`);
  }
  return {
    video: {
      codec: video.codec_name ?? "unknown",
      width: video.width ?? 0,
      height: video.height ?? 0,
      rFrameRate: video.r_frame_rate ?? "0/0",
      avgFrameRate: video.avg_frame_rate ?? "0/0",
      colorTransfer: video.color_transfer ?? null,
      colorPrimaries: video.color_primaries ?? null,
      colorSpace: video.color_space ?? null,
      rotation: rotationOf(video),
    },
    audio: audio
      ? { codec: audio.codec_name ?? "unknown", sampleRate: Number(audio.sample_rate) }
      : null,
    durationSeconds,
    formatName: raw.format?.format_name ?? null,
  };
}

const HDR_TRANSFERS = new Set(["smpte2084", "arib-std-b67"]);

// PQ (HDR10, Dolby Vision) or HLG: an iPhone's default HDR video.
export function isHdr(probe: Probe): boolean {
  return HDR_TRANSFERS.has(probe.video.colorTransfer ?? "");
}

// `30000/1001` as a number; null for `0/0` or anything unreadable.
function rate(text: string): number | null {
  const [numerator, denominator] = text.split("/").map(Number);
  if (numerator === undefined || denominator === undefined) return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (numerator <= 0 || denominator <= 0) return null;
  return numerator / denominator;
}

const VFR_TOLERANCE = 0.005;

// The stream's base rate and its average differ by more than 0.5%, or either
// is unknown: the frames are not evenly spaced.
export function isVariableFrameRate(probe: Probe): boolean {
  const base = rate(probe.video.rFrameRate);
  const average = rate(probe.video.avgFrameRate);
  if (base === null || average === null) return true;
  return Math.abs(base - average) / base > VFR_TOLERANCE;
}
