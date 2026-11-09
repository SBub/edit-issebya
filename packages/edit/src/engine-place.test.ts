import { beforeAll, describe, expect, it } from "vitest";
import { bigWordCoveredShare } from "./behind.ts";
import {
  MIN_SIZE_PX,
  PLACE_COSTS,
  type Obstacle,
  type PlaceElement,
  type PlaceScene,
  placeElement,
} from "./engine-place.ts";
import { overlaps } from "./engine-space.ts";
import { SAFE_ZONE } from "./engine-zones.ts";
import type { Box } from "./head-track.ts";
import type { Measurer } from "./measure.ts";
import { PLATFORM_BUTTONS, PLATFORM_SAFE } from "./preset.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";
import { VARIANTS, type TextVariant } from "./variants.ts";

// Synthetic scenes for the placer: one element, a face or none, obstacles laid
// by hand. Sizes come from HarfBuzz over the package's fonts, so the tests
// check relations (which zone, which cost, which notes) over exact pixels.

const S = PLATFORM_SAFE;
// An unpadded robust face in the middle of the frame.
const FACE: Box = { left: 300, right: 700, top: 500, bottom: 1000 };
// The upper third of S, 220 to 636.67.
const UPPER_THIRD: Box = { ...S, bottom: S.top + (S.bottom - S.top) / 3 };

const span = { start: 3.2, end: 4.1 };

function text(variant: TextVariant, words: string, id = "accent-1", lineGap = 0): PlaceElement {
  return { type: "text", id, variant, text: words, lineGap, ...span };
}

const hook = (words: string) => text(VARIANTS["hook/written-line"], words, "hook");
const accent = (words: string) => text(VARIANTS["accent/above-head"], words);
const caption = (words: string) => text(VARIANTS["caption/default"], words, "w0012", 14);
const bigWord = (words: string) => text(VARIANTS["bigword/behind"], words, "big-word-1");
const card: PlaceElement = {
  type: "box",
  id: "visual-1",
  variant: VARIANTS["visual/card"],
  ...span,
};

const textAt = (id: string, box: Box): Obstacle => ({ id, kind: "text", box });
const captionAt = (id: string, box: Box): Obstacle => ({ id, kind: "caption", box });
const boxAt = (id: string, box: Box): Obstacle => ({ id, kind: "box", box });

function scene(faces: readonly Box[], obstacles: readonly Obstacle[] = []): PlaceScene {
  return { faces, obstacles, safe: SAFE_ZONE };
}

const outcomes = (result: ReturnType<typeof placeElement>) => result.notes.map((n) => n.outcome);
const inside = (box: Box, area: Box) =>
  box.left >= area.left - 1e-6 &&
  box.right <= area.right + 1e-6 &&
  box.top >= area.top - 1e-6 &&
  box.bottom <= area.bottom + 1e-6;

let measurer: Measurer;
beforeAll(async () => {
  measurer = await nodeMeasurer();
});

describe("an empty scene", () => {
  it("places the hook at the top centre of the upper third, full size, one note `placed`", () => {
    const result = placeElement(hook("start here"), scene([]), measurer);
    expect(result.placed).not.toBeNull();
    const { box, zone, cost, lines, breaks } = result.placed!;
    expect(zone).toBe("upper-third");
    expect(cost).toBe(0);
    expect(lines).toEqual(["start here"]);
    expect(breaks).toEqual([]);
    expect(box.top).toBe(S.top);
    expect((box.left + box.right) / 2).toBeCloseTo((S.left + S.right) / 2, 0);
    expect(inside(box, UPPER_THIRD)).toBe(true);
    expect(outcomes(result)).toEqual(["placed"]);
    expect(result.notes[0]).toMatchObject({
      item: "hook",
      component: "HOOK",
      variant: "hook/written-line",
      start: 3.2,
      end: 4.1,
      rule: "zone",
      blockers: [],
      zone: "upper-third",
      lines: 1,
      cost: 0,
    });
    expect(result.notes[0]!.reason).toContain(
      'hook hook "start here" is placed in the upper third',
    );
  });

  it("places an accent above the head, its box clear of the face, at no cost", () => {
    const result = placeElement(accent("lock-in"), scene([FACE]), measurer);
    const { box, zone, cost, coversFace } = result.placed!;
    expect(zone).toBe("above-head");
    expect(cost).toBe(0);
    expect(coversFace).toBe(false);
    expect(box.bottom).toBeLessThanOrEqual(FACE.top - 12);
    expect(box.top).toBeGreaterThanOrEqual(S.top);
    expect(outcomes(result)).toEqual(["placed"]);
  });

  it("with no head, an accent aims at the accent line (y 1130) at the size S gives it", () => {
    const result = placeElement(accent("lock-in"), scene([]), measurer);
    const { box, zone, size } = result.placed!;
    expect(zone).toBe("above-head");
    // Its size is the room S has (its width), so the text is taller than the
    // 34 px between the accent line and the button column; at full width it
    // cannot cross the notch band, so it stops right above it.
    expect(size).toBeGreaterThan(PLATFORM_BUTTONS.top - 1130);
    expect(box.bottom).toBe(PLATFORM_BUTTONS.top);
    expect(box.top).toBeLessThan(1130);
    expect(overlaps(box, PLATFORM_BUTTONS)).toBe(false);
  });
});

