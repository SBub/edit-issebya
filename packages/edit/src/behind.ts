import { type Box, type HeadTrack, faceBox } from "./head-track.ts";
import type { Measurer } from "./measure.ts";
import type { BehindSpot, FontKey, Preset } from "./preset.ts";
import type { BehindWordItem, Edit } from "./schema.ts";
import { type Span, resolveTimeline } from "./timeline.ts";
import type { Transcript } from "./transcript.ts";

// The smallest size a big word is set at; a word that does not fit the frame
// even at this size fails the `frame` check.
const MIN_WORD_SIZE = 8;

// The rectangle a photo in `spot` covers exactly.
export function spotBox(spot: BehindSpot, preset: Preset): Box {
  return preset.behind.spots[spot];
}

// The share (0 to 1) of a photo's spot the face box covers; 0 without a face.
// Shared by the `behind-face` check and the decide prompt's clear spots, so
// the two never disagree.
export function spotFaceShare(spot: BehindSpot, face: Box | null, preset: Preset): number {
  if (!face) return 0;
  const box = spotBox(spot, preset);
  const width = Math.max(0, Math.min(box.right, face.right) - Math.max(box.left, face.left));
  const height = Math.max(0, Math.min(box.bottom, face.bottom) - Math.max(box.top, face.top));
  const area = (box.right - box.left) * (box.bottom - box.top);
  return area > 0 ? (width * height) / area : 0;
}

// One big word as placed: its box in frame pixels.
export interface BigWordBox {
  itemId: string;
  text: string;
  font: FontKey;
  size: number;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// The big word as large as fits between the side margins (at most the
// preset's size), centred across the frame, its vertical centre below the
// head's top at the item's start (so the head overlaps it) or at the preset's
// line when no head is in the frame. The width comes from HarfBuzz at 1 px, so
// the measurer records it and the goldens cover it.
export function bigWordLayout(
  item: BehindWordItem,
  span: Span,
  headTrack: HeadTrack,
  preset: Preset,
  measurer: Measurer,
): BigWordBox {
  const { word } = preset.behind;
  const { width: frameWidth } = preset.frame;
  const perPx = measurer.width(word.font, 1, item.text);
  const fit = perPx > 0 ? Math.floor((frameWidth - 2 * word.margin) / perPx) : word.maxSize;
  const size = Math.max(MIN_WORD_SIZE, Math.min(word.maxSize, fit));
  const width = perPx * size;
  const face = faceBox(headTrack, span.start, span.start);
  const centre = face ? face.top + word.belowHeadTop : word.noHeadY;
  return {
    itemId: item.id,
    text: item.text,
    font: word.font,
    size,
    color: word.color,
    x: Math.round((frameWidth - width) / 2),
    y: Math.round(centre - size / 2),
    width,
    height: size,
  };
}

// One stretch of the reel the cut-out covers, and the behind items in it.
export interface MaskSpan extends Span {
  items: string[];
}

function ms(seconds: number): number {
  const rounded = Math.round(seconds * 1000) / 1000;
  return rounded === 0 ? 0 : rounded;
}

// The spans the cut-out must cover, shared by the builder (which draws one
// composite per span) and the worker (which fingerprints and makes one mask
// per span), so the two always agree: each behind item's span padded by the
// preset's frames on each side, clamped to the reel, widened to whole frames,
// overlapping or touching spans merged, sorted, to the millisecond.
export function maskSpans(edit: Edit, transcript: Transcript, preset: Preset): MaskSpan[] {
  const items = edit.tracks.behind ?? [];
  if (items.length === 0) return [];
  const resolved = resolveTimeline(edit, transcript);
  const { padFrames, frameRate } = preset.behind;
  const pad = padFrames / frameRate;
  const duration = ms(edit.duration);
  const spans = items
    .map((item) => {
      const { start, end } = resolved.get(item.id)!;
      const from = Math.floor(Math.max(0, start - pad) * frameRate + 1e-6) / frameRate;
      const to = Math.ceil(Math.min(duration, end + pad) * frameRate - 1e-6) / frameRate;
      return { start: ms(from), end: Math.min(ms(to), duration), items: [item.id] };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: MaskSpan[] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      last.items.push(...span.items);
    } else {
      merged.push({ ...span, items: [...span.items] });
    }
  }
  return merged;
}
