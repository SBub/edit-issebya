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
  // How many of its own frames HyperFrames extracts: from its first output
  // frame's time to its end, `round((end - first / fps) x fps)`.
  extracted: number;
  // The output frames on which the clip has no frame of its own left and
  // repeats its last extracted one.
  held: number[];
}

// A clip on screen from `start` to `end` (seconds) in a reel of `total` frames:
// it is on output frames `ceil(start x fps)` to `ceil(end x fps) - 1`.
// HyperFrames first moves a start that falls between two frames forward to the
// next frame (`alignClipStartToFirstOutputFrame`: the clip's media start moves
// with it, its end stays), so the clip shows its own frame `frame - first` on
// each output frame and extracts only `round((end - first / fps) x fps)`
// frames, measured from that frame, not from the written start. When it is on
// screen for one frame more than it extracts it holds its last extracted
// frame: a span of 16.033 to 17.767 s is on 53 frames and extracts 52; one of
// 0.867 to 2.367 s starts on frame 27 (0.9 s), is on 45 frames (27 to 71) and
// extracts round(1.467 x 30) = 44, so frame 71 repeats frame 70.
export function clipFrames(
  { start, end }: { start: number; end: number },
  total: number,
  fps = EXPORT_FPS,
): ClipFrames {
  const startFrame = Math.ceil(start * fps - EDGE);
  const first = Math.max(0, startFrame);
  const last = Math.min(Math.ceil(end * fps - EDGE) - 1, total - 1);
  const extracted = Math.max(1, Math.round((end - startFrame / fps) * fps));
  const media = (frame: number) => frame - startFrame;
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
