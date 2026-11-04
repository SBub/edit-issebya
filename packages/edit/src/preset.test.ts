import { describe, expect, it } from "vitest";
import { bigWordLayout } from "./behind.ts";
import {
  ISSEBYA_PRESET,
  PLATFORM_BUTTONS,
  PLATFORM_SAFE,
  TRANSITION_KINDS,
  TRANSITION_TYPES,
  intersectBox,
} from "./preset.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";

const safe = ISSEBYA_PRESET.safe;

describe("intersectBox", () => {
  it("keeps the part both boxes share", () => {
    expect(
      intersectBox(
        { left: 0, right: 100, top: 10, bottom: 200 },
        { left: 20, right: 150, top: 0, bottom: 120 },
      ),
    ).toEqual({ left: 20, right: 100, top: 10, bottom: 120 });
  });
});

describe("the platform guard", () => {
  it("is the TikTok and Instagram box at 1080x1920", () => {
    expect(PLATFORM_SAFE).toEqual({ left: 35, right: 1045, top: 220, bottom: 1470 });
  });

  it("cuts the button column out of the box's lower-right corner", () => {
    expect(PLATFORM_BUTTONS).toEqual({ left: 945, right: 1045, top: 1164, bottom: 1470 });
    expect(intersectBox(PLATFORM_BUTTONS, PLATFORM_SAFE)).toEqual(PLATFORM_BUTTONS);
  });

  it("cuts the style's safe box, which lies inside the guard and clear of the buttons", () => {
    expect(safe).toEqual({ left: 130, right: 860, top: 260, bottom: 1400 });
    expect(intersectBox(safe, PLATFORM_SAFE)).toEqual(safe);
    expect(safe.right).toBeLessThanOrEqual(PLATFORM_BUTTONS.left);
  });

  it("keeps the caption fallback line inside the safe box", () => {
    const { caption, fonts } = ISSEBYA_PRESET;
    expect(caption.fallbackY).toBeGreaterThanOrEqual(safe.top);
    expect(caption.fallbackY + fonts[caption.font].size).toBeLessThanOrEqual(safe.bottom);
  });

  it("keeps the accent's no-head line inside the safe box", () => {
    const { accent, fonts } = ISSEBYA_PRESET;
    expect(accent.noHeadY).toBeGreaterThanOrEqual(safe.top);
    expect(accent.noHeadY + fonts[accent.font].size).toBeLessThanOrEqual(safe.bottom);
  });

  it("keeps every transition's text area inside the safe box", () => {
    for (const type of TRANSITION_TYPES) {
      const { text } = ISSEBYA_PRESET.transitions[type];
      expect(intersectBox(text, safe), type).toEqual(text);
    }
    expect(ISSEBYA_PRESET.transitions.panel.layer.top).toBeLessThanOrEqual(
      ISSEBYA_PRESET.transitions.panel.text.top,
    );
  });

  it("keeps every transition's level area inside its layer, the safe box and the guard, left of the buttons", () => {
    for (const type of TRANSITION_TYPES) {
      const { area, layer } = ISSEBYA_PRESET.transitions[type];
      for (const box of [layer, safe, PLATFORM_SAFE]) {
        expect(intersectBox(area, box), type).toEqual(area);
      }
      expect(area.right, type).toBeLessThanOrEqual(PLATFORM_BUTTONS.left);
    }
  });

  it("keeps the no-head big word inside the guard's top and bottom", async () => {
    const box = bigWordLayout(
      {
        id: "bw",
        kind: "word",
        text: "AI",
        start: { time: 1 },
        end: { time: 3 },
      },
      { start: 1, end: 3 },
      [null, null],
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    expect(box.y).toBeGreaterThanOrEqual(PLATFORM_SAFE.top);
    expect(box.y + box.height).toBeLessThanOrEqual(PLATFORM_SAFE.bottom);
  });
});

describe("the transition library", () => {
  it("offers dim, panel and numbered, never card", () => {
    expect([...TRANSITION_KINDS]).toEqual(["dim", "panel", "numbered"]);
    expect(TRANSITION_TYPES).toContain("card");
  });

  it("describes every kind Claude may pick", () => {
    for (const kind of TRANSITION_KINDS) {
      expect(ISSEBYA_PRESET.transitions[kind].description, kind).toMatch(/^\S.{20,}$/);
    }
  });

  it("holds no colour and no font in a transition entry: they come from the style roles", () => {
    for (const type of TRANSITION_TYPES) {
      const entry = JSON.stringify(ISSEBYA_PRESET.transitions[type]);
      expect(entry, type).not.toMatch(/#|rgb|"font"|"color"|"background"/);
    }
    expect(ISSEBYA_PRESET.background).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it("fits the number at its size inside the numbered area", async () => {
    const { numbered } = ISSEBYA_PRESET.transitions;
    const measurer = await nodeMeasurer();
    const width = measurer.width(ISSEBYA_PRESET.accent.font, numbered.numberSize!, "99");
    expect(width).toBeLessThanOrEqual(numbered.area.right - numbered.area.left);
    expect(numbered.numberSize!).toBeLessThanOrEqual(numbered.area.bottom - numbered.area.top);
  });

  it("times a transition from 1.5 s, holding 1 s (2 s asked), 1.6 times slower when asked, one per 7 s", () => {
    expect(ISSEBYA_PRESET.transition).toMatchObject({
      minSeconds: 1.5,
      holdSeconds: 1,
      longHoldSeconds: 2,
      slowFactor: 1.6,
      perSeconds: 7,
    });
  });
});
