import { balancedCuts } from "./engine-place.ts";
import type { FontRole } from "./font-pairs.ts";
import type { Measurer } from "./measure.ts";
import { type Preset, wordsText } from "./preset.ts";
import type { CaptionItem, Edit } from "./schema.ts";
import { type ResolvedItem, type Span, resolveTimeline } from "./timeline.ts";
import { type Transcript, sentenceSpans } from "./transcript.ts";
import { hiddenCaptionIds } from "./transitions.ts";
import { STYLES } from "./variants.ts";

// CAPTION BLOCKS (app_docs/owner-edits.md): the captions of one spoken
// sentence, which the layout engine places once, in one spot (`placeCaptions`,
// `engine-elements.ts`). A block's groups are the sets of captions on screen
// together, in time order. The stored edit holds no block: it is read back
// from the captions the same way the engine made it, so the owner's editor
// can move, resize and re-wrap a sentence's captions as one box.

// A block's id: its first shown caption's id behind a prefix no item id can
// hold (an underscore), so a block is never taken for an item.
export const CAPTION_BLOCK_PREFIX = "block_";

export function isCaptionBlockId(id: string): boolean {
  return id.startsWith(CAPTION_BLOCK_PREFIX);
}

// One set of captions on screen together: the shown captions (their ids, in
// order) that end on the same moment. Its id is its first caption's.
export interface CaptionGroup extends Span {
  id: string;
  captions: string[];
}

export interface CaptionBlock extends Span {
  id: string;
  groups: CaptionGroup[];
}

const SLACK = 0.0005;

// The caption blocks of an edit, in time order. A group is a run of
// consecutive captions ending on the same moment (the engine gives every
// caption of a group its group's end), counted over the captions that show
// (one a text shows in its place, `hidden_by`, takes no room) and have a
// place; a block is the groups whose first caption's first word is in the
// same spoken sentence (`sentenceSpans`), as the engine blocks them.
export function captionBlocks(
  edit: Edit,
  transcript: Transcript,
  resolved: ReadonlyMap<string, ResolvedItem> = resolveTimeline(edit, transcript),
): CaptionBlock[] {
  const hidden = hiddenCaptionIds(edit, resolved);
  const groups: CaptionGroup[] = [];
  let open: CaptionGroup | null = null;
  let openEnd: number | null = null;
  for (const caption of edit.tracks.captions) {
    const span = resolved.get(caption.id);
    if (!span) continue;
    if (openEnd === null || Math.abs(span.end - openEnd) >= SLACK) {
      open = null;
      openEnd = span.end;
    }
    if (hidden.has(caption.id) || !caption.position) continue;
    if (!open) {
      open = { id: caption.id, captions: [], start: span.start, end: span.end };
      groups.push(open);
    }
    open.captions.push(caption.id);
    open.start = Math.min(open.start, span.start);
  }
  const order = new Map(transcript.words.map((word, index) => [word.id, index]));
  const sentences = sentenceSpans(transcript).map((sentence) => ({
    from: order.get(sentence.from)!,
    to: order.get(sentence.to)!,
  }));
  const sentenceOf = (word: string): number => {
    const at = order.get(word);
    return at === undefined
      ? -1
      : sentences.findIndex((sentence) => sentence.from <= at && at <= sentence.to);
  };
  const byId = new Map(edit.tracks.captions.map((caption) => [caption.id, caption]));
  const blocks = new Map<number, CaptionBlock>();
  for (const group of groups) {
    const sentence = sentenceOf(byId.get(group.id)!.words[0]!);
    const block = blocks.get(sentence);
    if (!block) {
      blocks.set(sentence, {
        id: `${CAPTION_BLOCK_PREFIX}${group.id}`,
        groups: [group],
        start: group.start,
        end: group.end,
      });
    } else {
      block.groups.push(group);
      block.start = Math.min(block.start, group.start);
      block.end = Math.max(block.end, group.end);
    }
  }
  return [...blocks.values()].sort((a, b) => a.start - b.start);
}

export function captionFont(caption: Pick<CaptionItem, "font">): FontRole {
  return caption.font ?? STYLES.caption.font;
}

export function captionSize(caption: Pick<CaptionItem, "size">): number {
  return caption.size ?? STYLES.caption.base;
}

// The text a caption draws, as the builder reads it: its own or its words'.
export function captionText(
  caption: Pick<CaptionItem, "text" | "words">,
  transcript: Transcript,
  preset: Preset,
): string {
  return caption.text ?? wordsText(caption.words, transcript, preset);
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// The box around some rectangles.
export function boxAround(rects: readonly Rect[]): Rect {
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((rect) => rect.x + rect.width)) - x,
    height: Math.max(...rects.map((rect) => rect.y + rect.height)) - y,
  };
}

