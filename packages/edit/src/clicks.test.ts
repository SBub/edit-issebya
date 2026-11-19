import { describe, expect, it } from "vitest";
import { clicksFor, cueSound } from "./clicks.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import type { BehindItem } from "./schema.ts";
import { VARIANTS, type Variant } from "./variants.ts";

const visual = (id: string, at: number): BehindItem => ({
  id,
  kind: "visual",
  box: { x: 90, y: 160, width: 900, height: 600 },
  start: { time: at },
  end: { time: at + 1 },
});
const word = (id: string, at: number): BehindItem => ({
  id,
  kind: "word",
  text: "WORK",
  start: { time: at },
  end: { time: at + 1.5 },
});
const startOf = (item: BehindItem) => (item.start as { time: number }).time;

describe("clicksFor", () => {
  it("clicks as each visual and each big word comes in, in time order", () => {
    const clicks = clicksFor(
      [word("big-word-1", 6), visual("visual-1", 2)],
      startOf,
      ISSEBYA_PRESET,
    );
    expect(clicks).toEqual([
      { id: "click-visual-1", sound: "click", start: { time: 2 }, end: { time: 3 } },
      { id: "click-big-word-1", sound: "click", start: { time: 6 }, end: { time: 7.5 } },
    ]);
  });

  it("keeps the first of two clicks under the gap apart, and nothing for no item", () => {
    const close = clicksFor(
      [visual("visual-1", 2), word("big-word-1", 2.2)],
      startOf,
      ISSEBYA_PRESET,
    );
    expect(close.map((sound) => sound.id)).toEqual(["click-visual-1"]);
    const apart = clicksFor(
      [visual("visual-1", 2), word("big-word-1", 2.25)],
      startOf,
      ISSEBYA_PRESET,
    );
    expect(apart).toHaveLength(2);
    expect(clicksFor([], startOf, ISSEBYA_PRESET)).toEqual([]);
  });

  it("is louder than before: -6 dB", () => {
    expect(ISSEBYA_PRESET.sounds.click.gainDb).toBe(-6);
  });
});

// A visual and a big word come in with a pop.
describe("cueSound", () => {
  const behind = [visual("visual-1", 2), word("big-word-1", 6)];
  const cue = (id: string, sound: "click" | "shutter" | "whoosh" | "pop" = "click") => ({
    id,
    sound,
    start: { time: 2 },
    end: { time: 3 },
  });

  it("plays the pop for a visual's cue, on the cue the engine writes", () => {
    const [first] = clicksFor(behind, startOf, ISSEBYA_PRESET);
    // The stored cue is unchanged: the same id, the same anchors, still `click`.
    expect(first).toEqual({
      id: "click-visual-1",
      sound: "click",
      start: { time: 2 },
      end: { time: 3 },
    });
    expect(cueSound(first!, behind)).toBe("pop");
  });

  it("plays the pop for a big word's cue, on the cue the engine writes", () => {
    const second = clicksFor(behind, startOf, ISSEBYA_PRESET)[1]!;
    // The stored cue is unchanged: the same id, the same anchors, still `click`.
    expect(second).toMatchObject({ id: "click-big-word-1", sound: "click" });
    expect(cueSound(second, behind)).toBe("pop");
  });

  it("plays an owner's added card's cue as the pop too", () => {
    expect(cueSound(cue("click-owner-visual-1"), [visual("owner-visual-1", 2)])).toBe("pop");
  });

  it("keeps the sound of an item that is no visual's cue", () => {
    // A hand-written click, a cue whose item is gone, a version with no behind track.
    expect(cueSound(cue("s-fund-life"), behind)).toBe("click");
    expect(cueSound(cue("click-visual-9"), behind)).toBe("click");
    expect(cueSound(cue("click-visual-1"), undefined)).toBe("click");
    // A sound named on the track plays as named.
    expect(cueSound(cue("click-visual-1", "shutter"), behind)).toBe("shutter");
    expect(cueSound(cue("click-big-word-1", "whoosh"), behind)).toBe("whoosh");
    expect(cueSound(cue("s-1", "whoosh"), behind)).toBe("whoosh");
  });
});

describe("the sounds a version can play", () => {
  it("are click, shutter, whoosh and pop, each a short file at the click's level", () => {
    expect(Object.keys(ISSEBYA_PRESET.sounds).sort()).toEqual([
      "click",
      "pop",
      "shutter",
      "whoosh",
    ]);
    expect(ISSEBYA_PRESET.sounds.shutter.file).toBe("assets/sounds/camera-shutter.wav");
    expect(ISSEBYA_PRESET.sounds.pop.file).toBe("assets/sounds/pop.wav");
    for (const [name, sound] of Object.entries(ISSEBYA_PRESET.sounds)) {
      expect(sound.file, name).toMatch(/^assets\/sounds\/[a-z-]+\.wav$/);
      // Brief: under 0.5 s.
      expect(sound.durationSeconds, name).toBeLessThan(0.5);
      // One gain for all: the files are levelled to the click's loudness.
      expect(sound.gainDb, name).toBe(-6);
    }
  });

  it("names the pop as the big word entry's sound and the visual's, and no other entry has one", () => {
    const withSound = Object.values(VARIANTS as Record<string, Variant>).filter(
      (entry) => entry.sound !== undefined,
    );
    expect(withSound.map((entry) => [entry.variant, entry.sound])).toEqual([
      ["bigword/behind", "pop"],
      ["visual/card", "pop"],
    ]);
  });

  it("rejects a sound name the preset does not have at compile time", () => {
    const wrong: Variant = {
      ...VARIANTS["visual/card"],
      // @ts-expect-error -- "boing" is not a sound of the preset
      sound: "boing",
    };
    expect(wrong.sound).toBe("boing");
  });
});
