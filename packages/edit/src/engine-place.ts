import type { Blocker, EngineNote } from "./engine-note.ts";
import { expand, freeRects, overlaps, placeBox } from "./engine-space.ts";
import {
  type Point,
  type SafeZone,
  type ZoneName,
  type ZonePart,
  zonesAt,
} from "./engine-zones.ts";
import { type Box, LAYOUT_PADDING, boundingBox } from "./head-track.ts";
import { breaksOf } from "./lines.ts";
import type { Measurer } from "./measure.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import { bigWordCoveredShare } from "./behind.ts";
import type { Span } from "./timeline.ts";
import type { BoxVariant, TextVariant } from "./variants.ts";

// The placer (`specs/layout-engine.md`, "The loop" > "Placement", "Hard
// rules", "Soft rules", "Sizes and wrapping"): one element over a given
// obstacle set. It enumerates the candidates (each zone of the variant's
// ranking, each line count, the face as an obstacle then allowed), drops the
// ones that break a hard rule, scores the rest by the soft costs and takes the
// cheapest, with the spec's tie-break. Pure and deterministic: the same input
// gives the same result. Not yet called by the engine (`engine.ts`): build
// steps 6 to 10 wire each component through it.
//
// Where the spec leaves a detail open, this file takes the simplest reading
// and says so in a comment marked "Settled:".

// The soft costs (the spec's table). Tuning values: tuned on real reels.
export interface PlaceCosts {
  face: number; // the element's box overlaps F in any moment of its span (flat)
  zoneStep: number; // one step down the variant's zones
  shrinkStep: number; // one step of 10% below the element's full size
  wrap: number; // one more line
}

export const PLACE_COSTS: PlaceCosts = { face: 100, zoneStep: 10, shrinkStep: 10, wrap: 0 };

// The one global minimum size, in pixels: today's caption floor. Settled: it
// bounds a box's width too (the spec names one minimum for everything).
export const MIN_SIZE_PX = 30;

// One shrink step: 10% of the full size.
const SHRINK_STEP = 0.1;
// Text keeps this from the face, from other text and from captions.
const GAP = ISSEBYA_PRESET.layout.gap;
const FRAME_WIDTH = ISSEBYA_PRESET.frame.width;
// Rule 6: the face hides at most this share of a behind big word's height.
const MAX_HIDDEN_SHARE = 1 - ISSEBYA_PRESET.behind.word.minVisible;
const SLACK = 1e-9;

interface ElementBase extends Span {
  id: string; // the item id, "accent-1", "hook", "w0012"
}

// A text: its entry, its words and the gap between its lines (`caption.lineGap`
// for a caption, 0 for every other text; line height is the size).
export interface TextElement extends ElementBase {
  type: "text";
  variant: TextVariant;
  text: string;
  lineGap: number;
}

// A box: its entry gives its aspect and full width.
export interface BoxElement extends ElementBase {
  type: "box";
  variant: BoxVariant;
}

// Settled: a LIST stack (number, lead, key as one element) is not an element
// here yet; step 7 of the build order adds it.
export type PlaceElement = TextElement | BoxElement;

// Something already placed over a moment of the element's span. A `caption`
// blocks everything (rule 2); a `text` blocks text (rule 5); a `box` blocks
// nothing (text may sit on a card, a card under text). The caller passes the
// obstacles whose span shares a moment with the element.
export interface Obstacle {
  id: string;
  kind: "caption" | "text" | "box";
  box: Box;
}

export interface PlaceScene {
  // The robust faces over the element's span, unpadded (`facesOver` with no
  // padding). Empty when no head is in its moments.
  faces: readonly Box[];
  obstacles: readonly Obstacle[];
  safe: SafeZone;
}

// The chosen candidate.
export interface Placed {
  box: Box;
  // A text: its font size. A box: its width.
  size: number;
  lines: string[]; // a box: []
  breaks: number[]; // a box: []
  zone: ZoneName;
  cost: number;
  coversFace: boolean;
}

export interface PlaceResult {
  // null when no candidate keeps the hard rules (`no-spot`).
  placed: Placed | null;
  // One note per outcome (`placed` alone when nothing was given up; else each
  // of `moved`, `shrunk`, `wrapped`, `covers-face` that applies; `no-spot`).
  notes: EngineNote[];
}

// ------------------------------------------------------------------ shapes

