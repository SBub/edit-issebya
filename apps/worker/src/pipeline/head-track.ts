// Head tracking from the cut-out's alpha, a port of the old `head_track.py`:
// in each sampled frame the topmost opaque rows are the head. Pure: the frames
// come from ffmpeg (head-track-step.ts).

export interface HeadTrackBounds {
  minHeadTop: number | null;
  minHeadWidth: number | null;
  maxHeadWidth: number | null;
}

export interface HeadTrackSettings {
  // The size ffmpeg scales the cut-out to before reading it.
  analysisWidth: number;
  analysisHeight: number;
  // The frame the samples are given in.
  frameWidth: number;
  frameHeight: number;
  samplesPerSecond: number;
  // A pixel is opaque above this alpha.
  alphaThreshold: number;
  // The head's top is the first row with at least this many opaque pixels.
  minRowPixels: number;
  // The head's width is the median opaque span of these rows below the top.
  bandStart: number;
  bandEnd: number;
  // The decoder that keeps the WebM's alpha.
  decoder: string;
  // Optional sanity filter (in frame pixels): a sample outside is dropped.
  // The old script's room-specific values are not defaults.
  bounds: HeadTrackBounds;
}

export const HEAD_TRACK_SETTINGS: HeadTrackSettings = {
  analysisWidth: 270,
  analysisHeight: 480,
  frameWidth: 1080,
  frameHeight: 1920,
  samplesPerSecond: 4,
  alphaThreshold: 128,
  minRowPixels: 4,
  bandStart: 20,
  bandEnd: 50,
  decoder: "libvpx-vp9",
  bounds: { minHeadTop: null, minHeadWidth: null, maxHeadWidth: null },
};

// One sample: the time, the head's top, its centre and width, in frame pixels;
// null where no head was found.
export type HeadSample = { t: number; head_top: number; cx: number; head_w: number } | null;

function breaksBounds(
  sample: NonNullable<HeadSample>,
  { minHeadTop, minHeadWidth, maxHeadWidth }: HeadTrackBounds,
): boolean {
  return (
    (minHeadTop !== null && sample.head_top < minHeadTop) ||
    (minHeadWidth !== null && sample.head_w < minHeadWidth) ||
    (maxHeadWidth !== null && sample.head_w > maxHeadWidth)
  );
}

// The sample of one RGBA frame of `analysisWidth` x `analysisHeight`.
export function headSample(
  frame: Uint8Array,
  index: number,
  settings: HeadTrackSettings = HEAD_TRACK_SETTINGS,
): HeadSample {
  const { analysisWidth: w, analysisHeight: h, alphaThreshold } = settings;
  if (frame.length !== w * h * 4) {
    throw new Error(`head track: a frame is ${frame.length} bytes, expected ${w * h * 4}`);
  }
  // The first and last opaque x of a row, and how many are opaque.
  const row = (y: number) => {
    let first = -1;
    let last = -1;
    let count = 0;
    for (let x = 0; x < w; x += 1) {
      if (frame[(y * w + x) * 4 + 3]! > alphaThreshold) {
        if (first < 0) first = x;
        last = x;
        count += 1;
      }
    }
    return { first, last, count };
  };

  let top = -1;
  for (let y = 0; y < h; y += 1) {
    if (row(y).count >= settings.minRowPixels) {
      top = y;
      break;
    }
  }
  if (top < 0) return null;

  const spans: [number, number][] = [];
  for (let y = top + settings.bandStart; y < Math.min(h, top + settings.bandEnd); y += 1) {
    const { first, last, count } = row(y);
    if (count > 0) spans.push([first, last]);
  }
  if (spans.length === 0) return null;
  // Stable, like Python's sort.
  spans.sort((a, b) => a[1] - a[0] - (b[1] - b[0]));
  const [x0, x1] = spans[Math.floor(spans.length / 2)]!;

  const sx = settings.frameWidth / w;
  const sy = settings.frameHeight / h;
  const sample = {
    t: Math.round((index / settings.samplesPerSecond) * 100) / 100,
    head_top: top * sy,
    cx: Math.floor((x0 + x1) / 2) * sx,
    head_w: (x1 - x0) * sx,
  };
  return breaksBounds(sample, settings.bounds) ? null : sample;
}

export function trackHead(
  frames: Iterable<Uint8Array>,
  settings: HeadTrackSettings = HEAD_TRACK_SETTINGS,
): HeadSample[] {
  const samples: HeadSample[] = [];
  for (const frame of frames) samples.push(headSample(frame, samples.length, settings));
  return samples;
}

// `head tracked, <n> samples, <m> without a head`.
export function headTrackWhat(samples: readonly HeadSample[]): string {
  const missing = samples.filter((sample) => sample === null).length;
  const count = `${samples.length} ${samples.length === 1 ? "sample" : "samples"}`;
  return `head tracked, ${count}, ${missing} without a head`;
}
