import { describe, expect, it } from "vitest";
import { bigWordLayout } from "./behind.ts";
import {
  ISSEBYA_PRESET,
  LEGACY_TRANSITION_TYPES,
  PLATFORM_SAFE,
  TRANSITION_TYPES,
  backgroundCss,
  fontSize,
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
  it("is the stricter TikTok and Instagram box at 1080x1920", () => {
    expect(PLATFORM_SAFE).toEqual({ left: 120, right: 840, top: 252, bottom: 1164 });
  });

  it("cuts the style's safe box", () => {
    expect(safe).toEqual({ left: 130, right: 840, top: 260, bottom: 1164 });
    expect(intersectBox(safe, PLATFORM_SAFE)).toEqual(safe);
  });

  it("keeps the caption fallback line inside the safe box", () => {
    const { caption, roles } = ISSEBYA_PRESET;
    expect(caption.fallbackY).toBeGreaterThanOrEqual(safe.top);
    expect(caption.fallbackY + roles.captionText.size).toBeLessThanOrEqual(safe.bottom);
  });

  it("keeps the accent's no-head line inside the safe box", () => {
    const { accent, roles } = ISSEBYA_PRESET;
    expect(accent.noHeadY).toBeGreaterThanOrEqual(safe.top);
    expect(accent.noHeadY + roles.accentText.size).toBeLessThanOrEqual(safe.bottom);
  });

  it("keeps every library transition's text area inside the platform guard", () => {
    const guard = intersectBox(safe, PLATFORM_SAFE);
    for (const type of TRANSITION_TYPES) {
      const { text } = ISSEBYA_PRESET.transitions[type];
      expect(intersectBox(text, guard), type).toEqual(text);
    }
    expect(ISSEBYA_PRESET.transitions.panel.layer.top).toBeLessThanOrEqual(
      ISSEBYA_PRESET.transitions.panel.text.top,
    );
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

describe("the style roles", () => {
  it("names a font, a colour and a size per text role, and a background colour", () => {
    const { roles, fonts } = ISSEBYA_PRESET;
    expect(roles.accentText).toEqual({ font: "primary", color: "#B3E6FF", size: 110 });
    expect(roles.captionText).toEqual({ font: "secondary", color: "#FFFFFF", size: 50 });
    expect(roles.background).toEqual({ color: "#121212" });
    for (const role of [roles.accentText, roles.captionText]) {
      expect(fonts[role.font]).toBeDefined();
      expect(role.color).toMatch(/^#[0-9A-F]{6}$/);
    }
    expect(roles.background.color).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("gives a font the size of the first role set in it", () => {
    expect(fontSize(ISSEBYA_PRESET, "primary")).toBe(110);
    expect(fontSize(ISSEBYA_PRESET, "secondary")).toBe(50);
  });

  it("writes a background at a strength as rgba, solid as the colour", () => {
    expect(backgroundCss("#121212", 1)).toBe("#121212");
    expect(backgroundCss("#121212", 0.62)).toBe("rgba(18, 18, 18, 0.62)");
  });
});

describe("the transition library", () => {
  it("is dim, panel and numbered, each described, none naming a font or a colour", () => {
    expect(Object.keys(ISSEBYA_PRESET.transitions)).toEqual([...TRANSITION_TYPES]);
    expect(TRANSITION_TYPES).toEqual(["dim", "panel", "numbered"]);
    for (const type of TRANSITION_TYPES) {
      const entry = ISSEBYA_PRESET.transitions[type] as unknown as Record<string, unknown>;
      expect(String(entry.description).length, type).toBeGreaterThan(10);
      expect(entry, type).not.toHaveProperty("font");
      expect(entry, type).not.toHaveProperty("color");
      expect(JSON.stringify(entry), type).not.toMatch(/#[0-9A-Fa-f]{6}|rgba?\(/);
      expect((entry.background as { role: string }).role).toBe("background");
    }
    expect(ISSEBYA_PRESET.transitions.numbered.numberScale).toBe(1.6);
  });

  it("keeps the frozen look of stored timed transitions", () => {
    const frame = { left: 0, right: 1080, top: 0, bottom: 1920 };
    expect(LEGACY_TRANSITION_TYPES).toEqual(["dim", "panel", "card"]);
    expect(ISSEBYA_PRESET.legacyTransitions).toEqual({
      dim: {
        layer: frame,
        background: "rgba(0, 0, 0, 0.62)",
        motion: "fade",
        seconds: 0.3,
        ease: "power2.out",
        text: { left: 130, right: 840, top: 944, bottom: 1164 },
      },
      panel: {
        layer: { left: 0, right: 1080, top: 914, bottom: 1920 },
        background: "#121212",
        motion: "slide",
        seconds: 0.5,
        ease: "power3.inOut",
        text: { left: 130, right: 840, top: 964, bottom: 1164 },
      },
      card: {
        layer: frame,
        background: "rgba(8, 8, 8, 0.9)",
        motion: "fade",
        seconds: 0.25,
        ease: "power2.out",
        text: { left: 130, right: 840, top: 640, bottom: 1164 },
      },
    });
  });

  it("holds the transition rules", () => {
    expect(ISSEBYA_PRESET.transitionRules).toEqual({
      maxHoldSeconds: 1,
      minSeconds: 1.5,
      densitySeconds: 7,
      motionRange: { min: 0.2, max: 1.5 },
      holdRange: { min: 0, max: 2 },
      shrinkFloor: 0.6,
    });
  });
});
