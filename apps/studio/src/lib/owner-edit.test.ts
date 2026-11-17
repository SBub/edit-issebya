import type { PlacedComponent } from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import {
  type Drag,
  boxStyle,
  canRewrap,
  componentLabel,
  componentOption,
  draggedBox,
  draggedTurn,
  movableAt,
  movableComponents,
  moveOfDrag,
  resizeShare,
  resolveAsk,
  scaledVisual,
  showMoment,
  snapAngle,
  snapDrag,
  turnOfPointer,
  withMove,
} from "./owner-edit";

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

const ALL = [
  component({ id: "w0001", component: "CAPTION", start: 0, end: 1 }),
  component({ id: "visual-1", component: "VISUAL", size: null, start: 1, end: 3 }),
  component({ id: "transition-1", component: "LIST", start: 5, end: 8 }),
  component({ id: "hook", component: "HOOK", start: 0.2, end: 3 }),
  component({ id: "big-word-1", component: "BIGWORD", start: 4, end: 5.5 }),
  component({ id: "question-1", component: "QUESTION", start: 9, end: 11 }),
  component({}),
];

describe("the editor's components", () => {
  it("names each kind in plain words", () => {
    expect(
      (["ACCENT", "QUESTION", "BIGWORD", "LIST", "HOOK"] as const).map(componentLabel),
    ).toEqual(["Accent", "Question", "Big word", "List", "Hook"]);
  });

  it("lists the texts and visuals the owner may move, in the order they come on screen", () => {
    expect(movableComponents(ALL).map((entry) => entry.id)).toEqual([
      "hook",
      "visual-1",
      "accent-1",
      "big-word-1",
      "transition-1",
      "question-1",
    ]);
  });

  it("offers only what is on screen at the paused moment", () => {
    expect(movableAt(ALL, 0).map((entry) => entry.id)).toEqual([]);
    expect(movableAt(ALL, 2).map((entry) => entry.id)).toEqual(["hook", "visual-1"]);
    expect(movableAt(ALL, 5.2).map((entry) => entry.id)).toEqual([
      "accent-1",
      "big-word-1",
      "transition-1",
    ]);
    // A component is gone at its end.
    expect(movableAt(ALL, 6).map((entry) => entry.id)).toEqual(["transition-1"]);
  });

  it("writes one line per text for the list, a long text cut short", () => {
    expect(componentOption(component({}))).toBe("Accent: sense of purpose");
    expect(
      componentOption(
        component({ component: "HOOK", text: "Gen Z won't work like you did, and here is why" }),
      ),
    ).toBe("Hook: Gen Z won't work like you d…");
  });

  it("shows a picked text near its end, where it is whole on screen", () => {
    expect(showMoment({ start: 4, end: 6 })).toBe(5.6);
    expect(showMoment({ start: 0.2, end: 3 })).toBe(2.6);
    // Too short for that: its middle.
    expect(showMoment({ start: 4, end: 4.6 })).toBe(4.3);
  });
});

