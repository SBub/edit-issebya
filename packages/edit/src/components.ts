import type { BigWordBox } from "./behind.ts";
import { boxAround, captionBlocks } from "./caption-blocks.ts";
import { isQuestion } from "./question.ts";
import type { EngineComponent } from "./engine-note.ts";
import type { TextBox } from "./engine-space.ts";
import type { Edit } from "./schema.ts";
import type { ResolvedItem, Span } from "./timeline.ts";
import type { Transcript } from "./transcript.ts";
import type { LevelRole } from "./transitions.ts";

// One part of a component with its own box and time on screen: one group of a
// caption block (the captions on screen together; its id is its first
// caption's, `items` its captions' ids), or a LIST's lead-in or key phrase
// (its id `lead` or `key`). What the owner's text edit names (`owner-text.ts`).
export interface ComponentPart extends Span {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  items?: string[];
}

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
  // A VISUAL the owner turned: whole degrees clockwise about its box's centre
  // (`x` to `height` are its box upright). Absent for an upright one.
  rotation?: number;
  // A VISUAL's picture: its library photo's id, or its stand-in's file;
  // absent for an empty frame and for a text.
  picture?: string;
  // A caption block (a sentence's captions, `caption-blocks.ts`): its groups,
  // in time order; a single caption has none. A LIST: its lead-in and its key
  // phrase.
  parts?: ComponentPart[];
}

// True for a caption block: the captions of one sentence as one component.
export function isCaptionBlock(component: Pick<PlacedComponent, "component" | "parts">): boolean {
  return component.component === "CAPTION" && component.parts !== undefined;
}

// Every component of a built page with its box: the builder's own text boxes
// (`boxes`: the captions shown and the overlays; `levels`: each LIST's text
// levels; `bigWords`), never a second measurement, so a box here is the box on
// screen whatever the component's variant draws inside it. A LIST is one
// component: the box around its levels, its text the levels' in reading order
// (the number, the lead-in, the key phrase). A QUESTION is read from its id
// (`isQuestion`); its box and text are the ones its look draws, the question
// mark included (`question.ts`). After the single captions come the caption
// blocks (`captionBlocks`): each sentence's captions as one component, its box
// the box around them for the sentence's whole time, its parts its groups.
export function placedComponents(
  edit: Edit,
  boxes: readonly TextBox[],
  levels: readonly (TextBox & { transitionId: string; role: LevelRole })[],
  bigWords: readonly BigWordBox[],
  resolved: ReadonlyMap<string, ResolvedItem>,
  transcript: Transcript,
): PlacedComponent[] {
  const out: PlacedComponent[] = [];
  for (const box of boxes) {
    const component: EngineComponent =
      box.kind === "caption"
        ? "CAPTION"
        : box.kind === "hook"
          ? "HOOK"
          : isQuestion({ id: box.itemId, kind: box.kind })
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
  const captions = new Map(
    boxes.flatMap((box) => (box.kind === "caption" ? [[box.itemId, box] as const] : [])),
  );
  for (const block of captionBlocks(edit, transcript, resolved)) {
    const parts = block.groups.flatMap((group): ComponentPart[] => {
      const own = group.captions.flatMap((id) => {
        const box = captions.get(id);
        return box ? [box] : [];
      });
      if (own.length === 0) return [];
      return [
        {
          id: group.id,
          text: own.map((box) => box.text).join(" "),
          start: group.start,
          end: group.end,
          ...boxAround(own),
          items: own.map((box) => box.itemId),
        },
      ];
    });
    if (parts.length === 0) continue;
    out.push({
      id: block.id,
      component: "CAPTION",
      text: parts.map((part) => part.text).join(" "),
      size: captions.get(parts[0]!.id)!.size,
      start: block.start,
      end: block.end,
      ...boxAround(parts),
      parts,
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
      // The levels whose words the owner may edit, each with its own box.
      parts: own
        .filter((level) => level.role !== "number")
        .map((level) => ({
          id: level.role,
          text: level.text,
          start: level.start,
          end: level.end,
          x: level.x,
          y: level.y,
          width: level.width,
          height: level.height,
        })),
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
        ...(item.rotation ? { rotation: item.rotation } : {}),
        ...(item.photo
          ? { picture: item.photo.id }
          : item.image !== undefined
            ? { picture: item.image }
            : {}),
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
