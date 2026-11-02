// The head tracker, pure: one RGBA frame of the cut-out in, one head sample
// out. A port of the old `head_track.py`: the topmost opaque rows are the
// head; its width is the median opaque span in a band below the top.

export interface HeadTrackBounds {
  // A sample whose head top is above this (1080x1920 pixels) is dropped.
  minHeadTop: number | null;
  minHeadWidth: number | null;
  maxHeadWidth: number | null;
}

export interface HeadTrackSettings {
  // The size frames are decoded to for analysis.
  analysisWidth: number;
  analysisHeight: number;
  // The frame width samples are given in (1080x1920 coordinates).
  frameWidth: number;
  // One sample every this many seconds.
  sampleSeconds: number;
  // A pixel is opaque when its alpha is above this.
  alphaThreshold: number;
  // The head's top is the first row with at least this many opaque pixels.
  minOpaquePixels: number;
  // The band below the top (analysis rows) the head width is measured in.
  widthBandStart: number;
  widthBandEnd: number;
  // None by default. The old script's values (380, 220, 420) were for one
  // room, where an arch behind the speaker merged into the head.
  bounds: HeadTrackBounds;
}

export const HEAD_TRACK_SETTINGS: HeadTrackSettings = {
  analysisWidth: 270,
  analysisHeight: 480,
  frameWidth: 1080,
  sampleSeconds: 0.25,
  alphaThreshold: 128,
  minOpaquePixels: 4,
  widthBandStart: 20,
  widthBandEnd: 50,
  bounds: { minHeadTop: null, minHeadWidth: null, maxHeadWidth: null },
};

// One entry of head-track.json; a frame without a head is `null`.
export interface HeadSample {
  t: number;
  head_top: number;
  cx: number;
  head_w: number;
}

export function frameBytes(settings: HeadTrackSettings): number {
  return settings.analysisWidth * settings.analysisHeight * 4;
}

export function headSample(
  rgba: Uint8Array,
  t: number,
  settings: HeadTrackSettings,
): HeadSample | null {
  const w = settings.analysisWidth;
  const h = settings.analysisHeight;
  if (rgba.length !== frameBytes(settings)) {
    throw new Error(
      `head_track: a frame is ${rgba.length} bytes, expected ${frameBytes(settings)}`,
    );
  }
  const scale = settings.frameWidth / w;
  const opaque = (x: number, y: number) => rgba[(y * w + x) * 4 + 3]! > settings.alphaThreshold;
  // The first and last opaque x of a row, and how many are opaque.
  const row = (y: number) => {
    let first = -1;
    let last = -1;
    let count = 0;
    for (let x = 0; x < w; x += 1) {
      if (!opaque(x, y)) continue;
      if (first < 0) first = x;
      last = x;
      count += 1;
    }
    return { first, last, count };
  };

  let top = -1;
  for (let y = 0; y < h; y += 1) {
    if (row(y).count >= settings.minOpaquePixels) {
      top = y;
      break;
    }
  }
  if (top < 0) return null;

  const spans: [number, number][] = [];
  for (
    let y = top + settings.widthBandStart;
    y < Math.min(h, top + settings.widthBandEnd);
    y += 1
  ) {
    const { first, last, count } = row(y);
    if (count > 0) spans.push([first, last]);
  }
  if (spans.length === 0) return null;
  // Stable, like Python's sort.
  spans.sort((a, b) => a[1] - a[0] - (b[1] - b[0]));
  const [x0, x1] = spans[Math.floor(spans.length / 2)]!;
  return {
    t: Math.round(t * 100) / 100,
    head_top: top * scale,
    cx: Math.floor((x0 + x1) / 2) * scale,
    head_w: (x1 - x0) * scale,
  };
}

// A sample outside a set bound becomes `null`; unset bounds drop nothing.
export function withinBounds(
  sample: HeadSample | null,
  bounds: HeadTrackBounds,
): HeadSample | null {
  if (!sample) return null;
  if (bounds.minHeadTop !== null && sample.head_top < bounds.minHeadTop) return null;
  if (bounds.minHeadWidth !== null && sample.head_w < bounds.minHeadWidth) return null;
  if (bounds.maxHeadWidth !== null && sample.head_w > bounds.maxHeadWidth) return null;
  return sample;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// `head tracked, 200 samples, 3 without a head`.
export function headTrackWhat(samples: readonly (HeadSample | null)[]): string {
  const without = samples.filter((sample) => sample === null).length;
  return `head tracked, ${count(samples.length, "sample", "samples")}, ${without} without a head`;
}
