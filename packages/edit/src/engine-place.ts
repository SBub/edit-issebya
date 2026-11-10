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
import type { FontRole } from "./font-pairs.ts";
import { bigWordCoveredShare } from "./behind.ts";
import type { Span } from "./timeline.ts";
import type { BoxVariant, Level, StackVariant, TextStyle, TextVariant } from "./variants.ts";

// The placer (`specs/layout-engine.md`, "The loop" > "Placement", "Hard
// rules", "Soft rules", "Sizes and wrapping"): one element over a given
// obstacle set. It enumerates the candidates (each zone of the variant's
// ranking, each line count, the face as an obstacle then allowed), drops the
// ones that break a hard rule, scores the rest by the soft costs and takes the
// cheapest, with the spec's tie-break. Pure and deterministic: the same input
// gives the same result. The engine (`engine.ts`) places every element through
// it: the hook, accents, questions, LIST stacks, the big word, the visual's
// card and, last, the captions as sentence blocks (build steps 6 to 10).
//
// Where the spec leaves a detail open, this file takes the simplest reading
// and says so in a comment marked "Settled:".

// The soft costs (the spec's table). Tuning values: tuned on real reels.
export interface PlaceCosts {
  face: number; // the element's box overlaps F in any moment of its span (flat)
  zoneStep: number; // one step down the variant's zones
  shrinkStep: number; // one step of 10% below the element's full size (a text's style base)
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
// The share of a behind big word's height that stays visible (the face hides the rest).
const MIN_VISIBLE_SHARE = 0.7;
const MAX_HIDDEN_SHARE = 1 - MIN_VISIBLE_SHARE;
const SLACK = 1e-9;
// A whole-pixel size from a scaled one: floored, a float hair under a whole
// number counted as that number (88 * 300/110 is 240).
const wholePx = (size: number): number => Math.floor(size + 1e-6);

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
  // The most lines the text may take; every count up to its word count when
  // unset. Settled: the behind word item carries no `breaks` (the format sets
  // a big word on one line), so the engine passes 1 for it.
  maxLines?: number;
}

export type LevelRole = Level["role"];

// A stack (a LIST item): its entry, the text of each level it shows, in the
// entry's order (a one-item list shows no number; a phrase may have no
// lead-in; the key is always there) and the gap between the levels
// (`transition.gap`). The spec's "Sizes and wrapping": one element, placed
// once; its size is the key's, the lead at its own style's base over the
// key's, the number at the entry's ratio to the key, all shrunk together.
export interface StackElement extends ElementBase {
  type: "stack";
  variant: StackVariant;
  levels: readonly { role: LevelRole; text: string }[];
  gap: number;
}

// Where each level of a placed stack goes, in the order given: each level at a
// whole pixel, centred in the stack's box (the box is as wide as its widest
// level, so every level's left edge is inside it), the levels stacked from the
// box's top with `gap` between. Whole pixels matter: a centre rounded to the
// hundredth put a level 0.0025 px outside the box (its left edge at 34.9975
// against S's 35), which the `safe-box` check reads as outside the safe zone.
export function stackPositions(
  box: Box,
  levels: readonly PlacedLevel[],
  gap: number,
): { role: LevelRole; x: number; y: number }[] {
  // The widest level's width, not the box's (their difference is a float hair
  // either way: the widest level's own offset must be 0, not -1 after a floor).
  const widest = Math.max(...levels.map((level) => level.width));
  let y = box.top;
  return levels.map((level) => {
    const x = box.left + Math.max(0, Math.floor((widest - level.width) / 2 + 1e-6));
    const at = { role: level.role, x, y };
    y += level.height + gap;
    return at;
  });
}

// A box: its entry gives its full width, `aspect` (width over height) is the
// picture's own, so the height follows the picture and nothing is cropped.
export interface BoxElement extends ElementBase {
  type: "box";
  variant: BoxVariant;
  aspect: number;
}

// One caption of a block: set whole on one line, in its own font when the
// caption names one (else the style's).
export interface BlockUnit {
  id: string;
  text: string;
  font?: FontRole;
}

