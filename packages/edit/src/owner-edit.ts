import {
  bigWordNeedsCutout,
  paddedSpan,
  placedBigWord,
  rotatedBounds,
  wholeDegrees,
} from "./behind.ts";
import { build } from "./build.ts";
import type { PlacedComponent } from "./components.ts";
import type { EngineComponent, EngineNote } from "./engine-note.ts";
import { MIN_SIZE_PX, balancedLines } from "./engine-place.ts";
import { SAFE_ZONE } from "./engine-zones.ts";
import { type Box, type HeadTrack, boundingBox, facesOver } from "./head-track.ts";
import type { FontRole } from "./font-pairs.ts";
import { breaksOf, textLines } from "./lines.ts";
import type { Measurer } from "./measure.ts";
import { ISSEBYA_PRESET, type Preset, wordsText } from "./preset.ts";
import { isQuestion, questionText } from "./question.ts";
import type { BehindVisualItem, Edit, TransitionLevel } from "./schema.ts";
import { resolveTimeline } from "./timeline.ts";
import type { Transcript } from "./transcript.ts";
import { LEVEL_ROLES, levelBoxes, levelStyle } from "./transitions.ts";
import { STYLES, VISUAL_STAND_INS } from "./variants.ts";

// THE OWNER'S MOVES (app_docs/owner-edits.md): in the studio the owner moves
// and resizes a text component or a VISUAL on screen, and Save makes a new
// version from them. A component has one box for its whole time on screen, so
// a move moves it for all of it. A text's place, its text size and, through
// its wrap width, its line breaks change: never its words, its time or what
// its variant draws inside the box. A VISUAL's box moves, scales (keeping
// its picture's aspect ratio) and turns about its centre; a text never turns.

// The components the owner may move and resize: every text pick and the
// VISUALs. Captions are not.
export const MOVABLE_COMPONENTS: readonly EngineComponent[] = [
  "ACCENT",
  "QUESTION",
  "BIGWORD",
  "LIST",
  "HOOK",
  "VISUAL",
];

export function isMovable(component: Pick<PlacedComponent, "component">): boolean {
  return MOVABLE_COMPONENTS.includes(component.component);
}

// One move: the component's id, the top left corner of its box in frame pixels
// and its text size (a LIST's is its key phrase's; its other levels keep their
// ratio to it). A move that only moves keeps the size; one that only resizes
// keeps the corner. `width`, when set, is the wrap width in frame pixels at the
// move's size: the text is set again on the fewest balanced lines whose widest
// fits it (a LIST: its lead-in and its key phrase each), so a wider box has
// fewer lines and a narrower one more, the letters never stretched. Without
// it the version's own lines are kept. A big word has no wrap width.
export interface OwnerTextMove {
  id: string;
  kind?: never;
  x: number;
  y: number;
  size: number;
  width?: number;
}

// One move of a VISUAL: its box's top left corner and its width in frame
// pixels, upright. Its height follows from its picture's aspect ratio
// (`boxHeight`), so a VISUAL is only ever scaled in proportion. `rotation`,
// when set, turns the box about its centre, in whole degrees clockwise (any
// angle, kept as -179 to 180); without it the card keeps its own turn.
export interface OwnerBoxMove {
  id: string;
  kind: "box";
  x: number;
  y: number;
  width: number;
  rotation?: number;
}

export type OwnerMove = OwnerTextMove | OwnerBoxMove;

export function isBoxMove(move: OwnerMove): move is OwnerBoxMove {
  return move.kind === "box";
}

// The largest turn a move may ask for, either way, in degrees.
const MAX_ROTATION = 360;

function isRotation(rotation: unknown): rotation is number {
  return (
    typeof rotation === "number" && Number.isInteger(rotation) && Math.abs(rotation) <= MAX_ROTATION
  );
}

// The narrowest a VISUAL may be made, in frame pixels: a card still worth a
// look. The safe zone bounds the widest (`settleOwnerMove`).
const MIN_BOX_PX = 100;

// The largest text size of the format (`schema.ts`): an overlay or a level.
const MAX_TEXT_SIZE = 400;

// How many moves one save may carry: more than any reel has components.
export const OWNER_MOVES_MAX = 200;

const SLACK = 1e-6;

// A wrap width larger than any frame: past it a width is not a width.
const MAX_WRAP_WIDTH = 100_000;

interface Context {
  transcript: Transcript;
  headTrack: HeadTrack;
  preset: Preset;
  measurer: Measurer;
}