describe("a crowded upper third", () => {
  const crowd = [textAt("accent-1", UPPER_THIRD)];

  it("moves the hook down its ranking at one zone step, the crowd as its blockers", () => {
    const clear = placeElement(hook("start here"), scene([]), measurer);
    const result = placeElement(hook("start here"), scene([], crowd), measurer);
    const { box, zone, cost, size } = result.placed!;
    expect(zone).toBe("anywhere-in-safe-zone");
    expect(cost).toBe(PLACE_COSTS.zoneStep);
    // The width of S bounds the size in both zones: no shrink.
    expect(size).toBe(clear.placed!.size);
    expect(box.top).toBeGreaterThanOrEqual(UPPER_THIRD.bottom + 12);
    expect(outcomes(result)).toEqual(["moved"]);
    expect(result.notes[0]!.blockers).toEqual([{ kind: "item", id: "accent-1" }]);
    expect(result.notes[0]!.reason).toContain("moves in the safe zone");
    expect(result.notes[0]!.reason).toContain("accent-1 took the upper third");
  });

  it("is deterministic: the same scene twice gives the same result", () => {
    const once = placeElement(hook("start here"), scene([FACE], crowd), measurer);
    const twice = placeElement(hook("start here"), scene([FACE], crowd), measurer);
    expect(twice).toEqual(once);
  });

  it("a shrunk element notes `shrunk` with the size it gave up", () => {
    // Two words in a column of 300 px: narrower than the text at its full size.
    const column = [
      textAt("accent-1", { left: 347, right: S.right, top: S.top, bottom: S.bottom }),
    ];
    const clear = placeElement(hook("hi"), scene([]), measurer);
    const result = placeElement(hook("hi"), scene([], column), measurer);
    expect(result.placed!.size).toBeLessThan(clear.placed!.size);
    expect(result.placed!.zone).toBe("upper-third");
    expect(outcomes(result)).toEqual(["shrunk"]);
    expect(result.placed!.cost).toBe(
      PLACE_COSTS.shrinkStep * (result.notes[0]!.cost! / PLACE_COSTS.shrinkStep),
    );
    expect(result.notes[0]!.reason).toContain(
      `shrinks to ${result.placed!.size} px from ${clear.placed!.size} px`,
    );
  });
});

describe("the face", () => {
  // A face filling the upper third (unpadded; F reaches past S).
  const wide: Box = { left: 0, right: 1080, top: 150, bottom: 700 };

  it("is avoided at a zone step rather than covered", () => {
    const result = placeElement(hook("start here"), scene([wide]), measurer);
    expect(result.placed!.zone).toBe("anywhere-in-safe-zone");
    expect(result.placed!.coversFace).toBe(false);
    expect(result.placed!.cost).toBe(PLACE_COSTS.zoneStep);
    expect(result.placed!.box.top).toBeGreaterThanOrEqual(wide.bottom + 12);
    expect(outcomes(result)).toEqual(["moved"]);
    expect(result.notes[0]!.blockers).toEqual([{ kind: "face" }]);
  });

  it("is covered only when no spot off the face passes, outcome covers-face at the face cost", () => {
    const rest = [textAt("accent-1", { ...S, top: wide.bottom })];
    const result = placeElement(hook("start here"), scene([wide], rest), measurer);
    const { zone, cost, coversFace, box } = result.placed!;
    expect(zone).toBe("upper-third");
    expect(coversFace).toBe(true);
    expect(cost).toBe(PLACE_COSTS.face);
    expect(inside(box, UPPER_THIRD)).toBe(true);
    expect(outcomes(result)).toEqual(["covers-face"]);
    expect(result.notes[0]).toMatchObject({
      rule: "face",
      zone: "upper-third",
      cost: PLACE_COSTS.face,
    });
    expect(result.notes[0]!.blockers).toEqual(expect.arrayContaining([{ kind: "face" }]));
  });

  it("the behind big word pays no face cost and keeps 70% of its height clear of the face (rule 6)", () => {
    const result = placeElement(bigWord("AI"), scene([FACE]), measurer);
    expect(result.placed).not.toBeNull();
    const { box, zone, cost, coversFace } = result.placed!;
    expect(zone).toBe("head-top");
    expect(coversFace).toBe(false);
    expect(cost).toBeLessThan(PLACE_COSTS.face);
    expect(bigWordCoveredShare(box, [FACE])).toBeLessThanOrEqual(0.3);
    expect(inside(box, S)).toBe(true);
    expect(outcomes(result)).not.toContain("covers-face");
  });
});

