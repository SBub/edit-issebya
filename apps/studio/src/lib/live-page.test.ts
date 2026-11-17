import type { PlacedComponent } from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import {
  type PageElement,
  changedElements,
  componentElements,
  dragPatch,
  restyle,
  wrapPatch,
} from "./live-page";

function component(over: Partial<PlacedComponent>): PlacedComponent {
  return {
    id: "accent-1",
    component: "ACCENT",
    text: "sense of purpose",
    size: 110,
    start: 4,
    end: 6,
    x: 300,
    y: 400,
    width: 440,
    height: 110,
    ...over,
  };
}

function el(style: Record<string, string>, over: Partial<PageElement> = {}): PageElement {
  return { style, html: "sense of purpose", children: [], ...over };
}

const PAGE = new Map<string, PageElement>([
  ["accent-1", el({ left: "300px", top: "400px", "font-size": "110px", color: "#fff" })],
  // A LIST: its layer at (35, 1100), its levels inside it.
  [
    "transition-1",
    el(
      {
        left: "35px",
        top: "1100px",
        width: "1010px",
        height: "600px",
        transform: "translateY(600px)",
      },
      { html: null, children: ["transition-1-lead", "transition-1-key"] },
    ),
  ],
  ["transition-1-lead", el({ left: "100px", top: "50px", "font-size": "50px" })],
  ["transition-1-key", el({ left: "65px", top: "120px", "font-size": "110px" })],
  [
    "visual-1",
    el({ left: "600px", top: "300px", width: "400px", height: "300px" }, { html: null }),
  ],
]);

describe("componentElements", () => {
  it("is a LIST's levels and any other component's own element", () => {
    expect(componentElements(PAGE, "transition-1", "LIST")).toEqual([
      "transition-1-lead",
      "transition-1-key",
    ]);
    expect(componentElements(PAGE, "accent-1", "ACCENT")).toEqual(["accent-1"]);
    expect(componentElements(PAGE, "nothing", "ACCENT")).toEqual([]);
  });
});

describe("dragPatch", () => {
  it("moves a text's element by the drag", () => {
    expect(dragPatch(PAGE, component({}), { mode: "move", dx: -40.5, dy: 120 })).toEqual({
      "accent-1": { style: { left: "259.5px", top: "520px" } },
    });
  });

  it("scales a text's size about its corner on a corner drag", () => {
    // In by 0.3 of the box's width: 110 px to 77 px, the corner kept.
    expect(dragPatch(PAGE, component({}), { mode: "resize", dx: -132, dy: 0 })).toEqual({
      "accent-1": { style: { left: "300px", top: "400px", "font-size": "77px" } },
    });
  });

  it("moves and scales a LIST's levels inside its layer, never the layer", () => {
    // The LIST's box: its levels' corner on the frame, (100, 1150).
    const list = component({
      id: "transition-1",
      component: "LIST",
      x: 100,
      y: 1150,
      width: 400,
      height: 180,
    });
    expect(dragPatch(PAGE, list, { mode: "move", dx: 10, dy: -20 })).toEqual({
      "transition-1-lead": { style: { left: "110px", top: "30px" } },
      "transition-1-key": { style: { left: "75px", top: "100px" } },
    });
    // Twice the size: each level twice as far from the box's corner (65, 50 in the layer).
    const scaled = dragPatch(PAGE, list, { mode: "resize", dx: 400, dy: 0 });
    expect(scaled).toEqual({
      "transition-1-lead": { style: { left: "135px", top: "50px", "font-size": "100px" } },
      "transition-1-key": { style: { left: "65px", top: "190px", "font-size": "220px" } },
    });
  });

  it("scales a VISUAL's box in proportion", () => {
    const visual = component({
      id: "visual-1",
      component: "VISUAL",
      size: null,
      x: 600,
      y: 300,
      width: 400,
      height: 300,
    });
    expect(dragPatch(PAGE, visual, { mode: "resize", dx: -100, dy: 0 })).toEqual({
      "visual-1": { style: { left: "600px", top: "300px", width: "300px", height: "225px" } },
    });
  });

  it("turns a VISUAL with the rotate property, never transform, and never a text", () => {
    const visual = component({
      id: "visual-1",
      component: "VISUAL",
      size: null,
      x: 600,
      y: 300,
      width: 400,
      height: 300,
    });
    expect(dragPatch(PAGE, visual, { mode: "rotate", dx: 0, dy: 0, angle: -30 })).toEqual({
      "visual-1": { style: { rotate: "-30deg" } },
    });
    expect(dragPatch(PAGE, component({}), { mode: "rotate", dx: 0, dy: 0, angle: 30 })).toEqual({});
  });

  it("scales a turned VISUAL about the corner it shows at its top left", () => {
    const visual = component({
      id: "visual-1",
      component: "VISUAL",
      size: null,
      x: 600,
      y: 300,
      width: 400,
      height: 300,
      rotation: 180,
    });
    // Turned half round, its shown top left is its own bottom right: that stays.
    expect(dragPatch(PAGE, visual, { mode: "resize", dx: 100, dy: 0 })).toEqual({
      "visual-1": { style: { left: "700px", top: "375px", width: "300px", height: "225px" } },
    });
  });

  it("leaves an edge drag to the rebuilt lines", () => {
    expect(dragPatch(PAGE, component({}), { mode: "right", dx: -100, dy: 0 })).toEqual({});
  });
});