// A job's moves as they arrive (untrusted JSON): a list of at most
// `OWNER_MOVES_MAX` moves, no id twice, each either a text's (an id, finite
// coordinates, a whole size and optionally a positive wrap width) or a
// VISUAL's box (`kind: "box"`, an id, finite coordinates, a positive width
// and optionally a turn in whole degrees, -360 to 360). Null when it is
// anything else.
export function parseOwnerMoves(json: unknown): OwnerMove[] | null {
  if (!Array.isArray(json) || json.length === 0 || json.length > OWNER_MOVES_MAX) return null;
  const moves: OwnerMove[] = [];
  const seen = new Set<string>();
  for (const entry of json as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const { id, kind, x, y, size, width, rotation } = entry as Record<string, unknown>;
    if (typeof id !== "string" || id.length === 0 || id.length > 64 || seen.has(id)) return null;
    if (typeof x !== "number" || typeof y !== "number") return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    seen.add(id);
    if (kind === "box") {
      if (size !== undefined || !isWrapWidth(width)) return null;
      if (rotation !== undefined && !isRotation(rotation)) return null;
      moves.push(
        rotation === undefined ? { id, kind, x, y, width } : { id, kind, x, y, width, rotation },
      );
      continue;
    }
    if (kind !== undefined || rotation !== undefined) return null;
    if (typeof size !== "number" || !Number.isInteger(size)) return null;
    if (width !== undefined && !isWrapWidth(width)) return null;
    moves.push(typeof width === "number" ? { id, x, y, size, width } : { id, x, y, size });
  }
  return moves;
}

function visualOf(edit: Edit, id: string): BehindVisualItem | null {
  const item = (edit.tracks.behind ?? []).find((entry) => entry.id === id);
  return item?.kind === "visual" ? item : null;
}

// A VISUAL's height at a width: its picture's aspect ratio (its box's own,
// for a VISUAL with no picture), at whole pixels; its own height at its own
// width, so a move that only moves changes nothing else.
function boxHeight(item: BehindVisualItem, width: number): number {
  if (Math.abs(width - item.box.width) < SLACK) return item.box.height;
  const picture = VISUAL_STAND_INS.find((entry) => entry.file === item.image);
  const aspect = picture ? picture.height / picture.width : item.box.height / item.box.width;
  return Math.max(1, Math.round(width * aspect));
}

function isWrapWidth(width: unknown): width is number {
  return (
    typeof width === "number" && Number.isFinite(width) && width > 0 && width <= MAX_WRAP_WIDTH
  );
}

// The lines of a text set at `size` in `font` on the fewest balanced lines (the
// engine's own balancing) whose widest fits `width`; one word a line when even
// that is wider (a word is never cut).
function wrapToWidth(
  text: string,
  font: FontRole,
  size: number,
  width: number,
  measurer: Measurer,
): string[] {
  const words = text.split(" ");
  const widthOf = (line: string) => measurer.width(font, size, line);
  for (let count = 1; count <= words.length; count += 1) {
    const lines = count === 1 ? [text] : balancedLines(words, count, widthOf);
    if (Math.max(...lines.map(widthOf)) <= width + SLACK) return lines;
  }
  return words;
}

// The widest line of each balanced line count of a text at `size`, from one
// line to one word a line: the wrap widths at which its lines change.
function lineWidths(text: string, font: FontRole, size: number, measurer: Measurer): number[] {
  const words = text.split(" ");
  const widthOf = (line: string) => measurer.width(font, size, line);
  const widths: number[] = [];
  for (let count = 1; count <= words.length; count += 1) {
    const lines = count === 1 ? [text] : balancedLines(words, count, widthOf);
    widths.push(Math.max(...lines.map(widthOf)));
  }
  return widths;
}

// An overlay's font (an accent, a question or the hook): its own, or the
// accent style's, as the builder reads it.
function overlayFont(item: { font?: FontRole }): FontRole {
  return item.font ?? STYLES.accent.font;
}

// The text an overlay draws (an accent, a question or the hook), as the
// builder reads it: its own text or its words, a question's with its question
// mark (`questionText`), so its lines are set on what is on screen.
function overlayText(
  item: { id: string; kind: string; text?: string; words?: string[] },
  transcript: Transcript,
  preset: Preset,
): string {
  const written = item.text ?? wordsText(item.words ?? [], transcript, preset);
  return isQuestion(item) ? questionText(written) : written;
}

// `breaks` for a text's lines: none on one line.
function breaksFor(lines: readonly string[]): { breaks?: number[] } {
  return lines.length > 1 ? { breaks: breaksOf(lines) } : {};
}

function withoutBreaks<T extends { breaks?: number[] }>(item: T): Omit<T, "breaks"> {
  const copy = { ...item };
  delete copy.breaks;
  return copy;
}

// The sizes a component may take: never under the placer's 30 px (a LIST: its
// smallest level never under it) nor above the format's largest text (a big
// word: the frame's height). The safe zone bounds it further (`settleOwnerMove`).
export function ownerSizeRange(edit: Edit, id: string, preset: Preset): [number, number] | null {
  const overlay = edit.tracks.overlays.find((item) => item.id === id);
  if (overlay) return [MIN_SIZE_PX, MAX_TEXT_SIZE];
  const word = (edit.tracks.behind ?? []).find((item) => item.id === id && item.kind === "word");
  if (word) return [MIN_SIZE_PX, preset.frame.height];
  const list = edit.tracks.transitions.find((item) => item.id === id);
  if (list?.levels) {
    const key = list.levels.key.size;
    const sizes = LEVEL_ROLES.flatMap((role) => {
      const level = list.levels![role];
      return level ? [level.size] : [];
    });
    return [
      Math.ceil((MIN_SIZE_PX * key) / Math.min(...sizes)),
      Math.floor((MAX_TEXT_SIZE * key) / Math.max(...sizes)),
    ];
  }
  return null;
}

