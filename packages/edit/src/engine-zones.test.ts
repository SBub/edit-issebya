import { describe, expect, it } from "vitest";
import { SAFE_ZONE, type SafeZone, type ZoneName, zonesAt } from "./engine-zones.ts";
import type { Box } from "./head-track.ts";
import { PLATFORM_BUTTONS, PLATFORM_SAFE } from "./preset.ts";

// A face in the middle of the frame, padded the way the engine pads it (the
// zones take the face as given).
const FACE: Box = { left: 300, right: 700, top: 500, bottom: 1000 };

// The safe zone's centre x: (70 + 1010) / 2.
const CX = 540;
// PLATFORM_SAFE minus the notch (880 to 1010 by 833 to 1470), in the order
// `minus` cuts it: the part above the notch, then the part left of it.
const S_MINUS_NOTCH: Box[] = [
  { left: 70, right: 1010, top: 270, bottom: 833 },
  { left: 70, right: 880, top: 833, bottom: 1470 },
];

const ZONES: ZoneName[] = [
  "above-head",
  "upper-third",
  "beside-face",
  "below-face",
  "caption-line",
  "corner",
  "head-top",
  "anywhere-in-safe-zone",
];

describe("the safe zone S", () => {
  it("is the platform guard, with the button column's notch cut out of it", () => {
    expect(SAFE_ZONE).toEqual({ box: PLATFORM_SAFE, notch: PLATFORM_BUTTONS });
  });
});

describe("zonesAt, with a head", () => {
  it("above-head: S above the face less the gap, wanted 190 px above the face's top", () => {
    expect(zonesAt("above-head", SAFE_ZONE, FACE)).toEqual([
      {
        area: [{ left: 70, right: 1010, top: 270, bottom: 488 }],
        want: { x: CX, y: 310 },
      },
    ]);
  });

  it("above-head is empty when the face leaves no room above it", () => {
    const high: Box = { ...FACE, top: 230, bottom: 700 };
    expect(zonesAt("above-head", SAFE_ZONE, high)[0]!.area).toEqual([]);
  });

  it("upper-third: the top third of S, wanted at its top centre, whatever the face", () => {
    const [part] = zonesAt("upper-third", SAFE_ZONE, FACE);
    expect(part!.area).toHaveLength(1);
    expect(part!.area[0]!.left).toBe(70);
    expect(part!.area[0]!.right).toBe(1010);
    expect(part!.area[0]!.top).toBe(270);
    expect(part!.area[0]!.bottom).toBeCloseTo(270 + 1200 / 3, 6);
    expect(part!.want).toEqual({ x: CX, y: 270 });
  });

  it("beside-face: the strips left and right of the face, the wider one first", () => {
    // Left strip 70 to 300 (230 wide), right strip 700 to 1010 (310 wide), its lower part
    // cut by the notch.
    const [first, second] = zonesAt("beside-face", SAFE_ZONE, FACE);
    expect(first).toEqual({
      area: [
        { left: 700, right: 1010, top: 500, bottom: 833 },
        { left: 700, right: 880, top: 833, bottom: 1120 },
      ],
      want: { x: 700, y: 850 },
    });
    expect(second).toEqual({
      area: [{ left: 70, right: 300, top: 500, bottom: 1120 }],
      want: { x: 300, y: 850 },
    });
  });

  it("beside-face: the left strip first when it is the wider one", () => {
    const right: Box = { left: 500, right: 800, top: 500, bottom: 1000 };
    const [first] = zonesAt("beside-face", SAFE_ZONE, right);
    expect(first!.want.x).toBe(500);
  });

  it("below-face: S below the face and the gap, wanted under the face's centre", () => {
    // The part below the face runs into the notch: the notch is cut out.
    expect(zonesAt("below-face", SAFE_ZONE, FACE)).toEqual([
      {
        area: [{ left: 70, right: 880, top: 1012, bottom: 1470 }],
        want: { x: 500, y: 1012 },
      },
    ]);
  });

  it("caption-line: S from y 1290 down, wanted at its top centre", () => {
    expect(zonesAt("caption-line", SAFE_ZONE, FACE)).toEqual([
      { area: [{ left: 70, right: 880, top: 1290, bottom: 1470 }], want: { x: CX, y: 1290 } },
    ]);
  });

  it("corner: the four corners of S inset 40 px, in order, the notch cut out", () => {
    const parts = zonesAt("corner", SAFE_ZONE, FACE);
    const inset = [
      { left: 110, right: 970, top: 310, bottom: 833 },
      { left: 110, right: 880, top: 833, bottom: 1430 },
    ];
    expect(parts.map((part) => part.want)).toEqual([
      { x: 110, y: 310 },
      { x: 970, y: 310 },
      { x: 110, y: 1430 },
      { x: 970, y: 1430 },
    ]);
    for (const part of parts) expect(part.area).toEqual(inset);
  });

  it("head-top: all of S, wanted 60 px below the face's top, at the centre", () => {
    expect(zonesAt("head-top", SAFE_ZONE, FACE)).toEqual([
      { area: S_MINUS_NOTCH, want: { x: CX, y: 560 } },
    ]);
  });

  it("anywhere-in-safe-zone: all of S, wanted at its centre", () => {
    expect(zonesAt("anywhere-in-safe-zone", SAFE_ZONE, FACE)).toEqual([
      { area: S_MINUS_NOTCH, want: { x: CX, y: 870 } },
    ]);
  });
});