describe("no legal spot", () => {
  it("a word that fits nowhere: `no-spot`, the text that took the space as blockers", () => {
    const result = placeElement(accent("lock-in"), scene([FACE], [textAt("hook", S)]), measurer);
    expect(result.placed).toBeNull();
    expect(outcomes(result)).toEqual(["no-spot"]);
    expect(result.notes[0]).toMatchObject({
      item: "accent-1",
      component: "ACCENT",
      variant: "accent/above-head",
      rule: "no-spot",
    });
    expect(result.notes[0]!.blockers).toEqual([
      { kind: "item", id: "hook" },
      { kind: "face" },
      { kind: "buttons" },
    ]);
    expect(result.notes[0]!.reason).toContain(`nothing fits at ${MIN_SIZE_PX} px or more`);
    expect(result.notes[0]!.zone).toBeUndefined();
  });

  it("a word too wide for S at the minimum size: the safe zone's sides as blockers", () => {
    const result = placeElement(accent("W".repeat(120)), scene([]), measurer);
    expect(result.placed).toBeNull();
    expect(result.notes[0]!.blockers).toEqual([
      { kind: "safe-zone", edge: "left" },
      { kind: "safe-zone", edge: "right" },
    ]);
  });

  it("a caption blocks everything, a card too", () => {
    const result = placeElement(card, scene([], [captionAt("w0001", S)]), measurer);
    expect(result.placed).toBeNull();
    expect(result.notes[0]!.blockers).toEqual([
      { kind: "caption", id: "w0001" },
      { kind: "buttons" },
    ]);
  });
});

describe("the 30 px floor", () => {
  // One zone only, so the strip the obstacle leaves is the one place to be.
  const upperOnly: TextVariant = { ...VARIANTS["hook/written-line"], zones: ["upper-third"] };
  const strip = (height: number) => [textAt("accent-1", { ...S, top: S.top + height + 12 })];

  it("a strip one pixel under the floor fits nothing", () => {
    const result = placeElement(
      text(upperOnly, "hi", "hook"),
      scene([], strip(MIN_SIZE_PX - 1)),
      measurer,
    );
    expect(result.placed).toBeNull();
    expect(outcomes(result)).toEqual(["no-spot"]);
  });

  it("a strip at the floor holds the text at 30 px, shrunk", () => {
    const result = placeElement(
      text(upperOnly, "hi", "hook"),
      scene([], strip(MIN_SIZE_PX)),
      measurer,
    );
    expect(result.placed!.size).toBe(MIN_SIZE_PX);
    expect(result.placed!.box.top).toBe(S.top);
    expect(outcomes(result)).toEqual(["shrunk"]);
  });
});