// The edit with the moves applied, nothing else changed. An accent, a question
// or the hook: its `position` (its box's top left corner, left-aligned, which
// draws the same as any other alignment of the same box), its `size` and, with
// a wrap width, its `breaks`. A big word: its `position` and `size`. A LIST:
// every level, moved with the box and scaled about its top left corner (each
// level's size and its offset inside the box times the key phrase's new size
// over its old one), at whole pixels; with a wrap width its lead-in and key
// phrase are set again to it and the levels stacked again, each centred on the
// widest as the engine stacks them, the gaps between them scaled. Refused with
// reasons: an id that is no text component of the edit (a caption and a VISUAL
// are not moved), a size outside the component's range, a wrap width on a big
// word or one that is no positive number. A VISUAL's box move writes its
// `box` and, with a turn, its `rotation` (none when upright).
export function applyOwnerMoves(
  edit: Edit,
  moves: readonly OwnerMove[],
  { transcript, preset, measurer }: Pick<Context, "transcript" | "preset" | "measurer">,
): { ok: true; edit: Edit } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const byId = new Map<string, OwnerTextMove>();
  const boxes = new Map<string, OwnerBoxMove>();
  for (const move of moves) {
    if (byId.has(move.id) || boxes.has(move.id)) {
      reasons.push(`${move.id}: moved twice`);
      continue;
    }
    const visual = visualOf(edit, move.id);
    if (isBoxMove(move) || visual) {
      if (!visual) reasons.push(`${move.id}: not a visual of this version`);
      else if (!isBoxMove(move)) reasons.push(`${move.id}: a visual moves as a box`);
      else if (!Number.isFinite(move.x) || !Number.isFinite(move.y)) {
        reasons.push(`${move.id}: its place is not a number`);
      } else if (
        !Number.isFinite(move.width) ||
        move.width < MIN_BOX_PX - SLACK ||
        move.width > preset.frame.width + SLACK
      ) {
        reasons.push(
          `${move.id}: width ${move.width} is outside ${MIN_BOX_PX} to ${preset.frame.width} px`,
        );
      } else if (move.rotation !== undefined && !isRotation(move.rotation)) {
        reasons.push(`${move.id}: its turn is not whole degrees from -360 to 360`);
      }
      if (isBoxMove(move)) boxes.set(move.id, move);
      continue;
    }
    const range = ownerSizeRange(edit, move.id, preset);
    if (!range) reasons.push(`${move.id}: not a text component of this version`);
    else if (!Number.isInteger(move.size) || move.size < range[0] || move.size > range[1]) {
      reasons.push(`${move.id}: size ${move.size} is outside ${range[0]} to ${range[1]} px`);
    } else if (!Number.isFinite(move.x) || !Number.isFinite(move.y)) {
      reasons.push(`${move.id}: its place is not a number`);
    } else if (move.width !== undefined && !isWrapWidth(move.width)) {
      reasons.push(`${move.id}: its wrap width is not a positive number`);
    } else if (move.width !== undefined && isBigWord(edit, move.id)) {
      reasons.push(`${move.id}: a big word keeps its lines`);
    }
    byId.set(move.id, move);
  }
  if (reasons.length > 0) return { ok: false, reasons };

  const levels = levelBoxes(
    edit,
    resolveTimeline(edit, transcript),
    new Map(transcript.words.map((word) => [word.id, word])),
    preset,
    measurer,
  );
  const overlays = edit.tracks.overlays.map((item) => {
    const move = byId.get(item.id);
    if (!move) return item;
    const placed = {
      ...item,
      position: { x: move.x, y: move.y, align: "left" as const },
      size: move.size,
    };
    if (move.width === undefined) return placed;
    const text = overlayText(item, transcript, preset);
    return {
      ...withoutBreaks(placed),
      ...breaksFor(wrapToWidth(text, overlayFont(item), move.size, move.width, measurer)),
    };
  });
  const behind = edit.tracks.behind?.map((item) => {
    if (item.kind === "visual") {
      const box = boxes.get(item.id);
      if (!box) return item;
      const width = Math.round(box.width);
      const rotation = box.rotation === undefined ? item.rotation : wholeDegrees(box.rotation);
      const turned = { ...item };
      delete turned.rotation;
      return {
        ...turned,
        box: { x: Math.round(box.x), y: Math.round(box.y), width, height: boxHeight(item, width) },
        ...(rotation ? { rotation } : {}),
      };
    }
    const move = byId.get(item.id);
    if (!move) return item;
    return { ...item, position: { x: move.x, y: move.y }, size: move.size };
  });
  const transitions = edit.tracks.transitions.map((item) => {
    const move = byId.get(item.id);
    if (!move || !item.levels) return item;
    const own = levels.filter((level) => level.transitionId === item.id);
    const left = Math.min(...own.map((level) => level.x));
    const top = Math.min(...own.map((level) => level.y));
    const scale = move.size / item.levels.key.size;
    const restacked =
      move.width === undefined
        ? null
        : restack(item.levels, own, { ...move, width: move.width }, scale, measurer);
    const moved = (role: (typeof LEVEL_ROLES)[number]): TransitionLevel | undefined => {
      const level = item.levels![role];
      const box = own.find((entry) => entry.role === role);
      if (!level || !box) return level;
      const size = role === "key" ? move.size : Math.round(level.size * scale);
      const again = restacked?.get(role);
      if (again) {
        return {
          ...withoutBreaks(level),
          position: { x: again.x, y: again.y, align: "left" },
          size,
          ...breaksFor(again.lines),
        };
      }
      return {
        ...level,
        position: {
          x: Math.round(move.x + (box.x - left) * scale),
          y: Math.round(move.y + (box.y - top) * scale),
          align: "left",
        },
        size,
      };
    };
    const number = moved("number");
    const lead = moved("lead");
    return {
      ...item,
      levels: {
        ...(number ? { number } : {}),
        ...(lead ? { lead } : {}),
        key: moved("key")!,
      },
    };
  });
  return {
    ok: true,
    edit: {
      ...edit,
      tracks: { ...edit.tracks, overlays, transitions, ...(behind ? { behind } : {}) },
    },
  };
}

