import type { Box } from "./head-track.ts";
import type { FontKey } from "./preset.ts";
import type { Span } from "./timeline.ts";

// One piece of text on screen, in frame pixels: `x`, `y` its top left corner,
// `height` its font size (line-height 1).
export interface TextBox extends Span {
  itemId: string;
  // `level`: a text level inside a transition's layer; `hook`: the written
  // hook (Claude's own line, nobody says it).
  kind: "caption" | "accent" | "hook" | "level";
  text: string;
  // The text's lines: one, or more for a text set with `breaks`.
  lines: string[];
  font: FontKey;
  size: number;
  color: string;
  style: Record<string, string> | undefined;
  x: number;
  y: number;
  width: number;
  height: number;
}

// FREE SPACE for the layout engine: an area minus the obstacles in it, as the
// largest free rectangles (the "maximal rectangles" split: each free
// rectangle an obstacle cuts becomes the parts left, right, above and below
// it), and the place nearest a wanted point where a box of a given size fits.

export function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

export function expand(box: Box, by: number): Box {
  return { left: box.left - by, right: box.right + by, top: box.top - by, bottom: box.bottom + by };
}

function contains(outer: Box, inner: Box): boolean {
  return (
    outer.left <= inner.left &&
    outer.right >= inner.right &&
    outer.top <= inner.top &&
    outer.bottom >= inner.bottom
  );
}

// The largest rectangles of `area` no obstacle touches.
export function freeRects(area: Box, obstacles: readonly Box[]): Box[] {
  if (area.right <= area.left || area.bottom <= area.top) return [];
  let free: Box[] = [area];
  for (const obstacle of obstacles) {
    const next: Box[] = [];
    for (const rect of free) {
      if (!overlaps(rect, obstacle)) {
        next.push(rect);
        continue;
      }
      if (obstacle.left > rect.left) next.push({ ...rect, right: obstacle.left });
      if (obstacle.right < rect.right) next.push({ ...rect, left: obstacle.right });
      if (obstacle.top > rect.top) next.push({ ...rect, bottom: obstacle.top });
      if (obstacle.bottom < rect.bottom) next.push({ ...rect, top: obstacle.bottom });
    }
    free = next.filter(
      (rect, index) =>
        !next.some(
          (other, at) =>
            at !== index && contains(other, rect) && (!contains(rect, other) || at < index),
        ),
    );
  }
  return free;
}

// The whole-pixel top left corner of a `width` by `height` box inside the
// free part of `area` whose centre is nearest `want`; null when it fits
// nowhere. Ties go to the higher, then the further left place.
export function placeBox(
  area: Box,
  obstacles: readonly Box[],
  width: number,
  height: number,
  want: { x: number; y: number },
): { x: number; y: number } | null {
  let best: { x: number; y: number; distance: number } | null = null;
  for (const rect of freeRects(area, obstacles)) {
    const minX = Math.ceil(rect.left);
    const maxX = Math.floor(rect.right - width);
    const minY = Math.ceil(rect.top);
    const maxY = Math.floor(rect.bottom - height);
    if (maxX < minX || maxY < minY) continue;
    const x = Math.min(maxX, Math.max(minX, Math.round(want.x - width / 2)));
    const y = Math.min(maxY, Math.max(minY, Math.round(want.y - height / 2)));
    const distance = Math.hypot(x + width / 2 - want.x, y + height / 2 - want.y);
    if (
      !best ||
      distance < best.distance - 1e-9 ||
      (Math.abs(distance - best.distance) <= 1e-9 && (y < best.y || (y === best.y && x < best.x)))
    ) {
      best = { x, y, distance };
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}
