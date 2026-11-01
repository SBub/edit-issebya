// The head's position in the cut-out, from its alpha alone: a port of the old
// head_track.py. The topmost opaque rows are the head; its width is the median
// opaque span in a band below the top.
export const HEAD_TRACK_SETTINGS = {
  analysisWidth: 270,
  analysisHeight: 480,
  sampleFps: 4,
  // Opaque means alpha strictly above this.
  alphaThreshold: 128,
  // The head's top is the first row with at least this many opaque pixels.
  minOpaquePixels: 4,
  // The band (in analysis rows below the top) whose median span is the width.
  bandStartRows: 20,
  bandEndRows: 50,
  // No filtering by default: the old script's bounds (head_top >= 380,
  // 220 <= head_w <= 420) were for one room, where the cut-out merged an arch
  // behind the speaker into the head. In source pixels when set.
  bounds: {
    minHeadTop: null as number | null,
    minHeadWidth: null as number | null,
    maxHeadWidth: null as number | null,
  },
};

export type HeadTrackSettings = typeof HEAD_TRACK_SETTINGS;

// One sample every 1 / sampleFps seconds, in source pixel coordinates; null
// where no head was found.
export type HeadSample = { t: number; head_top: number; cx: number; head_w: number } | null;

export interface HeadTrackOptions extends HeadTrackSettings {
  // Source size divided by analysis size, per axis (4 and 4 for 1080x1920).
  scaleX: number;
  scaleY: number;
}

// One RGBA frame of analysisWidth x analysisHeight.
export function headSample(
  frame: Uint8Array,
  index: number,
  options: HeadTrackOptions,
): HeadSample {
  const width = options.analysisWidth;
  const height = options.analysisHeight;
  if (frame.length !== width * height * 4) {
    throw new Error(
      `head_track: frame ${index} is ${frame.length} bytes, not ${width * height * 4}`,
    );
  }
  const opaque = (x: number, y: number) => frame[(y * width + x) * 4 + 3]! > options.alphaThreshold;

  let top: number | null = null;
  for (let y = 0; y < height && top === null; y += 1) {
    let count = 0;
    for (let x = 0; x < width && count < options.minOpaquePixels; x += 1) {
      if (opaque(x, y)) count += 1;
    }
    if (count >= options.minOpaquePixels) top = y;
  }
  if (top === null) return null;

  const spans: [number, number][] = [];
  const end = Math.min(height, top + options.bandEndRows);
  for (let y = top + options.bandStartRows; y < end; y += 1) {
    let first = -1;
    let last = -1;
    for (let x = 0; x < width; x += 1) {
      if (!opaque(x, y)) continue;
      if (first < 0) first = x;
      last = x;
    }
    if (first >= 0) spans.push([first, last]);
  }
  if (spans.length === 0) return null;
  // Stable, like Python's sort.
  spans.sort((a, b) => a[1] - a[0] - (b[1] - b[0]));
  const [x0, x1] = spans[Math.floor(spans.length / 2)]!;

  const sample = {
    t: Math.round((index / options.sampleFps) * 100) / 100,
    head_top: Math.round(top * options.scaleY),
    cx: Math.round(Math.floor((x0 + x1) / 2) * options.scaleX),
    head_w: Math.round((x1 - x0) * options.scaleX),
  };
  const { minHeadTop, minHeadWidth, maxHeadWidth } = options.bounds;
  if (minHeadTop !== null && sample.head_top < minHeadTop) return null;
  if (minHeadWidth !== null && sample.head_w < minHeadWidth) return null;
  if (maxHeadWidth !== null && sample.head_w > maxHeadWidth) return null;
  return sample;
}

export async function headTrack(
  frames: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  options: HeadTrackOptions,
): Promise<HeadSample[]> {
  const track: HeadSample[] = [];
  for await (const frame of frames) track.push(headSample(frame, track.length, options));
  return track;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

// `head tracked, 197 samples, 3 without a head`.
export function headTrackWhat(track: HeadSample[]): string {
  const missing = track.filter((sample) => sample === null).length;
  return `head tracked, ${plural(track.length, "sample")}, ${missing} without a head`;
}
