import { type Box, type HeadTrack, faceBox } from "./head-track.ts";
import type { Measurer } from "./measure.ts";
import { type FontKey, type Preset, cleanWord } from "./preset.ts";
import type { CaptionItem, Edit, OverlayItem } from "./schema.ts";
import type { ResolvedItem, Span } from "./timeline.ts";
import type { Transcript } from "./transcript.ts";

// One piece of text on screen, in frame pixels: `x`, `y` its top left corner,
// `height` its font size (line-height 1).
export interface TextBox extends Span {
  itemId: string;
  kind: "caption" | "accent";
  text: string;
  font: FontKey;
  size: number;
  color: string;
  style: Record<string, string> | undefined;
  x: number;
  y: number;
  width: number;
  height: number;
}

type TextItem = Omit<TextBox, "x" | "y" | "width" | "height"> & {
  position: CaptionItem["position"];
};

// A spot beside the head: `r` is right-anchored at x (text ends there), `l`
// left-anchored at x; `room` the width available.
interface Slot {
  anchor: "r" | "l";
  x: number;
  y: number;
  room: number;
}

// build.py's `_slots`: rows 85 px apart from y 610 (or just below the head's
// top), right-anchored on the left of the face, left-anchored (one half row
// lower) on its right, as long as the side has room.
function slotsBeside(face: Box, preset: Preset): Slot[] {
  const { safe, slots } = preset;
  const leftRoom = face.left - safe.left;
  const rightRoom = safe.right - face.right;
  const out: Slot[] = [];
  const last = Math.min(face.bottom + 120, safe.bottom - 60);
  for (let y = Math.max(face.top + 20, slots.firstRow); y <= last; y += slots.rowGap) {
    const sides: Slot[] = [];
    if (leftRoom >= slots.minLeft) sides.push({ anchor: "r", x: face.left, y, room: leftRoom });
    if (rightRoom >= slots.minRight && y + slots.rightDrop <= safe.bottom - 60) {
      sides.push({ anchor: "l", x: face.right, y: y + slots.rightDrop, room: rightRoom });
    }
    // The wider side first.
    if (rightRoom > leftRoom) sides.reverse();
    out.push(...sides);
  }
  return out;
}

// Texts set in centred lines inside a region, wrapping at its width.
function lines(
  items: readonly TextItem[],
  region: { left: number; right: number; top: number },
  preset: Preset,
  measurer: Measurer,
): TextBox[] {
  const width = region.right - region.left;
  const rows: { item: TextItem; width: number }[][] = [];
  let row: { item: TextItem; width: number }[] = [];
  let used = 0;
  for (const item of items) {
    const w = measurer.width(item.font, item.size, item.text);
    const space = row.length > 0 ? measurer.width(item.font, item.size, " ") : 0;
    if (row.length > 0 && used + space + w > width) {
      rows.push(row);
      row = [];
      used = 0;
    }
    used += (row.length > 0 ? space : 0) + w;
    row.push({ item, width: w });
  }
  if (row.length > 0) rows.push(row);

  const out: TextBox[] = [];
  let y = region.top;
  for (const current of rows) {
    const spaces = current.map(({ item }, index) =>
      index === 0 ? 0 : measurer.width(item.font, item.size, " "),
    );
    const total = current.reduce((sum, { width: w }, index) => sum + w + spaces[index]!, 0);
    let x = region.left + (width - total) / 2;
    for (const [index, { item, width: w }] of current.entries()) {
      x += spaces[index]!;
      out.push(boxAt(item, x, y, w));
      x += w;
    }
    y += Math.max(...current.map(({ item }) => item.size)) + preset.caption.lineGap;
  }
  return out;
}

function boxAt(item: TextItem, x: number, y: number, width: number): TextBox {
  return {
    itemId: item.itemId,
    kind: item.kind,
    text: item.text,
    font: item.font,
    size: item.size,
    color: item.color,
    style: item.style,
    start: item.start,
    end: item.end,
    x,
    y,
    width,
    height: item.size,
  };
}

function anchored(
  item: TextItem,
  x: number,
  y: number,
  align: "left" | "right" | "center",
  width: number,
) {
  const left = align === "left" ? x : align === "right" ? x - width : x - width / 2;
  return boxAt(item, left, y, width);
}

// The caption text the words show by default: each word cleaned, a glossary
// term when the words are one of its heard forms.
function wordsText(ids: readonly string[], transcript: Transcript, preset: Preset): string {
  const byId = new Map(transcript.words.map((word) => [word.id, word]));
  const cleaned = ids.map((id) => cleanWord(byId.get(id)?.text ?? "", preset));
  const lower = cleaned.map((text) => text.toLowerCase());
  for (const entry of preset.glossary) {
    if (entry.heard.some((form) => form.join(" ") === lower.join(" "))) return entry.term;
  }
  return cleaned.join(" ");
}

