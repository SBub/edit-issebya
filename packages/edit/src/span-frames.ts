// Which output frames a timed clip is on, and which of its own frames it shows
// there: HyperFrames' rules (0.8.222), measured against its own export. The
// composite export (app_docs/export.md) follows them so its frames are the
// single-call export's frames. A HyperFrames update may change them: the
// worker's tools test compares the two exports frame by frame.

// The export's frame rate.
export const EXPORT_FPS = 30;

// A clip's start and end are written to the page in milliseconds, so a frame
// boundary (481 / 30 = 16.0333...) lands a hair before or after the frame.
const EDGE = 1e-3;

// The frames of a reel: every started frame counts.
export function reelFrames(duration: number, fps = EXPORT_FPS): number {
  return Math.ceil(duration * fps - 1e-6);
}

export interface ClipFrames {
  // The first and last output frame the clip is on (0-based, inclusive).
  first: number;
  last: number;
  // How many output frames that is.
  count: number;
  // How many of its own frames HyperFrames extracts: `round(duration x fps)`.
  extracted: number;
  // The output frames on which the clip has no frame of its own left and
  // repeats its last extracted one.
  held: number[];
}

// A clip on screen from `start` to `end` (seconds) in a reel of `total` frames:
// it is on output frames `ceil(start x fps)` to `ceil(end x fps) - 1`, shows its
// own frame `floor((frame / fps - start) x fps)` on each, and extracts only
// `round((end - start) x fps)` frames. When it is on screen for one frame more
// than it extracts (a span of 1.734 s is on 53 frames and extracts 52), it
// holds its last extracted frame.
export function clipFrames(
  { start, end }: { start: number; end: number },
  total: number,
  fps = EXPORT_FPS,
): ClipFrames {
  const first = Math.max(0, Math.ceil(start * fps - EDGE));
  const last = Math.min(Math.ceil(end * fps - EDGE) - 1, total - 1);
  const extracted = Math.max(1, Math.round((end - start) * fps));
  const media = (frame: number) => Math.floor((frame / fps - start + 1e-5) * fps);
  const held: number[] = [];
  for (let frame = first; frame <= last; frame += 1) {
    if (media(frame) >= extracted) held.push(frame);
  }
  return {
    first,
    last,
    count: Math.max(0, last - first + 1),
    extracted,
    held,
  };
}
