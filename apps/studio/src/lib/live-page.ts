import type { PlacedComponent } from "@edit-issebya/edit";
import { type Drag, resizeShare, scaledVisual } from "./owner-edit";

// The move and resize editor's instant view (app_docs/owner-edits.md): while
// a component is dragged, and from the drop until the rebuilt draft is on
// screen, the page already on screen is restyled in place, so the component
// follows the pointer and stays where it was dropped with no wait. Only what
// the builder writes on an element changes (its place, its size, its lines),
// never what the page's timeline animates (its rise, its fade), so the
// restyled page shows exactly what the rebuilt draft will show.

// One element of a built page as the builder wrote it: its inline style, its
// lines (the inside of a text element, null for anything holding more than
// lines), its lines of words (a text whose every word is an element of its
// own, a caption's, an accent's, a QUESTION's or the typed hook's: each line
// the ids of its words, null otherwise) and the ids of the elements inside it
// (a LIST's levels, a revealed text's words, a hook word's letters).
export interface PageElement {
  style: Record<string, string>;
  html: string | null;
  words: string[][] | null;
  children: string[];
}

export type PageElements = ReadonlyMap<string, PageElement>;

// What the editor asks the page on screen to show for some elements: style
// properties over the ones the page should have, and the lines (as html, or
// as lines of word elements).
export interface ElementPatch {
  style: Record<string, string>;
  html?: string;
  words?: string[][];
}

export type LivePatch = Record<string, ElementPatch>;

// What the page's timeline drives: never written by a patch, so the moment
// on screen (a text rising in, a list sliding up) stays the timeline's.
const ANIMATED = new Set(["transform", "translate", "opacity", "visibility", "display"]);

function isAnimated(property: string): boolean {
  return ANIMATED.has(property);
}

// What a patch may write that a page may not have: the page on screen is
// restyled over it too, so a turn a patch set and neither page has (an
// upright card turned, then the turn dropped) is taken off again. Every other
// property a patch writes is one the builder writes on that element.
export const PATCHED = ["rotate"] as const;

// The last few pages read: the editor and the player read the same pages.
const READ = new Map<string, PageElements>();
const READ_MAX = 4;

// Every element with an id of a built page, but its videos and sounds (the
// footage never moves): read from the page's html in an inert document.
export function pageElements(html: string): PageElements {
  const known = READ.get(html);
  if (known) return known;
  const read = readPage(html);
  READ.set(html, read);
  if (READ.size > READ_MAX) READ.delete(READ.keys().next().value!);
  return read;
}

function readPage(html: string): Map<string, PageElement> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out = new Map<string, PageElement>();
  for (const el of doc.querySelectorAll<HTMLElement>("#root [id]")) {
    if (el.tagName === "VIDEO" || el.tagName === "AUDIO") continue;
    const style: Record<string, string> = {};
    for (let index = 0; index < el.style.length; index += 1) {
      const name = el.style.item(index);
      style[name] = el.style.getPropertyValue(name);
    }
    const kids = [...el.children];
    out.set(el.id, {
      style,
      html: kids.every((kid) => kid.tagName === "BR") ? el.innerHTML : null,
      words: wordLines(el),
      children: kids.flatMap((kid) => (kid.id ? [kid.id] : [])),
    });
  }
  return out;
}

// The class of a revealed text's word element (the builder's `.q`, `build.ts`)
// and of a typed hook's word element (`.w`, which holds its letters, each an
// element of its own).
const WORD_CLASS = "q";
const TYPED_WORD_CLASS = "w";

function isWord(el: Element): boolean {
  if (el.tagName !== "SPAN" || el.id === "") return false;
  const classes = (el.getAttribute("class") ?? "").split(" ");
  if (classes.includes(TYPED_WORD_CLASS)) return true;
  return el.children.length === 0 && classes.includes(WORD_CLASS);
}

// A text whose every word is an element of its own (a caption, an accent or
// a QUESTION, which show their words one by one, or the hook, typed letter by
// letter inside its words: line breaks and word elements only): each line the
// ids of its words, in order. Null for any other element (a LIST's layer
// holds its levels, never words).
function wordLines(el: Element): string[][] | null {
  const kids = [...el.children];
  const words = kids.filter((kid) => kid.tagName !== "BR");
  if (words.length === 0 || !words.every(isWord)) return null;
  const lines: string[][] = [[]];
  for (const kid of kids) {
    if (kid.tagName === "BR") lines.push([]);
    else lines.at(-1)!.push(kid.id);
  }
  return lines;
}