function isBigWord(edit: Edit, id: string): boolean {
  return (edit.tracks.behind ?? []).some((item) => item.id === id && item.kind === "word");
}

// A LIST's levels set again to a wrap width: the number keeps its line, the
// lead-in and the key phrase are wrapped to the width at their new sizes, and
// the levels are stacked from the move's corner in their order on screen, each
// centred on the widest (as `stackPositions` stacks them), the gap before each
// the version's gap scaled. Whole pixels.
function restack(
  levels: NonNullable<Edit["tracks"]["transitions"][number]["levels"]>,
  own: readonly { role: (typeof LEVEL_ROLES)[number]; y: number; height: number }[],
  move: OwnerTextMove & { width: number },
  scale: number,
  measurer: Measurer,
): Map<(typeof LEVEL_ROLES)[number], { x: number; y: number; lines: string[] }> {
  const order = [...own].sort((a, b) => a.y - b.y);
  const shaped = order.map((box, index) => {
    const level = levels[box.role]!;
    const size = box.role === "key" ? move.size : Math.round(level.size * scale);
    const { font } = levelStyle(box.role);
    const lines =
      box.role === "number"
        ? textLines(level.text, level.breaks)
        : wrapToWidth(level.text, font, size, move.width, measurer);
    const width = Math.max(...lines.map((line) => measurer.width(font, size, line)));
    const before = order[index - 1];
    const gap = before ? (box.y - (before.y + before.height)) * scale : 0;
    return { role: box.role, lines, width, height: size * lines.length, gap };
  });
  const widest = Math.max(...shaped.map((level) => level.width));
  const out = new Map<(typeof LEVEL_ROLES)[number], { x: number; y: number; lines: string[] }>();
  let y = move.y;
  for (const level of shaped) {
    y += level.gap;
    out.set(level.role, {
      x: Math.round(move.x + Math.max(0, Math.floor((widest - level.width) / 2 + SLACK))),
      y: Math.round(y),
      lines: level.lines,
    });
    y += level.height;
  }
  return out;
}

// The wrap widths a component may take at a size, from one line to one word a
// line (a LIST: every width at which its lead-in or its key phrase changes
// lines), each with the box it gives, widest first; boxes that come out the
// same are given once. What the studio's edge handles choose from: a width
// handle takes the widest option that fits where it was dragged, a height
// handle the option whose height is nearest. Null for a big word (its one or
// two words keep their lines) and anything that is no text component.
export function ownerWrapOptions(
  edit: Edit,
  id: string,
  at: { x: number; y: number; size: number },
  context: Context,
): { width: number; boxWidth: number; boxHeight: number }[] | null {
  const { measurer, transcript, preset } = context;
  let widths: number[];
  const overlay = edit.tracks.overlays.find((item) => item.id === id);
  const list = edit.tracks.transitions.find((item) => item.id === id && item.levels);
  if (overlay) {
    const text = overlayText(overlay, transcript, preset);
    widths = lineWidths(text, overlayFont(overlay), at.size, measurer);
  } else if (list?.levels) {
    const scale = at.size / list.levels.key.size;
    widths = (["lead", "key"] as const).flatMap((role) => {
      const level = list.levels![role];
      if (!level) return [];
      const size = role === "key" ? at.size : Math.round(level.size * scale);
      return lineWidths(level.text, levelStyle(role).font, size, measurer);
    });
  } else {
    return null;
  }
  const options: { width: number; boxWidth: number; boxHeight: number }[] = [];
  for (const width of [...new Set(widths)].sort((a, b) => b - a)) {
    const applied = applyOwnerMoves(edit, [{ id, ...at, width }], context);
    if (!applied.ok) return null;
    const box = boxOf(applied.edit, id, context);
    if (!box) return null;
    const same = options.some(
      (option) =>
        Math.abs(option.boxWidth - box.width) < 0.5 &&
        Math.abs(option.boxHeight - box.height) < 0.5,
    );
    if (!same) options.push({ width, boxWidth: box.width, boxHeight: box.height });
  }
  return options;
}

