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
  return { style, html: "sense of purpose", words: null, children: [], ...over };
}

// A QUESTION as the builder draws it: one element, a word element per word
// (the timeline reveals each), its lines split by line breaks.
const QUESTION_WORDS = ["question-1_w1", "question-1_w2", "question-1_w3", "question-1_w4"];
function questionEl(lines: string[][], style: Record<string, string> = {}): PageElement {
  return el(
    { left: "120px", top: "900px", "font-size": "110px", ...style },
    { html: null, words: lines, children: QUESTION_WORDS },
  );
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
    expect(componentElements(PAGE, component({ id: "transition-1", component: "LIST" }))).toEqual([
      "transition-1-lead",
      "transition-1-key",
    ]);
    expect(componentElements(PAGE, component({}))).toEqual(["accent-1"]);
    expect(componentElements(PAGE, component({ id: "nothing" }))).toEqual([]);
  });

  it("is a caption block's captions, each an element of its own", () => {
    expect(componentElements(CAPTIONS, BLOCK)).toEqual(["cw1", "cw2", "cw3"]);
  });
});

// A caption block as the builder draws it: a sentence's captions, each an
// element of its own, two on the first line and one on the second (50 px, the
// lines 14 px apart), centred in the block's width.
const CAPTIONS = new Map<string, PageElement>([
  ["cw1", el({ left: "400px", top: "1500px", "font-size": "50px" })],
  ["cw2", el({ left: "520px", top: "1500px", "font-size": "50px" })],
  ["cw3", el({ left: "450px", top: "1564px", "font-size": "50px" })],
]);
const BLOCK = component({
  id: "block_cw1",
  component: "CAPTION",
  size: 50,
  x: 400,
  y: 1500,
  width: 240,
  height: 114,
  parts: [
    {
      id: "cw1",
      text: "we test this",
      start: 4,
      end: 6,
      x: 400,
      y: 1500,
      width: 240,
      height: 114,
      items: ["cw1", "cw2", "cw3"],
    },
  ],
});

