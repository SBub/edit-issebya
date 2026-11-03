import { z } from "zod";

// One entry of head-track.json (one every 0.25 s, 1080x1920 pixels); a frame
// without a head is `null`.
export type HeadSample = { t: number; head_top: number; cx: number; head_w: number } | null;
export type HeadTrack = HeadSample[];

export const headTrackSchema = z.array(
  z.object({ t: z.number(), head_top: z.number(), cx: z.number(), head_w: z.number() }).nullable(),
);

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

// How far the layout keeps text from the head (the old build.py's margins).
export const LAYOUT_PADDING = { left: 35, right: 30 };

// The head over a span, ported from build.py's `face_box`: the samples within
// 0.1 s of the span (all samples with a head when none is), `cx` their median,
// the width their widest, the top their highest; the face is 1.35 head widths
// tall. null when no sample has a head (a clip with no person).
export function faceBox(
  track: HeadTrack,
  t0: number,
  t1: number,
  padding: { left: number; right: number } = LAYOUT_PADDING,
): Box | null {
  const heads = track.filter((sample) => sample !== null);
  if (heads.length === 0) return null;
  const near = heads.filter((sample) => sample.t >= t0 - 0.1 && sample.t <= t1 + 0.1);
  const frames = near.length > 0 ? near : heads;
  const xs = frames.map((sample) => sample.cx).sort((a, b) => a - b);
  const cx = xs[Math.floor(xs.length / 2)]!;
  const width = Math.max(...frames.map((sample) => sample.head_w));
  const top = Math.max(0, Math.min(...frames.map((sample) => sample.head_top)));
  return {
    left: cx - Math.floor(width / 2) - padding.left,
    right: cx + Math.floor(width / 2) + padding.right,
    top,
    bottom: top + Math.floor(width * 1.35),
  };
}

// How far around a moment the robust face looks: samples within this many
// seconds of it.
const FACE_WINDOW_SECONDS = 0.5;
// A sample time belongs to a span when it lies within this of the span's
// edges (half the head track's 0.25 s step).
const SPAN_EDGE_SECONDS = 0.125;

function quartileIndex(count: number): number {
  return Math.round(0.25 * (count - 1));
}

// The face at each sample time of a span, each from the samples within half a
// second of that time: `cx` their median, the width their upper quartile, the
// top their lower quartile. A single bad reading never moves it (the layout
// engine and the checks both use this, so they always agree). Empty with no
// head near the span; padded like `faceBox`.
export function facesOver(
  track: HeadTrack,
  t0: number,
  t1: number,
  padding: { left: number; right: number } = { left: 0, right: 0 },
): Box[] {
  const heads = track.filter((sample) => sample !== null);
  if (heads.length === 0) return [];
  let times = heads
    .map((sample) => sample.t)
    .filter((t) => t >= t0 - SPAN_EDGE_SECONDS && t <= t1 + SPAN_EDGE_SECONDS);
  if (times.length === 0) {
    // A span between two samples: the nearest one on each side.
    const before = heads.filter((sample) => sample.t < t0).at(-1);
    const after = heads.find((sample) => sample.t > t1);
    times = [before?.t, after?.t].filter((t) => t !== undefined);
  }
  const out: Box[] = [];
  const seen = new Set<string>();
  for (const t of times) {
    const near = heads.filter((sample) => Math.abs(sample.t - t) <= FACE_WINDOW_SECONDS);
    if (near.length === 0) continue;
    const at = quartileIndex(near.length);
    const xs = near.map((sample) => sample.cx).sort((a, b) => a - b);
    const widths = near.map((sample) => sample.head_w).sort((a, b) => b - a);
    const tops = near.map((sample) => sample.head_top).sort((a, b) => a - b);
    const cx = xs[Math.floor(xs.length / 2)]!;
    const width = widths[at]!;
    const top = Math.max(0, tops[at]!);
    const box = {
      left: cx - Math.floor(width / 2) - padding.left,
      right: cx + Math.floor(width / 2) + padding.right,
      top,
      bottom: top + Math.floor(width * 1.35),
    };
    const key = `${box.left} ${box.right} ${box.top}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(box);
  }
  return out;
}

// The bounding box of boxes; null for none.
export function boundingBox(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  return {
    left: Math.min(...boxes.map((box) => box.left)),
    right: Math.max(...boxes.map((box) => box.right)),
    top: Math.min(...boxes.map((box) => box.top)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
  };
}