// Where a box of this size sits nearest `at` inside the safe zone S and clear
// of the platform buttons' notch: clamped into S, then, when it still reaches
// the notch, moved the shorter way out of it (left of the column or above it).
// Null when the box is larger than S.
export function fitInSafeZone(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number } | null {
  const { box: safe, notch } = SAFE_ZONE;
  if (box.width > safe.right - safe.left + SLACK || box.height > safe.bottom - safe.top + SLACK) {
    return null;
  }
  let x = Math.min(Math.max(box.x, safe.left), safe.right - box.width);
  let y = Math.min(Math.max(box.y, safe.top), safe.bottom - box.height);
  if (x + box.width > notch.left + SLACK && y + box.height > notch.top + SLACK) {
    const left = notch.left - box.width;
    const up = notch.top - box.height;
    const canLeft = left >= safe.left - SLACK;
    const canUp = up >= safe.top - SLACK;
    if (!canLeft && !canUp) return null;
    if (canLeft && (!canUp || x - left <= y - up)) x = left;
    else y = up;
  }
  return { x, y };
}

// The least share of a VISUAL's rectangle (the upright one around it when it is
// turned) that stays inside the frame: a card may reach past the safe zone and
// even past the frame's edge, but never so far that it is lost off screen.
const VISUAL_MIN_SHOWN = 0.2;

type Rect = { x: number; y: number; width: number; height: number };

// The share of a rectangle inside the frame (0 to 1).
export function shownShare(rect: Rect, frame: { width: number; height: number }): number {
  if (rect.width <= 0 || rect.height <= 0) return 0;
  const across = Math.max(0, Math.min(rect.x + rect.width, frame.width) - Math.max(rect.x, 0));
  const down = Math.max(0, Math.min(rect.y + rect.height, frame.height) - Math.max(rect.y, 0));
  return (across * down) / (rect.width * rect.height);
}

// Where one axis of a rectangle must start to show `length` of it inside
// `0..size`, moved the shorter way (the side it is past).
function shownAt(at: number, extent: number, size: number, length: number): number {
  const shown = Math.max(0, Math.min(at + extent, size) - Math.max(at, 0));
  if (shown >= length - SLACK) return at;
  return at + extent / 2 < size / 2 ? length - extent : size - length;
}

// The nearest place for a rectangle that keeps `VISUAL_MIN_SHOWN` of it inside
// the frame: where it is when it already does, else the least move along one
// axis or both (each axis then showing the square root of the share).
export function fitInFrame(
  rect: Rect,
  frame: { width: number; height: number } = ISSEBYA_PRESET.frame,
): { x: number; y: number } {
  if (shownShare(rect, frame) >= VISUAL_MIN_SHOWN - SLACK) return { x: rect.x, y: rect.y };
  const across = Math.min(rect.width, frame.width);
  const down = Math.min(rect.height, frame.height);
  const shareX =
    Math.max(0, Math.min(rect.x + rect.width, frame.width) - Math.max(rect.x, 0)) / rect.width;
  const shareY =
    Math.max(0, Math.min(rect.y + rect.height, frame.height) - Math.max(rect.y, 0)) / rect.height;
  const root = Math.sqrt(VISUAL_MIN_SHOWN);
  const options: { x: number; y: number }[] = [];
  // One axis alone, when the other already shows enough for the product.
  if (shareY > 0 && VISUAL_MIN_SHOWN / shareY <= across / rect.width + SLACK) {
    options.push({
      x: shownAt(rect.x, rect.width, frame.width, (VISUAL_MIN_SHOWN / shareY) * rect.width),
      y: rect.y,
    });
  }
  if (shareX > 0 && VISUAL_MIN_SHOWN / shareX <= down / rect.height + SLACK) {
    options.push({
      x: rect.x,
      y: shownAt(rect.y, rect.height, frame.height, (VISUAL_MIN_SHOWN / shareX) * rect.height),
    });
  }
  // Both axes, each to the square root of the share at least.
  options.push({
    x: shownAt(rect.x, rect.width, frame.width, Math.max(shareX, root) * rect.width),
    y: shownAt(rect.y, rect.height, frame.height, Math.max(shareY, root) * rect.height),
  });
  return options.reduce((best, option) =>
    Math.hypot(option.x - rect.x, option.y - rect.y) < Math.hypot(best.x - rect.x, best.y - rect.y)
      ? option
      : best,
  );
}

