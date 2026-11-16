import {
  type EngineComponent,
  type OwnerMove,
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
export interface Drag {
  mode: "move" | "resize";
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

// The box a component shows while it is dragged, before it is settled: moved
// by the drag, or scaled about its top left corner.
export function draggedBox(
  component: Pick<PlacedComponent, "x" | "y" | "width" | "height">,
  drag: Drag | null,
): { x: number; y: number; width: number; height: number } {
  const { x, y, width, height } = component;
  if (!drag) return { x, y, width, height };
  if (drag.mode === "move") return { x: x + drag.dx, y: y + drag.dy, width, height };
  const share = resizeShare(component, drag);
  return { x, y, width: width * share, height: height * share };
}

// The move a finished drag asks for (before it is made legal, `settleOwnerMove`):
// a move keeps the size, a resize keeps the corner. Null for a component with
// no text size.
export function moveOfDrag(component: PlacedComponent, drag: Drag): OwnerMove | null {
  if (component.size === null) return null;
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
