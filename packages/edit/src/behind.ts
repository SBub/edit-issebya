import type { Box } from "./head-track.ts";
import type { Measurer } from "./measure.ts";
import { BEHIND_SPOTS, type BehindSpot, type FontKey, type Preset } from "./preset.ts";
import type { BehindItem, BehindVisualItem, BehindWordItem, Edit } from "./schema.ts";
import { type Span, resolveTimeline } from "./timeline.ts";
import type { Transcript } from "./transcript.ts";

// The rectangle a VISUAL in `spot` covers exactly (its spot's rectangle).
export function spotBox(spot: BehindSpot, preset: Preset): Box {
  return preset.behind.spots[spot];
}

// The rectangle a VISUAL covers: the box the layout engine gave it.
export function visualBox(item: BehindVisualItem): Box {
  const { box } = item;
  return { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height };
}

// Whether a behind-track item needs the cut-out: a big word, which sits behind
// the speaker. A VISUAL sits in front of the speaker, over the footage, and
// needs none.
export function needsCutout(item: BehindItem): boolean {
  return item.kind === "word";
}

// The preset spot nearest a VISUAL's box (by their centres, ties in spot
// order): what a placed VISUAL's `spot` names.
export function nearestSpot(box: Box, preset: Preset): BehindSpot {
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  let best: BehindSpot = BEHIND_SPOTS[0];
  let distance = Infinity;
  for (const spot of BEHIND_SPOTS) {
    const at = spotBox(spot, preset);
    const d = Math.hypot((at.left + at.right) / 2 - cx, (at.top + at.bottom) / 2 - cy);
    if (d < distance - 1e-9) {
      best = spot;
      distance = d;
    }
  }
  return best;
}

// The share (0 to 1) of a box the face box covers; 0 without a face.
function boxFaceShare(box: Box, face: Box | null): number {
  if (!face) return 0;
  const width = Math.max(0, Math.min(box.right, face.right) - Math.max(box.left, face.left));
  const height = Math.max(0, Math.min(box.bottom, face.bottom) - Math.max(box.top, face.top));
  const area = (box.right - box.left) * (box.bottom - box.top);
  return area > 0 ? (width * height) / area : 0;
}

// The share (0 to 1) of a VISUAL's spot the face box covers; 0 without a face.
// Shared by the decide prompt's clear spots and the layout engine's placement,
// so the two never disagree.
export function spotFaceShare(spot: BehindSpot, face: Box | null, preset: Preset): number {
  return boxFaceShare(spotBox(spot, preset), face);
}

// The largest share (0 to 1) of a big word's height the face covers, in any of
// its columns, at any of the faces (the robust ones over its span, `facesOver`);
// 0 without a face. Only the face counts: the body under it is no obstacle to
// the word's visibility. Shared by the layout engine's placement and its check,
// so they never disagree.
export function bigWordCoveredShare(box: Box, faces: readonly Box[]): number {
  const height = box.bottom - box.top;
  if (height <= 0) return 0;
  let worst = 0;
  for (const face of faces) {
    if (!(face.left < box.right && box.left < face.right)) continue;
    const covered = Math.min(box.bottom, face.bottom) - Math.max(box.top, face.top);
    worst = Math.max(worst, Math.max(0, covered) / height);
  }
  return worst;
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

// The big word where the layout engine set it: its top left corner and size
// from the edit, its width from HarfBuzz.
export function placedBigWord(
  item: BehindWordItem,
  position: { x: number; y: number },
  size: number,
  preset: Preset,
  measurer: Measurer,
): BigWordBox {
  const { word } = preset.behind;
  return {
    itemId: item.id,
    text: item.text,
    font: word.font,
    size,
    color: word.color,
    x: position.x,
    y: position.y,
    width: measurer.width(word.font, 1, item.text) * size,
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
// per span), so the two always agree: the span of each item behind the
// speaker (a big word) padded by the preset's frames
// on each side, clamped to the reel, widened to whole frames, overlapping or
// touching spans merged, sorted, to the millisecond.
export function maskSpans(edit: Edit, transcript: Transcript, preset: Preset): MaskSpan[] {
  // Only what sits behind the speaker: a big word (a VISUAL needs no mask).
  const items = (edit.tracks.behind ?? []).filter(needsCutout);
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