// Why a component's box breaks the owner's hard rules. A text stays inside the
// safe zone S and clear of the buttons' notch (what the platforms cover is
// never readable). A VISUAL is free of the safe zone, even past the frame's
// edge, but keeps `VISUAL_MIN_SHOWN` of the upright rectangle around it inside
// the frame. Empty when every one holds. Everything else (the face, other
// text) is the owner's choice; the version's checks record it.
export function ownerMoveProblems(
  components: readonly PlacedComponent[],
  ids: readonly string[],
  frame: { width: number; height: number } = ISSEBYA_PRESET.frame,
): string[] {
  const { box: safe, notch } = SAFE_ZONE;
  const reasons: string[] = [];
  for (const id of ids) {
    const placed = components.find((component) => component.id === id);
    if (!placed) {
      reasons.push(`${id}: not on screen in this version`);
      continue;
    }
    const at = rotatedBounds(placed, placed.rotation ?? 0);
    if (placed.component === "VISUAL") {
      if (shownShare(at, frame) < VISUAL_MIN_SHOWN - SLACK) {
        reasons.push(`${id}: less than a fifth of it is inside the frame`);
      }
      continue;
    }
    const right = at.x + at.width;
    const bottom = at.y + at.height;
    if (
      at.x < safe.left - SLACK ||
      right > safe.right + SLACK ||
      at.y < safe.top - SLACK ||
      bottom > safe.bottom + SLACK
    ) {
      reasons.push(`${id}: runs past the safe zone`);
    } else if (right > notch.left + SLACK && bottom > notch.top + SLACK) {
      reasons.push(`${id}: runs into the platform button column`);
    }
  }
  return reasons;
}

function round(n: number): number {
  return Math.round(n);
}

// One move made legal, and the edit with it: a wrap width no wider than the
// safe zone, the size brought into the component's range and shrunk until its
// box fits the safe zone (a wrap width shrinks with it, so the lines stay),
// then the box moved the least it must to be inside the safe zone and clear of
// the notch, at whole pixels. What the studio shows after a drag and what the worker
// accepts are this same result. Refused when the id is no text component or
// its text fits nowhere in the safe zone even at its smallest size.
export function settleOwnerMove(
  edit: Edit,
  move: OwnerMove,
  context: Context,
): { ok: true; move: OwnerMove; edit: Edit } | { ok: false; reasons: string[] } {
  if (isBoxMove(move)) return settleBoxMove(edit, move, context);
  const range = ownerSizeRange(edit, move.id, context.preset);
  if (!range) return { ok: false, reasons: [`${move.id}: not a text component of this version`] };
  const { box: safe } = SAFE_ZONE;
  let size = Math.min(Math.max(round(move.size), range[0]), range[1]);
  let x = round(move.x);
  let y = round(move.y);
  let width =
    move.width === undefined
      ? undefined
      : Math.min(move.width * (size / move.size), safe.right - safe.left);
  const resize = (next: number) => {
    if (width !== undefined) width *= next / size;
    size = next;
  };
  const asked = (): OwnerTextMove =>
    width === undefined ? { id: move.id, x, y, size } : { id: move.id, x, y, size, width };
  // Each pass shrinks or moves; a text that still does not fit at its smallest
  // size ends the loop.
  for (let pass = 0; pass < 8; pass += 1) {
    const applied = applyOwnerMoves(edit, [asked()], context);
    if (!applied.ok) return applied;
    const at = boxOf(applied.edit, move.id, context);
    if (!at) return { ok: false, reasons: [`${move.id}: not on screen in this version`] };
    const share = Math.min(
      (safe.right - safe.left) / at.width,
      (safe.bottom - safe.top) / at.height,
    );
    if (share < 1 - SLACK) {
      if (size <= range[0]) {
        return { ok: false, reasons: [`${move.id}: does not fit the safe zone at any size`] };
      }
      resize(Math.max(range[0], Math.min(size - 1, Math.floor(size * share))));
      continue;
    }
    const spot = fitInSafeZone({ x: at.x, y: at.y, width: at.width, height: at.height });
    if (!spot) {
      if (size <= range[0]) {
        return { ok: false, reasons: [`${move.id}: does not fit the safe zone at any size`] };
      }
      resize(size - 1);
      continue;
    }
    // Whole pixels, the box kept inside: its left and top edges round up, and a
    // box whose right or bottom edge then passes the zone steps back one.
    const nx = Math.ceil(spot.x - SLACK);
    const ny = Math.ceil(spot.y - SLACK);
    const fx = nx + at.width > safe.right + SLACK ? nx - 1 : nx;
    const fy = ny + at.height > safe.bottom + SLACK ? ny - 1 : ny;
    if (Math.abs(fx - at.x) < SLACK && Math.abs(fy - at.y) < SLACK) {
      return { ok: true, move: asked(), edit: applied.edit };
    }
    x += fx - at.x;
    y += fy - at.y;
  }
  return { ok: false, reasons: [`${move.id}: no place inside the safe zone`] };
}

