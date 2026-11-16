import type { PlacedComponent } from "@edit-issebya/edit";
import { type Drag, resizeShare } from "./owner-edit";

// The move and resize editor's instant view (app_docs/owner-edits.md): while
// a component is dragged, and from the drop until the rebuilt draft is on
// screen, the page already on screen is restyled in place, so the component
// follows the pointer and stays where it was dropped with no wait. Only what
// the builder writes on an element changes (its place, its size, its lines),
// never what the page's timeline animates (its rise, its fade), so the
// restyled page shows exactly what the rebuilt draft will show.

// One element of a built page as the builder wrote it: its inline style, its
// lines (the inside of a text element, null for anything holding more than
// lines) and the ids of the elements inside it (a LIST's levels).
export interface PageElement {
  style: Record<string, string>;
  html: string | null;
  children: string[];
}

export type PageElements = ReadonlyMap<string, PageElement>;

// What the editor asks the page on screen to show for some elements: style
// properties over the ones the page should have, and the lines.
export interface ElementPatch {
  style: Record<string, string>;
  html?: string;
}

export type LivePatch = Record<string, ElementPatch>;

// What the page's timeline drives: never written by a patch, so the moment
// on screen (a text rising in, a list sliding up) stays the timeline's.
const ANIMATED = new Set(["transform", "translate", "opacity", "visibility", "display"]);

function isAnimated(property: string): boolean {
  return ANIMATED.has(property);
}

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
      children: kids.flatMap((kid) => (kid.id ? [kid.id] : [])),
    });
  }
  return out;
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

// A move or a corner resize drag as a patch of the page on screen: every
// element of the component moved by the drag, or scaled about the
// component's top left corner (its text size, or a VISUAL's box). The edge
// handles set lines again and are patched from the rebuilt lines
// (`wrapPatch`), never here.
export function dragPatch(
  elements: PageElements,
  component: PlacedComponent,
  drag: Drag,
): LivePatch {
  const patch: LivePatch = {};
  const own = elements.get(component.id);
  if (!own) return patch;
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
      style.width = px(pxOf(el.style.width) * share);
      style.height = px(pxOf(el.style.height) * share);
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
    if (styled || was.html !== next.html) out.push(id);
  }
  return out;
}

// One element of the page on screen made to show `wanted` (the page it should
// show, with the editor's patch over it): each written style property set,
// each one the page on screen or an earlier patch has and `wanted` has not
// removed, the lines replaced. What the timeline animates is never touched.
export function restyle(el: HTMLElement, wanted: ElementPatch, known: readonly string[]): void {
  for (const name of new Set([...known, ...Object.keys(wanted.style)])) {
    if (isAnimated(name)) continue;
    const value = wanted.style[name];
    if (value === undefined) el.style.removeProperty(name);
    else if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
  }
  if (wanted.html !== undefined && el.innerHTML !== wanted.html) el.innerHTML = wanted.html;
}
