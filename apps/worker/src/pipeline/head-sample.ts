// Where the speaker's head is in one cut-out frame: a port of the old
// `head_track.py`. Pure: frames come in as RGBA bytes at the analysis size.
import type { HeadSample, HeadTrack } from "@edit-issebya/edit";

// One sample in 1080x1920 pixels (the head's top row, its centre column and
// its width): one definition, in @edit-issebya/edit, shared with the builder.
export type { HeadSample };

export const HEAD_TRACK_SETTINGS = {
  analysisWidth: 270,
  analysisHeight: 480,
  // Analysis pixels to 1080x1920 output pixels.
  scale: 4,
  samplesPerSecond: 4,
  alphaThreshold: 128,
  minRowPixels: 4,
  bandStart: 20,
  bandEnd: 50,
  // The old filter's bounds were one room's (an arch merged into the head):
  // off by default, each a number to turn it on.
  bounds: {
    minHeadTop: null as number | null,
    minHeadWidth: null as number | null,
    maxHeadWidth: null as number | null,
  },
};

export type HeadTrackSettings = typeof HEAD_TRACK_SETTINGS;

export function frameBytes(settings: HeadTrackSettings): number {
  return settings.analysisWidth * settings.analysisHeight * 4;
}

// The first and last opaque column of a row, or null when it has fewer than
// `min` opaque columns.
function rowSpan(
  frame: Uint8Array,
  y: number,
  settings: HeadTrackSettings,
  min: number,
): [number, number] | null {
  const width = settings.analysisWidth;
  let first = -1;
  let last = -1;
  let count = 0;
  for (let x = 0; x < width; x += 1) {
    if (frame[(y * width + x) * 4 + 3]! > settings.alphaThreshold) {
      if (first < 0) first = x;
      last = x;
      count += 1;
    }
  }
  return count > 0 && count >= min ? [first, last] : null;
}

function outOfBounds(sample: HeadSample, bounds: HeadTrackSettings["bounds"]): boolean {
  if (bounds.minHeadTop !== null && sample.head_top < bounds.minHeadTop) return true;
  if (bounds.minHeadWidth !== null && sample.head_w < bounds.minHeadWidth) return true;
  if (bounds.maxHeadWidth !== null && sample.head_w > bounds.maxHeadWidth) return true;
  return false;
}

// The head top is the first row with at least `minRowPixels` opaque columns;
// the head's span is the median-width span of the rows from `bandStart` to
// `bandEnd` below it. Null when there is no head (or a bound rejects it).
export function headSample(
  frame: Uint8Array,
  index: number,
  settings: HeadTrackSettings,
): HeadSample | null {
  if (frame.length !== frameBytes(settings)) {
    throw new Error(
      `head sample: frame of ${frame.length} bytes, expected ${frameBytes(settings)}`,
    );
  }
  const height = settings.analysisHeight;
  let top = -1;
  for (let y = 0; y < height; y += 1) {
    if (rowSpan(frame, y, settings, settings.minRowPixels)) {
      top = y;
      break;
    }
  }
  if (top < 0) return null;

  const spans: [number, number][] = [];
  const end = Math.min(height, top + settings.bandEnd);
  for (let y = top + settings.bandStart; y < end; y += 1) {
    const span = rowSpan(frame, y, settings, 1);
    if (span) spans.push(span);
  }
  if (spans.length === 0) return null;
  // Array.prototype.sort is stable, like Python's sorted().
  spans.sort((a, b) => a[1] - a[0] - (b[1] - b[0]));
  const [x0, x1] = spans[Math.floor(spans.length / 2)]!;

  const sample: HeadSample = {
    t: Math.round((index / settings.samplesPerSecond) * 100) / 100,
    head_top: top * settings.scale,
    cx: Math.floor((x0 + x1) / 2) * settings.scale,
    head_w: (x1 - x0) * settings.scale,
  };
  return outOfBounds(sample, settings.bounds) ? null : sample;
}

export function trackHead(frames: Iterable<Uint8Array>, settings: HeadTrackSettings): HeadTrack {
  const track: HeadTrack = [];
  let index = 0;
  for (const frame of frames) {
    track.push(headSample(frame, index, settings));
    index += 1;
  }
  return track;
}
