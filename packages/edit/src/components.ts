import type { BigWordBox } from "./behind.ts";
import type { EngineComponent } from "./engine-note.ts";
import type { TextBox } from "./engine-space.ts";
import type { Edit } from "./schema.ts";
import type { Span } from "./timeline.ts";

// One component as the builder drew it: its box in frame pixels (`x`, `y` the
// top left corner) for its whole time on screen. A component has one box, not
// one per frame. `size` is its text size (a LIST's is its key phrase's); null
// for a VISUAL, which is a card with no text.
export interface PlacedComponent extends Span {
  id: string;
  component: EngineComponent;
  text: string;
  size: number | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

// The overlay id prefix of a QUESTION (`question-1`, ...): an accent overlay.
// The component is read from the id alone, so it holds whatever variant draws
// the question.
const QUESTION_ID = /^question-/;

// Every component of a built page with its box: the builder's own text boxes
// (`boxes`: the captions shown and the overlays; `levels`: each LIST's text
// levels; `bigWords`), never a second measurement, so a box here is the box on
// screen whatever the component's variant draws inside it. A LIST is one
// component: the box around its levels, its text the levels' in reading order
// (the number, the lead-in, the key phrase).
export function placedComponents(
  edit: Edit,
  boxes: readonly TextBox[],
  levels: readonly (TextBox & { transitionId: string })[],
  bigWords: readonly BigWordBox[],
  resolved: ReadonlyMap<string, Span>,
): PlacedComponent[] {
  const out: PlacedComponent[] = [];
  for (const box of boxes) {
    const component: EngineComponent =
      box.kind === "caption"
        ? "CAPTION"
        : box.kind === "hook"
          ? "HOOK"
          : QUESTION_ID.test(box.itemId)
            ? "QUESTION"
            : "ACCENT";
    out.push({
      id: box.itemId,
      component,
      text: box.text,
      size: box.size,
      start: box.start,
      end: box.end,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
    });
  }
  for (const item of edit.tracks.transitions) {
    const own = levels.filter((level) => level.transitionId === item.id);
    const span = resolved.get(item.id);
    if (own.length === 0 || !span || !item.levels) continue;
    const left = Math.min(...own.map((level) => level.x));
    const top = Math.min(...own.map((level) => level.y));
    out.push({
      id: item.id,
      component: "LIST",
      text: own.map((level) => level.text).join(" "),
      size: item.levels.key.size,
      start: span.start,
      end: span.end,
      x: left,
      y: top,
      width: Math.max(...own.map((level) => level.x + level.width)) - left,
      height: Math.max(...own.map((level) => level.y + level.height)) - top,
    });
  }
  const words = new Map(bigWords.map((word) => [word.itemId, word]));
  for (const item of edit.tracks.behind ?? []) {
    const span = resolved.get(item.id);
    if (!span) continue;
    if (item.kind === "visual") {
      out.push({
        id: item.id,
        component: "VISUAL",
        text: item.description ?? "",
        size: null,
        start: span.start,
        end: span.end,
        x: item.box.x,
        y: item.box.y,
        width: item.box.width,
        height: item.box.height,
      });
      continue;
    }
    const word = words.get(item.id);
    if (!word) continue;
    out.push({
      id: item.id,
      component: "BIGWORD",
      text: word.text,
      size: word.size,
      start: span.start,
      end: span.end,
      x: word.x,
      y: word.y,
      width: word.width,
      height: word.height,
    });
  }
  return out;
}
