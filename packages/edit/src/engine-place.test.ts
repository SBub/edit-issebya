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
import { STYLES, type StackVariant, VARIANTS, type TextVariant } from "./variants.ts";

// Synthetic scenes for the placer: one element, a face or none, obstacles laid
// by hand. Sizes come from HarfBuzz over the package's fonts, so the tests
// check relations (which zone, which cost, which notes) over exact pixels.
// Widths at size 1 (Raleway Light): "hi" 0.78, "start here" 4.32 ("start"
// 2.00, "here" 2.06), "lock-in" 3.08, "AI" 0.91; Golos Bold: "one two" 3.88,
// "one" 1.80.

const S = PLATFORM_SAFE;
// An unpadded robust face in the middle of the frame.
const FACE: Box = { left: 300, right: 700, top: 500, bottom: 1000 };
// The upper third of S, 220 to 636.67.
const UPPER_THIRD: Box = { ...S, bottom: S.top + (S.bottom - S.top) / 3 };

const span = { start: 3.2, end: 4.1 };
// The base size of the accent style (the hook's, the accent's, the question's).
const BASE = STYLES.accent.base as number;
// A text with the big word's style (largest fit) and no face to keep clear of.
const largestFit = (zones: TextVariant["zones"]): TextVariant => ({
  ...VARIANTS["bigword/behind"],
  zones,
});

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
    const { box, zone, cost, lines, breaks, size } = result.placed!;
    expect(zone).toBe("upper-third");
    expect(cost).toBe(0);
    expect(size).toBe(BASE);
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

  it("a short accent stays at its style's base size: it never grows into the room above the head", () => {
    // The room above the face is 1010 px wide and 268 px high: "lock-in" would
    // fit at 268 px. The style says 110.
    const result = placeElement(accent("lock-in"), scene([FACE]), measurer);
    const { box, size, cost } = result.placed!;
    expect(size).toBe(BASE);
    expect(box.bottom - box.top).toBe(BASE);
    expect(cost).toBe(0);
    expect(result.notes[0]!.size).toBe(BASE);
  });

  it("with no head, an accent sits on the accent line (y 1130) at its base size", () => {
    const result = placeElement(accent("lock-in"), scene([]), measurer);
    const { box, zone, size } = result.placed!;
    expect(zone).toBe("above-head");
    expect(size).toBe(BASE);
    expect(box.top).toBe(1130);
    expect((box.left + box.right) / 2).toBeCloseTo((S.left + S.right) / 2, 0);
    // Centred at 110 px it is 339 px wide: nowhere near the button column.
    expect(overlaps(box, PLATFORM_BUTTONS)).toBe(false);
  });

  it("a long accent shrinks from the base when its zone is short, in 10% steps", () => {
    // Above the face the zone is 268 px high: at 110 px the sentence needs
    // three lines (330 px) or two lines wider than S. One zone only, so it
    // shrinks rather than moves.
    const aboveOnly: TextVariant = { ...VARIANTS["accent/above-head"], zones: ["above-head"] };
    const result = placeElement(
      text(aboveOnly, "the time we are living right now pushes everyone to rethink"),
      scene([FACE]),
      measurer,
    );
    const { size, lines, cost, box } = result.placed!;
    expect(size).toBeLessThan(BASE);
    expect(size).toBeGreaterThanOrEqual(MIN_SIZE_PX);
    expect(lines.length).toBeGreaterThan(1);
    expect(box.bottom).toBeLessThanOrEqual(FACE.top - 12);
    const steps = Math.ceil((BASE - size) / (0.1 * BASE) - 1e-9);
    expect(cost).toBe(steps * PLACE_COSTS.shrinkStep);
    expect(outcomes(result)).toEqual(["shrunk", "wrapped"]);
    expect(result.notes[0]!.reason).toContain(`shrinks to ${size} px from ${BASE} px`);
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
    // One word in a column of 60 px: "hi" is 86 px at its base size.
    const column = [
      textAt("accent-1", { left: S.left + 60 + 12, right: S.right, top: S.top, bottom: S.bottom }),
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

  it("the behind big word grows to the largest fit, pays no face cost and keeps 70% of its height clear of the face (rule 6)", () => {
    const result = placeElement(bigWord("AI"), scene([FACE]), measurer);
    expect(result.placed).not.toBeNull();
    const { box, zone, cost, coversFace, size } = result.placed!;
    expect(zone).toBe("head-top");
    // Its style has no base: the largest room the face leaves (458 px below
    // it) is its size, far over the accent's 110.
    expect(size).toBeGreaterThan(BASE);
    expect(size).toBe(S.bottom - (FACE.bottom + 12));
    expect(coversFace).toBe(false);
    expect(cost).toBeLessThan(PLACE_COSTS.face);
    expect(bigWordCoveredShare(box, [FACE])).toBeLessThanOrEqual(0.3);
    expect(inside(box, S)).toBe(true);
    expect(outcomes(result)).not.toContain("covers-face");
  });

  it("the 30% rule is a hard filter: a big word the face would hide most of at the largest fit takes a smaller spot clear of it", () => {
    // A tall face through most of S: the largest fit (S's width, 1107 px) sits
    // over the face, which would hide 90% of it, so rule 6 drops that
    // candidate; the word takes the strip beside the face, still far over the
    // accent's base, at a shrink cost.
    const tall: Box = { left: 300, right: 700, top: 300, bottom: 1300 };
    const result = placeElement(bigWord("AI"), scene([tall]), measurer);
    const { box, size, cost } = result.placed!;
    expect(bigWordCoveredShare(box, [tall])).toBeLessThanOrEqual(0.3);
    expect(overlaps(box, tall)).toBe(false);
    expect(size).toBeGreaterThan(BASE);
    expect(inside(box, S)).toBe(true);
    expect(cost).toBeGreaterThan(0);
    expect(outcomes(result)).toEqual(["shrunk"]);
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
  // A text over the right of S leaves a column `width` px wide on the left.
  const columnOf = (width: number, bottom = S.bottom) => [
    textAt("accent-1", { left: S.left + width + 12, right: S.right, top: S.top, bottom }),
  ];

  it("is free: a largest-fit text in a tall zone takes two lines at a larger size, at no cost", () => {
    const result = placeElement(
      text(largestFit(["anywhere-in-safe-zone"]), "start here", "big-word-1"),
      scene([]),
      measurer,
    );
    const oneLine = Math.floor((S.right - S.left) / measurer.width("primary", 1, "start here"));
    expect(result.placed!.lines).toEqual(["start", "here"]);
    expect(result.placed!.breaks).toEqual([1]);
    expect(result.placed!.size).toBeGreaterThan(oneLine);
    expect(result.placed!.cost).toBe(PLACE_COSTS.wrap);
    expect(outcomes(result)).toEqual(["wrapped"]);
    expect(result.notes[0]!.blockers).toEqual([]);
  });

  it("comes before shrinking: a capped text in a column narrower than its line wraps at its base size, at no cost", () => {
    // "start here" is 475 px at 110; the column is 353. Two lines ("here",
    // 227 px) fit at 110, so nothing is given up but a line.
    const upperOnly: TextVariant = { ...VARIANTS["hook/written-line"], zones: ["upper-third"] };
    const clear = placeElement(text(upperOnly, "start here", "hook"), scene([]), measurer);
    const result = placeElement(
      text(upperOnly, "start here", "hook"),
      scene([], columnOf(353)),
      measurer,
    );
    expect(clear.placed!.lines).toHaveLength(1);
    expect(result.placed!.lines).toEqual(["start", "here"]);
    expect(result.placed!.size).toBe(BASE);
    expect(result.placed!.cost).toBe(PLACE_COSTS.wrap);
    expect(outcomes(result)).toEqual(["wrapped"]);
  });

  it("shrinks as little as it must: two lines four steps down beat one line seven steps down", () => {
    // A column of 150 px: two lines fit at 72 px (four steps under 110), one
    // line at 34 px (seven steps).
    const upperOnly: TextVariant = { ...VARIANTS["hook/written-line"], zones: ["upper-third"] };
    const result = placeElement(
      text(upperOnly, "start here", "hook"),
      scene([], columnOf(150)),
      measurer,
    );
    expect(result.placed!.lines).toEqual(["start", "here"]);
    expect(result.placed!.size).toBe(Math.floor(150 / measurer.width("primary", 1, "here")));
    expect(result.placed!.cost).toBe(4 * PLACE_COSTS.shrinkStep);
    expect(outcomes(result)).toEqual(["shrunk", "wrapped"]);
  });

  it("the hook: a zone step at the base size (10) beats four shrink steps in the upper third (40)", () => {
    // The column covers the upper third only: there the hook would be two
    // lines at 72 px; the next zone holds one line at 110.
    const result = placeElement(
      hook("start here"),
      scene([], columnOf(150, UPPER_THIRD.bottom)),
      measurer,
    );
    expect(result.placed!.lines).toEqual(["start here"]);
    expect(result.placed!.zone).toBe("anywhere-in-safe-zone");
    expect(result.placed!.size).toBe(BASE);
    expect(result.placed!.cost).toBe(PLACE_COSTS.zoneStep);
    expect(outcomes(result)).toEqual(["moved"]);
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
    // "one two" is 194 px at the caption base (50); a column of 150 px wraps it.
    const result = placeElement(caption("one two"), scene([], columnOf(150)), measurer);
    const { box, size, lines } = result.placed!;
    expect(lines).toHaveLength(2);
    expect(size).toBe(STYLES.caption.base);
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

describe("a LIST stack", () => {
  const LIST = VARIANTS["list/numbered"];
  const GAP = 24;
  const KEY_BASE = STYLES.accent.base as number;
  const LEAD_BASE = STYLES.caption.base as number;
  const RATIO = LIST.levels[0]!.role === "number" ? LIST.levels[0]!.ratio : NaN;
  const stack = (
    levels: { role: "number" | "lead" | "key"; text: string }[],
    variant: StackVariant = LIST,
  ): PlaceElement => ({ type: "stack", id: "transition-1", variant, levels, gap: GAP, ...span });
  const NUMBERED_LEVELS: { role: "number" | "lead" | "key"; text: string }[] = [
    { role: "number", text: "1" },
    { role: "lead", text: "they want" },
    { role: "key", text: "fair pay" },
  ];
  const numbered = stack(NUMBERED_LEVELS);

  it("is one element: number, lead-in and key at their bases, the number by its ratio, 24 px between, centred", () => {
    const result = placeElement(numbered, scene([]), measurer);
    expect(result.placed).not.toBeNull();
    const { box, size, levels, lines, breaks } = result.placed!;
    expect(size).toBe(KEY_BASE);
    expect(levels.map((level) => [level.role, level.size])).toEqual([
      ["number", Math.floor(KEY_BASE * RATIO + 1e-6)],
      ["lead", LEAD_BASE],
      ["key", KEY_BASE],
    ]);
    expect(levels[0]!.size).toBe(300);
    // The box is the widest level wide and the levels plus two gaps high.
    expect(box.right - box.left).toBeCloseTo(Math.max(...levels.map((level) => level.width)), 6);
    expect(box.bottom - box.top).toBe(300 + GAP + LEAD_BASE + GAP + KEY_BASE);
    expect(lines).toEqual(["1", "they want", "fair pay"]);
    expect(breaks).toEqual([]);
    expect(levels.every((level) => level.lines.length === 1 && level.breaks.length === 0)).toBe(
      true,
    );
    expect(inside(box, S)).toBe(true);
    expect(result.notes[0]!.reason).toContain('list transition-1 "1 / they want / fair pay"');
  });

  it("falls through to the safe zone whole rather than shrinking into the upper third: 508 px does not fit 416", () => {
    // The upper third of S is 416 px high; the stack at full size is 508. Two
    // shrink steps there (20) cost more than one zone step (10) at full size.
    const result = placeElement(numbered, scene([]), measurer);
    const { zone, cost, size, box } = result.placed!;
    expect(zone).toBe("anywhere-in-safe-zone");
    expect(cost).toBe(PLACE_COSTS.zoneStep);
    expect(size).toBe(KEY_BASE);
    expect((box.top + box.bottom) / 2).toBeCloseTo((S.top + S.bottom) / 2, 0);
    expect(outcomes(result)).toEqual(["moved"]);
  });

  it("a one-item list (no number) fits the upper third at full size: one note `placed`", () => {
    const result = placeElement(
      stack([
        { role: "lead", text: "AI has completely disrupted" },
        { role: "key", text: "the way we work" },
      ]),
      scene([]),
      measurer,
    );
    const { zone, cost, size, box, levels } = result.placed!;
    expect(zone).toBe("upper-third");
    expect(cost).toBe(0);
    expect(size).toBe(KEY_BASE);
    expect(levels.map((level) => level.role)).toEqual(["lead", "key"]);
    expect(box.top).toBe(S.top);
    expect(inside(box, UPPER_THIRD)).toBe(true);
    expect(outcomes(result)).toEqual(["placed"]);
  });

  it("shrinks the whole stack together, the levels keeping their ratios, in steps of the key's size", () => {
    // One zone only, a strip 400 px high: the stack (508 at full) must shrink
    // to fit; the key at 84 gives the number 229 and the lead-in 38.
    const upperOnly: StackVariant = { ...LIST, zones: ["upper-third"] };
    const strip = [textAt("accent-1", { ...S, top: S.top + 400 + 12 })];
    const result = placeElement(stack(NUMBERED_LEVELS, upperOnly), scene([], strip), measurer);
    expect(result.placed).not.toBeNull();
    const { size, levels, box, cost } = result.placed!;
    expect(size).toBe(84);
    expect(box.bottom).toBeLessThanOrEqual(S.top + 400);
    const [number, lead, key] = levels;
    expect(key!.size).toBe(size);
    expect(number!.size).toBe(Math.floor(size * RATIO + 1e-6));
    expect(lead!.size).toBe(Math.floor((size * LEAD_BASE) / KEY_BASE + 1e-6));
    expect(levels.map((level) => level.size)).toEqual([229, 38, 84]);
    // 84 is under 110 by 26: three steps of 11.
    expect(cost).toBe(3 * PLACE_COSTS.shrinkStep);
    expect(outcomes(result)).toEqual(["shrunk"]);
    expect(result.notes[0]!.reason).toContain(
      `shrinks its key phrase to ${size} px from ${KEY_BASE} px, the other levels with it`,
    );
  });

  it("wraps the lead-in and the key phrase freely, each on its own lines, at no cost", () => {
    // A column 450 px wide: "the way we work" is 837 px at 110, the lead-in
    // 684 px at 50; both take two lines, the stack stays at full size in the
    // upper third (two lines each fit its 416 px: 100 + 24 + 220).
    const column = [
      textAt("accent-1", { left: S.left + 450 + 12, right: S.right, top: S.top, bottom: S.bottom }),
    ];
    const result = placeElement(
      stack([
        { role: "lead", text: "AI has completely disrupted" },
        { role: "key", text: "the way we work" },
      ]),
      scene([], column),
      measurer,
    );
    const { size, levels, box, cost, zone } = result.placed!;
    expect(zone).toBe("upper-third");
    expect(size).toBe(KEY_BASE);
    expect(box.right).toBeLessThanOrEqual(S.left + 450);
    const [lead, key] = levels;
    expect(lead!.lines).toEqual(["AI has completely", "disrupted"]);
    expect(key!.lines).toEqual(["the way", "we work"]);
    expect(key!.breaks).toEqual([2]);
    expect(lead!.breaks).toEqual([3]);
    expect(cost).toBe(PLACE_COSTS.wrap);
    expect(outcomes(result)).toEqual(["wrapped"]);
    expect(result.notes[0]!.reason).toMatch(
      /wraps its lead-in to \d lines and its key phrase to \d lines/,
    );
  });

  it("the 30 px minimum holds for every level: the stack stops where its lead-in reaches it", () => {
    // The lead-in is 50 over the key's 110: at a key of 66 px it is 30 px. A
    // strip that fits the stack only below that is a no-spot.
    const upperOnly: StackVariant = { ...LIST, zones: ["upper-third"] };
    const floorKey = Math.ceil((MIN_SIZE_PX * KEY_BASE) / LEAD_BASE);
    const heightAt = (key: number) =>
      Math.floor(key * RATIO + 1e-6) +
      GAP +
      Math.floor((key * LEAD_BASE) / KEY_BASE + 1e-6) +
      GAP +
      key;
    const fits = placeElement(
      stack(NUMBERED_LEVELS, upperOnly),
      scene([], [textAt("accent-1", { ...S, top: S.top + heightAt(floorKey) + 12 })]),
      measurer,
    );
    expect(fits.placed!.size).toBe(floorKey);
    expect(fits.placed!.levels.map((level) => level.size)).toEqual([180, 30, 66]);
    const under = placeElement(
      stack(NUMBERED_LEVELS, upperOnly),
      scene([], [textAt("accent-1", { ...S, top: S.top + heightAt(floorKey) - 1 + 12 })]),
      measurer,
    );
    expect(under.placed).toBeNull();
    expect(outcomes(under)).toEqual(["no-spot"]);
  });

  it("that fits nowhere whole is a `no-spot`, never three placements", () => {
    const result = placeElement(numbered, scene([], [textAt("hook", S)]), measurer);
    expect(result.placed).toBeNull();
    expect(outcomes(result)).toEqual(["no-spot"]);
    expect(result.notes[0]).toMatchObject({
      item: "transition-1",
      component: "LIST",
      variant: "list/numbered",
      rule: "no-spot",
    });
    expect(result.notes[0]!.blockers).toEqual([{ kind: "item", id: "hook" }, { kind: "buttons" }]);
  });

  it("sees text as an obstacle and avoids the face at a zone step, like any text", () => {
    const wide: Box = { left: 0, right: 1080, top: 150, bottom: 700 };
    const result = placeElement(numbered, scene([wide]), measurer);
    const { zone, coversFace, box } = result.placed!;
    expect(zone).toBe("anywhere-in-safe-zone");
    expect(coversFace).toBe(false);
    expect(box.top).toBeGreaterThanOrEqual(wide.bottom + 12);
    expect(result.notes[0]!.blockers).toEqual([{ kind: "face" }]);
  });
});
