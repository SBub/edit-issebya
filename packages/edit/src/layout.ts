import { type Box, type HeadTrack, faceBox } from "./head-track.ts";
import type { Measurer } from "./measure.ts";
import { type FontKey, type Preset, cleanWord, fontSize } from "./preset.ts";
import {
  type CaptionItem,
  type Edit,
  type OverlayItem,
  type PhraseTransitionItem,
  isPhraseTransition,
} from "./schema.ts";
import { type ResolvedItem, type Span, phraseWords } from "./timeline.ts";
import type { Transcript } from "./transcript.ts";

// One piece of text on screen, in frame pixels: `x`, `y` its top left corner,
// `height` its font size (line-height 1). A phrase transition's level (its
// number, lead-in or key phrase) is one box per line, `itemId`
// `<transition>-number`, `-lead` or `-key`, with `transitionId` set.
export interface TextBox extends Span {
  itemId: string;
  kind: "caption" | "accent" | "number";
  transitionId?: string;
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

type TextItem = Omit<TextBox, "x" | "y" | "width" | "height" | "transitionId"> & {
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

type Row = { item: TextItem; width: number }[];

// Texts wrapped into rows at a width.
function wrap(items: readonly TextItem[], width: number, measurer: Measurer): Row[] {
  const rows: Row[] = [];
  let row: Row = [];
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
  return rows;
}

function rowsHeight(rows: readonly Row[], preset: Preset): number {
  if (rows.length === 0) return 0;
  const sizes = rows.map((current) => Math.max(...current.map(({ item }) => item.size)));
  return sizes.reduce((sum, size) => sum + size, 0) + preset.caption.lineGap * (rows.length - 1);
}

// The height of the texts set in centred lines at a region's width.
function blockHeight(
  items: readonly TextItem[],
  region: { left: number; right: number },
  preset: Preset,
  measurer: Measurer,
): number {
  return rowsHeight(wrap(items, region.right - region.left, measurer), preset);
}

// Texts set in centred lines inside a region, wrapping at its width. A block
// that would run past the region's bottom moves up to end there (never above
// the safe box's top, where the safe-box check reports it).
function lines(
  items: readonly TextItem[],
  region: Box,
  preset: Preset,
  measurer: Measurer,
): TextBox[] {
  const width = region.right - region.left;
  const rows = wrap(items, width, measurer);
  const out: TextBox[] = [];
  let y = Math.max(preset.safe.top, Math.min(region.top, region.bottom - rowsHeight(rows, preset)));
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
export function wordsText(ids: readonly string[], transcript: Transcript, preset: Preset): string {
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
// centred above the head. Nothing placed here ends below the safe box's
// bottom edge: spots too low for a caption are skipped, wrapped blocks move
// up to end there, and the line below the face moves above it when it would
// not fit. Widths are HarfBuzz's.
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
    const role = kind === "caption" ? preset.roles.captionText : preset.roles.accentText;
    const font = item.font ?? role.font;
    const words = item.words ?? [];
    return {
      itemId: item.id,
      kind,
      text: item.text ?? wordsText(words, transcript, preset),
      font,
      size: item.size ?? fontSize(preset, font),
      color: item.color ?? role.color,
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

  // Phrase transitions set their own captions as levels; a caption whose first
  // word is in a phrase is absorbed (shown only there).
  const phrases = edit.tracks.transitions.filter(isPhraseTransition).map((transition) => {
    const { lead, key } = phraseWords(transition, transcript);
    return { transition, span: span(transition.id), lead, key, captions: [] as CaptionItem[] };
  });
  // Stored timed transitions: captions starting inside move into the text area.
  const timed = edit.tracks.transitions.flatMap((transition) =>
    isPhraseTransition(transition)
      ? []
      : [{ transition, span: span(transition.id), items: [] as TextItem[] }],
  );
  const groups: TextItem[][] = [];
  for (const caption of edit.tracks.captions) {
    const phrase = phrases.find(({ lead, key }) =>
      [...lead, ...key].some((word) => word.id === caption.words[0]),
    );
    if (phrase) {
      phrase.captions.push(caption);
      continue;
    }
    const item = textItem(caption, "caption");
    // Shown in its usual place, it leaves before a phrase transition comes in.
    for (const { span: crossed } of phrases) {
      if (item.start < crossed.start && item.end > crossed.start) item.end = crossed.start;
    }
    if (place(item)) continue;
    const inside = timed.find((t) => item.start >= t.span.start && item.start < t.span.end);
    if (inside) {
      inside.items.push(item);
      continue;
    }
    const last = groups.at(-1);
    if (last && last[0]!.end === item.end) last.push(item);
    else groups.push([item]);
  }

  for (const { transition, items } of timed) {
    if (items.length === 0) continue;
    boxes.push(...lines(items, preset.legacyTransitions[transition.type].text, preset, measurer));
  }
  for (const phrase of phrases) {
    boxes.push(...phraseLevels(phrase, transcript, preset, measurer));
  }

  const fallback: Box = {
    left: preset.safe.left,
    right: preset.safe.right,
    top: preset.caption.fallbackY,
    bottom: preset.safe.bottom,
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
      // The first free spot wide enough whose row keeps the caption above
      // the safe box's bottom edge; a word that fits no spot goes to the line
      // below the face.
      const pick = free.find(
        (index) => slots[index]!.room >= need && slots[index]!.y + item.size <= preset.safe.bottom,
      );
      if (pick === undefined) {
        unplaced.push(item);
        continue;
      }
      free.splice(free.indexOf(pick), 1);
      const slot = slots[pick]!;
      boxes.push(anchored(item, slot.x, slot.y, slot.anchor === "r" ? "right" : "left", need));
    }
    if (unplaced.length > 0) {
      // Below the face when the block ends above the bottom edge; else above
      // the face when that stays under the safe box's top; else the block
      // moved up to end at the bottom edge, where the face check reports it
      // if it covers the face (the check stays the safety net).
      const { lineGap } = preset.caption;
      const height = blockHeight(unplaced, fallback, preset, measurer);
      const belowTop = Math.max(fallback.top, face.bottom + lineGap);
      const aboveTop = face.top - lineGap - height;
      const region =
        belowTop + height <= preset.safe.bottom
          ? { ...fallback, top: belowTop }
          : aboveTop >= preset.safe.top
            ? { ...fallback, top: aboveTop, bottom: aboveTop + height }
            : { ...fallback, top: belowTop };
      boxes.push(...lines(unplaced, region, preset, measurer));
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

type Level = "number" | "lead" | "key";

interface LevelBlock {
  level: Level;
  kind: TextBox["kind"];
  font: FontKey;
  color: string;
  size: number;
  units: string[];
  start: number;
}

// A level's units wrapped into lines at a width, each line one text.
function levelLines(
  block: LevelBlock,
  size: number,
  width: number,
  measurer: Measurer,
): { text: string; width: number }[] {
  const out: { text: string; width: number }[] = [];
  let line: string[] = [];
  for (const unit of block.units) {
    const candidate = [...line, unit].join(" ");
    if (line.length > 0 && measurer.width(block.font, size, candidate) > width) {
      out.push({ text: line.join(" "), width: 0 });
      line = [unit];
    } else {
      line.push(unit);
    }
  }
  if (line.length > 0) out.push({ text: line.join(" "), width: 0 });
  for (const entry of out) entry.width = measurer.width(block.font, size, entry.text);
  return out;
}

// A phrase transition's levels, top to bottom in its library entry's text
// area: the number (`numbered` only, accent text at the entry's scale), the
// lead-in (caption text) and the key phrase (accent text), each a centred
// block, `lineGap` apart. A stack too tall or too wide for the area shrinks
// every size together in steps of 5% down to the preset's floor; what still
// does not fit is laid out anyway, where the checks report it. The stack is
// centred vertically in the area. The level text is the phrase's captions'
// text (a fixed caption stays fixed) and the words no caption carries. Each
// level appears whole on its first word and stays until the transition ends.
function phraseLevels(
  phrase: {
    transition: PhraseTransitionItem;
    span: Span;
    lead: readonly { id: string; start: number }[];
    key: readonly { id: string; start: number }[];
    captions: readonly CaptionItem[];
  },
  transcript: Transcript,
  preset: Preset,
  measurer: Measurer,
): TextBox[] {
  const { transition, span, lead, key, captions } = phrase;
  const entry = preset.transitions[transition.type];
  const { accentText, captionText } = preset.roles;
  const shown = new Set<string>();
  const unitsOf = (words: readonly { id: string }[]) => {
    const units: string[] = [];
    for (const word of words) {
      const caption = captions.find((item) => item.words.includes(word.id));
      if (!caption) {
        units.push(wordsText([word.id], transcript, preset));
        continue;
      }
      if (shown.has(caption.id)) continue;
      shown.add(caption.id);
      units.push(caption.text ?? wordsText(caption.words, transcript, preset));
    }
    return units;
  };
  const leadUnits = unitsOf(lead);
  const keyUnits = unitsOf(key);
  const firstStart = (lead[0] ?? key[0])?.start ?? span.start;
  const blocks: LevelBlock[] = [];
  if (transition.type === "numbered" && transition.number !== undefined) {
    blocks.push({
      level: "number",
      kind: "number",
      font: accentText.font,
      color: accentText.color,
      size: accentText.size * (entry.numberScale ?? 1),
      units: [String(transition.number)],
      start: firstStart,
    });
  }
  if (leadUnits.length > 0) {
    blocks.push({
      level: "lead",
      kind: "caption",
      font: captionText.font,
      color: captionText.color,
      size: captionText.size,
      units: leadUnits,
      start: firstStart,
    });
  }
  if (keyUnits.length > 0) {
    blocks.push({
      level: "key",
      kind: "accent",
      font: accentText.font,
      color: accentText.color,
      size: accentText.size,
      units: keyUnits,
      start: key[0]?.start ?? firstStart,
    });
  }
  const area = entry.text;
  const width = area.right - area.left;
  const height = area.bottom - area.top;
  const { lineGap } = preset.caption;
  const setAt = (scale: number) => {
    const set = blocks.map((block) => {
      const size = Math.round(block.size * scale);
      return { block, size, lines: levelLines(block, size, width, measurer) };
    });
    const rows = set.flatMap(({ size, lines: rowsOf }) => rowsOf.map(() => size));
    const total = rows.reduce((sum, size) => sum + size, 0) + lineGap * (rows.length - 1);
    const widest = Math.max(0, ...set.flatMap(({ lines: rowsOf }) => rowsOf.map((r) => r.width)));
    return { set, total, fits: total <= height && widest <= width };
  };
  const steps = Math.round((1 - preset.transitionRules.shrinkFloor) / 0.05);
  let laid = setAt(1);
  for (let step = 1; step <= steps && !laid.fits; step += 1) {
    laid = setAt(Math.round((1 - 0.05 * step) * 100) / 100);
  }
  const out: TextBox[] = [];
  let y = area.top + Math.max(0, (height - laid.total) / 2);
  for (const { block, size, lines: rowsOf } of laid.set) {
    for (const row of rowsOf) {
      out.push({
        itemId: `${transition.id}-${block.level}`,
        kind: block.kind,
        transitionId: transition.id,
        text: row.text,
        font: block.font,
        size,
        color: block.color,
        style: undefined,
        start: block.start,
        end: span.end,
        x: area.left + (width - row.width) / 2,
        y,
        width: row.width,
        height: size,
      });
      y += size + lineGap;
    }
  }
  return out;
}