// What a candidate measures at a size: its width and height in pixels, and the
// largest size that fits a rectangle. A text at `n` lines, or a box at its aspect.
interface Shape {
  lines: string[];
  widthAt(size: number): number;
  heightAt(size: number): number;
  fit(rect: Box): number;
}

// The lines of `words` on `count` lines that keep the widest line narrowest
// (the balanced break), widths measured at size 1 so the break is the same at
// every size. Settled: ties go to the earlier cuts.
function balancedLines(
  words: readonly string[],
  count: number,
  widthOf: (line: string) => number,
): string[] {
  const widths = new Map<string, number>();
  const lineWidth = (from: number, to: number): number => {
    const key = `${from}:${to}`;
    const known = widths.get(key);
    if (known !== undefined) return known;
    const width = widthOf(words.slice(from, to).join(" "));
    widths.set(key, width);
    return width;
  };
  // best[k][j]: the narrowest widest line of the first j words on k lines, and
  // where its last line starts.
  const best: { width: number; cut: number }[][] = [];
  best[1] = [];
  for (let j = 1; j <= words.length; j += 1) best[1]![j] = { width: lineWidth(0, j), cut: 0 };
  for (let k = 2; k <= count; k += 1) {
    best[k] = [];
    for (let j = k; j <= words.length; j += 1) {
      let found: { width: number; cut: number } | undefined;
      for (let i = k - 1; i < j; i += 1) {
        const width = Math.max(best[k - 1]![i]!.width, lineWidth(i, j));
        if (!found || width < found.width - SLACK) found = { width, cut: i };
      }
      best[k]![j] = found!;
    }
  }
  const lines: string[] = [];
  let end = words.length;
  for (let k = count; k >= 1; k -= 1) {
    const { cut } = best[k]![end]!;
    lines.unshift(words.slice(cut, end).join(" "));
    end = cut;
  }
  return lines;
}

function textShape(element: TextElement, count: number, measurer: Measurer): Shape | null {
  const { font } = element.variant.style;
  const widthOf = (line: string) => measurer.width(font, 1, line);
  const words = element.text.split(" ");
  const lines = count === 1 ? [element.text] : balancedLines(words, count, widthOf);
  const perPx = Math.max(...lines.map(widthOf));
  if (!(perPx > 0)) return null;
  const gaps = (count - 1) * element.lineGap;
  return {
    lines,
    widthAt: (size) => size * perPx,
    heightAt: (size) => size * count + gaps,
    // Floored with no slack: a size rounded up by a float hair would overshoot
    // the rectangle and `placeBox` would find no place for it.
    fit: (rect) =>
      Math.floor(
        Math.min((rect.right - rect.left) / perPx, (rect.bottom - rect.top - gaps) / count),
      ),
  };
}

const ratio = (text: `${number}/${number}`): number => {
  const [a, b] = text.split("/").map(Number);
  return a! / b!;
};

function boxShape(element: BoxElement): Shape {
  const aspect = ratio(element.variant.aspect);
  return {
    lines: [],
    widthAt: (size) => size,
    heightAt: (size) => Math.floor(size / aspect),
    fit: (rect) => Math.floor(Math.min(rect.right - rect.left, (rect.bottom - rect.top) * aspect)),
  };
}

// The shapes an element may take: a text on 1 to its word count lines, a box one.
function shapesOf(element: PlaceElement, measurer: Measurer): Shape[] {
  if (element.type === "box") return [boxShape(element)];
  const count = element.text.split(" ").length;
  const shapes: Shape[] = [];
  for (let n = 1; n <= count; n += 1) {
    const shape = textShape(element, n, measurer);
    if (shape) shapes.push(shape);
  }
  return shapes;
}

// ------------------------------------------------------------------ geometry

// A zone part's area as one rectangle to search, with the notch as an
// obstacle. Settled: the part's disjoint pieces are rejoined as their bounding
// box (every point of it outside the pieces lies in the notch), so a spot that
// straddles the notch's top edge left of it stays a candidate.
function areaOf(part: ZonePart): Box | null {
  return boundingBox(part.area);
}

