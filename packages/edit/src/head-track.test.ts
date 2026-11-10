import { describe, expect, it } from "vitest";
import {
  HEAD_GLITCH_WIDTH_SHARE,
  type HeadTrack,
  cleanHeadTrack,
  facesOver,
  headTrackSchema,
} from "./head-track.ts";

// The real clip's head, one sample per 0.25 s for 50 s: 332 px wide, its top
// between 560 and 580. From 46.25 to 47.25 s the five glitch samples of the
// evidence replace the real ones (the real head there is 310 to 350 px wide, its
// top 548 to 564; the glitches read 112 to 228 px wide, tops 424 to 480).
const GLITCHES: Record<string, { head_top: number; cx: number; head_w: number }> = {
  "46.25": { head_top: 424, cx: 692, head_w: 228 },
  "46.5": { head_top: 432, cx: 676, head_w: 112 },
  "46.75": { head_top: 424, cx: 640, head_w: 152 },
  "47": { head_top: 472, cx: 636, head_w: 172 },
  "47.25": { head_top: 480, cx: 640, head_w: 180 },
};

const REAL_CLIP: HeadTrack = Array.from({ length: 200 }, (_, index) => {
  const t = index * 0.25;
  const glitch = GLITCHES[String(t)];
  if (glitch) return { t, ...glitch };
  return { t, head_top: 560 + (index % 3) * 8, cx: 610 + (index % 2) * 4, head_w: 332 };
});

describe("cleanHeadTrack: the glitch samples", () => {
  it("drops the samples narrower than the share of the median head, and keeps the real ones", () => {
    expect(HEAD_GLITCH_WIDTH_SHARE).toBe(0.7);
    const cleaned = cleanHeadTrack(REAL_CLIP);
    for (const t of [46.25, 46.5, 46.75, 47, 47.25]) {
      expect(cleaned[t * 4]).toBeNull();
    }
    // The real head around the glitches (310 to 350 px wide) is kept as read.
    expect(cleaned[45 * 4]).toEqual(REAL_CLIP[45 * 4]);
    expect(cleaned[47.5 * 4]).toEqual(REAL_CLIP[47.5 * 4]);
    expect(cleaned.filter((sample) => sample === null)).toHaveLength(5);
  });

  it("is applied by the schema, so every parse of the track sees the clean one", () => {
    const parsed = headTrackSchema.parse(REAL_CLIP);
    expect(parsed).toEqual(cleanHeadTrack(REAL_CLIP));
    expect(parsed[46.5 * 4]).toBeNull();
  });

  it("keeps a clip whose heads are all of a similar width unchanged", () => {
    const steady: HeadTrack = Array.from({ length: 80 }, (_, index) => ({
      t: index * 0.25,
      head_top: 500 + (index % 5),
      cx: 540,
      head_w: 320 + (index % 7) * 3,
    }));
    expect(cleanHeadTrack(steady)).toEqual(steady);
  });

  it("uses the median of the clip's heads, and a head exactly at the floor stays", () => {
    // Median 300: the floor is 210. 210 stays, 209 goes.
    const track: HeadTrack = [
      { t: 0, head_top: 500, cx: 540, head_w: 300 },
      { t: 0.25, head_top: 500, cx: 540, head_w: 300 },
      { t: 0.5, head_top: 500, cx: 540, head_w: 300 },
      { t: 0.75, head_top: 500, cx: 540, head_w: 210 },
      { t: 1, head_top: 500, cx: 540, head_w: 209 },
      null,
    ];
    const cleaned = cleanHeadTrack(track);
    expect(cleaned[3]).toEqual(track[3]);
    expect(cleaned[4]).toBeNull();
    expect(cleaned[5]).toBeNull();
  });

  it("leaves a track with no head at all as it is", () => {
    expect(cleanHeadTrack([null, null])).toEqual([null, null]);
    expect(cleanHeadTrack([])).toEqual([]);
  });
});

describe("the robust face over the glitch span", () => {
  it("reads the real head where the glitches were, not their tops", () => {
    const cleaned = headTrackSchema.parse(REAL_CLIP);
    const faces = facesOver(cleaned, 46.25, 47.25);
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      expect(face.top).toBeGreaterThanOrEqual(556);
      expect(face.top).toBeLessThanOrEqual(580);
    }
  });
});