describe("a drag", () => {
  const box = component({});

  it("moves the box by the drag and keeps its size", () => {
    expect(draggedBox(box, { mode: "move", dx: -50, dy: 120 })).toEqual({
      x: 250,
      y: 520,
      width: 440,
      height: 110,
    });
    expect(moveOfDrag(box, { mode: "move", dx: -50, dy: 120 })).toEqual({
      id: "accent-1",
      x: 250,
      y: 520,
      size: 110,
    });
  });

  it("resizes the box about its top left corner, by the direction the handle moved further in", () => {
    // 220 px wider is one and a half times the width; 11 px taller is only 1.1.
    expect(resizeShare(box, { dx: 220, dy: 11 })).toBe(1.5);
    expect(draggedBox(box, { mode: "resize", dx: 220, dy: 11 })).toEqual({
      x: 300,
      y: 400,
      width: 660,
      height: 165,
    });
    expect(moveOfDrag(box, { mode: "resize", dx: 220, dy: 11 })).toEqual({
      id: "accent-1",
      x: 300,
      y: 400,
      size: 165,
    });
  });

  it("shrinks with a drag inwards, along either edge, never inside out", () => {
    const size = (drag: Drag) => {
      const ask = moveOfDrag(box, drag);
      return ask && ask.kind !== "box" ? ask.size : null;
    };
    expect(size({ mode: "resize", dx: -220, dy: -55 })).toBe(55);
    // Straight in along the bottom edge, or straight up along the right one.
    expect(size({ mode: "resize", dx: -132, dy: 0 })).toBe(77);
    expect(size({ mode: "resize", dx: 0, dy: -33 })).toBe(77);
    // Straight down doubles it.
    expect(size({ mode: "resize", dx: 0, dy: 110 })).toBe(220);
    expect(resizeShare(box, { dx: -5000, dy: -5000 })).toBe(0.05);
  });

  it("leaves the box where it is with no drag", () => {
    expect(draggedBox(box, null)).toEqual({ x: 300, y: 400, width: 440, height: 110 });
  });

  it("moves a VISUAL's box and scales it about its corner in proportion, with no edge handle", () => {
    const visual = component({
      id: "visual-1",
      component: "VISUAL",
      size: null,
      width: 300,
      height: 383,
    });
    expect(moveOfDrag(visual, { mode: "move", dx: 12.5, dy: -40 })).toEqual({
      id: "visual-1",
      kind: "box",
      x: 312.5,
      y: 360,
      width: 300,
      rotation: 0,
    });
    expect(moveOfDrag(visual, { mode: "resize", dx: -90, dy: 0 })).toEqual({
      id: "visual-1",
      kind: "box",
      x: 300,
      y: 400,
      width: 210,
      rotation: 0,
    });
    const scaled = draggedBox(visual, { mode: "resize", dx: -90, dy: 0 });
    expect(scaled).toMatchObject({ x: 300, y: 400, width: 210 });
    expect(scaled.height).toBeCloseTo(268.1, 6);
    expect(moveOfDrag(visual, { mode: "right", dx: -90, dy: 0 })).toBeNull();
    expect(canRewrap(visual)).toBe(false);
    expect(componentLabel("VISUAL")).toBe("Visual");
  });
});