// The wanted point as the centre `placeBox` aims at. Settled: each zone's
// want anchors a different point of the element. Top centre: above-head,
// upper-third, below-face, caption-line. Centre: head-top,
// anywhere-in-safe-zone. Beside-face: the edge towards the face, at the mouth
// (the part left of the face hangs left of its want, the right part right).
// Corner: the element's own corner on the want (which corner, by the want's
// side of the zone's centre).
function centreWant(
  zone: ZoneName,
  part: ZonePart,
  area: Box,
  F: Box | null,
  width: number,
  height: number,
): Point {
  const { want } = part;
  switch (zone) {
    case "head-top":
    case "anywhere-in-safe-zone":
      return want;
    case "beside-face": {
      const faceCentre = F ? (F.left + F.right) / 2 : (area.left + area.right) / 2;
      const x = want.x <= faceCentre ? want.x - width / 2 : want.x + width / 2;
      return { x, y: want.y };
    }
    case "corner": {
      const left = want.x <= (area.left + area.right) / 2;
      const top = want.y <= (area.top + area.bottom) / 2;
      return {
        x: left ? want.x + width / 2 : want.x - width / 2,
        y: top ? want.y + height / 2 : want.y - height / 2,
      };
    }
    default:
      return { x: want.x, y: want.y + height / 2 };
  }
}

// ---------------------------------------------------------------- candidates

interface Candidate {
  rank: number; // the zone's index in the variant's ranking
  zone: ZoneName;
  box: Box;
  size: number;
  shape: Shape;
  coversFace: boolean;
  cost: number;
  shrinkSteps: number;
}

// Which obstacles the element sees (rule 5: a box sees no text; a box is no
// obstacle to anything), each grown by the gap.
function obstacleBoxes(element: PlaceElement, obstacles: readonly Obstacle[]): Box[] {
  return obstacles
    .filter((o) => o.kind === "caption" || (o.kind === "text" && element.type === "text"))
    .map((o) => expand(o.box, GAP));
}

// The largest size of `shape` that fits a free rectangle of `area` with the
// obstacles out, at most `cap`; 0 when nothing fits.
function largestFit(shape: Shape, area: Box, obstacles: readonly Box[], cap: number): number {
  let size = 0;
  for (const rect of freeRects(area, obstacles)) size = Math.max(size, shape.fit(rect));
  return Math.min(size, cap);
}

// The element's full size: the largest at which it fits its first zone with
// no obstacles (the notch only, no face), over any line count; a box: its
// `width` share of the frame. Settled: when the first zone has no room (none,
// as above a face at the top; or less than the minimum size), the next zone of
// the ranking with room gives it. 0 when no zone has room.
function fullSizeOf(
  element: PlaceElement,
  shapes: readonly Shape[],
  scene: PlaceScene,
  F: Box | null,
): number {
  if (element.type === "box") return Math.floor(FRAME_WIDTH * ratio(element.variant.width));
  for (const zone of element.variant.zones) {
    let full = 0;
    for (const part of zonesAt(zone, scene.safe, F)) {
      const area = areaOf(part);
      if (!area) continue;
      for (const shape of shapes)
        full = Math.max(full, largestFit(shape, area, [scene.safe.notch], Infinity));
    }
    if (full >= MIN_SIZE_PX) return full;
  }
  return 0;
}

// Settled: shrink steps are counted up: any size under the full size is at
// least one step, 0.9 of it one step, 0.89 two.
function shrinkStepsOf(size: number, full: number): number {
  if (size >= full) return 0;
  return Math.ceil((full - size) / (SHRINK_STEP * full) - SLACK);
}

// Candidates in order: zone rank, part, line count, then the face as an
// obstacle before the face allowed. A candidate is the largest size that fits
// (capped at the full size) at the spot nearest the zone's want.
function candidates(
  element: PlaceElement,
  shapes: readonly Shape[],
  scene: PlaceScene,
  F: Box | null,
  full: number,
  costs: PlaceCosts,
): Candidate[] {
  const out: Candidate[] = [];
  const fixed = [scene.safe.notch, ...obstacleBoxes(element, scene.obstacles)];
  const behind = element.variant.layer === "behind";
  const passes: readonly Box[][] = F ? [[expand(F, GAP), ...fixed], fixed] : [fixed];
  element.variant.zones.forEach((zone, rank) => {
    for (const part of zonesAt(zone, scene.safe, F)) {
      const area = areaOf(part);
      if (!area) continue;
      for (const shape of shapes) {
        for (const obstacles of passes) {
          const size = largestFit(shape, area, obstacles, full);
          // Hard: below the global minimum, nothing fits.
          if (size < MIN_SIZE_PX) continue;
          const width = shape.widthAt(size);
          const height = shape.heightAt(size);
          const want = centreWant(zone, part, area, F, width, height);
          const at = placeBox(area, obstacles, width, height, want);
          if (!at) continue;
          const box: Box = { left: at.x, top: at.y, right: at.x + width, bottom: at.y + height };
          // Hard rule 6: the face hides at most 30% of a behind text's height.
          if (behind && bigWordCoveredShare(box, scene.faces) > MAX_HIDDEN_SHARE + SLACK) continue;
          // A behind text sits behind the speaker by design: it never "covers"
          // the face (rule 6 bounds it instead).
          const coversFace = !behind && F !== null && overlaps(box, F);
          const shrinkSteps = shrinkStepsOf(size, full);
          const cost =
            (coversFace ? costs.face : 0) +
            rank * costs.zoneStep +
            shrinkSteps * costs.shrinkStep +
            (shape.lines.length - 1) * costs.wrap;
          out.push({ rank, zone, box, size, shape, coversFace, cost, shrinkSteps });
        }
      }
    }
  });
  return out;
}

