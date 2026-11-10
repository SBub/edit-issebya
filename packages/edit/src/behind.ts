import { type Box, type HeadTrack, facesOver } from "./head-track.ts";
import type { Measurer } from "./measure.ts";
import type { FontKey, Preset } from "./preset.ts";
import type { BehindItem, BehindVisualItem, BehindWordItem, Edit } from "./schema.ts";
import { type Span, resolveTimeline } from "./timeline.ts";
import type { Transcript } from "./transcript.ts";
import { STYLES } from "./variants.ts";

// The rectangle a VISUAL covers: the box the layout engine gave it.
export function visualBox(item: BehindVisualItem): Box {
  const { box } = item;
  return { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height };
}

// Whether a behind-track item needs the cut-out: a big word, which sits behind
// the speaker, unless the layout engine found the head cannot reach it (its
// `cutout: false`; a stored word without the field needs it). A VISUAL sits in
// front of the speaker, over the footage, and needs none.
export function needsCutout(item: BehindItem): boolean {
  return item.kind === "word" && item.cutout !== false;
}

// The margin (px) a big word's box may come under the highest head over its span
// before it needs the cut-out: the head is not in its way until it is that close.
export const HAIR_MARGIN = 20;

// The head track samples every 0.25 s: a span window also takes this much either
// side, so a short span always holds the sample nearest it.
const SAMPLE_HALF_STEP = 0.125;

// Whether a big word's box reaches the head over its span, so the cut-out is
// needed: the box's bottom is below the highest robust face's top over the span
// (`facesOver`, the faces the placer reads, so the two never disagree), less
// `HAIR_MARGIN`. The span is the word's mask span (padded, `paddedSpan`). No head
// sample in the span: no cut-out (`facesOver` would otherwise borrow the nearest
// heads, far away, which is not a head over the word).
export function bigWordNeedsCutout(box: Box, track: HeadTrack, span: Span): boolean {
  const headInSpan = track.some(
    (sample) =>
      sample !== null &&
      sample.t >= span.start - SAMPLE_HALF_STEP &&
      sample.t <= span.end + SAMPLE_HALF_STEP,
  );
  if (!headInSpan) return false;
  const highest = Math.min(...facesOver(track, span.start, span.end).map((face) => face.top));
  return box.bottom > highest - HAIR_MARGIN;
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
  measurer: Measurer,
): BigWordBox {
  const word = STYLES.bigWord;
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

// A span of the reel padded by the preset's frames on each side, clamped to the
// reel, widened to whole frames, to the millisecond: the mask span of a big word
// (`maskSpans`), and the span the layout engine checks its head against.
export function paddedSpan(span: Span, duration: number, preset: Preset): Span {
  const { padFrames, frameRate } = preset.behind;
  const pad = padFrames / frameRate;
  const end = ms(duration);
  const from = Math.floor(Math.max(0, span.start - pad) * frameRate + 1e-6) / frameRate;
  const to = Math.ceil(Math.min(end, span.end + pad) * frameRate - 1e-6) / frameRate;
  return { start: ms(from), end: Math.min(ms(to), end) };
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
  const spans = items
    .map((item) => ({
      ...paddedSpan(resolved.get(item.id)!, edit.duration, preset),
      items: [item.id],
    }))
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