describe("dragPatch, a caption block", () => {
  it("moves every caption of the sentence by the drag", () => {
    expect(dragPatch(CAPTIONS, BLOCK, { mode: "move", dx: 30, dy: -200 })).toEqual({
      cw1: { style: { left: "430px", top: "1300px" } },
      cw2: { style: { left: "550px", top: "1300px" } },
      cw3: { style: { left: "480px", top: "1364px" } },
    });
  });

  it("scales the captions about the block's corner, the gap between its lines kept", () => {
    // Twice the width: twice the size, the second line one size and one gap down.
    expect(dragPatch(CAPTIONS, BLOCK, { mode: "resize", dx: 240, dy: 0 })).toEqual({
      cw1: { style: { left: "400px", top: "1500px", "font-size": "100px" } },
      cw2: { style: { left: "640px", top: "1500px", "font-size": "100px" } },
      cw3: { style: { left: "500px", top: "1614px", "font-size": "100px" } },
    });
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

  it("names a question whose words sit on other lines, its place and size the same", () => {
    const one = new Map([["question-1", questionEl([QUESTION_WORDS])]]);
    const two = new Map([
      ["question-1", questionEl([QUESTION_WORDS.slice(0, 2), QUESTION_WORDS.slice(2)])],
    ]);
    expect(changedElements(one, two)).toEqual(["question-1"]);
    expect(changedElements(two, two)).toEqual([]);
  });
});

describe("wrapPatch, a question", () => {
  it("carries the question's lines as lines of its own word elements", () => {
    const lines = [QUESTION_WORDS.slice(0, 2), QUESTION_WORDS.slice(2)];
    expect(
      wrapPatch(
        new Map([["question-1", questionEl(lines)]]),
        component({ id: "question-1", component: "QUESTION" }),
        10,
        -5,
      ),
    ).toEqual({
      "question-1": {
        style: { left: "130px", top: "895px", "font-size": "110px" },
        words: lines,
      },
    });
  });
});

describe("changedElements, a text the owner edited", () => {
  // A caption as the builder draws it: its one word an element of its own.
  const caption = (word: string) =>
    new Map<string, PageElement>([
      [
        "cw4",
        el(
          { left: "400px", top: "1500px", "font-size": "50px" },
          { html: null, words: [["cw4_w1"]], children: ["cw4_w1"] },
        ),
      ],
      ["cw4_w1", el({}, { html: word })],
    ]);

  it("names the word element whose text changed, never the text that holds it", () => {
    // The word's own element is restyled with the new word, so the page's
    // timeline still reveals that same element.
    expect(changedElements(caption("short"), caption("brief"))).toEqual(["cw4_w1"]);
    expect(changedElements(caption("short"), caption("short"))).toEqual([]);
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

  // An element with child nodes, enough of the DOM for `restyle` to set lines
  // of word elements.
  interface FakeNode {
    tagName?: string;
    id?: string;
    text?: string;
    children?: FakeNode[];
    getAttribute?: (name: string) => string | null;
  }
  function questionNode(lines: string[][], wordClass = "q", letters = 0) {
    const doc = {
      createElement: (tag: string): FakeNode => ({
        tagName: tag.toUpperCase(),
        id: "",
        children: [],
      }),
      createTextNode: (text: string): FakeNode => ({ text }),
    };
    const words = new Map(
      lines.flat().map((id) => [
        id,
        {
          tagName: "SPAN",
          id,
          // A typed hook's word holds its letters, each an element.
          children: Array.from({ length: letters }, (_, at) => ({
            tagName: "SPAN",
            id: `${id}_c${at + 1}`,
            children: [],
            getAttribute: () => "ch",
          })),
          getAttribute: () => wordClass,
        } as FakeNode,
      ]),
    );
    const node = {
      nodes: [] as FakeNode[],
      children: [] as FakeNode[],
      innerHTML: "never written",
      ownerDocument: doc,
      style: { getPropertyValue: () => "", setProperty: () => {}, removeProperty: () => {} },
      replaceChildren(...nodes: FakeNode[]) {
        node.nodes = nodes;
        node.children = nodes.filter((kid) => kid.tagName !== undefined);
      },
    };
    node.replaceChildren(
      ...lines.flatMap((line, index) => [
        ...(index > 0 ? [doc.createElement("br")] : []),
        ...line.flatMap((id, at) => [...(at > 0 ? [doc.createTextNode(" ")] : []), words.get(id)!]),
      ]),
    );
    return { node, words };
  }

  it("sets a question's lines by moving its own word elements, never writing new ones", () => {
    const { node, words } = questionNode([QUESTION_WORDS]);
    restyle(
      node as unknown as HTMLElement,
      { style: {}, words: [QUESTION_WORDS.slice(0, 3), QUESTION_WORDS.slice(3)] },
      [],
    );
    // The same elements (the timeline's), on two lines, a space between words.
    expect(node.nodes.map((kid) => kid.id || kid.tagName || kid.text)).toEqual([
      "question-1_w1",
      " ",
      "question-1_w2",
      " ",
      "question-1_w3",
      "BR",
      "question-1_w4",
    ]);
    for (const id of QUESTION_WORDS) expect(node.children).toContain(words.get(id));
    expect(node.innerHTML).toBe("never written");
    // Lines that are not its own words change nothing.
    const before = node.nodes;
    restyle(node as unknown as HTMLElement, { style: {}, words: [["question-2_w1"]] }, []);
    expect(node.nodes).toBe(before);
  });

  it("sets the typed hook's lines by moving its own words, each with its letters inside", () => {
    const HOOK_WORDS = ["hook_w1", "hook_w2", "hook_w3"];
    const { node, words } = questionNode([HOOK_WORDS], "w", 4);
    restyle(
      node as unknown as HTMLElement,
      { style: {}, words: [HOOK_WORDS.slice(0, 2), HOOK_WORDS.slice(2)] },
      [],
    );
    expect(node.nodes.map((kid) => kid.id || kid.tagName || kid.text)).toEqual([
      "hook_w1",
      " ",
      "hook_w2",
      "BR",
      "hook_w3",
    ]);
    // The same word elements, so the letters the timeline types stay its own.
    for (const id of HOOK_WORDS) {
      expect(node.children).toContain(words.get(id));
      expect(words.get(id)!.children).toHaveLength(4);
    }
    expect(node.innerHTML).toBe("never written");
  });
});
