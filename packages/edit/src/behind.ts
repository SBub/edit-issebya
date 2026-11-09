import type { Box } from "./head-track.ts";
import type { Measurer } from "./measure.ts";
import type { FontKey, Preset } from "./preset.ts";
import type { BehindItem, BehindVisualItem, BehindWordItem, Edit } from "./schema.ts";
import { type Span, resolveTimeline } from "./timeline.ts";
import type { Transcript } from "./transcript.ts";

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
