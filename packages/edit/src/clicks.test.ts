import { describe, expect, it } from "vitest";
import { clicksFor } from "./clicks.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import type { BehindItem } from "./schema.ts";

const PHOTO = "3f6c1a52-8e4d-4b7a-9c21-5d0e8f7b6a14";
const photo = (id: string, at: number): BehindItem => ({
  id,
  kind: "photo",
  photo_id: PHOTO,
  spot: "top",
  layer: "front",
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
  it("clicks as each photo, front or behind, and each big word comes in, in time order", () => {
    const clicks = clicksFor([word("big-word-1", 6), photo("photo-1", 2)], startOf, ISSEBYA_PRESET);
    expect(clicks).toEqual([
      { id: "click-photo-1", sound: "click", start: { time: 2 }, end: { time: 3 } },
      { id: "click-big-word-1", sound: "click", start: { time: 6 }, end: { time: 7.5 } },
    ]);
  });

  it("keeps the first of two clicks under the gap apart, and nothing for no item", () => {
    const close = clicksFor(
      [photo("photo-1", 2), word("big-word-1", 2.2)],
      startOf,
      ISSEBYA_PRESET,
    );
    expect(close.map((sound) => sound.id)).toEqual(["click-photo-1"]);
    const apart = clicksFor(
      [photo("photo-1", 2), word("big-word-1", 2.25)],
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