// A VISUAL's move made legal: its turn in whole degrees (-179 to 180), its
// width at least `MIN_BOX_PX`, at most the frame's width and shrunk (its
// height with it, in proportion) while its height passes the frame's, then the
// box moved the least it must to keep `VISUAL_MIN_SHOWN` of the upright
// rectangle around it inside the frame, at whole pixels. The safe zone does
// not bind a card. Refused when the id is no VISUAL.
function settleBoxMove(
  edit: Edit,
  move: OwnerBoxMove,
  context: Context,
): { ok: true; move: OwnerMove; edit: Edit } | { ok: false; reasons: string[] } {
  const visual = visualOf(edit, move.id);
  if (!visual) return { ok: false, reasons: [`${move.id}: not a visual of this version`] };
  const { frame } = context.preset;
  const rotation = wholeDegrees(move.rotation ?? visual.rotation ?? 0);
  let width = Math.min(frame.width, Math.max(MIN_BOX_PX, Math.round(move.width)));
  while (width > MIN_BOX_PX && boxHeight(visual, width) > frame.height) width -= 1;
  const height = boxHeight(visual, width);
  const x = Math.round(move.x);
  const y = Math.round(move.y);
  const bounds = rotatedBounds({ x, y, width, height }, rotation);
  const spot = fitInFrame(bounds, frame);
  // The upright box under the rectangle's spot, at whole pixels: the nearest
  // corners first, then the ones a pixel further in, the first legal one.
  const corner = wholeCorners(spot.x - (bounds.x - x), spot.y - (bounds.y - y)).find(
    (at) =>
      shownShare(rotatedBounds({ ...at, width, height }, rotation), frame) >=
      VISUAL_MIN_SHOWN - SLACK,
  );
  if (!corner) return { ok: false, reasons: [`${move.id}: no place inside the frame`] };
  const settled: OwnerBoxMove = {
    id: move.id,
    kind: "box",
    ...corner,
    width,
    ...(move.rotation !== undefined || visual.rotation ? { rotation } : {}),
  };
  const applied = applyOwnerMoves(edit, [settled], context);
  if (!applied.ok) return applied;
  return { ok: true, move: settled, edit: applied.edit };
}

// Whole-pixel corners near a place, nearest first: the place rounded up (as
// an upright box always settles), then each way a pixel either side.
function wholeCorners(x: number, y: number): { x: number; y: number }[] {
  const baseX = Math.ceil(x - SLACK);
  const baseY = Math.ceil(y - SLACK);
  const out: { x: number; y: number }[] = [];
  for (const dy of [0, -1, 1]) {
    for (const dx of [0, -1, 1]) out.push({ x: baseX + dx, y: baseY + dy });
  }
  return out;
}

function boxOf(edit: Edit, id: string, context: Context): PlacedComponent | null {
  const { components } = build(
    edit,
    context.transcript,
    context.headTrack,
    context.preset,
    context.measurer,
    { layer: "front" },
  );
  return components.find((component) => component.id === id) ?? null;
}

// Whether a component's box or size differs from another placement of it: a
// new corner is a move; a new size, or a box of another width or height (its
// lines set again), is a resize; a VISUAL's new turn is a rotation.
function differs(
  a: PlacedComponent,
  b: PlacedComponent,
): { moved: boolean; resized: boolean; rotated: boolean } {
  return {
    moved: Math.abs(a.x - b.x) >= 0.5 || Math.abs(a.y - b.y) >= 0.5,
    resized:
      a.size !== b.size ||
      Math.abs(a.width - b.width) >= 0.5 ||
      Math.abs(a.height - b.height) >= 0.5,
    rotated: (a.rotation ?? 0) !== (b.rotation ?? 0),
  };
}

function changes(change: { moved: boolean; resized: boolean; rotated: boolean }): boolean {
  return change.moved || change.resized || change.rotated;
}

// The moves that change something: a move whose corner and size (a VISUAL's
// corner, width and turn) are the component's own in `components` (the
// version being edited) and that sets no wrap width is left out. With `after` (the components with the moves
// applied, as the studio's draft has them), a move is left out when its
// component's box and size there are the version's own, a rewrap that came
// back to the version's lines included.
export function effectiveMoves(
  moves: readonly OwnerMove[],
  components: readonly PlacedComponent[],
  after?: readonly PlacedComponent[],
): OwnerMove[] {
  return moves.filter((move) => {
    const at = components.find((component) => component.id === move.id);
    if (!at) return true;
    if (after) {
      const now = after.find((component) => component.id === move.id);
      if (!now) return true;
      return changes(differs(now, at));
    }
    if (isBoxMove(move)) {
      return (
        Math.abs(at.x - move.x) >= 0.5 ||
        Math.abs(at.y - move.y) >= 0.5 ||
        Math.abs(at.width - move.width) >= 0.5 ||
        (move.rotation !== undefined && wholeDegrees(move.rotation) !== (at.rotation ?? 0))
      );
    }
    return (
      move.width !== undefined ||
      Math.abs(at.x - move.x) >= 0.5 ||
      Math.abs(at.y - move.y) >= 0.5 ||
      at.size !== move.size
    );
  });
}

// The big words' `cutout` after a move: whether the head reaches the word over
// its padded span, the layout engine's own rule (`bigWordNeedsCutout`). A word
// moved above the head is plain text with no mask; one moved onto the head
// goes behind the speaker and needs a mask, which only the worker can make, so
// the worker calls this before it saves and the studio's draft does not.
export function withOwnerCutouts(
  edit: Edit,
  ids: readonly string[],
  { transcript, headTrack, preset, measurer }: Context,
): Edit {
  const behind = edit.tracks.behind;
  if (!behind || !behind.some((item) => item.kind === "word" && ids.includes(item.id))) {
    return edit;
  }
  const resolved = resolveTimeline(edit, transcript);
  return {
    ...edit,
    tracks: {
      ...edit.tracks,
      behind: behind.map((item) => {
        if (item.kind !== "word" || !ids.includes(item.id)) return item;
        const span = resolved.get(item.id);
        if (!span || !item.position || !item.size) return item;
        const at = placedBigWord(item, item.position, item.size, measurer);
        const box: Box = {
          left: at.x,
          right: at.x + at.width,
          top: at.y,
          bottom: at.y + at.height,
        };
        return {
          ...item,
          cutout: bigWordNeedsCutout(box, headTrack, paddedSpan(span, edit.duration, preset)),
        };
      }),
    },
  };
}