describe("a VISUAL's rotate handle", () => {
  const visual = component({
    id: "visual-1",
    component: "VISUAL",
    size: null,
    width: 300,
    height: 383,
  });

  it("turns with the pointer round the box's centre, from the card's own turn", () => {
    const centre = { x: 100, y: 100 };
    // From straight above the centre to straight right of it: a quarter turn clockwise.
    expect(turnOfPointer(centre, { x: 100, y: 50 }, { x: 150, y: 100 }, 0)).toBeCloseTo(90, 6);
    expect(turnOfPointer(centre, { x: 100, y: 50 }, { x: 50, y: 100 }, 10)).toBeCloseTo(-80, 6);
  });

  it("snaps upright and to each quarter turn within a few degrees, and keeps whole degrees", () => {
    expect(snapAngle(3.4)).toEqual({ angle: 0, snapped: true });
    expect(snapAngle(-4)).toEqual({ angle: 0, snapped: true });
    expect(snapAngle(87)).toEqual({ angle: 90, snapped: true });
    expect(snapAngle(183)).toEqual({ angle: 180, snapped: true });
    expect(snapAngle(-92)).toEqual({ angle: -90, snapped: true });
    expect(snapAngle(268)).toEqual({ angle: -90, snapped: true });
    expect(snapAngle(4.6)).toEqual({ angle: 5, snapped: false });
    expect(snapAngle(-33.2)).toEqual({ angle: -33, snapped: false });
    expect(snapAngle(200)).toEqual({ angle: -160, snapped: false });
  });

  it("asks for the card's box with the turn, and keeps the box while it turns", () => {
    expect(moveOfDrag(visual, { mode: "rotate", dx: 0, dy: 0, angle: 25 })).toEqual({
      id: "visual-1",
      kind: "box",
      x: 300,
      y: 400,
      width: 300,
      rotation: 25,
    });
    expect(draggedBox(visual, { mode: "rotate", dx: 0, dy: 0, angle: 25 })).toEqual({
      x: 300,
      y: 400,
      width: 300,
      height: 383,
    });
    expect(draggedTurn(visual, { mode: "rotate", dx: 0, dy: 0, angle: 25 })).toBe(25);
    expect(draggedTurn({ rotation: 12 }, null)).toBe(12);
    // A text never turns.
    expect(moveOfDrag(component({}), { mode: "rotate", dx: 0, dy: 0, angle: 25 })).toBeNull();
  });

  it("moves and scales a turned card with its turn, the corner it shows at its top left kept", () => {
    const turned = { ...visual, rotation: 90 };
    expect(moveOfDrag(turned, { mode: "move", dx: 10, dy: 0 })).toMatchObject({
      x: 310,
      rotation: 90,
    });
    // Turned a quarter, the box's own width runs down the screen: a drag down
    // grows it.
    expect(resizeShare(turned, { dx: 0, dy: 150 })).toBeCloseTo(1.5, 6);
    const scaled = scaledVisual(turned, 2);
    // The shown top left corner (the box's own bottom left, turned) stays.
    const shown = (box: { x: number; y: number; width: number; height: number }) => ({
      x: box.x + box.width / 2 + box.height / 2,
      y: box.y + box.height / 2 - box.width / 2,
    });
    expect(shown(scaled).x).toBeCloseTo(shown(turned).x, 6);
    expect(shown(scaled).y).toBeCloseTo(shown(turned).y, 6);
    expect(scaled.width).toBe(600);
    const ask = moveOfDrag(turned, { mode: "resize", dx: 0, dy: 300 });
    expect(ask).toMatchObject({ kind: "box", width: 600, rotation: 90 });
    // Upright, the box's own corner stays.
    expect(scaledVisual(visual, 2)).toEqual({ x: 300, y: 400, width: 600, height: 766 });
  });
});

describe("an edge handle", () => {
  const box = component({});

  it("moves one edge and keeps the opposite one, at the same text size", () => {
    expect(draggedBox(box, { mode: "right", dx: -140, dy: 30 })).toEqual({
      x: 300,
      y: 400,
      width: 300,
      height: 110,
    });
    expect(draggedBox(box, { mode: "left", dx: 140, dy: 0 })).toEqual({
      x: 440,
      y: 400,
      width: 300,
      height: 110,
    });
    expect(draggedBox(box, { mode: "bottom", dx: 0, dy: 110 })).toEqual({
      x: 300,
      y: 400,
      width: 440,
      height: 220,
    });
    expect(draggedBox(box, { mode: "top", dx: 0, dy: -110 })).toEqual({
      x: 300,
      y: 290,
      width: 440,
      height: 220,
    });
    // Never narrower or shorter than 20 frame pixels.
    expect(draggedBox(box, { mode: "right", dx: -5000, dy: 0 }).width).toBe(20);
  });

  it("asks for a width or a height, with the edge that stays", () => {
    const at = { id: "accent-1", x: 300, y: 400, size: 110 };
    expect(moveOfDrag(box, { mode: "right", dx: -140, dy: 0 })).toEqual({ ...at, width: 300 });
    expect(moveOfDrag(box, { mode: "left", dx: 140, dy: 0 })).toEqual({
      ...at,
      width: 300,
      keep: { right: 740 },
    });
    expect(moveOfDrag(box, { mode: "bottom", dx: 0, dy: 110 })).toEqual({ ...at, height: 220 });
    expect(moveOfDrag(box, { mode: "top", dx: 0, dy: -110 })).toEqual({
      ...at,
      height: 220,
      keep: { bottom: 510 },
    });
  });

  it("sets the lines of every text but a big word", () => {
    expect(canRewrap(component({}))).toBe(true);
    expect(canRewrap(component({ component: "LIST" }))).toBe(true);
    expect(canRewrap(component({ component: "HOOK" }))).toBe(true);
    expect(canRewrap(component({ component: "QUESTION" }))).toBe(true);
    expect(canRewrap(component({ component: "BIGWORD" }))).toBe(false);
    expect(canRewrap(component({ component: "CAPTION" }))).toBe(false);
  });
});