describe("wrapPatch", () => {
  it("is another page's elements of the component, with its lines, moved", () => {
    const wrapped = new Map([
      [
        "accent-1",
        el({ left: "300px", top: "400px", "font-size": "110px" }, { html: "sense of<br>purpose" }),
      ],
    ]);
    expect(wrapPatch(wrapped, component({}), -20, 0)).toEqual({
      "accent-1": {
        style: { left: "280px", top: "400px", "font-size": "110px" },
        html: "sense of<br>purpose",
      },
    });
  });
});

describe("changedElements", () => {
  it("names the elements whose place, size or lines differ, never what the timeline animates", () => {
    const next = new Map(PAGE);
    next.set("accent-1", el({ left: "310px", top: "400px", "font-size": "110px", color: "#fff" }));
    next.set(
      "transition-1",
      el(
        { left: "35px", top: "1100px", width: "1010px", height: "600px", transform: "none" },
        { html: null, children: ["transition-1-lead", "transition-1-key"] },
      ),
    );
    next.set(
      "transition-1-key",
      el({ left: "65px", top: "120px", "font-size": "110px" }, { html: "a<br>b" }),
    );
    expect(changedElements(PAGE, next)).toEqual(["accent-1", "transition-1-key"]);
  });
});

describe("restyle", () => {
  function fake(style: Record<string, string>, html: string) {
    const props = new Map(Object.entries(style));
    return {
      innerHTML: html,
      style: {
        getPropertyValue: (name: string) => props.get(name) ?? "",
        setProperty: (name: string, value: string) => props.set(name, value),
        removeProperty: (name: string) => props.delete(name),
      },
      props,
    };
  }

  it("sets what is wanted, removes what is no longer, and never touches what the timeline animates", () => {
    const node = fake(
      {
        left: "300px",
        top: "400px",
        "text-align": "center",
        transform: "translateY(12px)",
        opacity: "0.5",
      },
      "a<br>b",
    );
    restyle(
      node as unknown as HTMLElement,
      { style: { left: "320px", top: "400px", transform: "none" }, html: "a b" },
      ["left", "top", "text-align", "transform", "opacity"],
    );
    expect(Object.fromEntries(node.props)).toEqual({
      left: "320px",
      top: "400px",
      transform: "translateY(12px)",
      opacity: "0.5",
    });
    expect(node.innerHTML).toBe("a b");
  });
});
