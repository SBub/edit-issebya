import { describe, expect, it } from "vitest";
import {
  ISSEBYA_PRESET,
  PLATFORM_BUTTONS,
  PLATFORM_SAFE,
  TRANSITION_KINDS,
  intersectBox,
} from "./preset.ts";
import { SAFE_ZONE, zonesAt } from "./engine-zones.ts";
import type { Box } from "./head-track.ts";
import { STYLES, VARIANTS, timingOf } from "./variants.ts";

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
  it("is the TikTok full screen player's box at 1080x1920", () => {
    expect(PLATFORM_SAFE).toEqual({ left: 70, right: 1010, top: 270, bottom: 1470 });
  });

  it("cuts the button column out of the box's lower-right corner", () => {
    expect(PLATFORM_BUTTONS).toEqual({ left: 880, right: 1010, top: 833, bottom: 1470 });
    expect(intersectBox(PLATFORM_BUTTONS, PLATFORM_SAFE)).toEqual(PLATFORM_BUTTONS);
  });

  it("is the one safe zone: the guard, with the button column's notch as its own part", () => {
    expect(SAFE_ZONE).toEqual({ box: PLATFORM_SAFE, notch: PLATFORM_BUTTONS });
  });

  it("keeps the caption line and the accent's no-head line inside the safe box", () => {
    const captionLine = zonesAt("caption-line", SAFE_ZONE, null)[0]!.want.y;
    expect(captionLine).toBeGreaterThanOrEqual(safe.top);
    expect(captionLine + STYLES.caption.base).toBeLessThanOrEqual(safe.bottom);
    const noHeadLine = zonesAt("above-head", SAFE_ZONE, null)[0]!.want.y;
    expect(noHeadLine).toBeGreaterThanOrEqual(safe.top);
    expect(noHeadLine + STYLES.accent.base).toBeLessThanOrEqual(safe.bottom);
  });
});

// What TikTok's full screen player draws over the video on an iPhone (owner's
// screenshots, 2026-11-19), in video pixels: the player scales the 1080x1920
// video by 0.941 (its height fills the area above the black bottom panel) and
// crops the sides, so x 50 to 1030 shows. Measured, rounded outwards.
const PLAYER_UI: Record<string, Box> = {
  "side crop, left": { left: 0, right: 50, top: 0, bottom: 1920 },
  "side crop, right": { left: 1030, right: 1080, top: 0, bottom: 1920 },
  "status bar, back arrow and search box": { left: 0, right: 1080, top: 0, bottom: 247 },
  "right rail (avatar to music disc)": { left: 900, right: 1011, top: 853, bottom: 1748 },
  "username and caption": { left: 79, right: 400, top: 1645, bottom: 1758 },
  "promo bar, progress bar and bottom panel": { left: 0, right: 1080, top: 1785, bottom: 1920 },
};

describe("the safe zone against the full screen player", () => {
  const usable = zonesAt("anywhere-in-safe-zone", SAFE_ZONE, null).flatMap((part) => part.area);
  it("has usable area", () => {
    expect(usable.length).toBeGreaterThan(0);
  });
  it.each(Object.entries(PLAYER_UI))("excludes the %s", (_name, ui) => {
    for (const area of usable) {
      const overlap = intersectBox(area, ui);
      expect(overlap.right <= overlap.left || overlap.bottom <= overlap.top).toBe(true);
    }
  });
  it("keeps about 20 px from the rail, the top bar and the crop", () => {
    expect(safe.left - 50).toBeGreaterThanOrEqual(20);
    expect(1030 - safe.right).toBeGreaterThanOrEqual(20);
    expect(safe.top - 247).toBeGreaterThanOrEqual(20);
    expect(900 - SAFE_ZONE.notch.left).toBeGreaterThanOrEqual(20);
    expect(853 - SAFE_ZONE.notch.top).toBeGreaterThanOrEqual(20);
  });
});

describe("the transition library", () => {
  it("offers numbered only: the LIST, the one kind a transition takes", () => {
    expect([...TRANSITION_KINDS]).toEqual(["numbered"]);
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

  it("paces Intense: the hook from 0.2 s to 3 s; a VISUAL shows 1 to 2 s", () => {
    const { pace } = ISSEBYA_PRESET;
    expect(pace).toEqual({
      hook: { fromSeconds: 0.2, untilSeconds: 3, maxWords: 7, maxCharacters: 45 },
    });
    // The hook comes in on the big word's lead and holds longer than its minimum.
    const bigWord = timingOf(VARIANTS["bigword/behind"], "words-lead");
    expect(pace.hook.fromSeconds).toBe(bigWord.lead);
    expect(pace.hook.untilSeconds - pace.hook.fromSeconds).toBeGreaterThan(bigWord.minimum);
    expect(timingOf(VARIANTS["visual/card"], "words-min-max")).toMatchObject({
      minimum: 1,
      maximum: 2,
    });
  });

  it("times a big word 0.2 s before its word, at least 1.5 s; an accent by its words", () => {
    expect(ISSEBYA_PRESET.accent).toEqual({ afterSeconds: 1 });
    const bigWord = timingOf(VARIANTS["bigword/behind"], "words-lead");
    expect(bigWord).toMatchObject({ lead: 0.2, minimum: 1.5 });
    // The lead fits a start anchor's offset (at most 1 s).
    expect(bigWord.lead).toBeLessThanOrEqual(1);
  });

  it("sets captions in the simple font, accents and the big word in the artistic one, all white", () => {
    expect([STYLES.caption.font, STYLES.accent.font, STYLES.bigWord.font]).toEqual([
      "simple",
      "artistic",
      "artistic",
    ]);
    expect([STYLES.caption.color, STYLES.accent.color, STYLES.bigWord.color]).toEqual([
      "#FFFFFF",
      "#FFFFFF",
      "#FFFFFF",
    ]);
  });
});
