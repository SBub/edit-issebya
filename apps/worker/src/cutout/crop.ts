import type { HeadTrack } from "@edit-issebya/edit";
import { HEAD_TRACK_SETTINGS } from "../pipeline/head-track.ts";

// How much of each frame above the speaker a span's mask leaves out, read from
// the head track (never a fixed height). `id` is in every mask fingerprint
// (MATTE_SETTINGS.crop): change it with any value here.
export const CROP_RULE = {
  id: "above-head-half-width",
  // Kept above the highest person top of the span, in head widths: room for
  // what moves between two samples and for the model to see past the hair.
  marginHeadWidths: 0.5,
  // Samples this far outside the span still count (the track has one every
  // 0.25 s, so a span's first and last frames lie between two of them).
  reachSeconds: 0.25,
} as const;

// The rows a span's mask leaves out at the top, in the head track's pixels (a
// frame 1920 high; the entry scales them to the footage): the smallest
// `head_top` of the span's samples (the top of the person, a raised hand
// included) minus the margin under its widest head, never below 0. No crop (0)
// without a track, without a sample in the span, or when one of the span's
// samples has no head: where the person is then is not known.
export function spanCropTop(track: HeadTrack | null, span: { start: number; end: number }): number {
  if (!track) return 0;
  const from = span.start - CROP_RULE.reachSeconds;
  const to = span.end + CROP_RULE.reachSeconds;
  let top = Infinity;
  let width = 0;
  for (const [index, sample] of track.entries()) {
    // A sample without a head has no time of its own: its place gives it.
    const t = sample?.t ?? index * HEAD_TRACK_SETTINGS.sampleSeconds;
    if (t < from || t > to) continue;
    if (sample === null) return 0;
    top = Math.min(top, sample.head_top);
    width = Math.max(width, sample.head_w);
  }
  if (top === Infinity) return 0;
  return Math.max(0, Math.floor(top - CROP_RULE.marginHeadWidths * width));
}