// A caption block (owner decision 4): a sentence's captions as one element,
// placed once, so captions never jump mid-sentence. Its groups are the sets of
// captions on screen together, in time order, each unit one caption. The
// block's size is the largest at which every group fits the spot; its lines
// are free (balanced breaks between whole units), `lineGap` between them
// (`caption.lineGap`).
export interface BlockElement extends ElementBase {
  type: "block";
  variant: TextVariant;
  groups: readonly (readonly BlockUnit[])[];
  lineGap: number;
}

export type PlaceElement = TextElement | StackElement | BoxElement | BlockElement;

// Something already placed over a moment of the element's span. A `caption`
// blocks everything (rule 2); a `text` blocks text (rule 5); a `behind` (a big
// word) blocks text and cards (decision 24); a `box` (a visual's card) blocks
// only the big words, so text may sit on a card (decision 9). The caller passes
// the obstacles whose span shares a moment with the element.
export interface Obstacle {
  id: string;
  kind: "caption" | "text" | "behind" | "box";
  box: Box;
}

export interface PlaceScene {
  // The robust faces over the element's span, unpadded (`facesOver` with no
  // padding). Empty when no head is in its moments.
  faces: readonly Box[];
  obstacles: readonly Obstacle[];
  safe: SafeZone;
  // A big word only: whether a candidate box needs the cut-out (decision 21). One
  // that does keeps off every card (decision 24); one that does not is front text
  // and may sit on a card, drawn above it. Absent: every behind box needs it.
  cutout?: (box: Box) => boolean;
}

// One level of a placed stack, at the stack's chosen size: its own size, its
// lines and `breaks`, and its box's width and height (the stack centres it).
export interface PlacedLevel {
  role: LevelRole;
  size: number;
  lines: string[];
  breaks: number[];
  width: number;
  height: number;
}

// One line of a placed block's group: its units (captions) in order with their
// widths at the block's size, and the line's width (units and the spaces
// between them). The engine lays the units along it.
export interface PlacedLine {
  units: { id: string; width: number }[];
  width: number;
}