// A placed caption's box, as the builder draws it (`placedText`, `build.ts`).
export function captionRect(
  caption: CaptionItem,
  transcript: Transcript,
  preset: Preset,
  measurer: Measurer,
): Rect {
  const size = captionSize(caption);
  const width = measurer.width(
    captionFont(caption),
    size,
    captionText(caption, transcript, preset),
  );
  const { x, y, align } = caption.position!;
  const left = align === "left" ? x : align === "right" ? x - width : x - width / 2;
  return { x: left, y, width, height: size };
}

// The lines a group's captions are on, as stored: the captions at the same
// height share a line. Each line is the indexes of its captions in the group.
export function storedLines(captions: readonly CaptionItem[]): number[][] {
  const lines: number[][] = [];
  let y: number | null = null;
  captions.forEach((caption, index) => {
    const at = caption.position!.y;
    if (y === null || Math.abs(at - y) >= SLACK) lines.push([]);
    y = at;
    lines.at(-1)!.push(index);
  });
  return lines;
}

// One caption as a block lays it: its text and font.
export interface BlockUnitText {
  id: string;
  text: string;
  font: FontRole;
}

// The widths a group's lines are measured with at a size: each unit's own
// width, and a line's as the engine lays it (the units and a caption-font
// space between them).
function groupWidths(units: readonly BlockUnitText[], size: number, measurer: Measurer) {
  const space = measurer.width(STYLES.caption.font, size, " ");
  const widths = units.map((unit) => measurer.width(unit.font, size, unit.text));
  const lineWidth = (from: number, to: number): number =>
    widths.slice(from, to).reduce((sum, width) => sum + width, 0) + (to - from - 1) * space;
  return { space, widths, lineWidth };
}

// The widest line of each balanced line count of a group at a size, from one
// line to one caption a line: the wrap widths at which its lines change.
export function groupLineWidths(
  units: readonly BlockUnitText[],
  size: number,
  measurer: Measurer,
): number[] {
  const { lineWidth } = groupWidths(units, size, measurer);
  const out: number[] = [];
  for (let count = 1; count <= units.length; count += 1) {
    const cuts = balancedCuts(units.length, lineWidth, count);
    out.push(Math.max(...cuts.map(([from, to]) => lineWidth(from, to))));
  }
  return out;
}

// A group set on the fewest balanced lines (the engine's own balancing, between
// whole captions) whose widest fits `width`; one caption a line when even that
// is wider (a caption is never cut). Each line is the indexes of its captions.
export function wrapGroup(
  units: readonly BlockUnitText[],
  size: number,
  width: number,
  measurer: Measurer,
): number[][] {
  const { lineWidth } = groupWidths(units, size, measurer);
  const indexes = (cuts: [number, number][]) =>
    cuts.map(([from, to]) => Array.from({ length: to - from }, (_, at) => from + at));
  for (let count = 1; count <= units.length; count += 1) {
    const cuts = balancedCuts(units.length, lineWidth, count);
    if (Math.max(...cuts.map(([from, to]) => lineWidth(from, to))) <= width + 1e-6) {
      return indexes(cuts);
    }
  }
  return units.map((_, index) => [index]);
}

// A block laid from its top left corner at a size, as the engine lays it
// (`placeCaptions`): the block is as wide as its widest line, every line is
// centred in it, the lines of a group stack from the block's top with
// `lineGap` between them, and each caption sits on its line after the ones
// before it. Each caption's corner, by its id, and the block's size.
export function layBlock(
  groups: readonly { units: readonly BlockUnitText[]; lines: readonly number[][] }[],
  corner: { x: number; y: number },
  size: number,
  lineGap: number,
  measurer: Measurer,
  // Where the block's width is taken from: its top left corner (the default),
  // or the vertical line its lines are centred on.
  centre?: number,
): { places: Map<string, { x: number; y: number }>; width: number; height: number; x: number } {
  const measured = groups.map((group) => ({
    ...group,
    ...groupWidths(group.units, size, measurer),
  }));
  const lineWidthOf = (group: (typeof measured)[number], line: readonly number[]) =>
    line.reduce((sum, index) => sum + group.widths[index]!, 0) + (line.length - 1) * group.space;
  const width = Math.max(
    ...measured.flatMap((group) => group.lines.map((line) => lineWidthOf(group, line))),
  );
  const deepest = Math.max(...measured.map((group) => group.lines.length));
  const left = centre === undefined ? corner.x : Math.round((centre - width / 2) * 100) / 100;
  const places = new Map<string, { x: number; y: number }>();
  for (const group of measured) {
    let y = corner.y;
    for (const line of group.lines) {
      let x = left + (width - lineWidthOf(group, line)) / 2;
      for (const index of line) {
        places.set(group.units[index]!.id, { x: Math.floor(x * 100 + 1e-6) / 100, y });
        x += group.widths[index]! + group.space;
      }
      y += size + lineGap;
    }
  }
  return { places, width, height: size * deepest + (deepest - 1) * lineGap, x: left };
}
