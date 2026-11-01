import type { Box, Preset } from "./preset.ts";
import type { Item, Track } from "./schema.ts";
import type { HeadTrack } from "./transcript.ts";
import type { Measurer } from "./measure.ts";

// An item with its anchors resolved to seconds.
export interface ResolvedItem {
  id: string;
  track: Track;
  item: Item;
  start: number;
  end: number;
}

// Where one text item sits: pixels rounded to two decimals, seconds to three.
export interface LayoutEntry {
  id: string;
  track: "captions" | "overlays" | "transitions";
  text: string;
  font: string;
  size: number;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
  start: number;
  end: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

// The face's box over [t0, t1] (the reference build's `face_box`): samples in
// the window give or take 0.1 s, else every sample; median centre, widest
// head, highest top; null when the track has no head at all.
export function faceBox(headTrack: HeadTrack, t0: number, t1: number, preset: Preset): Box | null {
  const all = headTrack.filter((sample) => sample !== null);
  if (all.length === 0) return null;
  const near = all.filter((sample) => t0 - 0.1 <= sample.t && sample.t <= t1 + 0.1);
  const samples = near.length > 0 ? near : all;
  const cx = median(samples.map((sample) => sample.cx));
  const width = Math.max(...samples.map((sample) => sample.head_w));
  const top = Math.max(0, Math.min(...samples.map((sample) => sample.head_top)));
  const { faceMargin, faceHeightRatio } = preset.caption;
  return {
    left: cx - Math.floor(width / 2) - faceMargin.left,
    right: cx + Math.floor(width / 2) + faceMargin.right,
    top,
    bottom: top + Math.floor(width * faceHeightRatio),
  };
}

function colorOf(color: string, preset: Preset): string {
  return preset.colors[color] ?? color;
}

// When a caption leaves the screen: its end less the fade, but never before
// it has been fully on screen for the minimum time.
export function hideAt(start: number, end: number, preset: Preset): number {
  const { fade, minOnScreen } = preset.caption;
  return Math.max(end - fade, start + minOnScreen);
}

interface Placed {
  box: Box;
  start: number;
  until: number;
}

interface Slot {
  // "r": the text ends at x; "l": it starts at x; "c": it is centred on x.
  anchor: "r" | "l" | "c";
  x: number;
  y: number;
  room: number;
}

// Rows beside the face (the reference build's `_slots`): the wider side's
// rows `lineGap` apart from the face's top plus 20, never above `minRowTop`.
function slotsBeside(face: Box, preset: Preset): Slot[] {
  const { safe } = preset;
  const leftRoom = face.left - safe.left;
  const rightRoom = safe.right - face.right;
  const slots: Slot[] = [];
  for (
    let y = Math.max(face.top + 20, preset.caption.minRowTop);
    y <= Math.min(face.bottom + 120, safe.bottom - 60);
    y += preset.caption.lineGap
  ) {
    if (leftRoom >= 110) slots.push({ anchor: "r", x: face.left, y, room: leftRoom });
    if (rightRoom >= 90 && y + 42 <= safe.bottom - 60) {
      slots.push({ anchor: "l", x: face.right, y: y + 42, room: rightRoom });
    }
  }
  // The wider side first, each side top to bottom.
  const wider = leftRoom >= rightRoom ? "r" : "l";
  return [
    ...slots.filter((slot) => slot.anchor === wider),
    ...slots.filter((slot) => slot.anchor !== wider),
  ];
}

function boxAt(slot: Slot, width: number, size: number): Box {
  const left =
    slot.anchor === "r" ? slot.x - width : slot.anchor === "l" ? slot.x : slot.x - width / 2;
  return { left, right: left + width, top: slot.y, bottom: slot.y + size };
}

function intersects(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

export interface LayoutInput {
  resolved: ResolvedItem[];
  headTrack: HeadTrack;
  preset: Preset;
  measurer: Measurer;
}

// Every text item's place, filling from the preset whatever the item does not
// set (font, size, colour). An item with a position keeps it. A caption
// without one takes the first free row beside the face that fits it, else a
// row above the head, else the widest row shrunk to fit; with no face, the
// low centred line (or a free line above it). An accent without a position
// is centred above the head. Text that still does not fit is shrunk, never
// hidden: the checks report what stays outside the safe box.
export function layoutText({ resolved, headTrack, preset, measurer }: LayoutInput): LayoutEntry[] {
  const { safe } = preset;
  const centre = (safe.left + safe.right) / 2;
  const safeRoom = safe.right - safe.left;
  const placed: Placed[] = [];
  const entries: LayoutEntry[] = [];

  const fit = (font: string, text: string, size: number, room: number) => {
    const width = measurer.width(font, text, size);
    if (width <= room) return { size, width };
    const shrunk = Math.max(1, Math.floor((size * (room - 4)) / width));
    return { size: shrunk, width: measurer.width(font, text, shrunk) };
  };

  const free = (box: Box, start: number, until: number) =>
    !placed.some(
      (other) => other.start < until && start < other.until && intersects(box, other.box),
    );

  const add = (
    entry: ResolvedItem,
    text: string,
    font: string,
    size: number,
    width: number,
    color: string,
    box: Box,
  ) => {
    placed.push({
      box,
      start: entry.start,
      until: hideAt(entry.start, entry.end, preset) + preset.caption.fade,
    });
    entries.push({
      id: entry.id,
      track: entry.track as LayoutEntry["track"],
      text,
      font,
      size: round2(size),
      color: colorOf(color, preset),
      x: round2(box.left),
      y: round2(box.top),
      width: round2(width),
      height: round2(size),
      start: entry.start,
      end: entry.end,
    });
  };

  for (const entry of resolved) {
    const { item, start, end } = entry;
    const until = hideAt(start, end, preset) + preset.caption.fade;
    const style = item.style ?? {};
    let text: string;
    let fontKey: string;
    let colorKey: string;
    if (entry.track === "captions" && "text" in item && item.text !== undefined) {
      text = item.text;
      fontKey = style.font ?? preset.caption.font;
      colorKey = style.color ?? preset.caption.color;
    } else if (entry.track === "overlays" && "text" in item && item.text !== undefined) {
      text = item.text;
      fontKey = style.font ?? preset.accent.font;
      colorKey = style.color ?? preset.accent.color;
    } else if (entry.track === "transitions" && "type" in item && item.text !== undefined) {
      text = item.text;
      fontKey = style.font ?? preset.transitionText.font;
      colorKey = style.color ?? preset.transitionText.color;
    } else {
      continue;
    }
    const wanted = style.size ?? preset.fonts[fontKey]!.size;

    if (style.position) {
      const width = measurer.width(fontKey, text, wanted);
      const { x, y } = style.position;
      add(entry, text, fontKey, wanted, width, colorKey, {
        left: x,
        right: x + width,
        top: y,
        bottom: y + wanted,
      });
      continue;
    }

    const face = faceBox(headTrack, start, end, preset);
    if (entry.track === "transitions" && "type" in item) {
      const { size, width } = fit(fontKey, text, wanted, safeRoom);
      const y = preset.transitionText.top[item.type] ?? safe.top;
      add(
        entry,
        text,
        fontKey,
        size,
        width,
        colorKey,
        boxAt({ anchor: "c", x: centre, y, room: safeRoom }, width, size),
      );
      continue;
    }
    if (entry.track === "overlays") {
      const { size, width } = fit(fontKey, text, wanted, safeRoom);
      const y = face ? Math.max(safe.top + 25, face.top - preset.accent.aboveHead) : safe.top + 25;
      add(
        entry,
        text,
        fontKey,
        size,
        width,
        colorKey,
        boxAt({ anchor: "c", x: centre, y, room: safeRoom }, width, size),
      );
      continue;
    }

    // A caption.
    if (!face) {
      const { size, width } = fit(fontKey, text, wanted, safeRoom);
      let chosen: Box | null = null;
      for (let row = 0; row < 4 && !chosen; row += 1) {
        const y = preset.caption.lowLineTop - row * preset.caption.lineGap;
        const box = boxAt({ anchor: "c", x: centre, y, room: safeRoom }, width, size);
        if (free(box, start, until)) chosen = box;
      }
      chosen ??= boxAt(
        { anchor: "c", x: centre, y: preset.caption.lowLineTop, room: safeRoom },
        width,
        size,
      );
      add(entry, text, fontKey, size, width, colorKey, chosen);
      continue;
    }
    const slots = slotsBeside(face, preset);
    const need = measurer.width(fontKey, text, wanted);
    let done = false;
    for (const slot of slots) {
      if (slot.room < need) continue;
      const box = boxAt(slot, need, wanted);
      if (!free(box, start, until)) continue;
      add(entry, text, fontKey, wanted, need, colorKey, box);
      done = true;
      break;
    }
    if (done) continue;
    const above: Slot = { anchor: "c", x: centre, y: face.top - 70, room: safeRoom };
    if (need <= safeRoom && above.y >= safe.top) {
      const box = boxAt(above, need, wanted);
      if (free(box, start, until)) {
        add(entry, text, fontKey, wanted, need, colorKey, box);
        continue;
      }
    }
    const candidates = slots.length > 0 ? slots : [{ ...above, y: preset.caption.lowLineTop }];
    // Sorting is stable: equal rooms keep their order.
    const byRoom = [...candidates].sort((a, b) => b.room - a.room);
    const widest =
      byRoom.find((slot) => free(boxAt(slot, Math.min(need, slot.room), wanted), start, until)) ??
      byRoom[0]!;
    const { size, width } = fit(fontKey, text, wanted, widest.room);
    add(entry, text, fontKey, size, width, colorKey, boxAt(widest, width, size));
  }

  return entries.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
