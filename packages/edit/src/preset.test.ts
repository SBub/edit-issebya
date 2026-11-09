import { describe, expect, it } from "vitest";
import {
  ISSEBYA_PRESET,
  PLATFORM_BUTTONS,
  PLATFORM_SAFE,
  TRANSITION_KINDS,
  intersectBox,
} from "./preset.ts";
import { SAFE_ZONE } from "./engine-zones.ts";

const safe = SAFE_ZONE.box;

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

  it("is the one safe zone: the guard, with the button column's notch as its own part", () => {
    expect(SAFE_ZONE).toEqual({ box: PLATFORM_SAFE, notch: PLATFORM_BUTTONS });
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
});

describe("the transition library", () => {
  it("offers numbered only: the LIST, the one kind a transition takes", () => {
    expect([...TRANSITION_KINDS]).toEqual(["numbered"]);
  });

  it("describes every kind Claude may pick", () => {
    for (const kind of TRANSITION_KINDS) {
      expect(ISSEBYA_PRESET.transitions[kind].description, kind).toMatch(/^\S.{20,}$/);
    }
  });

  it("holds no colour and no font in a transition entry: they come from the style roles", () => {
    for (const type of TRANSITION_KINDS) {
      const entry = JSON.stringify(ISSEBYA_PRESET.transitions[type]);
      expect(entry, type).not.toMatch(/#|rgb|"font"|"color"|"background"/);
    }
  });

  it("holds no size and no spot for a transition's levels: the stack's entry and the zones have them", () => {
    for (const type of TRANSITION_KINDS) {
      expect(ISSEBYA_PRESET.transitions[type]).not.toHaveProperty("numberSize");
      expect(ISSEBYA_PRESET.transitions[type]).not.toHaveProperty("want");
    }
  });

  it("gives a transition no hold after its phrase: it leaves at the last word's end", () => {
    expect(ISSEBYA_PRESET.transition).not.toHaveProperty("holdSeconds");
    expect(ISSEBYA_PRESET.transition.gap).toBe(24);
  });

  it("paces Intense: something new every 3 s, the hook to 3 s", () => {
    const { pace, behind, accent } = ISSEBYA_PRESET;
    expect(pace).toEqual({
      extraEverySeconds: 3,
      hook: { fromSeconds: 0.2, untilSeconds: 3, maxWords: 7, maxCharacters: 45 },
    });
    // The hook comes in on the accent's lead and holds the first beat.
    expect(pace.hook.fromSeconds).toBe(accent.leadSeconds);
    expect(pace.hook.untilSeconds - pace.hook.fromSeconds).toBeGreaterThan(accent.minSeconds);
    // A VISUAL (1 to 2 s) fits inside one beat.
    expect([behind.minSeconds, behind.maxSeconds]).toEqual([1, 2]);
    expect(behind.maxSeconds).toBeLessThan(pace.extraEverySeconds);
  });

  it("times accents and big words alike: 0.2 s before the word, at least 1.5 s", () => {
    expect(ISSEBYA_PRESET.accent).toMatchObject({
      minSeconds: 1.5,
      afterSeconds: 1,
      leadSeconds: 0.2,
    });
    // The lead fits a start anchor's offset (at most 1 s).
    expect(ISSEBYA_PRESET.accent.leadSeconds).toBeLessThanOrEqual(1);
  });

  it("sets captions in Golos Text Bold, accents and the big word in Raleway Light, all white", () => {
    const { fonts, caption, accent, behind } = ISSEBYA_PRESET;
    expect(fonts.primary).toMatchObject({
      family: "Raleway Light",
      file: "assets/fonts/Raleway-Light.ttf",
      weight: 300,
    });
    expect(fonts.secondary).toMatchObject({
      family: "Golos Text",
      file: "assets/fonts/GolosText-Bold.ttf",
      weight: 700,
    });
    expect([caption.font, accent.font, behind.word.font]).toEqual([
      "secondary",
      "primary",
      "primary",
    ]);
    expect([caption.color, accent.color, behind.word.color]).toEqual([
      "#FFFFFF",
      "#FFFFFF",
      "#FFFFFF",
    ]);
    // Only the lower 30% of a big word may go behind the head.
    expect(behind.word.minVisible).toBe(0.7);
  });
});