// A box and a text size, as the learning record stores a placement.
export interface RecordedPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  size: number | null;
}

// One component the owner moved or resized, for learning placement rules
// later (the `owner_moves` table): where the engine placed it, where the owner
// put it, and what was on screen with it at that moment.
export interface OwnerMoveRecord {
  item: string;
  component: EngineComponent;
  // The entry the engine placed it with ("accent/above-head"), when its record
  // names one.
  variant: string | null;
  text: string;
  start: number;
  end: number;
  engine: RecordedPlacement;
  owner: RecordedPlacement;
  moved: boolean;
  resized: boolean;
  // A VISUAL turned: the engine's turn (always 0, the engine never turns a
  // card) and the owner's, in whole degrees clockwise. 0 and 0 for a text.
  rotated: boolean;
  engine_rotation: number;
  owner_rotation: number;
  // The wrap width the owner set (frame pixels at the owner's size), or null
  // when the version's lines were kept.
  wrap_width: number | null;
  // The engine-placed version `engine` was read from; set by the worker.
  engine_version_id?: string;
  context: {
    frame: { width: number; height: number };
    font_pair: string;
    // The head over the component's time on screen: the box around the robust
    // faces of the head track (`facesOver`); null with no head.
    head: Box | null;
    // The zone the engine took for it, when its record names one.
    engine_zone: string | null;
    // Everything else on screen during its time, where the owner's version has
    // it; `moved_by_owner` when that is not where the engine placed it.
    others: {
      item: string;
      component: EngineComponent;
      text: string;
      start: number;
      end: number;
      box: RecordedPlacement;
      // A turned VISUAL's turn, in degrees; absent when upright.
      rotation?: number;
      moved_by_owner: boolean;
    }[];
  };
}

// The wrap width a text's move set; a VISUAL's width is its box's, never a
// wrap width.
function wrapWidthOf(move: OwnerMove | undefined): number | null {
  return move && !isBoxMove(move) ? (move.width ?? null) : null;
}

function placementOf(at: PlacedComponent): RecordedPlacement {
  return { x: at.x, y: at.y, width: at.width, height: at.height, size: at.size };
}

// The learning records of one save: one per moved id whose place, size or
// turn is not the engine's. `engine` holds the components where the layout engine
// placed them (the engine-placed version the owner's edits started from),
// `owner` the components of the version being saved, `moves` the moves saved
// (their wrap widths).
export function ownerMoveRecords({
  ids,
  moves = [],
  engine,
  owner,
  edit,
  headTrack,
  preset,
  engineRecord = [],
}: {
  ids: readonly string[];
  moves?: readonly OwnerMove[];
  engine: readonly PlacedComponent[];
  owner: readonly PlacedComponent[];
  edit: Pick<Edit, "font_pair">;
  headTrack: HeadTrack;
  preset: Preset;
  engineRecord?: readonly EngineNote[];
}): OwnerMoveRecord[] {
  const placed = new Map(engine.map((component) => [component.id, component]));
  const records: OwnerMoveRecord[] = [];
  for (const id of ids) {
    const mine = owner.find((component) => component.id === id);
    const theirs = placed.get(id);
    if (!mine || !theirs) continue;
    const change = differs(mine, theirs);
    if (!changes(change)) continue;
    const note = engineRecord.find((entry) => entry.item === id && entry.zone !== undefined);
    const variant = engineRecord.find((entry) => entry.item === id)?.variant ?? null;
    records.push({
      item: id,
      component: mine.component,
      variant,
      text: mine.text,
      start: mine.start,
      end: mine.end,
      engine: placementOf(theirs),
      owner: placementOf(mine),
      ...change,
      engine_rotation: theirs.rotation ?? 0,
      owner_rotation: mine.rotation ?? 0,
      wrap_width: wrapWidthOf(moves.find((move) => move.id === id)),
      context: {
        frame: { width: preset.frame.width, height: preset.frame.height },
        font_pair: edit.font_pair,
        head: boundingBox(facesOver(headTrack, mine.start, mine.end)),
        engine_zone: note?.zone ?? null,
        others: owner
          .filter(
            (other) =>
              other.id !== id && other.start < mine.end - SLACK && mine.start < other.end - SLACK,
          )
          .map((other) => {
            const was = placed.get(other.id);
            return {
              item: other.id,
              component: other.component,
              text: other.text,
              start: other.start,
              end: other.end,
              box: placementOf(other),
              ...(other.rotation ? { rotation: other.rotation } : {}),
              moved_by_owner: was ? changes(differs(other, was)) : false,
            };
          }),
      },
    });
  }
  return records;
}
