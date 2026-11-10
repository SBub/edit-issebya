import type { Box } from "./head-track.ts";
import { ISSEBYA_PRESET, PLATFORM_BUTTONS, PLATFORM_SAFE, intersectBox } from "./preset.ts";

// The zones of the layout engine (specs/layout-engine.md, "Zones"): named
// areas the engine computes per moment from the head track and the safe
// zone. Not yet called by the placement; the engine switches to it step by
// step.

// The one safe zone S: the platform guard minus the button column's notch.
// Text stays inside `box` and clear of `notch` (hard rule 1).
export interface SafeZone {
  box: Box;
  notch: Box;
}

export const SAFE_ZONE: SafeZone = { box: PLATFORM_SAFE, notch: PLATFORM_BUTTONS };

// A zone's wanted point, in frame pixels. What it aims at is the zone's own
// (see the table in `zonesAt`): the element's top centre, its centre (head-top),
// the corner itself (corner) or the point at the mouth (beside-face).
export interface Point {
  x: number;
  y: number;
}

// One part of a zone: the areas it covers (already cut to S, the notch out, as
// disjoint boxes; empty when nothing fits) and the point nearest which an
// element of the zone is placed. A zone has one part, except beside-face (one
// per side, the wider side first) and corner (one per corner, in the order
// top-left, top-right, bottom-left, bottom-right).
export interface ZonePart {
  area: Box[];
  want: Point;
}

export type ZoneName =
  | "above-head"
  | "upper-third"
  | "beside-face"
  | "below-face"
  | "caption-line"
  | "corner"
  | "head-top"
  | "anywhere-in-safe-zone";

// The pixel offsets the zones hold (today's values, named where they sit in
// the preset: `accent.aboveHead`, `accent.noHeadY`, `caption.fallbackY`,
// `card.inset`, `word.belowHeadTop`, `word.noHeadY`).
// The gap a zone keeps from the face: `layout.gap`.
const GAP = ISSEBYA_PRESET.layout.gap;
const ABOVE_HEAD = 190;
const NO_HEAD_ACCENT_Y = 1130;
const CAPTION_LINE_Y = 1290;
const CORNER_INSET = 40;
const BELOW_HEAD_TOP = 60;
const NO_HEAD_BIG_WORD_Y = 700;
// The beside-face strips reach this far below the face's bottom.
const SIDE_REACH = 120;
// The wanted height beside the face: the mouth, 0.7 of the face's height down.
const MOUTH = 0.7;

const EMPTY_BOX = (box: Box) => box.right <= box.left || box.bottom <= box.top;

// `box` minus `hole` as disjoint boxes, in the order top, bottom, left, right.
function minus(box: Box, hole: Box): Box[] {
  const misses =
    hole.right <= box.left ||
    hole.left >= box.right ||
    hole.bottom <= box.top ||
    hole.top >= box.bottom;
  if (misses) return [box];
  const middleTop = Math.max(box.top, hole.top);
  const middleBottom = Math.min(box.bottom, hole.bottom);
  const pieces: Box[] = [
    { left: box.left, right: box.right, top: box.top, bottom: hole.top },
    { left: box.left, right: box.right, top: hole.bottom, bottom: box.bottom },
    { left: box.left, right: hole.left, top: middleTop, bottom: middleBottom },
    { left: hole.right, right: box.right, top: middleTop, bottom: middleBottom },
  ];
  return pieces.filter((piece) => !EMPTY_BOX(piece));
}

// `box` cut to S: inside its box, the notch out.
function clip(box: Box, zone: SafeZone): Box[] {
  const inside = intersectBox(box, zone.box);
  if (EMPTY_BOX(inside)) return [];
  return minus(inside, zone.notch);
}

// The named zone's parts for one moment. `F` is the moment's face (the
// padded bounding box of the robust faces) or null when no head is in the
// frame. Zone table (the spec's, with `gap` = `layout.gap`, 12 px):
//
// - above-head: S above F.top - gap; wanted (centre x of S, F.top - 190).
//   No head: S; wanted (centre x of S, 1130).
// - upper-third: the top third of S; wanted (centre x of S, S.top). No head: the same.
// - beside-face: the strips of S left and right of F, from F.top to
//   F.bottom + 120; wanted at the face's edge at the mouth (0.7 of the face's
//   height down); the wider strip first, the left first on a tie. No head: none.
// - below-face: S below F.bottom + gap; wanted (the face's centre x, F.bottom +
//   gap). No head: none.
// - caption-line: S from y 1290 down; wanted (centre x of S, 1290). No head: the same.
// - corner: S inset 40 px; wanted each corner of that inset box, top-left,
//   top-right, bottom-left, bottom-right. No head: the same.
// - head-top: S; wanted (centre x of S, F.top + 60). No head: (centre x of S, 700).
// - anywhere-in-safe-zone: S; wanted the centre of S. No head: the same.
export function zonesAt(name: ZoneName, zone: SafeZone, F: Box | null): ZonePart[] {
  const s = zone.box;
  const cx = (s.left + s.right) / 2;
  const part = (area: Box, want: Point): ZonePart => ({ area: clip(area, zone), want });
  switch (name) {
    case "above-head":
      if (!F) return [part(s, { x: cx, y: NO_HEAD_ACCENT_Y })];
      return [part({ ...s, bottom: F.top - GAP }, { x: cx, y: F.top - ABOVE_HEAD })];
    case "upper-third": {
      const bottom = s.top + (s.bottom - s.top) / 3;
      return [part({ ...s, bottom }, { x: cx, y: s.top })];
    }
    case "beside-face": {
      if (!F) return [];
      const top = Math.max(s.top, F.top);
      const bottom = Math.min(s.bottom, F.bottom + SIDE_REACH);
      const mouth = F.top + MOUTH * (F.bottom - F.top);
      const left = part({ left: s.left, right: F.left, top, bottom }, { x: F.left, y: mouth });
      const right = part({ left: F.right, right: s.right, top, bottom }, { x: F.right, y: mouth });
      return s.right - F.right > F.left - s.left ? [right, left] : [left, right];
    }
    case "below-face": {
      if (!F) return [];
      const top = F.bottom + GAP;
      return [part({ ...s, top }, { x: (F.left + F.right) / 2, y: top })];
    }
    case "caption-line":
      return [part({ ...s, top: CAPTION_LINE_Y }, { x: cx, y: CAPTION_LINE_Y })];
    case "corner": {
      const inset: Box = {
        left: s.left + CORNER_INSET,
        right: s.right - CORNER_INSET,
        top: s.top + CORNER_INSET,
        bottom: s.bottom - CORNER_INSET,
      };
      return [
        part(inset, { x: inset.left, y: inset.top }),
        part(inset, { x: inset.right, y: inset.top }),
        part(inset, { x: inset.left, y: inset.bottom }),
        part(inset, { x: inset.right, y: inset.bottom }),
      ];
    }
    case "head-top":
      return [part(s, F ? { x: cx, y: F.top + BELOW_HEAD_TOP } : { x: cx, y: NO_HEAD_BIG_WORD_Y })];
    case "anywhere-in-safe-zone":
      return [part(s, { x: cx, y: (s.top + s.bottom) / 2 })];
  }
}