// The spec's tie-break: cost, the earlier zone, the larger size, fewer lines,
// the higher spot, the further left spot. Negative when `a` wins.
function compare(a: Candidate, b: Candidate): number {
  return (
    a.cost - b.cost ||
    a.rank - b.rank ||
    b.size - a.size ||
    a.shape.lines.length - b.shape.lines.length ||
    a.box.top - b.box.top ||
    a.box.left - b.box.left
  );
}

// ------------------------------------------------------------------ blockers

// What took the space of the zones up to `rank` (every zone when `rank` is
// the ranking's length): the captions and texts the element sees that touch a
// zone's area, the face when it does, the buttons when the notch does.
function blockersUpTo(
  element: PlaceElement,
  scene: PlaceScene,
  F: Box | null,
  rank: number,
): Blocker[] {
  const out: Blocker[] = [];
  const seen = new Set<string>();
  const add = (blocker: Blocker) => {
    const key = JSON.stringify(blocker);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(blocker);
  };
  const seesText = element.type === "text";
  element.variant.zones.slice(0, rank + 1).forEach((zone) => {
    for (const part of zonesAt(zone, scene.safe, F)) {
      const area = areaOf(part);
      if (!area) continue;
      for (const o of scene.obstacles) {
        if (o.kind === "box" || (o.kind === "text" && !seesText)) continue;
        if (!overlaps(expand(o.box, GAP), area)) continue;
        add(o.kind === "caption" ? { kind: "caption", id: o.id } : { kind: "item", id: o.id });
      }
      if (F && overlaps(expand(F, GAP), area)) add({ kind: "face" });
      if (overlaps(scene.safe.notch, area)) add({ kind: "buttons" });
    }
  });
  return out;
}

// The safe zone's own edges as blockers, when the element at the minimum size
// fits nowhere in S even with no obstacle: too wide (left and right) or too
// tall (top and bottom).
function safeZoneBlockers(shapes: readonly Shape[], safe: SafeZone): Blocker[] {
  const s = safe.box;
  const fitsWidth = shapes.some((shape) => shape.widthAt(MIN_SIZE_PX) <= s.right - s.left + SLACK);
  if (!fitsWidth) {
    return [
      { kind: "safe-zone", edge: "left" },
      { kind: "safe-zone", edge: "right" },
    ];
  }
  return [
    { kind: "safe-zone", edge: "top" },
    { kind: "safe-zone", edge: "bottom" },
  ];
}

// --------------------------------------------------------------------- notes

const ZONE_WORDS: Record<ZoneName, string> = {
  "above-head": "above the head",
  "upper-third": "in the upper third",
  "beside-face": "beside the face",
  "below-face": "below the face",
  "caption-line": "on the caption line",
  corner: "in a corner",
  "head-top": "at the head top",
  "anywhere-in-safe-zone": "in the safe zone",
};

const seconds = (t: number) => `${t.toFixed(2)} s`;

function blockerWords(blockers: readonly Blocker[]): string {
  if (blockers.length === 0) return "nothing";
  return blockers
    .map((b) => {
      switch (b.kind) {
        case "caption":
        case "item":
          return b.id;
        case "face":
          return "the face";
        case "buttons":
          return "the buttons";
        case "safe-zone":
          return `the safe zone's ${b.edge} edge`;
      }
    })
    .join(", ");
}

function whoIs(element: PlaceElement): string {
  const kind = element.variant.component.toLowerCase();
  return element.type === "text"
    ? `${kind} ${element.id} "${element.text}"`
    : `${kind} ${element.id}`;
}

// --------------------------------------------------------------------- place

