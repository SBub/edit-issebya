import {
  type EngineComponent,
  type OwnerBoxMove,
  type OwnerMove,
  type OwnerTextMove,
  type PlacedComponent,
  isMovable,
} from "@edit-issebya/edit";

// The move and resize editor's own logic (app_docs/owner-edits.md), with no
// DOM in it: which components can be picked and when, what a drag means in
// frame pixels, and the draft's list of moves.

// The component's kind in the owner's words, shown on the selected box and in
// the list of texts.
const LABELS: Partial<Record<EngineComponent, string>> = {
  ACCENT: "Accent",
  QUESTION: "Question",
  BIGWORD: "Big word",
  LIST: "List",
  HOOK: "Hook",
  VISUAL: "Visual",
};

export function componentLabel(component: EngineComponent): string {
  return (Object.hasOwn(LABELS, component) ? LABELS[component] : undefined) ?? "Text";
}

// The components the owner may move, in the order they come on screen.
export function movableComponents(components: readonly PlacedComponent[]): PlacedComponent[] {
  return components
    .filter(isMovable)
    .sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// The movable components on screen at `seconds`.
export function movableAt(
  components: readonly PlacedComponent[],
  seconds: number,
): PlacedComponent[] {
  return movableComponents(components).filter(
    (component) => component.start <= seconds && seconds < component.end,
  );
}

const TEXT_MAX = 28;

// One line of the list of texts: the kind and the start of its text.
export function componentOption(component: PlacedComponent): string {
  const text =
    component.text.length > TEXT_MAX
      ? `${component.text.slice(0, TEXT_MAX - 1).trimEnd()}…`
      : component.text;
  return `${componentLabel(component.component)}: ${text}`;
}

// How long before a component's end the preview stops to show it whole: past
// its way in (a text rises in, a question types its words, a list brings its
// levels one by one) and before its way out.
const BEFORE_END_SECONDS = 0.4;

// The moment to show a component picked from the list: near its end, where it
// is whole on screen; the middle of one too short for that.
export function showMoment(component: Pick<PlacedComponent, "start" | "end">): number {
  const length = component.end - component.start;
  const at =
    length > BEFORE_END_SECONDS * 2
      ? component.end - BEFORE_END_SECONDS
      : component.start + length / 2;
  return Math.round(at * 1000) / 1000;
}

// A drag on screen, in frame pixels: `scale` is frame pixels per screen pixel
// (the frame's width over the preview's width on screen).
// `resize` is the corner handle (the text size, in proportion); `left` and
// `right` are the edge handles that set the box's width, `top` and `bottom`
// the ones that set its height (both by setting its lines again).
export type DragMode = "move" | "resize" | EdgeMode;
export type EdgeMode = "left" | "right" | "top" | "bottom";
export const EDGE_MODES: readonly EdgeMode[] = ["left", "right", "top", "bottom"];

export interface Drag {
  mode: DragMode;
  dx: number;
  dy: number;
}

// Under this many screen pixels a press is a click (it selects), not a drag.
export const CLICK_SLOP_PX = 3;

// The smallest a resize drag may make a box, as a share of its size, so a
// handle dragged past the box's corner never turns it inside out.
const MIN_RESIZE_SHARE = 0.05;

// The share a resize drag scales the box by: the direction the handle moved
// further in, as a share of the box, so dragging the corner handle along
// either edge resizes it, larger or smaller.
export function resizeShare(
  component: Pick<PlacedComponent, "width" | "height">,
  drag: Pick<Drag, "dx" | "dy">,
): number {
  const across = (component.width + drag.dx) / component.width;
  const down = (component.height + drag.dy) / component.height;
  const share = Math.abs(across - 1) >= Math.abs(down - 1) ? across : down;
  return Math.max(MIN_RESIZE_SHARE, share);
}

// The narrowest or shortest an edge drag may make a box, in frame pixels.
const MIN_EDGE_PX = 20;

// Whether a component's lines can be set again by its edge handles: every
// text but a big word (one or two words that keep their lines). A VISUAL has
// no lines: its corner handle scales it in proportion, and it has no edge
// handles.
export function canRewrap(component: Pick<PlacedComponent, "component">): boolean {
  return (
    isMovable(component) && component.component !== "BIGWORD" && component.component !== "VISUAL"
  );
}

// The box a component shows while it is dragged, before it is settled: moved
// by the drag, scaled about its top left corner, or one edge moved with the
// opposite edge kept.
export function draggedBox(
  component: Pick<PlacedComponent, "x" | "y" | "width" | "height">,
  drag: Drag | null,
): { x: number; y: number; width: number; height: number } {
  const { x, y, width, height } = component;
  if (!drag) return { x, y, width, height };
  if (drag.mode === "move") return { x: x + drag.dx, y: y + drag.dy, width, height };
  if (drag.mode === "right") return { x, y, width: Math.max(MIN_EDGE_PX, width + drag.dx), height };
  if (drag.mode === "bottom") {
    return { x, y, width, height: Math.max(MIN_EDGE_PX, height + drag.dy) };
  }
  if (drag.mode === "left") {
    const next = Math.max(MIN_EDGE_PX, width - drag.dx);
    return { x: x + width - next, y, width: next, height };
  }
  if (drag.mode === "top") {
    const next = Math.max(MIN_EDGE_PX, height - drag.dy);
    return { x, y: y + height - next, width, height: next };
  }
  const share = resizeShare(component, drag);
  return { x, y, width: width * share, height: height * share };
}

// What a finished drag asks for, before its lines are chosen (`resolveAsk`)
// and it is made legal (`settleOwnerMove`): a move, or for an edge handle the
// width or height the box was dragged to and the edge that stays where it was
// (the right edge for the left handle, the bottom edge for the top one).
// A VISUAL's ask is its box (`kind: "box"`): moved, or scaled about its corner.
export interface OwnerTextAsk extends OwnerTextMove {
  height?: number;
  keep?: { right?: number; bottom?: number };
}

export type OwnerAsk = OwnerTextAsk | OwnerBoxMove;

// The ask of a finished drag: a move keeps the size, a resize keeps the
// corner, an edge handle keeps the size and asks for a width or a height. A
// VISUAL's move or corner resize asks for its box (its height follows its
// picture). Null for an edge handle on a VISUAL or any other component with
// no text size.
export function moveOfDrag(component: PlacedComponent, drag: Drag): OwnerAsk | null {
  if (component.component === "VISUAL") {
    if (drag.mode === "move") {
      return {
        id: component.id,
        kind: "box",
        x: component.x + drag.dx,
        y: component.y + drag.dy,
        width: component.width,
      };
    }
    if (drag.mode !== "resize") return null;
    return {
      id: component.id,
      kind: "box",
      x: component.x,
      y: component.y,
      width: Math.round(component.width * resizeShare(component, drag)),
    };
  }
  if (component.size === null) return null;
  if (
    drag.mode === "left" ||
    drag.mode === "right" ||
    drag.mode === "top" ||
    drag.mode === "bottom"
  ) {
    const box = draggedBox(component, drag);
    const at = { id: component.id, x: component.x, y: component.y, size: component.size };
    if (drag.mode === "right") return { ...at, width: box.width };
    if (drag.mode === "left") {
      return { ...at, width: box.width, keep: { right: component.x + component.width } };
    }
    if (drag.mode === "bottom") return { ...at, height: box.height };
    return { ...at, height: box.height, keep: { bottom: component.y + component.height } };
  }
  if (drag.mode === "move") {
    return {
      id: component.id,
      x: component.x + drag.dx,
      y: component.y + drag.dy,
      size: component.size,
    };
  }
  return {
    id: component.id,
    x: component.x,
    y: component.y,
    size: Math.round(component.size * resizeShare(component, drag)),
  };
}

// How close, in screen pixels, a dragged box's centre comes to one of the
// frame's centre lines before it snaps onto it.
export const SNAP_PX = 8;

// A move drag with its box's centre snapped to the frame's vertical and
// horizontal centre lines, each axis on its own: within `threshold` frame
// pixels of a line the drag is moved so the centre sits on it. `snapped` says
// which guide shows. Any other drag is left as it is. What the snapped drag
// asks for is still settled (`settleOwnerMove`), so the safe zone wins.
export function snapDrag<T extends Drag>(
  component: Pick<PlacedComponent, "x" | "y" | "width" | "height">,
  drag: T,
  frame: { width: number; height: number },
  threshold: number,
): { drag: T; snapped: { x: boolean; y: boolean } } {
  if (drag.mode !== "move") return { drag, snapped: { x: false, y: false } };
  const offX = frame.width / 2 - (component.x + drag.dx + component.width / 2);
  const offY = frame.height / 2 - (component.y + drag.dy + component.height / 2);
  const x = Math.abs(offX) <= threshold;
  const y = Math.abs(offY) <= threshold;
  return {
    drag: { ...drag, dx: x ? drag.dx + offX : drag.dx, dy: y ? drag.dy + offY : drag.dy },
    snapped: { x, y },
  };
}

// One wrap width a component may take and the box it gives
// (`ownerWrapOptions`, widest first).
export interface WrapOption {
  width: number;
  boxWidth: number;
  boxHeight: number;
}

// The move an edge drag asks for, from the component's wrap options: a width
// takes the widest option that fits in it (the narrowest when none does), a
// height the option whose box is nearest it (the wider of two as near). The
// kept edge stays where it was. An ask with neither is a plain move.
export function resolveAsk(ask: OwnerTextAsk, options: readonly WrapOption[]): OwnerTextMove {
  const move: OwnerTextMove = { id: ask.id, x: ask.x, y: ask.y, size: ask.size };
  if (ask.width === undefined && ask.height === undefined) return move;
  if (options.length === 0) return ask.width === undefined ? move : { ...move, width: ask.width };
  let chosen: WrapOption;
  if (ask.height !== undefined) {
    const target = ask.height;
    chosen = options.reduce((best, option) =>
      Math.abs(option.boxHeight - target) < Math.abs(best.boxHeight - target) - 1e-6
        ? option
        : best,
    );
  } else {
    const target = ask.width!;
    chosen = options.find((option) => option.width <= target + 1e-6) ?? options.at(-1)!;
  }
  return {
    ...move,
    x: ask.keep?.right !== undefined ? ask.keep.right - chosen.boxWidth : ask.x,
    y: ask.keep?.bottom !== undefined ? ask.keep.bottom - chosen.boxHeight : ask.y,
    width: chosen.width,
  };
}

// The draft's moves with one more: a component moved again replaces its
// earlier move, so the list holds each component once, with where it is now.
export function withMove(moves: readonly OwnerMove[], move: OwnerMove): OwnerMove[] {
  return [...moves.filter((entry) => entry.id !== move.id), move];
}

// A box as percentages of the frame, so it scales with the preview.
export function boxStyle(
  box: { x: number; y: number; width: number; height: number },
  frame: { width: number; height: number },
): { left: string; top: string; width: string; height: string } {
  const pct = (value: number, of: number) => `${Math.round((value / of) * 1e5) / 1e3}%`;
  return {
    left: pct(box.x, frame.width),
    top: pct(box.y, frame.height),
    width: pct(box.width, frame.width),
    height: pct(box.height, frame.height),
  };
}