describe("zonesAt, with no head in the moment", () => {
  it("above-head falls back to the accent line at y 1130, centred, over all of S", () => {
    expect(zonesAt("above-head", SAFE_ZONE, null)).toEqual([
      { area: S_MINUS_NOTCH, want: { x: CX, y: 1130 } },
    ]);
  });

  it("upper-third is the same as with a head", () => {
    expect(zonesAt("upper-third", SAFE_ZONE, null)).toEqual(
      zonesAt("upper-third", SAFE_ZONE, FACE),
    );
  });

  it("beside-face and below-face are absent", () => {
    expect(zonesAt("beside-face", SAFE_ZONE, null)).toEqual([]);
    expect(zonesAt("below-face", SAFE_ZONE, null)).toEqual([]);
  });

  it("caption-line and corner are the same as with a head", () => {
    expect(zonesAt("caption-line", SAFE_ZONE, null)).toEqual(
      zonesAt("caption-line", SAFE_ZONE, FACE),
    );
    expect(zonesAt("corner", SAFE_ZONE, null)).toEqual(zonesAt("corner", SAFE_ZONE, FACE));
  });

  it("head-top falls back to y 700, centred, over all of S", () => {
    expect(zonesAt("head-top", SAFE_ZONE, null)).toEqual([
      { area: S_MINUS_NOTCH, want: { x: CX, y: 700 } },
    ]);
  });

  it("anywhere-in-safe-zone is the same as with a head", () => {
    expect(zonesAt("anywhere-in-safe-zone", SAFE_ZONE, null)).toEqual(
      zonesAt("anywhere-in-safe-zone", SAFE_ZONE, FACE),
    );
  });
});

describe("zonesAt, every zone", () => {
  // Hard rule 1 holds by construction: no area leaves S or touches the notch,
  // with a head and without, for a face near every edge of the frame.
  const faces: (Box | null)[] = [
    null,
    FACE,
    { left: 0, right: 1080, top: 0, bottom: 300 },
    { left: 800, right: 1080, top: 1200, bottom: 1920 },
  ];
  const S: SafeZone = SAFE_ZONE;

  it.each(ZONES)("%s keeps every area inside S and clear of the notch", (name) => {
    for (const face of faces) {
      for (const part of zonesAt(name, S, face)) {
        for (const box of part.area) {
          expect(box.left, name).toBeGreaterThanOrEqual(S.box.left);
          expect(box.right, name).toBeLessThanOrEqual(S.box.right);
          expect(box.top, name).toBeGreaterThanOrEqual(S.box.top);
          expect(box.bottom, name).toBeLessThanOrEqual(S.box.bottom);
          const overlapsNotch =
            box.left < S.notch.right &&
            S.notch.left < box.right &&
            box.top < S.notch.bottom &&
            S.notch.top < box.bottom;
          expect(overlapsNotch, name).toBe(false);
        }
      }
    }
  });
});