// The element's place over the scene: the cheapest candidate that keeps the
// hard rules, or none, and the notes that say what happened.
export function placeElement(
  element: PlaceElement,
  scene: PlaceScene,
  measurer: Measurer,
  costs: PlaceCosts = PLACE_COSTS,
): PlaceResult {
  // F: the padded bounding box of the faces over the span (the zones apply the
  // gap vertically themselves, so F is padded horizontally only).
  const faces = boundingBox(scene.faces);
  const F: Box | null = faces && {
    ...faces,
    left: faces.left - LAYOUT_PADDING.left,
    right: faces.right + LAYOUT_PADDING.right,
  };
  const shapes = shapesOf(element, measurer);
  const full = fullSizeOf(element, shapes, scene, F);
  const who = whoIs(element);
  const when = `from ${seconds(element.start)} to ${seconds(element.end)}`;
  const base = {
    item: element.id,
    component: element.variant.component,
    variant: element.variant.variant,
    start: element.start,
    end: element.end,
  };

  const all = full > 0 ? candidates(element, shapes, scene, F, full, costs) : [];
  let chosen: Candidate | undefined;
  for (const candidate of all) {
    if (!chosen || compare(candidate, chosen) < 0) chosen = candidate;
  }

  if (!chosen) {
    // What took the space; the safe zone's edges when the element fits no zone
    // even with nothing in the way.
    const taken = blockersUpTo(element, scene, F, element.variant.zones.length);
    const blockers = full > 0 && taken.length > 0 ? taken : safeZoneBlockers(shapes, scene.safe);
    return {
      placed: null,
      notes: [
        {
          ...base,
          rule: "no-spot",
          outcome: "no-spot",
          blockers,
          reason: `${who} has no spot ${when}: nothing fits at ${MIN_SIZE_PX} px or more; ${blockerWords(blockers)} took the space`,
        },
      ],
    };
  }

  const lines = chosen.shape.lines;
  const taken = {
    zone: chosen.zone,
    size: chosen.size,
    lines: lines.length,
    cost: chosen.cost,
  };
  const where = ZONE_WORDS[chosen.zone];
  const notes: EngineNote[] = [];
  const givenUp =
    chosen.rank > 0 || chosen.shrinkSteps > 0 || lines.length > 1 || chosen.coversFace;
  // Settled: the blockers of a note are what took the space of the zones
  // before the chosen one, plus the chosen zone's own when the element shrank
  // or covers the face there.
  const blockers = givenUp
    ? blockersUpTo(
        element,
        scene,
        F,
        chosen.shrinkSteps > 0 || chosen.coversFace ? chosen.rank : chosen.rank - 1,
      )
    : [];
  if (chosen.rank > 0) {
    notes.push({
      ...base,
      ...taken,
      rule: "zone",
      outcome: "moved",
      blockers,
      reason: `${who} moves ${where} ${when}; ${blockerWords(blockers)} took ${element.variant.zones
        .slice(0, chosen.rank)
        .map((zone) => ZONE_WORDS[zone].replace(/^(in|on|at) /, ""))
        .join(" and ")}`,
    });
  }
  if (chosen.shrinkSteps > 0) {
    notes.push({
      ...base,
      ...taken,
      rule: "size",
      outcome: "shrunk",
      blockers,
      reason: `${who} shrinks to ${chosen.size} px from ${full} px ${where} ${when}; ${blockerWords(blockers)} took the room`,
    });
  }
  if (lines.length > 1) {
    notes.push({
      ...base,
      ...taken,
      rule: "size",
      outcome: "wrapped",
      blockers,
      reason: `${who} wraps to ${lines.length} lines ${where} ${when}`,
    });
  }
  if (chosen.coversFace) {
    notes.push({
      ...base,
      ...taken,
      rule: "face",
      outcome: "covers-face",
      blockers,
      reason: `${who} covers the face ${where} ${when}; no spot off the face was free`,
    });
  }
  if (notes.length === 0) {
    notes.push({
      ...base,
      ...taken,
      rule: "zone",
      outcome: "placed",
      blockers: [],
      reason: `${who} is placed ${where} at ${chosen.size} px ${when}, nothing given up`,
    });
  }
  return {
    placed: {
      box: chosen.box,
      size: chosen.size,
      lines,
      breaks: breaksOf(lines),
      zone: chosen.zone,
      cost: chosen.cost,
      coversFace: chosen.coversFace,
    },
    notes,
  };
}