function sameLines(a: readonly string[][] | null, b: readonly string[][] | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function pxOf(value: string | undefined): number {
  const n = Number.parseFloat(value ?? "");
  return Number.isFinite(n) ? n : 0;
}

function px(n: number): string {
  return `${Math.round(n * 1000) / 1000}px`;
}

// The elements that draw a component: a LIST's levels (its layer stays where
// the builder put it), any other component's own element.
export function componentElements(elements: PageElements, id: string, component: string): string[] {
  const own = elements.get(id);
  if (!own) return [];
  return component === "LIST" && own.children.length > 0 ? own.children : [id];
}

// A move, a corner resize or a turn as a patch of the page on screen: every
// element of the component moved by the drag, or scaled about the
// component's top left corner (its text size, or a VISUAL's box, a turned one
// about the corner it shows at its top left), or a VISUAL turned about its
// centre (the `rotate` property, never `transform`). The edge handles set
// lines again and are patched from the rebuilt lines (`wrapPatch`), never here.
export function dragPatch(
  elements: PageElements,
  component: PlacedComponent,
  drag: Drag,
): LivePatch {
  const patch: LivePatch = {};
  const own = elements.get(component.id);
  if (!own) return patch;
  if (drag.mode === "rotate") {
    if (component.component !== "VISUAL" || drag.angle === undefined) return patch;
    return { [component.id]: { style: { rotate: `${drag.angle}deg` } } };
  }
  const share = drag.mode === "resize" ? resizeShare(component, drag) : 1;
  // A LIST's levels sit inside its layer: their corners are the layer's.
  const nested = component.component === "LIST" && own.children.length > 0;
  const originX = nested ? pxOf(own.style.left) : 0;
  const originY = nested ? pxOf(own.style.top) : 0;
  for (const id of componentElements(elements, component.id, component.component)) {
    const el = elements.get(id);
    if (!el) continue;
    const left = pxOf(el.style.left);
    const top = pxOf(el.style.top);
    if (drag.mode === "move") {
      patch[id] = { style: { left: px(left + drag.dx), top: px(top + drag.dy) } };
      continue;
    }
    if (drag.mode !== "resize") continue;
    const cornerX = component.x - originX;
    const cornerY = component.y - originY;
    const style: Record<string, string> = {
      left: px(cornerX + (left - cornerX) * share),
      top: px(cornerY + (top - cornerY) * share),
    };
    if (el.style["font-size"] !== undefined) {
      style["font-size"] = px(pxOf(el.style["font-size"]) * share);
    }
    if (component.component === "VISUAL") {
      const box = scaledVisual(
        { ...component, width: pxOf(el.style.width), height: pxOf(el.style.height) },
        share,
      );
      style.left = px(box.x);
      style.top = px(box.y);
      style.width = px(box.width);
      style.height = px(box.height);
    }
    patch[id] = { style };
  }
  return patch;
}

// A component's elements as another page draws them (a page built with one
// wrap width), moved by `dx` and `dy`: what an edge handle shows while it is
// held.
export function wrapPatch(
  elements: PageElements,
  component: Pick<PlacedComponent, "id" | "component">,
  dx: number,
  dy: number,
): LivePatch {
  const patch: LivePatch = {};
  for (const id of componentElements(elements, component.id, component.component)) {
    const el = elements.get(id);
    if (!el) continue;
    patch[id] = {
      style: {
        ...el.style,
        left: px(pxOf(el.style.left) + dx),
        top: px(pxOf(el.style.top) + dy),
      },
      ...(el.html !== null ? { html: el.html } : {}),
      ...(el.words !== null ? { words: el.words } : {}),
    };
  }
  return patch;
}

// The ids whose style or lines differ between two pages.
export function changedElements(from: PageElements, to: PageElements): string[] {
  const out: string[] = [];
  for (const [id, next] of to) {
    const was = from.get(id);
    if (!was) continue;
    const names = new Set([...Object.keys(was.style), ...Object.keys(next.style)]);
    const styled = [...names].some(
      (name) => !isAnimated(name) && was.style[name] !== next.style[name],
    );
    if (styled || was.html !== next.html || !sameLines(was.words, next.words)) out.push(id);
  }
  return out;
}

// One element of the page on screen made to show `wanted` (the page it should
// show, with the editor's patch over it): each written style property set,
// each one the page on screen or an earlier patch has and `wanted` has not
// removed, the lines replaced. What the timeline animates is never touched.
// Lines of word elements are set by moving the page's own word elements
// between lines, never by writing new ones: the timeline drives each word
// (the word-by-word reveal) or each letter inside it (the typed hook), so a
// word written anew would never show.
export function restyle(el: HTMLElement, wanted: ElementPatch, known: readonly string[]): void {
  for (const name of new Set([...known, ...Object.keys(wanted.style)])) {
    if (isAnimated(name)) continue;
    const value = wanted.style[name];
    if (value === undefined) el.style.removeProperty(name);
    else if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
  }
  if (wanted.words !== undefined) relineWords(el, wanted.words);
  else if (wanted.html !== undefined && el.innerHTML !== wanted.html) el.innerHTML = wanted.html;
}

// A text's own word elements set on `lines` (each the ids of its words): the
// same elements, a space between two words and a line break between two
// lines, as the builder writes them. Nothing changes when the text already
// has those lines, or when a word of `lines` is not one of its own.
function relineWords(el: HTMLElement, lines: readonly string[][]): void {
  if (sameLines(wordLines(el), lines as string[][])) return;
  const own = new Map([...el.children].flatMap((kid) => (kid.id ? [[kid.id, kid] as const] : [])));
  if (lines.some((line) => line.some((id) => !own.has(id)))) return;
  const doc = el.ownerDocument;
  const nodes: Node[] = [];
  lines.forEach((line, index) => {
    if (index > 0) nodes.push(doc.createElement("br"));
    line.forEach((id, at) => {
      if (at > 0) nodes.push(doc.createTextNode(" "));
      nodes.push(own.get(id)!);
    });
  });
  el.replaceChildren(...nodes);
}