describe("wrapping", () => {
  // The right half of S taken by a text: a column 493 px wide is left.
  const column = [textAt("accent-1", { left: 540, right: S.right, top: S.top, bottom: S.bottom })];

  it("is free: in a tall zone two words take two lines at a larger size, at no cost", () => {
    const anywhere: TextVariant = {
      ...VARIANTS["hook/written-line"],
      zones: ["anywhere-in-safe-zone"],
    };
    const result = placeElement(text(anywhere, "start here", "hook"), scene([]), measurer);
    const oneLine = Math.floor((S.right - S.left) / measurer.width("primary", 1, "start here"));
    expect(result.placed!.lines).toEqual(["start", "here"]);
    expect(result.placed!.breaks).toEqual([1]);
    expect(result.placed!.size).toBeGreaterThan(oneLine);
    expect(result.placed!.cost).toBe(PLACE_COSTS.wrap);
    expect(outcomes(result)).toEqual(["wrapped"]);
    expect(result.notes[0]!.blockers).toEqual([]);
  });

  it("is preferred to shrinking: two lines two steps down beat one line six steps down", () => {
    const upperOnly: TextVariant = { ...VARIANTS["hook/written-line"], zones: ["upper-third"] };
    const clear = placeElement(text(upperOnly, "start here", "hook"), scene([]), measurer);
    const result = placeElement(text(upperOnly, "start here", "hook"), scene([], column), measurer);
    expect(clear.placed!.lines).toHaveLength(1);
    expect(result.placed!.lines).toEqual(["start", "here"]);
    // Two lines in 417 px: 208 px, two steps under 233; one line in the
    // column would be 114 px, six steps.
    expect(result.placed!.size).toBe(Math.floor((UPPER_THIRD.bottom - UPPER_THIRD.top) / 2));
    expect(result.placed!.cost).toBe(2 * PLACE_COSTS.shrinkStep);
    expect(outcomes(result)).toEqual(["shrunk", "wrapped"]);
  });

  it("the hook: a zone step with two full lines (10) beats two shrink steps in the upper third (20)", () => {
    // The upper third is 417 px high: two lines there mean 208 px, two steps
    // under the one-line full size (233 px); the next zone holds both at full.
    const clear = placeElement(hook("start here"), scene([]), measurer);
    const result = placeElement(hook("start here"), scene([], column), measurer);
    expect(result.placed!.lines).toEqual(["start", "here"]);
    expect(result.placed!.zone).toBe("anywhere-in-safe-zone");
    expect(result.placed!.size).toBe(clear.placed!.size);
    expect(result.placed!.cost).toBe(PLACE_COSTS.zoneStep);
    expect(outcomes(result)).toEqual(["moved", "wrapped"]);
  });

  it("balances any number of lines: three words in a narrow column take three lines", () => {
    const column = [
      textAt("accent-1", { left: 300, right: S.right, top: S.top, bottom: S.bottom }),
    ];
    const result = placeElement(hook("one two three"), scene([], column), measurer);
    expect(result.placed!.lines).toEqual(["one", "two", "three"]);
    expect(result.placed!.breaks).toEqual([1, 2]);
    expect(result.placed!.box.right).toBeLessThanOrEqual(300 - 12);
  });

  it("caption lines keep the line gap between them", () => {
    const column = [
      textAt("accent-1", { left: 400, right: S.right, top: S.top, bottom: S.bottom }),
    ];
    const result = placeElement(caption("one two"), scene([], column), measurer);
    const { box, size, lines } = result.placed!;
    expect(lines).toHaveLength(2);
    expect(box.bottom - box.top).toBe(2 * size + 14);
  });
});

describe("text and boxes", () => {
  it("a box under a text is no obstacle: the accent keeps its spot and cost", () => {
    const clear = placeElement(accent("lock-in"), scene([FACE]), measurer);
    const under = placeElement(
      accent("lock-in"),
      scene([FACE], [boxAt("visual-1", { left: 300, right: 700, top: 220, bottom: 488 })]),
      measurer,
    );
    expect(under.placed).toEqual(clear.placed);
    expect(outcomes(under)).toEqual(["placed"]);
  });

  it("a card sees no text: it takes the top-left corner over a text there, full size", () => {
    const result = placeElement(
      card,
      scene([], [textAt("hook", { left: 75, right: 600, top: 260, bottom: 500 })]),
      measurer,
    );
    const { box, size, zone, cost, lines, breaks } = result.placed!;
    expect(zone).toBe("corner");
    expect(cost).toBe(0);
    expect(size).toBe(360);
    expect(box).toEqual({ left: 75, top: 260, right: 435, bottom: 710 });
    expect(lines).toEqual([]);
    expect(breaks).toEqual([]);
  });

  it("a card beside a wide face shrinks from its full width, cost by 10% steps", () => {
    // The face takes the top of S; the corners' inset box leaves it only strips.
    const wide: Box = { left: 200, right: 800, top: 230, bottom: 1300 };
    const result = placeElement(card, scene([wide]), measurer);
    expect(result.placed).not.toBeNull();
    const { size, cost, coversFace } = result.placed!;
    expect(coversFace).toBe(false);
    expect(size).toBeLessThan(360);
    expect(cost).toBe(PLACE_COSTS.shrinkStep * Math.ceil((360 - size) / 36 - 1e-9));
    expect(outcomes(result)).toContain("shrunk");
  });
});

describe("the notch", () => {
  it("a caption on the caption line stays left of the button column", () => {
    const result = placeElement(
      caption("a long caption line of many words here"),
      scene([]),
      measurer,
    );
    const { box, zone } = result.placed!;
    expect(zone).toBe("caption-line");
    expect(box.top).toBe(1290);
    expect(overlaps(box, PLATFORM_BUTTONS)).toBe(false);
    expect(box.right).toBeLessThanOrEqual(PLATFORM_BUTTONS.left);
    expect(inside(box, S)).toBe(true);
  });

  it("every candidate stays inside S: a text filling the safe zone never crosses the notch", () => {
    const result = placeElement(bigWord("WWWWWWWW"), scene([]), measurer);
    const { box } = result.placed!;
    expect(inside(box, S)).toBe(true);
    expect(overlaps(box, PLATFORM_BUTTONS)).toBe(false);
  });
});