// The chosen candidate.
export interface Placed {
  box: Box;
  // A text or a block: its font size. A stack: its key's font size. A box: its width.
  size: number;
  lines: string[]; // a stack: every level's lines; a block: its deepest group's; a box: []
  breaks: number[]; // a stack, a block or a box: [] (a stack's levels carry their own)
  levels: PlacedLevel[]; // a stack's; else []
  groups: PlacedLine[][]; // a block's: each group's lines; else []
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
// largest size that fits a rectangle. A text at `n` lines, a stack with each
// level at its line count, or a box at its aspect.
interface Shape {
  lines: string[];
  // Lines beyond one per text: a text's line count less one, a stack's over
  // its levels. The wrap cost and the `wrapped` outcome count these.
  extraLines: number;
  // The smallest size the shape may take so that every text in it is at least
  // the global minimum: `MIN_SIZE_PX` for a text or a box; for a stack, the
  // size at which its smallest level (the lead-in) reaches it.
  min: number;
  widthAt(size: number): number;
  heightAt(size: number): number;
  fit(rect: Box): number;
  // A stack's levels at a size; a text, a block or a box has none.
  levelsAt?(size: number): PlacedLevel[];
  // A block's groups at a size, each its lines; a text, a stack or a box has none.
  groupsAt?(size: number): PlacedLine[][];
}

// The cuts that set `length` items (words, or a block's captions) on `count`
// lines keeping the widest line narrowest (the balanced break): each line as
// `[from, to)`. `lineWidth(from, to)` is the width of those items on one line,
// measured at size 1 so the break is the same at every size. Settled: ties go
// to the earlier cuts.
function balancedCuts(
  length: number,
  count: number,
  lineWidth: (from: number, to: number) => number,
): [number, number][] {
  const widths = new Map<string, number>();
  const widthOf = (from: number, to: number): number => {
    const key = `${from}:${to}`;
    const known = widths.get(key);
    if (known !== undefined) return known;
    const width = lineWidth(from, to);
    widths.set(key, width);
    return width;
  };
  // best[k][j]: the narrowest widest line of the first j items on k lines, and
  // where its last line starts.
  const best: { width: number; cut: number }[][] = [];
  best[1] = [];
  for (let j = 1; j <= length; j += 1) best[1]![j] = { width: widthOf(0, j), cut: 0 };
  for (let k = 2; k <= count; k += 1) {
    best[k] = [];
    for (let j = k; j <= length; j += 1) {
      let found: { width: number; cut: number } | undefined;
      for (let i = k - 1; i < j; i += 1) {
        const width = Math.max(best[k - 1]![i]!.width, widthOf(i, j));
        if (!found || width < found.width - SLACK) found = { width, cut: i };
      }
      best[k]![j] = found!;
    }
  }
  const lines: [number, number][] = [];
  let end = length;
  for (let k = count; k >= 1; k -= 1) {
    const { cut } = best[k]![end]!;
    lines.unshift([cut, end]);
    end = cut;
  }
  return lines;
}

// The lines of `words` on `count` lines, balanced (above).
function balancedLines(
  words: readonly string[],
  count: number,
  widthOf: (line: string) => number,
): string[] {
  const line = (from: number, to: number) => words.slice(from, to).join(" ");
  return balancedCuts(words.length, count, (from, to) => widthOf(line(from, to))).map(
    ([from, to]) => line(from, to),
  );
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
    extraLines: count - 1,
    min: MIN_SIZE_PX,
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

// A block at one line count: every group on at most `count` lines (a group of
// fewer captions on one per caption), balanced between whole units, the line
// width the units' widths at size 1 and a space between them. The block's
// width is its widest line's, its height its deepest group's: the size that
// fits is the largest at which every group fits (decision 4). Null when the
// block has no text.
function blockShape(element: BlockElement, count: number, measurer: Measurer): Shape | null {
  const { font } = element.variant.style;
  const space = measurer.width(font, 1, " ");
  const groups = element.groups.map((units) => {
    const widths = units.map((unit) => measurer.width(unit.font ?? font, 1, unit.text));
    const lineWidth = (from: number, to: number): number =>
      widths.slice(from, to).reduce((sum, width) => sum + width, 0) + (to - from - 1) * space;
    const cuts = balancedCuts(units.length, Math.min(count, units.length), lineWidth);
    return { units, widths, cuts, lineWidth };
  });
  const perPx = Math.max(
    ...groups.flatMap((group) => group.cuts.map(([from, to]) => group.lineWidth(from, to))),
  );
  if (!(perPx > 0)) return null;
  const deepest = Math.max(...groups.map((group) => group.cuts.length));
  const deep = groups.find((group) => group.cuts.length === deepest)!;
  const gaps = (deepest - 1) * element.lineGap;
  return {
    lines: deep.cuts.map(([from, to]) =>
      deep.units
        .slice(from, to)
        .map((unit) => unit.text)
        .join(" "),
    ),
    extraLines: deepest - 1,
    min: MIN_SIZE_PX,
    widthAt: (size) => size * perPx,
    heightAt: (size) => size * deepest + gaps,
    fit: (rect) =>
      Math.floor(
        Math.min((rect.right - rect.left) / perPx, (rect.bottom - rect.top - gaps) / deepest),
      ),
    groupsAt: (size) =>
      groups.map((group) =>
        group.cuts.map(([from, to]) => ({
          units: group.units
            .slice(from, to)
            .map((unit, index) => ({ id: unit.id, width: group.widths[from + index]! * size })),
          width: group.lineWidth(from, to) * size,
        })),
      ),
  };
}

const ratio = (text: `${number}/${number}`): number => {
  const [a, b] = text.split("/").map(Number);
  return a! / b!;
};

function boxShape(element: BoxElement): Shape {
  const { aspect } = element;
  return {
    lines: [],
    extraLines: 0,
    min: MIN_SIZE_PX,
    widthAt: (size) => size,
    heightAt: (size) => Math.floor(size / aspect),
    fit: (rect) => Math.floor(Math.min(rect.right - rect.left, (rect.bottom - rect.top) * aspect)),
  };
}

// A style's base size. A stack is set from its levels' bases and a block from
// its style's, so a `largest-fit` style has no place in either.
function baseOf(style: TextStyle): number {
  if (style.base === "largest-fit")
    throw new Error("engine-place: a stack level or a block needs a base size");
  return style.base;
}

// One level of a stack at one line count: its share of the stack's size (the
// key's: 1 for the key, its base over the key's for the lead-in, the entry's
// ratio for the number), its lines and the widest line's width at size 1.
interface LevelShape {
  role: LevelRole;
  factor: number;
  lines: string[];
  perPx: number;
}

// A stack at one line count per level. Every level's size is the stack's times
// its factor, floored to a whole pixel; the fit is the linear estimate, which
// the floors only ever come under.
function stackShape(levels: readonly LevelShape[], gap: number): Shape {
  const gaps = gap * (levels.length - 1);
  const widthPerPx = Math.max(...levels.map((level) => level.perPx * level.factor));
  const heightPerPx = levels.reduce((sum, level) => sum + level.factor * level.lines.length, 0);
  const minFactor = Math.min(...levels.map((level) => level.factor));
  const levelsAt = (size: number): PlacedLevel[] =>
    levels.map((level) => {
      const own = wholePx(size * level.factor);
      return {
        role: level.role,
        size: own,
        lines: level.lines,
        breaks: breaksOf(level.lines),
        width: own * level.perPx,
        height: own * level.lines.length,
      };
    });
  return {
    lines: levels.flatMap((level) => level.lines),
    extraLines: levels.reduce((sum, level) => sum + level.lines.length - 1, 0),
    // Settled: the global minimum holds for every level of a stack, so the stack
    // shrinks only until its smallest level (the lead-in, 50 over 110) is at it.
    min: Math.ceil(MIN_SIZE_PX / minFactor - SLACK),
    widthAt: (size) => Math.max(...levelsAt(size).map((level) => level.width)),
    heightAt: (size) => levelsAt(size).reduce((sum, level) => sum + level.height, 0) + gaps,
    fit: (rect) =>
      Math.floor(
        Math.min(
          (rect.right - rect.left) / widthPerPx,
          (rect.bottom - rect.top - gaps) / heightPerPx,
        ),
      ),
    levelsAt,
  };
}

// The key level's entry, the one a stack's size is measured by.
function keyLevelOf(variant: StackVariant): Level {
  const key = variant.levels.find((level) => level.role === "key");
  if (!key) throw new Error(`engine-place: ${variant.variant} has no key level`);
  return key;
}

// Every stack shape: each level on 1 to its word count lines (balanced breaks,
// as a text), every combination.
function stackShapes(element: StackElement, measurer: Measurer): Shape[] {
  const keyBase = baseOf(keyLevelOf(element.variant).style);
  const options = element.levels.map(({ role, text }): LevelShape[] => {
    const entry = element.variant.levels.find((level) => level.role === role);
    if (!entry) throw new Error(`engine-place: ${element.variant.variant} has no ${role} level`);
    const factor = entry.role === "number" ? entry.ratio : baseOf(entry.style) / keyBase;
    const widthOf = (line: string) => measurer.width(entry.style.font, 1, line);
    const words = text.split(" ");
    const shapes: LevelShape[] = [];
    for (let count = 1; count <= words.length; count += 1) {
      const lines = count === 1 ? [text] : balancedLines(words, count, widthOf);
      const perPx = Math.max(...lines.map(widthOf));
      if (perPx > 0) shapes.push({ role, factor, lines, perPx });
    }
    return shapes;
  });
  let combos: LevelShape[][] = [[]];
  for (const levelOptions of options) {
    combos = combos.flatMap((combo) => levelOptions.map((option) => [...combo, option]));
  }
  return combos
    .filter((combo) => combo.length === element.levels.length)
    .map((combo) => stackShape(combo, element.gap));
}

// The shapes an element may take: a text on 1 to its word count lines, a stack
// with each level on 1 to its word count lines, a block with every group on 1
// to its largest group's caption count lines, a box one.
function shapesOf(element: PlaceElement, measurer: Measurer): Shape[] {
  if (element.type === "box") return [boxShape(element)];
  if (element.type === "stack") return stackShapes(element, measurer);
  const count =
    element.type === "block"
      ? Math.max(0, ...element.groups.map((group) => group.length))
      : Math.min(element.text.split(" ").length, element.maxLines ?? Infinity);
  const shapes: Shape[] = [];
  for (let n = 1; n <= count; n += 1) {
    const shape =
      element.type === "block" ? blockShape(element, n, measurer) : textShape(element, n, measurer);
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
  part: number; // the zone part's index (a corner, a side of the face)
  distance: number; // from the box's centre to the centre the part's want asks for
  box: Box;
  size: number;
  shape: Shape;
  coversFace: boolean;
  cost: number;
  shrinkSteps: number;
}

// Whether the element sees an obstacle. A caption is seen by everything (rule 2).
// A text is seen by every text (rule 5), never by a card (decision 9: text may
// sit on a card). A big word (`behind`) is text, and a card never sits on one
// either (decision 24): it is seen by a card too. A card (`box`) is seen only by
// the big words, which are the behind layer.
function sees(element: PlaceElement, o: Obstacle): boolean {
  switch (o.kind) {
    case "caption":
      return true;
    case "text":
      return element.type !== "box";
    case "behind":
      return true;
    case "box":
      return element.variant.layer === "behind";
  }
}

// Which obstacles the element sees (`sees`), each grown by the gap.
function obstacleBoxes(element: PlaceElement, obstacles: readonly Obstacle[]): Box[] {
  return obstacles.filter((o) => sees(element, o)).map((o) => expand(o.box, GAP));
}

// The largest size of `shape` that fits a free rectangle of `area` with the
// obstacles out, at most `cap`; 0 when nothing fits.
function largestFit(shape: Shape, area: Box, obstacles: readonly Box[], cap: number): number {
  let size = 0;
  for (const rect of freeRects(area, obstacles)) size = Math.max(size, shape.fit(rect));
  return Math.min(size, cap);
}

// A spot for a shape in a zone part: its size and box, or null when no size
// at or above the shape's minimum keeps the hard rules there.
interface Fit {
  size: number;
  box: Box;
}

// What a fitter sees: the zone part's area, the centre the shape aims at (by
// its width and height), the obstacles grown by the gap (the notch among
// them), the unpadded faces and whether the text is behind the speaker
// (rule 6), and the cap on the size.
interface FitScene {
  area: Box;
  want: (width: number, height: number) => Point;
  obstacles: readonly Box[];
  faces: readonly Box[];
  behind: boolean;
  cap: number;
}

// Hard rule 6: the face hides at most 30% of a behind text's height. A front
// text has no such rule.
function keepsVisible(box: Box, scene: FitScene): boolean {
  return !scene.behind || bigWordCoveredShare(box, scene.faces) <= MAX_HIDDEN_SHARE + SLACK;
}

// A text with a base size, a stack or a box: the largest size that fits a
// free rectangle of the area with the obstacles out, at the spot nearest the
// want (`freeRects`, `placeBox`).
function freeFit(shape: Shape, scene: FitScene): Fit | null {
  const size = largestFit(shape, scene.area, scene.obstacles, scene.cap);
  // Hard: below the global minimum (for every text in the shape), nothing fits.
  if (size < shape.min) return null;
  const width = shape.widthAt(size);
  const height = shape.heightAt(size);
  const at = placeBox(scene.area, scene.obstacles, width, height, scene.want(width, height));
  if (!at) return null;
  const box: Box = { left: at.x, top: at.y, right: at.x + width, bottom: at.y + height };
  return keepsVisible(box, scene) ? { size, box } : null;
}

// A `largest-fit` text (the big word), owner decision 18 (2026-11-09): its
// largest fit is anchored at the zone's want (the head top), it does not wander
// to a roomier spot elsewhere in the zone. Sizes are searched from the largest
// the area holds down to the minimum, by the pixel; at each, the box is centred
// on the want (moved only as far as keeps it inside the area), then moved up
// towards the area's top, by the pixel, until every hard rule holds: clear of
// the obstacles (the notch, the texts on screen) and, behind the speaker, the
// face hiding at most 30% of it. The first size with such a spot is the fit,
// at the lowest spot that keeps the rules (nearest the want). Settled: the
// moves are by the pixel, not today's 10 px steps, so the fit is exact.
function anchoredFit(shape: Shape, scene: FitScene): Fit | null {
  const { area } = scene;
  const minX = Math.ceil(area.left);
  const top = Math.ceil(area.top);
  for (let size = Math.min(scene.cap, shape.fit(area)); size >= shape.min; size -= 1) {
    const width = shape.widthAt(size);
    const height = shape.heightAt(size);
    const maxX = Math.floor(area.right - width);
    const maxY = Math.floor(area.bottom - height);
    if (maxX < minX || maxY < top) continue;
    const centre = scene.want(width, height);
    const x = Math.min(maxX, Math.max(minX, Math.round(centre.x - width / 2)));
    const start = Math.min(maxY, Math.max(top, Math.round(centre.y - height / 2)));
    for (let y = start; y >= top; y -= 1) {
      const box: Box = { left: x, top: y, right: x + width, bottom: y + height };
      if (!scene.obstacles.some((o) => overlaps(box, o)) && keepsVisible(box, scene)) {
        return { size, box };
      }
    }
  }
  return null;
}

const isAnchored = (element: PlaceElement): boolean =>
  element.type === "text" && element.variant.style.base === "largest-fit";

const fitterOf = (element: PlaceElement) => (isAnchored(element) ? anchoredFit : freeFit);

// Whether some zone of the element's ranking holds it at its minimum size with
// nothing but the notch in the way (and, behind the speaker, the face at most
// 30% over it): the safe zone itself has room for it.
function fitsEmpty(
  element: PlaceElement,
  shapes: readonly Shape[],
  scene: PlaceScene,
  F: Box | null,
): boolean {
  const fit = fitterOf(element);
  const behind = element.variant.layer === "behind";
  for (const zone of element.variant.zones) {
    for (const part of zonesAt(zone, scene.safe, F)) {
      const area = areaOf(part);
      if (!area) continue;
      for (const shape of shapes) {
        const found = fit(shape, {
          area,
          want: (width, height) => centreWant(zone, part, area, F, width, height),
          obstacles: [scene.safe.notch],
          faces: scene.faces,
          behind,
          cap: Infinity,
        });
        if (found) return true;
      }
    }
  }
  return false;
}

// The element's full size, the cap on every candidate and the size the shrink
// steps count from. A text or a block: its style's base size (owner decision
// 2026-11-09: the engine never sets a text above its style's base, it only
// shrinks from it). A stack: its key level's base (the lead-in and the number
// follow by their factors). A box: its `width` share of the frame. The big word's style
// is `largest-fit`: the largest size at which it fits at its first zone's want
// with no text in the way (the notch only; behind the speaker, rule 6 kept),
// over any line count it may take. Settled: when that first zone has no room
// (none, as above a face at the top; or less than the minimum size), the next
// zone of the ranking with room gives it. 0 when no zone has room.
function fullSizeOf(
  element: PlaceElement,
  shapes: readonly Shape[],
  scene: PlaceScene,
  F: Box | null,
): number {
  if (element.type === "box") return Math.floor(FRAME_WIDTH * ratio(element.variant.width));
  if (element.type === "stack") return baseOf(keyLevelOf(element.variant).style);
  if (element.type === "block") return baseOf(element.variant.style);
  const { base } = element.variant.style;
  if (base !== "largest-fit") return base;
  const behind = element.variant.layer === "behind";
  for (const zone of element.variant.zones) {
    let full = 0;
    for (const part of zonesAt(zone, scene.safe, F)) {
      const area = areaOf(part);
      if (!area) continue;
      for (const shape of shapes) {
        const fit = anchoredFit(shape, {
          area,
          want: (width, height) => centreWant(zone, part, area, F, width, height),
          obstacles: [scene.safe.notch],
          faces: scene.faces,
          behind,
          cap: Infinity,
        });
        if (fit) full = Math.max(full, fit.size);
      }
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
// obstacle before the face allowed (a front text; a behind text sits behind
// the speaker by design, so the face is never an obstacle to it, rule 6 bounds
// it instead). A candidate is the fitter's spot (`freeFit`: the largest size
// that fits, capped at the full size, a text's base, so a short text never
// grows past its style, nearest the zone's want; `anchoredFit`: the largest
// size at the want).
function candidates(
  element: PlaceElement,
  shapes: readonly Shape[],
  scene: PlaceScene,
  F: Box | null,
  full: number,
  costs: PlaceCosts,
): Candidate[] {
  const out: Candidate[] = [];
  const fit = fitterOf(element);
  const behind = element.variant.layer === "behind";
  // The cards are obstacles only to a big word, and only where it needs the
  // cut-out (decision 24): searched once without them (a word without a cut-out
  // may sit on a card) and once with them (the cut-out spot clear of every card).
  const cards = behind
    ? scene.obstacles.filter((o) => o.kind === "box").map((o) => expand(o.box, GAP))
    : [];
  const needsCut = scene.cutout ?? (() => true);
  const fixed = [
    scene.safe.notch,
    ...obstacleBoxes(
      element,
      scene.obstacles.filter((o) => o.kind !== "box"),
    ),
  ];
  const passes: readonly Box[][] = behind
    ? cards.length > 0
      ? [fixed, [...fixed, ...cards]]
      : [fixed]
    : F
      ? [[expand(F, GAP), ...fixed], fixed]
      : [fixed];
  element.variant.zones.forEach((zone, rank) => {
    zonesAt(zone, scene.safe, F).forEach((part, index) => {
      const area = areaOf(part);
      if (!area) return;
      const want = (width: number, height: number) =>
        centreWant(zone, part, area, F, width, height);
      for (const shape of shapes) {
        for (const obstacles of passes) {
          const found = fit(shape, {
            area,
            want,
            obstacles,
            faces: scene.faces,
            behind,
            cap: full,
          });
          if (!found) continue;
          const { size, box } = found;
          // A big word that needs the cut-out keeps off every card (decision 24).
          if (behind && needsCut(box) && cards.some((card) => overlaps(box, card))) continue;
          // A behind text never "covers" the face (rule 6 bounds it instead).
          const coversFace = !behind && F !== null && overlaps(box, F);
          const shrinkSteps = shrinkStepsOf(size, full);
          const cost =
            (coversFace ? costs.face : 0) +
            rank * costs.zoneStep +
            shrinkSteps * costs.shrinkStep +
            shape.extraLines * costs.wrap;
          const aimed = want(box.right - box.left, box.bottom - box.top);
          const distance = Math.hypot(
            (box.left + box.right) / 2 - aimed.x,
            (box.top + box.bottom) / 2 - aimed.y,
          );
          out.push({
            rank,
            zone,
            part: index,
            distance,
            box,
            size,
            shape,
            coversFace,
            cost,
            shrinkSteps,
          });
        }
      }
    });
  });
  return out;
}

// The spec's tie-break: cost, the earlier zone, the larger size, fewer lines,
// the higher spot, the further left spot. Negative when `a` wins. Settled (step
// 9): a zone of several parts (the four corners, the two sides of the face) is
// one zone to the ranking, so between its parts the spot nearest its part's
// want wins (the spec's rule inside a zone: "of the spots that fit, the one
// nearest it wins"), then the earlier part (the zone table's order: top-left
// first, the wider side first), before the higher and the further left spot.
// Without it a card pushed along the top edge by the face, far from the
// top-left corner, beat the card sitting exactly in the top-right one.
function compare(a: Candidate, b: Candidate): number {
  return (
    a.cost - b.cost ||
    a.rank - b.rank ||
    b.size - a.size ||
    a.shape.lines.length - b.shape.lines.length ||
    a.distance - b.distance ||
    a.part - b.part ||
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
  element.variant.zones.slice(0, rank + 1).forEach((zone) => {
    for (const part of zonesAt(zone, scene.safe, F)) {
      const area = areaOf(part);
      if (!area) continue;
      for (const o of scene.obstacles) {
        if (!sees(element, o)) continue;
        if (!overlaps(expand(o.box, GAP), area)) continue;
        add(o.kind === "caption" ? { kind: "caption", id: o.id } : { kind: "item", id: o.id });
      }
      if (F && overlaps(expand(F, GAP), area)) add({ kind: "face" });
      if (overlaps(scene.safe.notch, area)) add({ kind: "buttons" });
    }
  });
  return out;
}

// What blocks the element at its minimum size when it fits nowhere in S even
// with no text in the way: the safe zone's sides when it is too wide, the face
// when it is behind the speaker and rule 6 leaves it no spot, else the safe
// zone's top and bottom.
function emptyBlockers(
  element: PlaceElement,
  shapes: readonly Shape[],
  scene: PlaceScene,
): Blocker[] {
  const s = scene.safe.box;
  const fitsWidth = shapes.some((shape) => shape.widthAt(shape.min) <= s.right - s.left + SLACK);
  if (!fitsWidth) {
    return [
      { kind: "safe-zone", edge: "left" },
      { kind: "safe-zone", edge: "right" },
    ];
  }
  if (element.variant.layer === "behind" && scene.faces.length > 0) return [{ kind: "face" }];
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
  switch (element.type) {
    case "text":
      return `${kind} ${element.id} "${element.text}"`;
    case "stack":
      return `${kind} ${element.id} "${element.levels.map((level) => level.text).join(" / ")}"`;
    case "block":
      return `${kind} block ${element.id} "${element.groups
        .flat()
        .map((unit) => unit.text)
        .join(" ")}"`;
    case "box":
      return `${kind} ${element.id}`;
  }
}

const LEVEL_WORDS: Record<LevelRole, string> = {
  number: "number",
  lead: "lead-in",
  key: "key phrase",
};

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
  const roomy = fitsEmpty(element, shapes, scene, F);
  const full = roomy ? fullSizeOf(element, shapes, scene, F) : 0;
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
    const blockers = roomy && taken.length > 0 ? taken : emptyBlockers(element, shapes, scene);
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
  const levels = chosen.shape.levelsAt?.(chosen.size) ?? [];
  const groups = chosen.shape.groupsAt?.(chosen.size) ?? [];
  const wrapped = chosen.shape.extraLines > 0;
  const taken = {
    zone: chosen.zone,
    size: chosen.size,
    lines: lines.length,
    cost: chosen.cost,
  };
  const where = ZONE_WORDS[chosen.zone];
  const notes: EngineNote[] = [];
  const givenUp = chosen.rank > 0 || chosen.shrinkSteps > 0 || wrapped || chosen.coversFace;
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
    const what =
      element.type === "stack"
        ? `shrinks its key phrase to ${chosen.size} px from ${full} px, the other levels with it,`
        : `shrinks to ${chosen.size} px from ${full} px`;
    notes.push({
      ...base,
      ...taken,
      rule: "size",
      outcome: "shrunk",
      blockers,
      reason: `${who} ${what} ${where} ${when}; ${blockerWords(blockers)} took the room`,
    });
  }
  if (wrapped) {
    const what =
      element.type === "stack"
        ? `wraps its ${levels
            .filter((level) => level.lines.length > 1)
            .map((level) => `${LEVEL_WORDS[level.role]} to ${level.lines.length} lines`)
            .join(" and its ")}`
        : `wraps to ${lines.length} lines`;
    notes.push({
      ...base,
      ...taken,
      rule: "size",
      outcome: "wrapped",
      blockers,
      reason: `${who} ${what} ${where} ${when}`,
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
      breaks: element.type === "text" ? breaksOf(lines) : [],
      levels,
      groups,
      zone: chosen.zone,
      cost: chosen.cost,
      coversFace: chosen.coversFace,
    },
    notes,
  };
}
