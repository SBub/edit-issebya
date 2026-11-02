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
const LAYOUT_PADDING = { left: 35, right: 30 };

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