describe("choosing the lines an edge drag asks for", () => {
  // One line 440 wide, two lines 250 wide, three lines 180 wide.
  const options = [
    { width: 440, boxWidth: 440, boxHeight: 110 },
    { width: 250, boxWidth: 250, boxHeight: 220 },
    { width: 180, boxWidth: 180, boxHeight: 330 },
  ];
  const at = { id: "accent-1", x: 300, y: 400, size: 110 };

  it("takes the widest lines that fit a width, the narrowest when none does", () => {
    expect(resolveAsk({ ...at, width: 300 }, options)).toEqual({ ...at, width: 250 });
    expect(resolveAsk({ ...at, width: 1000 }, options)).toEqual({ ...at, width: 440 });
    expect(resolveAsk({ ...at, width: 50 }, options)).toEqual({ ...at, width: 180 });
  });

  it("takes the lines whose height is nearest, the wider of two as near", () => {
    expect(resolveAsk({ ...at, height: 300 }, options)).toEqual({ ...at, width: 180 });
    expect(resolveAsk({ ...at, height: 165 }, options)).toEqual({ ...at, width: 440 });
  });

  it("keeps the right or the bottom edge where it was", () => {
    expect(resolveAsk({ ...at, width: 300, keep: { right: 740 } }, options)).toEqual({
      ...at,
      x: 490,
      width: 250,
    });
    expect(resolveAsk({ ...at, height: 330, keep: { bottom: 510 } }, options)).toEqual({
      ...at,
      y: 180,
      width: 180,
    });
  });

  it("is a plain move with no width or height", () => {
    expect(resolveAsk(at, options)).toEqual(at);
  });
});

describe("snapping to the frame's centre lines", () => {
  const frame = { width: 1080, height: 1920 };
  const box = { x: 100, y: 300, width: 400, height: 110 };

  it("puts the box's centre on a centre line it comes near, each axis on its own", () => {
    // Centre at (300 + 236, 355 + 600) = (536, 955): 4 and 5 px off the lines.
    const near = snapDrag(box, { mode: "move", dx: 236, dy: 600 }, frame, 10);
    expect(near.snapped).toEqual({ x: true, y: true });
    expect(near.drag).toEqual({ mode: "move", dx: 240, dy: 605 });
    const onlyX = snapDrag(box, { mode: "move", dx: 236, dy: 100 }, frame, 10);
    expect(onlyX.snapped).toEqual({ x: true, y: false });
    expect(onlyX.drag).toEqual({ mode: "move", dx: 240, dy: 100 });
  });

  it("leaves a drag away from the lines, and any resize, as it is", () => {
    const far = snapDrag(box, { mode: "move", dx: 200, dy: 600 }, frame, 10);
    expect(far).toEqual({
      drag: { mode: "move", dx: 200, dy: 605 },
      snapped: { x: false, y: true },
    });
    const resize = { mode: "resize" as const, dx: 236, dy: 600 };
    expect(snapDrag(box, resize, frame, 10)).toEqual({
      drag: resize,
      snapped: { x: false, y: false },
    });
  });
});

describe("the draft's moves", () => {
  it("keeps each component once, with where it is now", () => {
    const first = { id: "accent-1", x: 1, y: 2, size: 110 };
    const hook = { id: "hook", x: 5, y: 6, size: 80 };
    const again = { id: "accent-1", x: 9, y: 9, size: 90 };
    expect(withMove(withMove(withMove([], first), hook), again)).toEqual([hook, again]);
  });
});

describe("a box on the preview", () => {
  it("is placed in percentages of the frame", () => {
    expect(
      boxStyle({ x: 270, y: 480, width: 540, height: 192 }, { width: 1080, height: 1920 }),
    ).toEqual({ left: "25%", top: "25%", width: "50%", height: "10%" });
  });
});