// Positions for every caption and accent. Items that set a position keep it;
// captions inside a transition go to its text region; other captions, one
// group (same end) at a time, take the spots beside the face over the group's
// span (a word too wide for them, and every caption when no head is in the
// frame, the fallback line); accents are
// centred above the head. Widths are HarfBuzz's.
export function layoutText(
  edit: Edit,
  resolved: ReadonlyMap<string, ResolvedItem>,
  transcript: Transcript,
  headTrack: HeadTrack,
  preset: Preset,
  measurer: Measurer,
): TextBox[] {
  const span = (id: string) => resolved.get(id)!;
  const textItem = (item: CaptionItem | OverlayItem, kind: "caption" | "accent"): TextItem => {
    const font = item.font ?? (kind === "caption" ? preset.caption.font : preset.accent.font);
    const words = item.words ?? [];
    return {
      itemId: item.id,
      kind,
      text: item.text ?? wordsText(words, transcript, preset),
      font,
      size: item.size ?? preset.fonts[font].size,
      color: item.color ?? (kind === "caption" ? preset.caption.color : preset.accent.color),
      style: item.style,
      start: span(item.id).start,
      end: span(item.id).end,
      position: item.position,
    };
  };

  const boxes: TextBox[] = [];
  const place = (item: TextItem): boolean => {
    if (!item.position) return false;
    const width = measurer.width(item.font, item.size, item.text);
    boxes.push(anchored(item, item.position.x, item.position.y, item.position.align, width));
    return true;
  };

  const transitions = edit.tracks.transitions.map((transition) => ({
    transition,
    span: span(transition.id),
    items: [] as TextItem[],
  }));
  const groups: TextItem[][] = [];
  for (const caption of edit.tracks.captions) {
    const item = textItem(caption, "caption");
    if (place(item)) continue;
    const inside = transitions.find((t) => item.start >= t.span.start && item.start < t.span.end);
    if (inside) {
      inside.items.push(item);
      continue;
    }
    const last = groups.at(-1);
    if (last && last[0]!.end === item.end) last.push(item);
    else groups.push([item]);
  }

  for (const { transition, items } of transitions) {
    if (items.length === 0) continue;
    boxes.push(...lines(items, preset.transitions[transition.type].text, preset, measurer));
  }

  const fallback = {
    left: preset.safe.left,
    right: preset.safe.right,
    top: preset.caption.fallbackY,
  };
  for (const group of groups) {
    // The head over the group's span and over each caption's own span: the
    // face check looks at each caption's span, where the median can shift.
    const faces = [
      faceBox(headTrack, group[0]!.start, group[0]!.end),
      ...group.map((item) => faceBox(headTrack, item.start, item.end)),
    ].filter((box) => box !== null);
    const face =
      faces.length === 0
        ? null
        : {
            left: Math.min(...faces.map((box) => box.left)),
            right: Math.max(...faces.map((box) => box.right)),
            top: Math.min(...faces.map((box) => box.top)),
            bottom: Math.max(...faces.map((box) => box.bottom)),
          };
    if (!face) {
      boxes.push(...lines(group, fallback, preset, measurer));
      continue;
    }
    const slots = slotsBeside(face, preset);
    const free = slots.map((_, index) => index);
    const unplaced: TextItem[] = [];
    for (const item of group) {
      const need = measurer.width(item.font, item.size, item.text);
      // The first free spot wide enough; a word too wide for every spot goes
      // to the line below the face.
      const pick = free.find((index) => slots[index]!.room >= need);
      if (pick === undefined) {
        unplaced.push(item);
        continue;
      }
      free.splice(free.indexOf(pick), 1);
      const slot = slots[pick]!;
      boxes.push(anchored(item, slot.x, slot.y, slot.anchor === "r" ? "right" : "left", need));
    }
    if (unplaced.length > 0) {
      const below = {
        ...fallback,
        top: Math.max(fallback.top, face.bottom + preset.caption.lineGap),
      };
      boxes.push(...lines(unplaced, below, preset, measurer));
    }
  }

  for (const overlay of edit.tracks.overlays) {
    const item = textItem(overlay, "accent");
    if (place(item)) continue;
    const face = faceBox(headTrack, item.start, item.end);
    const y = face
      ? Math.max(preset.safe.top + 25, face.top - preset.accent.aboveHead)
      : preset.accent.noHeadY;
    const width = measurer.width(item.font, item.size, item.text);
    boxes.push(anchored(item, (preset.safe.left + preset.safe.right) / 2, y, "center", width));
  }

  return boxes;
}
